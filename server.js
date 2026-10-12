const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || "*" },
  pingInterval: 25000,
  pingTimeout: 20000
});
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, service: "treasure-hunt" }));

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const MATCH_MS = 120_000;
const TICK_MS = 50;
const BROADCAST_MS = 50;
const WORLD = { width: 1200, height: 760, margin: 35 };
const MOVE_SPEED = 235; // world units / second
const PLAYER_RADIUS = 19;
const PICKUP_RADIUS = 34;

const rooms = new Map();
const socketToPlayer = new Map();
const names = ["Mango", "Comet", "Pebble", "Sunny", "Sprout", "Bubbles", "Clover", "Pippin"];
const characters = ["🧭", "🦊", "🐸", "🐼", "🦜", "🐢"];
const treasureTemplates = [
  { x: 120, y: 135, points: 10, kind: "common" },
  { x: 315, y: 110, points: 10, kind: "common" },
  { x: 525, y: 170, points: 25, kind: "rare" },
  { x: 770, y: 115, points: 10, kind: "common" },
  { x: 1050, y: 150, points: 10, kind: "common" },
  { x: 180, y: 345, points: 25, kind: "rare" },
  { x: 440, y: 355, points: 10, kind: "common" },
  { x: 710, y: 340, points: 10, kind: "common" },
  { x: 1000, y: 360, points: 25, kind: "rare" },
  { x: 115, y: 600, points: 10, kind: "common" },
  { x: 360, y: 630, points: 10, kind: "common" },
  { x: 620, y: 570, points: 10, kind: "common" },
  { x: 865, y: 630, points: 25, kind: "rare" },
  { x: 1080, y: 600, points: 10, kind: "common" }
];

function cleanName(raw) {
  const value = String(raw || "").replace(/[<>]/g, "").trim().replace(/\s+/g, " ");
  return value.slice(0, 18) || "Explorer";
}
function makeRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}
function randomPosition(index) {
  const spots = [
    [70, 70], [1130, 70], [70, 690], [1130, 690], [600, 70], [600, 690]
  ];
  const [x, y] = spots[index % spots.length];
  return { x, y };
}
function makeTreasures() {
  return treasureTemplates.map((t, i) => ({
    id: `t${i + 1}`, x: t.x, y: t.y, points: t.points, kind: t.kind, collected: false
  }));
}
function createRoom(hostSocketId, hostName, hostCharacter) {
  let id = makeRoomId();
  while (rooms.has(id)) id = makeRoomId();
  const room = {
    id, hostSocketId, status: "lobby", createdAt: Date.now(),
    players: new Map(), treasures: makeTreasures(), startAt: null, endAt: null,
    winnerIds: [], lastTick: Date.now()
  };
  rooms.set(id, room);
  addPlayer(room, hostSocketId, hostName, hostCharacter);
  return room;
}
function addPlayer(room, socketId, rawName, preferredCharacter) {
  const index = room.players.size;
  const takenNames = new Set([...room.players.values()].map(p => p.name.toLowerCase()));
  const takenCharacters = new Set([...room.players.values()].map(p => p.character));
  let name = cleanName(rawName);
  if (takenNames.has(name.toLowerCase())) name = `${name} ${index + 2}`.slice(0, 18);
  const availableCharacters = characters.filter(c => !takenCharacters.has(c));
  const character = availableCharacters.includes(preferredCharacter)
    ? preferredCharacter
    : availableCharacters[index % Math.max(1, availableCharacters.length)] || characters[index % characters.length];
  const player = {
    id: socketId, name, character,
    x: randomPosition(index).x, y: randomPosition(index).y, score: 0,
    input: { up: false, down: false, left: false, right: false },
    connected: true, lastInputAt: Date.now()
  };
  room.players.set(socketId, player);
  socketToPlayer.set(socketId, room.id);
  return player;
}
function publicRoom(room) {
  return {
    id: room.id, status: room.status,
    hostSocketId: room.hostSocketId,
    minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, character: p.character, x: p.x, y: p.y,
      score: p.score, connected: p.connected
    })),
    treasures: room.treasures.filter(t => !t.collected).map(t => ({ ...t })),
    startAt: room.startAt, endAt: room.endAt,
    serverNow: Date.now(), world: WORLD,
    winnerIds: room.winnerIds
  };
}
function emitState(room) {
  io.to(room.id).emit("state", publicRoom(room));
}
function roomForSocket(socket) {
  const roomId = socketToPlayer.get(socket.id);
  return roomId ? rooms.get(roomId) : null;
}
function leaveRoom(socket, intentional = true) {
  const room = roomForSocket(socket);
  if (!room) return;
  room.players.delete(socket.id);
  socketToPlayer.delete(socket.id);
  socket.leave(room.id);
  if (room.players.size === 0) {
    rooms.delete(room.id);
    return;
  }
  if (room.hostSocketId === socket.id) {
    room.hostSocketId = room.players.keys().next().value;
    io.to(room.id).emit("notice", "The host left. Host controls passed to another explorer.");
  }
  if (room.status === "lobby" && room.players.size === 0) rooms.delete(room.id);
  emitState(room);
}
function finishRoom(room) {
  if (room.status !== "playing") return;
  room.status = "finished";
  room.endAt = Date.now();
  const high = Math.max(0, ...[...room.players.values()].map(p => p.score));
  room.winnerIds = [...room.players.values()].filter(p => p.score === high).map(p => p.id);
  io.to(room.id).emit("gameOver", {
    winnerIds: room.winnerIds,
    winners: room.winnerIds.map(id => {
      const p = room.players.get(id);
      return p ? { id, name: p.name, character: p.character, score: p.score } : null;
    }).filter(Boolean),
    rankings: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, character: p.character, score: p.score
    })).sort((a, b) => b.score - a.score),
    endAt: room.endAt
  });
  emitState(room);
}
function startRoom(room, socket) {
  if (room.hostSocketId !== socket.id) return socket.emit("errorMessage", "Only the host can start the match.");
  if (room.status !== "lobby") return socket.emit("errorMessage", "This room has already started.");
  if (room.players.size < MIN_PLAYERS) return socket.emit("errorMessage", "At least 2 players must be in the lobby.");
  room.status = "playing";
  room.startAt = Date.now();
  room.endAt = room.startAt + MATCH_MS;
  room.lastTick = room.startAt;
  room.treasures = makeTreasures();
  io.to(room.id).emit("matchStarted", { startAt: room.startAt, endAt: room.endAt, serverNow: Date.now() });
  emitState(room);
}
function tryCollect(room, player) {
  if (room.status !== "playing") return;
  for (const t of room.treasures) {
    if (t.collected) continue;
    if (Math.hypot(player.x - t.x, player.y - t.y) <= PICKUP_RADIUS + PLAYER_RADIUS) {
      // Synchronous server-side mutation is the atomic winner of a contested treasure.
      if (t.collected) return;
      t.collected = true;
      player.score += t.points;
      io.to(room.id).emit("treasureCollected", {
        treasureId: t.id, playerId: player.id, playerName: player.name,
        points: t.points, score: player.score
      });
    }
  }
}
io.on("connection", socket => {
  socket.emit("connected", { socketId: socket.id });

  // Clock-sync endpoint: clients estimate server/client offset using a round trip.
  socket.on("timeSync", ({ clientSentAt } = {}) => {
    socket.emit("timeSync", {
      clientSentAt: Number(clientSentAt) || Date.now(),
      serverNow: Date.now()
    });
  });

  socket.on("createRoom", ({ name, character } = {}) => {
    if (roomForSocket(socket)) leaveRoom(socket);
    const room = createRoom(socket.id, name, character);
    socket.join(room.id);
    socket.emit("roomCreated", { roomId: room.id, playerId: socket.id });
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, name, character } = {}) => {
    const id = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(id);
    if (!room) return socket.emit("joinError", "Room not found. Ask the host for a fresh invitation link.");
    if (room.status !== "lobby") return socket.emit("joinError", "This match has already started.");
    if (room.players.size >= MAX_PLAYERS) return socket.emit("joinError", "This room is full (maximum 6 players).");
    if (roomForSocket(socket)) leaveRoom(socket);
    addPlayer(room, socket.id, name, character);
    socket.join(room.id);
    socket.emit("joinedRoom", { roomId: room.id, playerId: socket.id });
    io.to(room.id).emit("notice", `${[...room.players.values()].find(p => p.id === socket.id).name} joined the island!`);
    emitState(room);
  });

  socket.on("startGame", () => {
    const room = roomForSocket(socket);
    if (room) startRoom(room, socket);
  });

  socket.on("input", (input = {}) => {
    const room = roomForSocket(socket);
    if (!room || room.status !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p) return;
    for (const key of ["up", "down", "left", "right"]) p.input[key] = Boolean(input[key]);
    p.lastInputAt = Date.now();
  });

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket, false));
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status === "playing") {
      if (now >= room.endAt) {
        finishRoom(room);
        continue;
      }
      const dt = Math.min(0.1, Math.max(0, (now - room.lastTick) / 1000));
      room.lastTick = now;
      for (const p of room.players.values()) {
        if (!p.connected) continue;
        let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
        let dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
        const length = Math.hypot(dx, dy) || 1;
        if (dx || dy) {
          p.x += dx / length * MOVE_SPEED * dt;
          p.y += dy / length * MOVE_SPEED * dt;
          p.x = Math.max(WORLD.margin, Math.min(WORLD.width - WORLD.margin, p.x));
          p.y = Math.max(WORLD.margin, Math.min(WORLD.height - WORLD.margin, p.y));
        }
        tryCollect(room, p);
      }
      emitState(room);
    }
  }
}, TICK_MS);

server.listen(PORT, () => console.log(`Treasure Hunt listening on port ${PORT}`));
