const $ = (id) => document.getElementById(id);
let mode = "login";
let currentUser = null;
let channels = [];
let currentChannelId = null;
let socket = null;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Ocurrió un error.");
  return data;
}
function initials(name) { return (name || "?").slice(0, 2).toUpperCase(); }
function setMode(next) {
  mode = next;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  $("authSubmit").textContent = mode === "login" ? "Entrar" : "Crear cuenta";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("authError").textContent = "";
}
document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));

$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("authError").textContent = "";
  const username = $("username").value.trim();
  const password = $("password").value;
  $("authSubmit").disabled = true;
  try {
    const data = await api(`/api/${mode}`, { method: "POST", body: JSON.stringify({ username, password }) });
    await enterApp(data.user, data.isAdmin);
  } catch (err) {
    $("authError").textContent = err.message;
  } finally {
    $("authSubmit").disabled = false;
  }
});

async function enterApp(user, isAdmin) {
  currentUser = user;
  $("authView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("myName").textContent = user.username;
  $("myAvatar").textContent = initials(user.username);
  $("railAvatar").textContent = initials(user.username);
  $("addChannel").classList.toggle("hidden", !isAdmin);
  await loadChannels();
  connectSocket();
}
async function loadChannels() {
  channels = await api("/api/channels");
  renderChannels();
  if (!currentChannelId || !channels.some(c => c.id === currentChannelId)) {
    if (channels[0]) await selectChannel(channels[0].id);
  }
}
function renderChannels() {
  const list = $("channelList");
  list.replaceChildren();
  channels.forEach(channel => {
    const button = document.createElement("button");
    button.className = "channel" + (channel.id === currentChannelId ? " active" : "");
    const hash = document.createElement("span");
    hash.className = "hash"; hash.textContent = "#";
    const name = document.createElement("span"); name.textContent = channel.name;
    button.append(hash, name);
    button.addEventListener("click", () => selectChannel(channel.id));
    list.append(button);
  });
}
async function selectChannel(id) {
  currentChannelId = id;
  const channel = channels.find(c => c.id === id);
  if (!channel) return;
  $("currentChannel").textContent = channel.name;
  $("channelTopic").textContent = channel.description || "Chat with everyone!";
  $("messageInput").placeholder = `Mensaje #${channel.name}...`;
  renderChannels();
  const messages = await api(`/api/messages/${id}`);
  renderMessages(messages);
  if (socket?.connected) socket.emit("channel:join", id);
}
function renderMessages(messages) {
  const container = $("messages");
  container.replaceChildren();
  if (!messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    const logo = document.createElement("div"); logo.className = "welcome-logo"; logo.textContent = "jc";
    const title = document.createElement("h2"); title.textContent = `¡Bienvenido a #${$("currentChannel").textContent}!`;
    const desc = document.createElement("p"); desc.textContent = "Este es el comienzo de este canal. ¡Di hola! 👋";
    welcome.append(logo, title, desc); container.append(welcome); return;
  }
  messages.forEach(message => appendMessage(message));
  container.scrollTop = container.scrollHeight;
}
function appendMessage(message) {
  const container = $("messages");
  const row = document.createElement("article"); row.className = "message";
  const avatar = document.createElement("div"); avatar.className = "message-avatar"; avatar.textContent = initials(message.username);
  const body = document.createElement("div"); body.className = "message-body";
  const top = document.createElement("div"); top.className = "message-top";
  const name = document.createElement("span"); name.className = "message-name"; name.textContent = message.username;
  const time = document.createElement("span"); time.className = "message-time";
  const date = new Date(message.createdAt);
  time.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const content = document.createElement("div"); content.className = "message-content"; content.textContent = message.content;
  top.append(name, time); body.append(top, content); row.append(avatar, body); container.append(row);
  container.scrollTop = container.scrollHeight;
}
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io();
  socket.on("connect", () => { if (currentChannelId) socket.emit("channel:join", currentChannelId); });
  socket.on("connect_error", () => toast("Se perdió la conexión. Recarga la página para volver a entrar."));
  socket.on("message:new", message => {
    if (message.channelId === currentChannelId) appendMessage(message);
  });
  socket.on("channel:new", channel => {
    if (!channels.some(c => c.id === channel.id)) {
      channels.push(channel); renderChannels(); toast(`Nuevo canal #${channel.name}`);
    }
  });
  socket.on("presence:update", users => {
    $("onlineCount").textContent = users.length;
    const list = $("memberList"); list.replaceChildren();
    users.sort((a,b) => a.username.localeCompare(b.username)).forEach(user => {
      const row = document.createElement("div"); row.className = "member";
      const avatar = document.createElement("div"); avatar.className = "member-avatar"; avatar.textContent = initials(user.username);
      const name = document.createElement("span"); name.textContent = user.username;
      const dot = document.createElement("span"); dot.className = "member-dot";
      row.append(avatar, name, dot); list.append(row);
    });
  });
}
$("messageForm").addEventListener("submit", event => {
  event.preventDefault();
  const content = $("messageInput").value.trim();
  if (!content || !socket?.connected || !currentChannelId) return;
  socket.emit("message:send", { channelId: currentChannelId, content }, result => {
    if (result?.error) toast(result.error);
    else $("messageInput").value = "";
  });
});
$("messageInput").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault(); $("messageForm").requestSubmit();
  }
});
$("logout").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  socket?.disconnect(); location.reload();
});
$("addChannel").addEventListener("click", async () => {
  const name = prompt("Nombre del nuevo canal (ejemplo: clips):");
  if (!name) return;
  const description = prompt("Descripción breve (opcional):") || "";
  try {
    const channel = await api("/api/channels", { method: "POST", body: JSON.stringify({ name, description }) });
    if (!channels.some(c => c.id === channel.id)) channels.push(channel);
    renderChannels(); await selectChannel(channel.id);
  } catch (err) { toast(err.message); }
});
$("railAdd").addEventListener("click", () => toast("¡Próximamente: más servidores!"));

(async function boot() {
  try {
    const data = await api("/api/me");
    await enterApp(data.user, data.isAdmin);
  } catch {
    $("authView").classList.remove("hidden");
    $("appView").classList.add("hidden");
  }
})();
