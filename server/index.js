const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const dotenv = require("dotenv");

dotenv.config();

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || "0.0.0.0";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const allowedOrigins = CLIENT_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAnyOrigin = allowedOrigins.includes("*");

function corsOrigin(origin, callback) {
  // Allow non-browser tools or same-origin requests with no Origin header.
  if (!origin) {
    callback(null, true);
    return;
  }

  if (allowAnyOrigin || allowedOrigins.includes(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Origin ${origin} is not allowed by CORS`));
}

const app = express();
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
  },
});

/**
 * Room shape:
 * roomId => {
 *   password: string | null,
 *   hostId: string,
 *   members: Set<string>
 * }
 */
const rooms = new Map();

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomId(length = 6) {
  let roomId = "";
  for (let i = 0; i < length; i += 1) {
    const randomIndex = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    roomId += ROOM_CODE_ALPHABET[randomIndex];
  }
  return roomId;
}

function createUniqueRoomId() {
  let attempts = 0;

  while (attempts < 10) {
    const roomId = generateRoomId();
    if (!rooms.has(roomId)) {
      return roomId;
    }
    attempts += 1;
  }

  // Very unlikely fallback: use timestamp suffix to guarantee uniqueness.
  return `${generateRoomId(4)}${Date.now().toString().slice(-2)}`;
}

function getOtherMemberId(room, selfId) {
  for (const memberId of room.members) {
    if (memberId !== selfId) {
      return memberId;
    }
  }
  return null;
}

function removeSocketFromRoom(socket) {
  const activeRoomId = socket.data.roomId;
  if (!activeRoomId) return;

  const room = rooms.get(activeRoomId);
  if (!room) return;

  room.members.delete(socket.id);
  socket.leave(activeRoomId);
  socket.data.roomId = null;

  if (room.members.size === 0) {
    rooms.delete(activeRoomId);
    return;
  }

  if (room.hostId === socket.id) {
    const nextHost = room.members.values().next().value;
    room.hostId = nextHost;
  }

  const peerId = getOtherMemberId(room, socket.id);
  if (peerId) {
    io.to(peerId).emit("peer-left", { roomId: activeRoomId });
  }
}

io.on("connection", (socket) => {
  socket.data.roomId = null;

  socket.on("create-room", (payload = {}, callback) => {
    const requestedRoomId = typeof payload.roomId === "string" ? payload.roomId.trim().toUpperCase() : "";
    const roomId = requestedRoomId || createUniqueRoomId();
    const password = typeof payload.password === "string" && payload.password.trim().length > 0
      ? payload.password.trim()
      : null;

    if (rooms.has(roomId)) {
      callback?.({ ok: false, message: "Room already exists. Try another room code." });
      return;
    }

    removeSocketFromRoom(socket);

    const room = {
      password,
      hostId: socket.id,
      members: new Set([socket.id]),
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;

    callback?.({
      ok: true,
      roomId,
      hostId: socket.id,
      requiresPassword: Boolean(password),
    });
  });

  socket.on("join-room", (payload = {}, callback) => {
    const roomId = typeof payload.roomId === "string" ? payload.roomId.trim().toUpperCase() : "";
    const password = typeof payload.password === "string" ? payload.password : "";

    if (!roomId) {
      callback?.({ ok: false, message: "Room ID is required." });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      callback?.({ ok: false, message: "Room not found." });
      return;
    }

    if (room.password && room.password !== password) {
      callback?.({ ok: false, message: "Invalid room password." });
      return;
    }

    if (room.members.size >= 2 && !room.members.has(socket.id)) {
      callback?.({ ok: false, message: "Room is full. Only 2 peers are supported." });
      return;
    }

    removeSocketFromRoom(socket);

    room.members.add(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    const peerId = getOtherMemberId(room, socket.id);

    callback?.({
      ok: true,
      roomId,
      peerId,
      hostId: room.hostId,
      requiresPassword: Boolean(room.password),
    });

    if (peerId) {
      io.to(peerId).emit("peer-joined", {
        roomId,
        peerId: socket.id,
        initiatorId: room.hostId,
      });

      io.to(socket.id).emit("peer-joined", {
        roomId,
        peerId,
        initiatorId: room.hostId,
      });
    }
  });

  socket.on("offer", ({ roomId, target, offer }) => {
    if (!roomId || !target || !offer) return;
    io.to(target).emit("offer", { from: socket.id, roomId, offer });
  });

  socket.on("answer", ({ roomId, target, answer }) => {
    if (!roomId || !target || !answer) return;
    io.to(target).emit("answer", { from: socket.id, roomId, answer });
  });

  socket.on("ice-candidate", ({ roomId, target, candidate }) => {
    if (!roomId || !target || !candidate) return;
    io.to(target).emit("ice-candidate", { from: socket.id, roomId, candidate });
  });

  socket.on("leave-room", (callback) => {
    removeSocketFromRoom(socket);
    callback?.({ ok: true });
  });

  socket.on("disconnect", () => {
    removeSocketFromRoom(socket);
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Signaling server listening on http://${HOST}:${PORT}`);
});
