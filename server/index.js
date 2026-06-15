const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// rooms: { roomId: { sender: socketId, receivers: [socketId] } }
const rooms = {};

app.get("/health", (req, res) => res.json({ status: "ok" }));

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  // Sender creates a room
  socket.on("create-room", (callback) => {
    const roomId = crypto.randomBytes(4).toString("hex");
    rooms[roomId] = { sender: socket.id, receivers: [] };
    socket.join(roomId);
    console.log(`Room created: ${roomId} by ${socket.id}`);
    callback({ roomId });
  });

  // Receiver joins a room
  socket.on("join-room", ({ roomId }, callback) => {
    const room = rooms[roomId];
    if (!room) {
      callback({ error: "Room not found" });
      return;
    }
    room.receivers.push(socket.id);
    socket.join(roomId);
    console.log(`${socket.id} joined room ${roomId}`);
    // Notify sender that a receiver is ready to connect
    socket.to(room.sender).emit("receiver-joined", { receiverId: socket.id });
    callback({ ok: true });
  });

  // WebRTC signaling — relay offer/answer/ice between peers
  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    // Clean up rooms where this socket was the sender
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.sender === socket.id) {
        // Notify all receivers the sender left
        socket.to(roomId).emit("sender-left");
        delete rooms[roomId];
      } else {
        const idx = room.receivers.indexOf(socket.id);
        if (idx !== -1) room.receivers.splice(idx, 1);
      }
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));