const express = require("express");
const http = require("http");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-before-production";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "jesusinicord.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const channelCount = db.prepare("SELECT COUNT(*) AS count FROM channels").get().count;
if (!channelCount) {
  const add = db.prepare("INSERT INTO channels (name, description) VALUES (?, ?)");
  add.run("general", "Chat with everyone");
  add.run("memes", "Memes and funny stuff");
  add.run("gaming", "Games, clips and updates");
  add.run("music", "Share what you're listening to");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e5
});

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

function makeToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}
function setAuthCookie(res, token) {
  res.cookie("jc_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}
function getUserFromToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return db.prepare("SELECT id, username FROM users WHERE id = ?").get(payload.id) || null;
  } catch {
    return null;
  }
}
function requireAuth(req, res, next) {
  const token = req.cookiesToken || (req.headers.cookie ? cookie.parse(req.headers.cookie).jc_token : null);
  const user = token && getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Inicia sesión para continuar." });
  req.user = user;
  next();
}
function validUsername(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(value);
}

app.get("/health", (_req, res) => res.json({ ok: true, app: "jesusiniCORD" }));

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) {
    return res.status(400).json({ error: "El usuario debe tener 3-20 caracteres: letras, números o _." });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: "La contraseña debe tener entre 8 y 72 caracteres." });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(username, hash);
    const user = { id: Number(result.lastInsertRowid), username };
    setAuthCookie(res, makeToken(user));
    res.json({ user, isAdmin: user.id === 1 });
  } catch (err) {
    if (String(err.code).includes("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "Ese nombre de usuario ya existe." });
    console.error(err);
    res.status(500).json({ error: "No se pudo crear la cuenta." });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") return res.status(400).json({ error: "Completa usuario y contraseña." });
  const userRow = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!userRow || !(await bcrypt.compare(password, userRow.password_hash))) {
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  }
  const user = { id: userRow.id, username: userRow.username };
  setAuthCookie(res, makeToken(user));
  res.json({ user, isAdmin: user.id === 1 });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie("jc_token", { path: "/", sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const token = req.headers.cookie ? cookie.parse(req.headers.cookie).jc_token : null;
  const user = token && getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "No has iniciado sesión." });
  res.json({ user, isAdmin: user.id === 1 });
});

app.get("/api/channels", requireAuth, (_req, res) => {
  res.json(db.prepare("SELECT id, name, description FROM channels ORDER BY id").all());
});

app.get("/api/messages/:channelId", requireAuth, (req, res) => {
  const channelId = Number(req.params.channelId);
  if (!Number.isInteger(channelId)) return res.status(400).json({ error: "Canal inválido." });
  const messages = db.prepare(`
    SELECT messages.id, messages.content, messages.created_at AS createdAt,
           users.id AS userId, users.username
    FROM messages JOIN users ON users.id = messages.user_id
    WHERE messages.channel_id = ?
    ORDER BY messages.id DESC LIMIT 80
  `).all(channelId).reverse();
  res.json(messages);
});

app.post("/api/channels", requireAuth, (req, res) => {
  if (req.user.id !== 1) return res.status(403).json({ error: "Solo el primer usuario registrado puede crear canales." });
  const name = String(req.body?.name || "").toLowerCase().trim();
  const description = String(req.body?.description || "").trim().slice(0, 80);
  if (!/^[a-z0-9-]{2,24}$/.test(name)) return res.status(400).json({ error: "Usa 2-24 caracteres: letras minúsculas, números o guiones." });
  try {
    const result = db.prepare("INSERT INTO channels (name, description) VALUES (?, ?)").run(name, description);
    const channel = { id: Number(result.lastInsertRowid), name, description };
    io.emit("channel:new", channel);
    res.json(channel);
  } catch {
    res.status(409).json({ error: "Ese canal ya existe." });
  }
});

const onlineUsers = new Map();
io.use((socket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || "");
  const user = cookies.jc_token && getUserFromToken(cookies.jc_token);
  if (!user) return next(new Error("No autorizado"));
  socket.user = user;
  next();
});

io.on("connection", (socket) => {
  onlineUsers.set(socket.user.id, { id: socket.user.id, username: socket.user.username });
  io.emit("presence:update", [...onlineUsers.values()]);

  socket.on("channel:join", (channelId) => {
    const id = Number(channelId);
    if (!Number.isInteger(id) || !db.prepare("SELECT id FROM channels WHERE id = ?").get(id)) return;
    for (const room of socket.rooms) if (room.startsWith("channel:")) socket.leave(room);
    socket.join(`channel:${id}`);
  });

  let lastMessageAt = 0;
  socket.on("message:send", (payload, callback) => {
    const now = Date.now();
    if (now - lastMessageAt < 650) {
      if (typeof callback === "function") callback({ error: "Espera un momento antes de enviar otro mensaje." });
      return;
    }
    lastMessageAt = now;
    const channelId = Number(payload?.channelId);
    const content = typeof payload?.content === "string" ? payload.content.trim() : "";
    if (!Number.isInteger(channelId) || !db.prepare("SELECT id FROM channels WHERE id = ?").get(channelId)) {
      if (typeof callback === "function") callback({ error: "Canal inválido." });
      return;
    }
    if (!content || content.length > 2000) {
      if (typeof callback === "function") callback({ error: "El mensaje debe tener entre 1 y 2000 caracteres." });
      return;
    }
    const result = db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)").run(channelId, socket.user.id, content);
    const message = {
      id: Number(result.lastInsertRowid),
      channelId,
      userId: socket.user.id,
      username: socket.user.username,
      content,
      createdAt: new Date().toISOString()
    };
    io.to(`channel:${channelId}`).emit("message:new", message);
    if (typeof callback === "function") callback({ ok: true });
  });

  socket.on("disconnect", () => {
    const stillConnected = [...io.sockets.sockets.values()].some(s => s.user && s.user.id === socket.user.id);
    if (!stillConnected) onlineUsers.delete(socket.user.id);
    io.emit("presence:update", [...onlineUsers.values()]);
  });
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`jesusiniCORD listening on ${PORT}; database: ${DB_PATH}`);
});
