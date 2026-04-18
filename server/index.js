const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const dotenv = require("dotenv");

dotenv.config();

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || "0.0.0.0";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const REDIS_URL = process.env.REDIS_URL || "";
const ROOM_TTL_SECONDS = Number(process.env.ROOM_TTL_SECONDS || 3600);

const allowedOrigins = CLIENT_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAnyOrigin = allowedOrigins.includes("*");

function corsOrigin(origin, callback) {
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
  res.json({ status: "ok", redis: Boolean(REDIS_URL) });
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
  },
});

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomId(length = 6) {
  let roomId = "";
  for (let i = 0; i < length; i += 1) {
    const randomIndex = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    roomId += ROOM_CODE_ALPHABET[randomIndex];
  }
  return roomId;
}

class MemoryRoomStore {
  constructor() {
    this.rooms = new Map();
  }

  async hasRoom(roomId) {
    return this.rooms.has(roomId);
  }

  async createRoom(roomId, password, hostId) {
    if (this.rooms.has(roomId)) return false;

    this.rooms.set(roomId, {
      password,
      hostId,
      members: new Set([hostId]),
      expiresAt: Date.now() + ROOM_TTL_SECONDS * 1000,
    });

    return true;
  }

  async getRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    if (room.expiresAt < Date.now()) {
      this.rooms.delete(roomId);
      return null;
    }

    return {
      roomId,
      password: room.password,
      hostId: room.hostId,
      members: Array.from(room.members),
    };
  }

  async addMember(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.members.add(socketId);
    room.expiresAt = Date.now() + ROOM_TTL_SECONDS * 1000;
    return this.getRoom(roomId);
  }

  async removeMember(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.members.delete(socketId);

    if (room.members.size === 0) {
      this.rooms.delete(roomId);
      return { deleted: true, room: null, nextHost: null };
    }

    let nextHost = room.hostId;
    if (room.hostId === socketId) {
      nextHost = room.members.values().next().value;
      room.hostId = nextHost;
    }

    room.expiresAt = Date.now() + ROOM_TTL_SECONDS * 1000;
    return { deleted: false, room: await this.getRoom(roomId), nextHost };
  }
}

class RedisRoomStore {
  constructor(client) {
    this.client = client;
  }

  roomKey(roomId) {
    return `room:${roomId}`;
  }

  membersKey(roomId) {
    return `room:${roomId}:members`;
  }

  async hasRoom(roomId) {
    const exists = await this.client.exists(this.roomKey(roomId));
    return exists === 1;
  }

  async createRoom(roomId, password, hostId) {
    const roomKey = this.roomKey(roomId);
    const membersKey = this.membersKey(roomId);

    const setResult = await this.client.hSetNX(roomKey, "hostId", hostId);
    if (!setResult) return false;

    await this.client.hSet(roomKey, {
      password: password || "",
    });

    await this.client.sAdd(membersKey, hostId);
    await this.client.expire(roomKey, ROOM_TTL_SECONDS);
    await this.client.expire(membersKey, ROOM_TTL_SECONDS);

    return true;
  }

  async getRoom(roomId) {
    const roomKey = this.roomKey(roomId);
    const membersKey = this.membersKey(roomId);

    const [room, members] = await Promise.all([
      this.client.hGetAll(roomKey),
      this.client.sMembers(membersKey),
    ]);

    if (!room || !room.hostId) return null;

    return {
      roomId,
      password: room.password || null,
      hostId: room.hostId,
      members,
    };
  }

  async addMember(roomId, socketId) {
    const roomKey = this.roomKey(roomId);
    const membersKey = this.membersKey(roomId);

    const exists = await this.client.exists(roomKey);
    if (!exists) return null;

    await this.client.sAdd(membersKey, socketId);
    await this.client.expire(roomKey, ROOM_TTL_SECONDS);
    await this.client.expire(membersKey, ROOM_TTL_SECONDS);

    return this.getRoom(roomId);
  }

  async removeMember(roomId, socketId) {
    const roomKey = this.roomKey(roomId);
    const membersKey = this.membersKey(roomId);

    const exists = await this.client.exists(roomKey);
    if (!exists) return null;

    await this.client.sRem(membersKey, socketId);

    const members = await this.client.sMembers(membersKey);

    if (members.length === 0) {
      await this.client.del(roomKey, membersKey);
      return { deleted: true, room: null, nextHost: null };
    }

    const room = await this.client.hGetAll(roomKey);
    let nextHost = room.hostId;

    if (room.hostId === socketId) {
      nextHost = members[0];
      await this.client.hSet(roomKey, { hostId: nextHost });
    }

    await this.client.expire(roomKey, ROOM_TTL_SECONDS);
    await this.client.expire(membersKey, ROOM_TTL_SECONDS);

    return { deleted: false, room: await this.getRoom(roomId), nextHost };
  }
}

function getOtherMemberId(room, selfId) {
  for (const memberId of room.members) {
    if (memberId !== selfId) {
      return memberId;
    }
  }
  return null;
}

async function createUniqueRoomId(roomStore) {
  let attempts = 0;

  while (attempts < 10) {
    const roomId = generateRoomId();
    const exists = await roomStore.hasRoom(roomId);
    if (!exists) {
      return roomId;
    }
    attempts += 1;
  }

  return `${generateRoomId(4)}${Date.now().toString().slice(-2)}`;
}

let roomStore = new MemoryRoomStore();

async function setupRedisIfConfigured() {
  if (!REDIS_URL) {
    console.log("REDIS_URL not set. Using in-memory room store (single instance only).");
    return;
  }

  const pubClient = createClient({ url: REDIS_URL });
  const subClient = pubClient.duplicate();

  pubClient.on("error", (error) => {
    console.error("Redis pub client error:", error.message);
  });

  subClient.on("error", (error) => {
    console.error("Redis sub client error:", error.message);
  });

  await Promise.all([pubClient.connect(), subClient.connect()]);

  io.adapter(createAdapter(pubClient, subClient));
  roomStore = new RedisRoomStore(pubClient);

  console.log("Redis adapter enabled for multi-instance signaling.");
}

async function removeSocketFromRoom(socket) {
  const activeRoomId = socket.data.roomId;
  if (!activeRoomId) return;

  const removal = await roomStore.removeMember(activeRoomId, socket.id);

  socket.leave(activeRoomId);
  socket.data.roomId = null;

  if (!removal || removal.deleted || !removal.room) {
    return;
  }

  const peerId = getOtherMemberId(removal.room, socket.id);
  if (peerId) {
    io.to(peerId).emit("peer-left", { roomId: activeRoomId });
  }
}

io.on("connection", (socket) => {
  socket.data.roomId = null;

  socket.on("create-room", async (payload = {}, callback) => {
    try {
      const requestedRoomId = typeof payload.roomId === "string" ? payload.roomId.trim().toUpperCase() : "";
      const roomId = requestedRoomId || (await createUniqueRoomId(roomStore));
      const password = typeof payload.password === "string" && payload.password.trim().length > 0
        ? payload.password.trim()
        : null;

      const alreadyExists = await roomStore.hasRoom(roomId);
      if (alreadyExists) {
        callback?.({ ok: false, message: "Room already exists. Try another room code." });
        return;
      }

      await removeSocketFromRoom(socket);

      const created = await roomStore.createRoom(roomId, password, socket.id);
      if (!created) {
        callback?.({ ok: false, message: "Room already exists. Try another room code." });
        return;
      }

      socket.join(roomId);
      socket.data.roomId = roomId;

      callback?.({
        ok: true,
        roomId,
        hostId: socket.id,
        requiresPassword: Boolean(password),
      });
    } catch (error) {
      callback?.({ ok: false, message: "Could not create room." });
      console.error("create-room error:", error);
    }
  });

  socket.on("join-room", async (payload = {}, callback) => {
    try {
      const roomId = typeof payload.roomId === "string" ? payload.roomId.trim().toUpperCase() : "";
      const password = typeof payload.password === "string" ? payload.password : "";

      if (!roomId) {
        callback?.({ ok: false, message: "Room ID is required." });
        return;
      }

      const room = await roomStore.getRoom(roomId);
      if (!room) {
        callback?.({ ok: false, message: "Room not found." });
        return;
      }

      if (room.password && room.password !== password) {
        callback?.({ ok: false, message: "Invalid room password." });
        return;
      }

      if (room.members.length >= 2 && !room.members.includes(socket.id)) {
        callback?.({ ok: false, message: "Room is full. Only 2 peers are supported." });
        return;
      }

      // If this same socket is already in the target room, treat it as a no-op join.
      if (socket.data.roomId === roomId && room.members.includes(socket.id)) {
        const peerId = getOtherMemberId(room, socket.id);
        callback?.({
          ok: true,
          roomId,
          peerId,
          hostId: room.hostId,
          requiresPassword: Boolean(room.password),
        });
        return;
      }

      await removeSocketFromRoom(socket);

      const updatedRoom = await roomStore.addMember(roomId, socket.id);
      if (!updatedRoom) {
        callback?.({ ok: false, message: "Room not found." });
        return;
      }

      socket.join(roomId);
      socket.data.roomId = roomId;

      const peerId = getOtherMemberId(updatedRoom, socket.id);

      callback?.({
        ok: true,
        roomId,
        peerId,
        hostId: updatedRoom.hostId,
        requiresPassword: Boolean(updatedRoom.password),
      });

      if (peerId) {
        io.to(peerId).emit("peer-joined", {
          roomId,
          peerId: socket.id,
          initiatorId: updatedRoom.hostId,
        });

        io.to(socket.id).emit("peer-joined", {
          roomId,
          peerId,
          initiatorId: updatedRoom.hostId,
        });
      }
    } catch (error) {
      callback?.({ ok: false, message: "Could not join room." });
      console.error("join-room error:", error);
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

  socket.on("leave-room", async (callback) => {
    try {
      await removeSocketFromRoom(socket);
      callback?.({ ok: true });
    } catch {
      callback?.({ ok: false });
    }
  });

  socket.on("disconnect", async () => {
    try {
      await removeSocketFromRoom(socket);
    } catch (error) {
      console.error("disconnect cleanup error:", error);
    }
  });
});

(async () => {
  try {
    await setupRedisIfConfigured();

    httpServer.listen(PORT, HOST, () => {
      console.log(`Signaling server listening on http://${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
})();
