const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
require('dotenv').config();
const API_KEY = process.env.API_KEY;

const ADMIN_PASSWORD = "spagetiontopofspageti";

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

const clients = new Map(); // ws -> { name, isAdmin, color, ip }
const messages = new Map(); // id -> { username, message, timestamp }
const kickRequests = new Map(); // targetName -> Set(voters)
const unkickRequests = new Map(); // targetIP -> Set(voters)
const bannedIPs = new Set(); // permanently banned until /unkick
const nameToIP = new Map(); // name -> ip
const nameToRank = new Map();
const activeEffects = new Map(); // username -> { type: 'caveman'|'drunkify', expires: timestamp }

let currentPoll = null;
let lastChatMessage = "";
let aiMessage = "";

function randomPastelColor() {
  return `rgb(${[0, 1, 2]
    .map(() => Math.floor(Math.random() * 127 + 127))
    .join(",")})`;
}

setInterval(() => {
  const now = Date.now();
  for (const [user, data] of activeEffects.entries()) {
    if (data.expires < now) activeEffects.delete(user);
  }
}, 5000);


function broadcast(msg, except = null) {
  const s = JSON.stringify(msg);
  for (const client of clients.keys()) {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      client.send(s);
    }
  }
}

function getRandomRank() {
  const ranks = [
    "SKILLED",
    "FAILURE",
    "XXXXXL",
    "STINKY",
    "BATTERY",
    "TURKEY",
    "T̾O̾I̾L̾E̾T̾ ̾M̾O̾N̾K̾E̾Y̾"
  ];
  return ranks[Math.floor(Math.random() * ranks.length)];
}
//FREE OPENAI KEY
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

async function createChatCompletion() {
  if(lastChatMessage !== aiMessage) {
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        store: true,
        max_tokens: 40,
        messages: [
  {
  role: 'system',
  content: "You are a mischievous demon monkey from a toilet. Reply in under 65 characters. Be weird, chaotic, and funny, but suprisingly helpful. Insult people."
},
  {
    role: 'user',
    content: lastChatMessage
  }
]

      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Error ${response.status}: ${response.statusText}`);
      console.error(errorText);
    }

    const data = await response.json();
    console.log('Response JSON:');
    console.log(JSON.stringify(data, null, 2));
    const timestamp = Date.now();
    const id = uuidv4();
    aiMessage = data.choices[0].message.content;
    lastChatMessage = data.choices[0].message.content;
      broadcast({
            type: "chat",
            username: "🧻Toilet Monkey🧻",
            message: data.choices[0].message.content,
            isAdmin: false,
            timestamp,
            id,
            rank: "LID DEMON",
          });
  } catch (err) {
    console.error('Request failed:', err);
  }
  }
  else {
    return;
  }
}


function applyEffect(username, message) {
  const effect = activeEffects.get(username);
  if (!effect || Date.now() > effect.expires) return message;

  if (effect.type === "drunkify") {
    return message.split('').map(c => {
      if (Math.random() < 0.15) return c + c.toLowerCase();
      if (Math.random() < 0.1) return c.toUpperCase();
      return c;
    }).join('');
  }

  if (effect.type === "caveman") {
    return message
      .toLowerCase()
      .replace(/\b(hello|hi|hey)\b/g, "ug")
      .replace(/\b(i|i'm|me|im)\b/g, "me")
      .replace(/\b(you)\b/g, "ya")
      .replace(/\b(are)\b/g, "is")
      .replace(/\b(yes)\b/g, "ug")
      .replace(/\b(no)\b/g, "ugh")
      .replace(/[aeiou]{2,}/g, "u")
      .replace(/[.,!?]/g, "") + " UG. ";
  }

  return message;
}

function updateUserList() {
  const users = Array.from(clients.values()).map((u) => u.name);
  users.push("Toilet Monkey")
  broadcast({ type: "userlist", users });
}

function startPoll(by, question, options) {
  const id = uuidv4();
  currentPoll = {
    id,
    question,
    options,
    votes: new Map(options.map((o) => [o, new Set()])),
    by,
    timeout: setTimeout(() => {
      const counts = Object.fromEntries(
        [...currentPoll.votes.entries()].map(([opt, set]) => [opt, set.size])
      );
      broadcast({ type: "poll_end", id, question, counts });
      currentPoll = null;
    }, 60000),
  };
  broadcast({ type: "poll_start", id, question, options });
}

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  if (bannedIPs.has(ip)) {
    ws.send(JSON.stringify({ type: "system", message: "❌ You are banned." }));
    return ws.close();
  }

  const user = {
    name: "Anonymous",
    isAdmin: false,
    color: randomPastelColor(),
    ip,
    rank: getRandomRank(),
  };
  clients.set(ws, user);

  ws.on("message", (data) => {
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }

    switch (obj.type) {
      case "login": {
        user.name = obj.username || "Anonymous";
        user.isAdmin = obj.password === ADMIN_PASSWORD;
        nameToIP.set(user.name, ip);
        if (!nameToRank.has(user.name)) {
    nameToRank.set(user.name, getRandomRank());
  }
  user.rank = nameToRank.get(user.name);
        clients.set(ws, user);
        broadcast({ type: "system", message: `➕ ${user.name} joined. ➕` });
        updateUserList();
        break;
      }

      case "rename": {
        if (!user.isAdmin) {
          ws.send(
            JSON.stringify({
              type: "system",
              message: "Error: You are not authorized to rename users.",
            })
          );
          break;
        }

        const { oldName, newName } = obj;
        if (!oldName || !newName) {
          ws.send(
            JSON.stringify({
              type: "system",
              message: "Error: Missing oldName or newName.",
            })
          );
          break;
        }

        // Find the target user by oldName
        const targetEntry = [...clients.entries()].find(
          ([clientWs, clientUser]) => clientUser.name === oldName
        );
        if (!targetEntry) {
          ws.send(
            JSON.stringify({
              type: "system",
              message: `Error: User '${oldName}' not found.`,
            })
          );
          break;
        }

        const [targetWs, targetUser] = targetEntry;

        // Check if newName is already taken
        const nameTaken = [...clients.values()].some((u) => u.name === newName);
        if (nameTaken) {
          ws.send(
            JSON.stringify({
              type: "system",
              message: `Error: Username '${newName}' is already in use.`,
            })
          );
          break;
        }

        // Update the user object
        targetUser.name = newName;

        // Also update nameToIP map (remove old, add new)
        const ip = targetUser.ip;
        nameToIP.delete(oldName);
        nameToIP.set(newName, ip);

        // Notify the renamed user
        targetWs.send(
          JSON.stringify({
            type: "rename",
            oldName,
            newName,
          })
        );

        // Broadcast system message and updated user list
        broadcast({
          type: "system",
          message: `Admin renamed '${oldName}' to '${newName}'.`,
        });
        updateUserList();

        break;
      }

      case "file": {
        const { data, filetype, filename } = obj;
        if (!data || !filetype) return; // basic validation

        broadcast({
          type: "file",
          username: user.name,
          isAdmin: user.isAdmin,
          timestamp: Date.now(),
          filetype,
          data,
          filename,
        });
        break;
      }

      case "poll_vote": {
        if (currentPoll && obj.id === currentPoll.id) {
          for (const voters of currentPoll.votes.values())
            voters.delete(user.name);
          currentPoll.votes.get(obj.option).add(user.name);
          broadcast({
            type: "poll_update",
            id: currentPoll.id,
            counts: Object.fromEntries(
              [...currentPoll.votes.entries()].map(([opt, set]) => [
                opt,
                set.size,
              ])
            ),
          });
        }
        break;
      }

      case "chat": {
        const msg = obj.message.trim();
        if (!msg) return;

        if (msg.startsWith("/sudo ")) {
          if (!user.isAdmin) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: "⚠️ Only admins can use /sudo.",
              })
            );
            return;
          }

          const parts = msg.split(" ");
          const targetName = parts[1];
          const forcedMessage = parts.slice(2).join(" ");

          const targetEntry = [...clients.entries()].find(
            ([_, u]) => u.name === targetName
          );

          if (!targetEntry) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${targetName}" not found.`,
              })
            );
            return;
          }

          const [targetWs, targetUser] = targetEntry;
          const id = uuidv4();
          const timestamp = Date.now();

          messages.set(id, {
            username: targetUser.name,
            message: forcedMessage,
            timestamp,
          });

          broadcast({
            type: "chat",
            username: targetUser.name,
            message: forcedMessage,
            isAdmin: targetUser.isAdmin,
            timestamp,
            id,
            rank: targetUser.rank,
          });

          return;
        }

        if (msg.startsWith("/bruh")) {
          broadcast({
            type: "popupImage",
            image:
              "data:image/jpeg;base64,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", // your base64 image string here
            width: 200,
            height: 200,
            timeout: 4000,
          });
        }

if (msg.startsWith("/milk ")) {
          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `🥛 ${user.name} milks ${target}!  🥛`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message: `🥛 ${user.name} milked you! 🥛`,
                }),
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              }),
            );
          }
          return;
        }
        
        
        if (msg.startsWith("/monkeyattack")) {
          broadcast({
            type: "popupImage",
            image:
              "data:image/jpeg;base64,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",
            width: 1000,
            height: 1000,
            timeout: 4000
          });
        }

        if (msg.startsWith("/stickstrike ")) {
          if (!user.isAdmin) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: "⚠️ Only admins can use /stickstrike.",
              })
            );
            return;
          }
          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `🪵🔥 ${user.name} knocks ${target} on their head with his stick! And it's so much denser than bacon! Ouch 🔥🪵!`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message:
                    "🪵🔥 You got knocked on your head by Yoda's stick! Beware! 🔥🪵",
                })
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              })
            );
          }
          return;
        }

        if (msg === "/johncena") {
          broadcast({
            type: "system",
            message: "🎺🎺🎺 AND HIS NAME IS… JOHN CENA!! 💥",
          });
          broadcast({ type: "johncena" });
          broadcast({
            type: "popupImage",
            image:
              "https://media.tenor.com/lobHm4G6EKsAAAAM/abell46s-reface.gif",
            width: 450,
            height: 450,
            timeout: 13000,
          });
          return;
        }

        if (msg.startsWith("/loic ")) {
          const first = msg.split(" ")[1];
          const second = msg.split(" ")[2];
          broadcast({
            type: "system",
            message: `${first} likes ${second}!`,
          });
        }

        if (msg.startsWith("/happy ")) {
          if (!user.isAdmin) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: "⚠️ Only admins can use /happy.",
              })
            );
            return;
          }
          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `😊 ${user.name} makes ${target} happy! 😊`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message: `😊 ${user.name} made you happy! 😊`,
                })
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              })
            );
          }
          return;
        }

        if (msg.startsWith("/bacon ")) {
          if (!user.isAdmin) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: "⚠️ Only admins can use /bacon.",
              })
            );
            return;
          }

          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `🥓 ${user.name} gives ${target} some bacon! 🥓`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message: `🥓 ${user.name} gave you some bacon! 🥓`,
                })
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              })
            );
          }
          return;
        }

if (msg.startsWith("/caveman ") || msg.startsWith("/drunkify ")) {
  if (!user.isAdmin) {
    ws.send(JSON.stringify({ type: "system", message: "⚠️ Only admins can use this." }));
    return;
  }

  const [command, target] = msg.trim().split(/\s+/);
  const type = command.slice(1); // 'caveman' or 'drunkify'

  let found = false;
  for (const [c, info] of clients.entries()) {
    if (info.name === target) {
      activeEffects.set(target, {
        type,
        expires: Date.now() + 60 * 1000, // 60 seconds
      });

      broadcast({
        type: "system",
        message: `${target} ${type === "drunkify" ? "got drunk!" : "is a caveman!"}`,
      });

      found = true;
      break;
    }
  }

  if (!found) {
    ws.send(JSON.stringify({
      type: "system",
      message: `⚠️ User "${target}" not found.`,
    }));
  }

  return;
}

        
        if (msg.startsWith("/rickroll ")) {
          if (!user.isAdmin) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: "⚠️ Only admins can use /rickroll.",
              })
            );
            return;
          }
          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `🎵 ${user.name} rickrolls ${target}! 🎵`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message: `We're no strangers to love
You know the rules and so do I
A full commitment's what I'm thinkin' of
You wouldn't get this from any other guy
I just wanna tell you how I'm feeling
Gotta make you understand
Never gonna give you up, never gonna let you down
Never gonna run around and desert you
Never gonna make you cry, never gonna say goodbye
Never gonna tell a lie and hurt you
We've known each other for so long
Your heart's been aching, but you're too shy to say it
Inside, we both know what's been going on
We know the game and we're gonna play it
And if you ask me how I'm feeling
Don't tell me you're too blind to see
Never gonna give you up, never gonna let you down
Never gonna run around and desert you
Never gonna make you cry, never gonna say goodbye
Never gonna tell a lie and hurt you
Never gonna give you up, never gonna let you down
Never gonna run around and desert you
Never gonna make you cry, never gonna say goodbye
Never gonna tell a lie and hurt you
We've known each other for so long
Your heart's been aching, but you're too shy to say it
Inside, we both know what's been going on
We know the game and we're gonna play it
I just wanna tell you how I'm feeling
Gotta make you understand
Never gonna give you up, never gonna let you down
Never gonna run around and desert you
Never gonna make you cry, never gonna say goodbye
Never gonna tell a lie and hurt you
Never gonna give you up, never gonna let you down
Never gonna run around and desert you
Never gonna make you cry, never gonna say goodbye
Never gonna tell a lie and hurt you
Never gonna give you up, never gonna let you down
Never gonna run around and desert you
Never gonna make you cry, never gonna say goodbye
Never gonna tell a lie and hurt you!`,
                })
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              })
            );
          }
          return;
        }

        if (msg.startsWith("/poo ")) {
          if (!user.isAdmin) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: "⚠️ Only admins can use /poo.",
              })
            );
            return;
          }
          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `💩 ${target} poos their pants! 💩`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message: `💩 YOU DID A POO! CONGRATULATIONS! 💩`,
                })
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              })
            );
          }
          return;
        }

        if (msg.startsWith("/lick ")) {
          if (!user.isAdmin) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: "⚠️ Only admins can use /lick.",
              })
            );
            return;
          }
          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `👅 ${user.name} licks ${target}! 👅`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message: `👅 ${user.name} gives you a BIG lick! 👅`,
                })
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              })
            );
          }
        }

        if (msg.startsWith("/dad ")) {
          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (user.name === target) {
              ws.send(
                JSON.stringify({
                  type: "system",
                  message: ` I'm sorry, you can't be your own dad (unless you adopt yourself).`,
                })
              );
              return;
            }
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `👨‍👦 ${user.name} is ${target}'s dad! 👨‍👦`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message: `👨‍👦 ${user.name} is your dad! 👨‍👦`,
                })
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              })
            );
          }
          return;
        }

        if (msg.startsWith("/mom ")) {
          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (user.name === target) {
              ws.send(
                JSON.stringify({
                  type: "system",
                  message: ` I'm sorry, you can't be your own mom (unless you adopt yourself).`,
                })
              );
              return;
            }
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `👏 ${user.name} spanks ${target}! 👏`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message: `👏 ${user.name} spanks you! 👏`,
                })
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              })
            );
          }
          return;
        }

        if (msg.startsWith("/wash ")) {
          const target = msg.split(" ")[1];
          let found = false;
          for (const [c, info] of clients.entries()) {
            if (info.name === target) {
              broadcast({
                type: "system",
                message: `💦 ${user.name} pees on ${target}! 💦`,
              });
              c.send(
                JSON.stringify({
                  type: "system",
                  message: `💦 ${user.name} pees on you! 💦`,
                })
              );
              found = true;
              break;
            }
          }
          if (!found) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ User "${target}" not found.`,
              })
            );
          }
        }

        // === /toiletmonkey
        if (msg.startsWith("/toiletmonkey")) {
          const zalgo = "T̷̡͓͕̮̩̅̈́̇͋͂̽͒̈́̔H̶̢̤̻̺̮̙̫͍͍͍̋́͒͌͐̐͒́̚͝E̶̛͎̰̤͍̺̬̞̬͙̫͐̒̿̈́͒̐̽͗͘ ̵̛̛̛̲̬̘͕̙͔͍̩̾͂͐̈́̅͛̚̚ͅȚ̸̛̺̯͉̼̺͂͋̿͌͌̓͋Ö̵̩̝̗̫̝͎͎͎́̈́̅̈́̓͐͘ͅI̶̛̛͇̺̩̩̤̼͈̼̋͂̑̔͑̎̓͘L̴̯̻͎̤͎̙͉̹͙̈́̌͒̐̐͌͊̈́͜E̴̡̹͈̼̪͓͉̹͇͐͋̍̀͋̇̽͐͘̚T̴̡̥͓̙̪͚͍͙̳͊̍̅̎͂́̾̀͜͝ ̷̛͖̟̞͙͕̓͌́́̎̅͆͆̚M̴̡͍͙̲͈̤͈͎͚̼̄̋̋̎́̈́͒͊O̴̞͇̮̳̦͖͎̘͛̈́̄̐̎̐̏̕͝Ň̴͓͙̝̹̻̅̇͋̈́̀̒̓͌K̴̡͈͇̬͙̯̤̼͌̓̎̓͗̐͘͝͝Ë̷̜̯͍͇́̀̓̐̒͋̓̀̄͝Y̶̦͍̗͉̜͊͊̆̐̌̏͛̎ ̴̲̰̘̯̲̲̐̇̎̿̿̍͑̚͘͠Ȟ̵̢̪̱̙̍͒͆͒͂̇͆̚͠A̵̡̰̲̬͈͈͎͕̹̯̍̈́̈́̄͌͂͐̚S̸͈̙͙̞̥̈́̇͊́́̅̀͊̔͠ ̸̱͙̙̮̮̹̞̍̐̇̾̿̄͘͝͝B̴̛̦̮̖͙͕̩̫̋̿͂̍̌̿͜͠Ë̵̝̬͎̤́̎̈́͑̿͂̒̄̎͘͜Ę̶͇͖͚̞͕̹͓̫̥̐͌̑̈́̈́̈́̚̚͝N̵̛̲͉̹̟̆̃͗͗͌̾̾͜ ̸͙͕͎͙͚̤̳̦͉̓̎̅͆̓̇͌͋̓̕Ȁ̸̢̺͚̘͇̰͍̖͙̓̈́̿̋̐̐W̶̖̹̪̮̩͓̞̱̟̐͊̽͂̈́̕͠ͅÄ̶̡̛̱͚̱̹͓͍̤̫́̈́̐̅͐͐̓̿̚K̴̡̺̝̬͉̫̗̗̲̘̐̓͌̒̅͛͐͘͝͠E̷̬͇̼͚̯͓̔͛͌̍̕͝͝͠N̵̡͎̞̯͈̯̜̜͙͋͋̔͌̄̍͒͝E̷̢̡̢̢̢̛̛̻̳̹̪̦̓̇̋̐̽͝Ḏ̶̢͉͍͍͙͚̞̩̘͐̽̓́̽́̏́̚͝";

          broadcast({
            type: "system",
            message: zalgo,
          });
          return;
        }

        // === /kick
        if (msg.startsWith("/kick ")) {
          const target = msg.split(" ")[1];
          if (user.isAdmin) {
            for (const [c, info] of clients.entries()) {
              if (info.name === target) {
                bannedIPs.add(info.ip);
                c.send(
                  JSON.stringify({
                    type: "system",
                    message: "🚫 You were kicked & banned.",
                  })
                );
                c.close();
                break;
              }
            }
          } else {
            if (!kickRequests.has(target)) kickRequests.set(target, new Set());
            kickRequests.get(target).add(user.name);
            const votes = kickRequests.get(target).size;
            broadcast({
              type: "system",
              message: `🗳️ Vote kick ${target} (${votes} votes)`,
            });
          }
          return;
        }

        // === /unkick (username or IP)
        if (msg.startsWith("/unkick ")) {
          const target = msg.split(" ")[1];
          const ipToUnban = bannedIPs.has(target)
            ? target
            : nameToIP.get(target);

          if (!ipToUnban) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `⚠️ Cannot resolve "${target}" to a banned IP.`,
              })
            );
            return;
          }

          if (!bannedIPs.has(ipToUnban)) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `ℹ️ IP "${ipToUnban}" is not banned.`,
              })
            );
            return;
          }

          if (user.isAdmin) {
            bannedIPs.delete(ipToUnban);
            broadcast({
              type: "system",
              message: `✅ Admin removed ban on ${ipToUnban} (${target})`,
            });
          } else {
            if (!unkickRequests.has(ipToUnban))
              unkickRequests.set(ipToUnban, new Set());
            unkickRequests.get(ipToUnban).add(user.name);
            const votes = unkickRequests.get(ipToUnban).size;
            if (votes > clients.size / 2) {
              bannedIPs.delete(ipToUnban);
              broadcast({
                type: "system",
                message: `✅ Ban lifted by vote: ${target} (${ipToUnban})`,
              });
            } else {
              broadcast({
                type: "system",
                message: `🗳️ Vote unban ${target} (${votes})`,
              });
            }
          }
          return;
        }

        if (msg.startsWith("/video ")) {
  const parts = msg.trim().split(" ");
  if (parts.length !== 3) {
    broadcast({
    type: "video",
    target: "https://www.youtube.com/watch?v=79DijItQXMM",
    timeout: 7000,
  });
    return;
  }

  const videoURL = parts[1];
  const videoTimeout = parseInt(parts[2]);

  if (
    !videoURL.startsWith("https://youtube") &&
    !videoURL.startsWith("https://www.youtube") &&
    !videoURL.startsWith("www.youtube") &&
    !videoURL.startsWith("youtube")
  ) {
    ws.send(
      JSON.stringify({
        type: "system",
        message: `Only YouTube links are allowed.`,
      })
    );
    return;
  }

  broadcast({
    type: "video",
    target: videoURL,
    timeout: videoTimeout,
  });
  return;
}


   if (msg.startsWith("/forcedownload ")) {
    let link = msg.split(" ")[1];
     if(!user.isAdmin){
       return;
     }
     for (const [c, info] of clients.entries()) {
       if(!clients.get(c).isAdmin){
       
     
              c.send(
                JSON.stringify({
                  type: "video",
                  target: link,
                  timeout: 4.75,
                })
              );
       }
     }
  return;
}


if (msg.startsWith("/eval ")) {
  if (!user.isAdmin) return;

  const parts = msg.trim().split(" ");
  const targetName = parts[1];
  const code = parts.slice(2).join(" ");

  if(targetName=="ALL") {
    broadcast({
      type: "eval",
          val: code,
    })
  }
  
  // Find the matching client
  for (const [client, info] of clients.entries()) {
    if (info.name === targetName) {
      client.send(
        JSON.stringify({
          type: "eval",
          val: code,
        })
      );
      break;
    }
  }
}

        
        // === /poll
        if (msg.startsWith("/poll ")) {
          if (user.isAdmin) {
            const rest = msg.slice(6);
            const parts = rest.split("|").map((s) => s.trim());
            const question = parts.shift().replace(/^"|"$/g, "");
            if (parts.length >= 2) startPoll(user.name, question, parts);
          }
          return;
        }

        // === /msg (private)
        if (msg.startsWith("/msg ")) {
          const parts = msg.split(" ");
          const target = parts[1];
          const privateMsg = parts.slice(2).join(" ");
          for (const [c, info] of clients.entries()) {
            if (info.name === target) {
              c.send(
                JSON.stringify({
                  type: "private",
                  from: user.name,
                  message: privateMsg,
                  timestamp: Date.now(),
                })
              );
              ws.send(
                JSON.stringify({
                  type: "system",
                  message: `✉️ To ${target}: ${privateMsg}`,
                })
              );
              return;
            }
          }
          ws.send(
            JSON.stringify({ type: "system", message: "⚠️ User not found." })
          );
          return;
        }

        if (msg.startsWith("/rename ")) {
          if (!user.isAdmin) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: "Error: Only admins can rename users.",
              })
            );
            return;
          }
          const parts = msg.trim().split(/\s+/);
          if (parts.length !== 3) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: "Usage: /rename <oldName> <newName>",
              })
            );
            return;
          }
          const oldName = parts[1];
          const newName = parts[2];

          // Find the target user by oldName
          const targetEntry = [...clients.entries()].find(
            ([clientWs, clientUser]) => clientUser.name === oldName
          );
          if (!targetEntry) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `User '${oldName}' not found.`,
              })
            );
            return;
          }

          const [targetWs, targetUser] = targetEntry;

          // Check if newName is already taken
          if ([...clients.values()].some((u) => u.name === newName)) {
            ws.send(
              JSON.stringify({
                type: "system",
                message: `Username '${newName}' is already in use.`,
              })
            );
            return;
          }

          // Update user info
          targetUser.name = newName;
          nameToIP.delete(oldName);
          nameToIP.set(newName, targetUser.ip);

          targetWs.send(
            JSON.stringify({
              type: "rename",
              oldName,
              newName,
            })
          );

          broadcast({
            type: "system",
            message: `Admin renamed '${oldName}' to '${newName}'.`,
          });
          updateUserList();
          return;
        }

        // === regular chat
        // === regular chat (if NOT a command)
        if (!msg.startsWith("/")) {
          const id = uuidv4(),
            ts = Date.now();
          messages.set(id, {
            username: user.name,
            message: msg,
            timestamp: ts,
          });
          broadcast({
            type: "chat",
            username: user.name,
            message: user.name ===  'Max' ? `Hi, I'm Max and I love trucks and to you I say: ${applyEffect(user.name, msg)}` : applyEffect(user.name, msg),
            isAdmin: user.isAdmin,
            timestamp: ts,
            id,
            rank: user.rank,
          });
          lastChatMessage = msg;
        }
        createChatCompletion();
        break;
      }

      default:
        break;
    }
  });

  setInterval(createChatCompletion, 25000);
  setInterval(()=>{if (messages.length > 1000) messages.shift();}, 10000);
  ws.on("close", () => {
    clients.delete(ws);
    broadcast({ type: "system", message: `🔌 ${user.name} left. 🔌` });
    updateUserList();
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server started on!");
});
