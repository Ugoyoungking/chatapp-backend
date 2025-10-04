
import express from "express";
import http from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import jwt from "jsonwebtoken";
import Redis from "ioredis";
import multer from "multer";
import path from "path";
import fs from "fs";
import fetch from "node-fetch";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("MongoDB error", err));

// Redis
let redis;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  console.log("✅ Redis connected");
}

// Simple User/Message schema
const UserSchema = new mongoose.Schema({ username: String, password: String });
const MessageSchema = new mongoose.Schema({
  sender: String,
  receiver: String,
  text: String,
  type: { type: String, default: "text" },
  reactions: [String],
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", UserSchema);
const Message = mongoose.model("Message", MessageSchema);

// File upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

app.post("/api/upload", upload.single("file"), (req, res) => {
  res.json({ url: "/uploads/" + req.file.filename });
});

// Auth (basic demo)
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  const existing = await User.findOne({ username });
  if (existing) return res.status(400).json({ error: "User exists" });
  const user = new User({ username, password });
  await user.save();
  res.json({ success: true });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username, password });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user._id, username }, process.env.JWT_SECRET);
  res.json({ token });
});

// Socket.IO
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("message", async (msg) => {
    const newMsg = new Message(msg);
    await newMsg.save();
    io.emit("message", newMsg);

    // If message to UgoAI
    if (msg.receiver === "ugoai") {
      try {
        const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: "You are UgoAI assistant." },
                       { role: "user", content: msg.text }]
          })
        });
        const data = await aiRes.json();
        const reply = {
          sender: "ugoai",
          receiver: msg.sender,
          text: data.choices[0].message.content,
          type: "text",
          createdAt: new Date()
        };
        const m = new Message(reply);
        await m.save();
        io.emit("message", m);
      } catch (err) {
        console.error("AI error", err);
      }
    }
  });

  socket.on("reaction", async ({ messageId, emoji }) => {
    const msg = await Message.findById(messageId);
    if (msg) {
      msg.reactions.push(emoji);
      await msg.save();
      io.emit("reaction", { messageId, emoji });
    }
  });

  socket.on("read", async (messageId) => {
    const msg = await Message.findById(messageId);
    if (msg) {
      msg.read = true;
      await msg.save();
      io.emit("read", { messageId });
    }
  });

  socket.on("delete", async (messageId) => {
    await Message.findByIdAndDelete(messageId);
    io.emit("delete", { messageId });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

server.listen(process.env.PORT, () => {
  console.log("🚀 Server running on port", process.env.PORT);
});
