const $ = (id) => document.getElementById(id);
let mode = "login";
let currentUser = null;
let channels = [];
let currentChannelId = null;
let socket = null;
let loadedAppVersion = null;
let updateCheckTimer = null;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

function showConnectionNotice(message, connected = false) {
  const notice = $("connectionNotice");
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle("connected", connected);
  notice.classList.remove("hidden");
  const statusText = connected ? "● Conectado" : (message.startsWith("Sin conexión") ? "● Offline" : "● Reconectando");
  const secureLabel = document.querySelector(".secure-label");
  const onlineDot = document.querySelector(".online-dot");
  if (secureLabel) secureLabel.textContent = statusText;
  if (onlineDot) onlineDot.textContent = statusText;
  if (connected) setTimeout(() => notice.classList.add("hidden"), 2200);
}

async function checkForUpdates() {
  try {
    const response = await fetch(`/api/version?_=${Date.now()}`, {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error("Servidor no disponible");
    const info = await response.json();
    if (!loadedAppVersion) {
      loadedAppVersion = info.version;
      return;
    }
    if (info.version && info.version !== loadedAppVersion) {
      $("updateMessage").textContent = `¡jesusiniCORD ${info.version} está disponible! Actualiza para aplicar los cambios.`;
      $("updateNotice").classList.remove("hidden");
    }
  } catch {
    // A short outage during a Render deploy is normal; the connection notice handles it.
  }
}

function startUpdateChecks() {
  checkForUpdates();
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  updateCheckTimer = setInterval(checkForUpdates, 45000);
}

$("applyUpdate")?.addEventListener("click", () => location.reload());
$("dismissUpdate")?.addEventListener("click", () => $("updateNotice").classList.add("hidden"));
window.addEventListener("online", () => {
  showConnectionNotice("Internet recuperado. Reconectando...", false);
  checkForUpdates();
});
window.addEventListener("offline", () => showConnectionNotice("Sin conexión a Internet. Comprueba tu red.", false));
window.addEventListener("pagehide", () => {
  if (socket) socket.disconnect();
});
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
function paintAvatar(element, url, username) {
  element.replaceChildren();
  if (url) {
    const image = document.createElement("img"); image.src = url; image.alt = `Avatar de ${username}`;
    image.onerror = () => { element.textContent = initials(username); };
    element.append(image);
  } else element.textContent = initials(username);
}
function openProfile() {
  $("profileAvatar").value = currentUser.avatarUrl || "";
  $("profileBanner").value = currentUser.bannerUrl || "";
  $("profileBio").value = currentUser.bio || "";
  $("profileStatus").value = currentUser.status || "En línea";
  $("profileAccent").value = currentUser.accent || "#7778ff";
  updateProfilePreview();
  $("profileModal").classList.remove("hidden");
}
function updateProfilePreview() {
  const avatar = $("profileAvatar").value.trim();
  const banner = $("profileBanner").value.trim();
  const preview = $("profilePreviewAvatar");
  paintAvatar(preview, avatar, currentUser.username);
  $("profilePreviewBanner").style.backgroundImage = banner ? `linear-gradient(#0003,#0003),url("${banner.replace(/["\\]/g, "")}")` : "linear-gradient(120deg,#555ee7,#1c2b58)";
}
function closeProfile() { $("profileModal").classList.add("hidden"); }

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
  paintAvatar($("myAvatar"), user.avatarUrl, user.username);
  paintAvatar($("railAvatar"), user.avatarUrl, user.username);
  document.documentElement.style.setProperty("--profile-accent", user.accent || "#7778ff");
  $("myName").title = user.status || "En línea";
  $("addChannel").classList.toggle("hidden", !isAdmin);
  await loadChannels();
  await refreshSocial();
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
  const avatar = document.createElement("div"); avatar.className = "message-avatar"; paintAvatar(avatar, message.avatarUrl, message.username);
  const body = document.createElement("div"); body.className = "message-body";
  const top = document.createElement("div"); top.className = "message-top";
  const name = document.createElement("span"); name.className = "message-name"; name.textContent = message.username;
  const time = document.createElement("span"); time.className = "message-time";
  const date = new Date(message.createdAt);
  time.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const content = document.createElement("div"); content.className = "message-content"; content.textContent = message.content;
  const tools=document.createElement("div");tools.className="message-tools";
  ["👍","❤️","😂","🔥"].forEach(emoji=>{const b=document.createElement("button");b.className="reaction";b.textContent=emoji;b.title="Reaccionar";b.addEventListener("click",async()=>{try{await api(`/api/messages/${message.id}/reactions`,{method:"POST",body:JSON.stringify({emoji})});b.classList.toggle("active")}catch(e){toast(e.message)}});tools.append(b)});
  top.append(name, time); body.append(top, content, tools); row.append(avatar, body); container.append(row);
  container.scrollTop = container.scrollHeight;
}
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io();
  socket.on("connect", () => {
    if (currentChannelId) socket.emit("channel:join", currentChannelId);
    showConnectionNotice("Conexión restablecida. ¡Ya estás en línea!", true);
  });
  socket.on("disconnect", (reason) => {
    if (reason !== "io client disconnect") showConnectionNotice("Conexión perdida. Intentando reconectar automáticamente...", false);
  });
  socket.on("connect_error", () => showConnectionNotice("No se pudo conectar con el servidor. Reintentando...", false));
  socket.on("server:shutdown", (info) => {
    showConnectionNotice(info?.message || "El servidor se está reiniciando. Volveremos a conectar automáticamente.", false);
  });
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
      const avatar = document.createElement("div"); avatar.className = "member-avatar"; paintAvatar(avatar, user.avatarUrl, user.username);
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
async function refreshSocial(){try{const [friends,servers]=await Promise.all([api("/api/friends"),api("/api/servers")]);const fl=$("friendsList");fl.replaceChildren();friends.forEach(f=>{const b=document.createElement("button");b.className="friend-entry";b.textContent=(f.status==="pending"?(f.direction==="received"?"📨 ":"⏳ "):"● ")+f.username;b.addEventListener("click",async()=>{if(f.status==="pending"&&f.direction==="received"){try{await api(`/api/friends/${f.id}/accept`,{method:"POST"});toast("Solicitud aceptada");refreshSocial()}catch(e){toast(e.message)}}else if(f.status==="accepted")openDM(f.userId,f.username)});fl.append(b)});const sl=$("serverList");sl.replaceChildren();servers.forEach(s=>{const d=document.createElement("div");d.className="friend-entry";d.textContent=`✦ ${s.name} · ${s.role}`;sl.append(d)})}catch(e){console.error(e)}}
async function openDM(id,username){try{const msgs=await api(`/api/dm/${id}`);const transcript=msgs.map(m=>`${m.username}: ${m.content}`).join("\n")||"(Sin mensajes)";const content=prompt(`MD con ${username}\n\n${transcript}\n\nEscribe un mensaje nuevo:`);if(content?.trim()){await api(`/api/dm/${id}`,{method:"POST",body:JSON.stringify({content})});toast("Mensaje privado enviado")}}catch(e){toast(e.message)}}
$("addFriend").addEventListener("click",async()=>{const username=prompt("Nombre exacto del usuario:");if(!username)return;try{await api("/api/friends/request",{method:"POST",body:JSON.stringify({username})});toast("Solicitud enviada");refreshSocial()}catch(e){toast(e.message)}});
$("openFriends").addEventListener("click",()=>{refreshSocial();toast("Selecciona un amigo de la lista para abrir un MD")});
$("createServer").addEventListener("click",async()=>{const name=prompt("Nombre del servidor:");if(!name)return;try{const s=await api("/api/servers",{method:"POST",body:JSON.stringify({name})});toast(`Servidor ${s.name} creado`);refreshSocial()}catch(e){toast(e.message)}});
$("manageRole").addEventListener("click",async()=>{const servers=await api("/api/servers");const owned=servers.find(s=>s.role==="Owner");if(!owned)return toast("Primero crea un servidor.");const username=prompt("Usuario:");if(!username)return;const role=prompt("Rol (Admin, Moderador, VIP, Member):","Member");if(!role)return;try{await api(`/api/servers/${owned.id}/roles`,{method:"POST",body:JSON.stringify({username,role})});toast("Rol actualizado")}catch(e){toast(e.message)}});
$("railAdd").addEventListener("click",()=>$("createServer").click());

$("editProfile").addEventListener("click", openProfile);
$("closeProfile").addEventListener("click", closeProfile);
$("cancelProfile").addEventListener("click", closeProfile);
$("profileAvatar").addEventListener("input", updateProfilePreview);
$("profileBanner").addEventListener("input", updateProfilePreview);
$("profileForm").addEventListener("submit", async event => {
  event.preventDefault();
  const payload = {
    avatarUrl: $("profileAvatar").value.trim(), bannerUrl: $("profileBanner").value.trim(),
    bio: $("profileBio").value, status: $("profileStatus").value, accent: $("profileAccent").value
  };
  try {
    const data = await api("/api/profile", { method: "PUT", body: JSON.stringify(payload) });
    currentUser = data.user;
    paintAvatar($("myAvatar"), currentUser.avatarUrl, currentUser.username);
    paintAvatar($("railAvatar"), currentUser.avatarUrl, currentUser.username);
    document.documentElement.style.setProperty("--profile-accent", currentUser.accent);
    $("myName").title = currentUser.status;
    closeProfile(); toast("¡Perfil actualizado!");
  } catch (err) { toast(err.message); }
});
$("profileModal").addEventListener("click", event => { if (event.target === $("profileModal")) closeProfile(); });

startUpdateChecks();

(async function boot() {
  try {
    const data = await api("/api/me");
    await enterApp(data.user, data.isAdmin);
  } catch {
    $("authView").classList.remove("hidden");
    $("appView").classList.add("hidden");
  }
})();
