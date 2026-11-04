const express = require("express");
const http = require("http");
const path = require("path");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const APP_VERSION = require("./package.json").version;
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
  CREATE TABLE IF NOT EXISTS friendships (id INTEGER PRIMARY KEY AUTOINCREMENT, requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', UNIQUE(requester_id,addressee_id));
  CREATE TABLE IF NOT EXISTS dm_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji TEXT NOT NULL, UNIQUE(message_id,user_id,emoji));
  CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS server_members (server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'Member', PRIMARY KEY(server_id,user_id));
`);

// Profile upgrades are additive, so existing databases keep their accounts and messages.
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(column => column.name);
for (const [name, definition] of Object.entries({
  avatar_url: "TEXT NOT NULL DEFAULT ''",
  banner_url: "TEXT NOT NULL DEFAULT ''",
  bio: "TEXT NOT NULL DEFAULT ''",
  status: "TEXT NOT NULL DEFAULT 'En línea'",
  accent: "TEXT NOT NULL DEFAULT '#7778ff'"
})) {
  if (!userColumns.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
}

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
    return db.prepare("SELECT id, username, avatar_url AS avatarUrl, banner_url AS bannerUrl, bio, status, accent FROM users WHERE id = ?").get(payload.id) || null;
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

app.get("/health", (_req, res) => res.json({ ok: true, app: "jesusiniCORD", version: APP_VERSION }));
app.get("/api/version", (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.json({ app: "jesusiniCORD", version: APP_VERSION, status: "online" });
});
// Friends, private messages, reactions and community servers.
app.get("/api/users/search", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 20);
  if (q.length < 2) return res.json([]);
  res.json(db.prepare("SELECT id, username FROM users WHERE username LIKE ? AND id != ? COLLATE NOCASE LIMIT 12").all(`%${q}%`, req.user.id));
});
app.get("/api/friends", requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT f.id, f.status, u.id AS userId, u.username,
    CASE WHEN f.requester_id = ? THEN 'sent' ELSE 'received' END AS direction
    FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
    WHERE f.requester_id = ? OR f.addressee_id = ? ORDER BY f.id DESC`).all(req.user.id, req.user.id, req.user.id, req.user.id);
  res.json(rows);
});
app.post("/api/friends/request", requireAuth, (req, res) => {
  const username = String(req.body?.username || "").trim();
  const target = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!target || target.id === req.user.id) return res.status(404).json({ error: "No se encontró ese usuario." });
  const exists = db.prepare("SELECT * FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)").get(req.user.id,target.id,target.id,req.user.id);
  if (exists) return res.status(409).json({ error: "Ya existe una solicitud o amistad." });
  db.prepare("INSERT INTO friendships (requester_id,addressee_id) VALUES (?,?)").run(req.user.id,target.id);
  res.json({ ok: true });
});
app.post("/api/friends/:id/accept", requireAuth, (req,res) => {
  const result = db.prepare("UPDATE friendships SET status='accepted' WHERE id=? AND addressee_id=? AND status='pending'").run(Number(req.params.id),req.user.id);
  if (!result.changes) return res.status(404).json({error:"Solicitud no encontrada."});
  res.json({ok:true});
});
app.delete("/api/friends/:id", requireAuth, (req,res) => {
  db.prepare("DELETE FROM friendships WHERE id=? AND (requester_id=? OR addressee_id=?)").run(Number(req.params.id),req.user.id,req.user.id); res.json({ok:true});
});
app.get("/api/dm/:userId", requireAuth, (req,res) => {
  const id=Number(req.params.userId);
  const friend=db.prepare("SELECT 1 FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))").get(req.user.id,id,id,req.user.id);
  if(!friend) return res.status(403).json({error:"Primero deben ser amigos."});
  res.json(db.prepare(`SELECT d.id,d.content,d.created_at AS createdAt,d.sender_id AS senderId,u.username
    FROM dm_messages d JOIN users u ON u.id=d.sender_id WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?) ORDER BY d.id DESC LIMIT 100`).all(req.user.id,id,id,req.user.id).reverse());
});
app.post("/api/dm/:userId", requireAuth, (req,res) => {
  const id=Number(req.params.userId), content=String(req.body?.content||'').trim();
  const friend=db.prepare("SELECT 1 FROM friendships WHERE status='accepted' AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))").get(req.user.id,id,id,req.user.id);
  if(!friend) return res.status(403).json({error:"Primero deben ser amigos."});
  if(!content || content.length>2000) return res.status(400).json({error:"Mensaje inválido."});
  const result=db.prepare("INSERT INTO dm_messages (sender_id,receiver_id,content) VALUES (?,?,?)").run(req.user.id,id,content);
  const msg={id:Number(result.lastInsertRowid),senderId:req.user.id,username:req.user.username,content,createdAt:new Date().toISOString()};
  for(const [sid,sock] of io.sockets.sockets) if(sock.user?.id===id) sock.emit("dm:new",msg);
  res.json(msg);
});
app.post("/api/messages/:id/reactions", requireAuth, (req,res) => {
  const messageId=Number(req.params.id), emoji=String(req.body?.emoji||'').slice(0,12);
  if(!db.prepare("SELECT id FROM messages WHERE id=?").get(messageId) || !emoji) return res.status(400).json({error:"Reacción inválida."});
  const found=db.prepare("SELECT id FROM reactions WHERE message_id=? AND user_id=? AND emoji=?").get(messageId,req.user.id,emoji);
  if(found) db.prepare("DELETE FROM reactions WHERE id=?").run(found.id); else db.prepare("INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)").run(messageId,req.user.id,emoji);
  res.json({ok:true});
});
app.get("/api/servers", requireAuth, (req,res)=>res.json(db.prepare(`SELECT s.id,s.name,sm.role FROM servers s JOIN server_members sm ON sm.server_id=s.id WHERE sm.user_id=? ORDER BY s.id`).all(req.user.id)));
app.post("/api/servers", requireAuth, (req,res)=>{
  const name=String(req.body?.name||'').trim().slice(0,32); if(name.length<2) return res.status(400).json({error:"El nombre debe tener al menos 2 caracteres."});
  const r=db.prepare("INSERT INTO servers(name,owner_id) VALUES(?,?)").run(name,req.user.id);
  db.prepare("INSERT INTO server_members(server_id,user_id,role) VALUES(?,?,'Owner')").run(r.lastInsertRowid,req.user.id);
  res.json({id:Number(r.lastInsertRowid),name,role:'Owner'});
});
app.post("/api/servers/:id/join", requireAuth, (req,res)=>{
  const id=Number(req.params.id); if(!db.prepare("SELECT id FROM servers WHERE id=?").get(id)) return res.status(404).json({error:"Servidor no encontrado."});
  db.prepare("INSERT OR IGNORE INTO server_members(server_id,user_id) VALUES(?,?)").run(id,req.user.id); res.json({ok:true});
});
app.post("/api/servers/:id/roles", requireAuth, (req,res)=>{
  const id=Number(req.params.id), username=String(req.body?.username||''), role=String(req.body?.role||'Member').slice(0,24);
  const owner=db.prepare("SELECT owner_id FROM servers WHERE id=?").get(id);
  if(!owner || owner.owner_id!==req.user.id) return res.status(403).json({error:"Solo el dueño puede cambiar roles."});
  const target=db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").get(username); if(!target) return res.status(404).json({error:"Usuario no encontrado."});
  db.prepare("INSERT INTO server_members(server_id,user_id,role) VALUES(?,?,?) ON CONFLICT(server_id,user_id) DO UPDATE SET role=excluded.role").run(id,target.id,role); res.json({ok:true});
});




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
    const user = db.prepare("SELECT id, username, avatar_url AS avatarUrl, banner_url AS bannerUrl, bio, status, accent FROM users WHERE id = ?").get(Number(result.lastInsertRowid));
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
  const user = db.prepare("SELECT id, username, avatar_url AS avatarUrl, banner_url AS bannerUrl, bio, status, accent FROM users WHERE id = ?").get(userRow.id);
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

app.put("/api/profile", requireAuth, (req, res) => {
  const avatarUrl = String(req.body?.avatarUrl || "").trim();
  const bannerUrl = String(req.body?.bannerUrl || "").trim();
  const bio = String(req.body?.bio || "").trim().slice(0, 190);
  const status = String(req.body?.status || "En línea").trim().slice(0, 32);
  const accent = String(req.body?.accent || "#7778ff");
  const validImage = value => !value || (/^https:\/\//i.test(value) && value.length <= 500 && !/[\s"'()\\]/.test(value));
  if (!validImage(avatarUrl) || !validImage(bannerUrl)) return res.status(400).json({ error: "Las imágenes deben usar una URL HTTPS válida." });
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) return res.status(400).json({ error: "Color no válido." });
  db.prepare("UPDATE users SET avatar_url=?, banner_url=?, bio=?, status=?, accent=? WHERE id=?")
    .run(avatarUrl, bannerUrl, bio, status || "En línea", accent, req.user.id);
  const user = db.prepare("SELECT id, username, avatar_url AS avatarUrl, banner_url AS bannerUrl, bio, status, accent FROM users WHERE id=?").get(req.user.id);
  res.json({ user });
});

app.get("/api/users/:username", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, username, avatar_url AS avatarUrl, banner_url AS bannerUrl, bio, status, accent, created_at AS createdAt FROM users WHERE username=? COLLATE NOCASE").get(req.params.username);
  if (!user) return res.status(404).json({ error: "Usuario no encontrado." });
  res.json(user);
});

app.get("/api/channels", requireAuth, (_req, res) => {
  res.json(db.prepare("SELECT id, name, description FROM channels ORDER BY id").all());
});

app.get("/api/messages/:channelId", requireAuth, (req, res) => {
  const channelId = Number(req.params.channelId);
  if (!Number.isInteger(channelId)) return res.status(400).json({ error: "Canal inválido." });
  const messages = db.prepare(`
    SELECT messages.id, messages.content, messages.created_at AS createdAt,
           users.id AS userId, users.username, users.avatar_url AS avatarUrl
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
  onlineUsers.set(socket.user.id, { id: socket.user.id, username: socket.user.username, avatarUrl: socket.user.avatarUrl, status: socket.user.status });
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
      avatarUrl: socket.user.avatarUrl,
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

let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received. Closing jesusiniCORD gracefully...`);
  io.emit("server:shutdown", { message: "El servidor se está reiniciando para aplicar una actualización." });
  setTimeout(() => {
    io.close(() => {
      try { db.close(); } catch (error) { console.error("Database close error:", error); }
      if (server.listening) server.close(() => process.exit(0));
      else process.exit(0);
    });
  }, 350);
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`jesusiniCORD v${APP_VERSION} listening on ${PORT}; database: ${DB_PATH}`);
});
