"use strict";

// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const svg = (paths) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.innerHTML = paths;
  return node;
};
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" />',
  x: '<path d="M6 6l12 12M18 6L6 18" />',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M12 8v4M12 16h.01" />',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />',
  more: '<circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" />',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z" />',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11h14V8M10 12h4" />',
};

let toastTimer;
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 3500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("Sign in first.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function renderMarkdown(text) {
  if (!window.marked || !window.DOMPurify) return null;
  const html = window.marked.parse(text, { gfm: true, breaks: true });
  return window.DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

// ---------- theme ----------
const THEMES = ["system", "light", "dark"];
function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("#theme-label").textContent = `Theme: ${theme}`;
}
function currentTheme() {
  try {
    return localStorage.getItem("mina-theme") || "system";
  } catch {
    return "system";
  }
}
$("#theme-toggle").addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  try {
    localStorage.setItem("mina-theme", next);
  } catch {}
  applyTheme(next);
});
applyTheme(currentTheme());

// ---------- state ----------
const state = {
  sessions: [],
  currentId: null,
  busy: false, // a turn is streaming
  streamAbort: null,
  turn: null, // the current Mina turn element
  blocks: new Map(), // text event id -> { node, text }
  tools: new Map(), // tool event id -> step/approval element
  pending: new Set(), // tool ids waiting for approval
  renderQueued: new Set(),
};

// ---------- sign-in ----------
function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#password").focus();
}
function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("#password").value } });
    $("#password").value = "";
    await boot();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  location.reload();
});

// ---------- sidebar ----------
function groupFor(dateStr) {
  const d = new Date(dateStr);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = (startOfToday - new Date(d).setHours(0, 0, 0, 0)) / 864e5;
  if (days <= 0) return "Today";
  if (days <= 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  return "Older";
}

function renderSessions() {
  const list = $("#session-list");
  list.replaceChildren();
  let lastGroup = null;
  for (const s of state.sessions) {
    const group = groupFor(s.updatedAt || s.createdAt);
    if (group !== lastGroup) {
      list.append(el("div", "group-label", group));
      lastGroup = group;
    }
    const item = el("button", "session" + (s.id === state.currentId ? " active" : ""));
    item.dataset.id = s.id;
    if (s.status === "running") item.append(el("span", "dot"));
    item.append(el("span", "name", s.title));
    const more = el("span", "more");
    more.setAttribute("role", "button");
    more.setAttribute("tabindex", "0");
    more.setAttribute("aria-label", "Conversation options");
    more.append(svg(ICONS.more));
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu(more, s);
    });
    item.append(more);
    item.addEventListener("click", () => openSession(s.id));
    list.append(item);
  }
  if (!state.sessions.length) list.append(el("div", "group-label", "No conversations yet"));
}

async function loadSessions() {
  try {
    const { sessions } = await api("/api/sessions");
    state.sessions = sessions;
    renderSessions();
  } catch (err) {
    toast(err.message);
  }
}

let openMenuNode = null;
function closeMenu() {
  openMenuNode?.remove();
  openMenuNode = null;
}
document.addEventListener("click", closeMenu);

function openMenu(anchor, session) {
  closeMenu();
  const menu = el("div", "menu");
  const rename = el("button");
  rename.append(svg(ICONS.pencil), "Rename");
  rename.addEventListener("click", () => startRename(session));
  const archive = el("button", "danger");
  archive.append(svg(ICONS.archive), "Archive");
  archive.addEventListener("click", () => archiveSession(session));
  menu.append(rename, archive);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - 170)}px`;
  openMenuNode = menu;
}

function startRename(session) {
  const item = document.querySelector(`.session[data-id="${session.id}"]`);
  if (!item) return;
  const input = el("input");
  input.value = session.title;
  item.querySelector(".name").replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener("click", (e) => e.stopPropagation());
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (save && title && title !== session.title) {
      try {
        await api(`/api/sessions/${session.id}`, { method: "PATCH", body: { title } });
        session.title = title;
        if (session.id === state.currentId) $("#chat-title").textContent = title;
      } catch (err) {
        toast(err.message);
      }
    }
    renderSessions();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

async function archiveSession(session) {
  if (!confirm(`Archive “${session.title}”? It will disappear from this list.`)) return;
  try {
    await api(`/api/sessions/${session.id}/archive`, { method: "POST" });
    state.sessions = state.sessions.filter((s) => s.id !== session.id);
    if (session.id === state.currentId) newConversation();
    renderSessions();
  } catch (err) {
    toast(err.message);
  }
}

function setSidebar(open) {
  $("#sidebar").classList.toggle("open", open);
  $("#scrim").hidden = !open;
}
$("#open-sidebar").addEventListener("click", () => setSidebar(true));
$("#close-sidebar").addEventListener("click", () => setSidebar(false));
$("#scrim").addEventListener("click", () => setSidebar(false));

// ---------- conversation view ----------
function resetView() {
  state.streamAbort?.abort();
  state.streamAbort = null;
  state.busy = false;
  state.turn = null;
  state.blocks.clear();
  state.tools.clear();
  state.pending.clear();
  $("#messages").replaceChildren();
  setStatus(null);
  updateComposer();
}

function newConversation() {
  resetView();
  state.currentId = null;
  $("#chat-title").textContent = "New conversation";
  $("#empty").hidden = false;
  renderSessions();
  setSidebar(false);
  $("#input").focus();
}
$("#new-chat").addEventListener("click", newConversation);

async function openSession(id) {
  if (id === state.currentId && !state.busy) return setSidebar(false);
  resetView();
  state.currentId = id;
  renderSessions();
  setSidebar(false);
  $("#empty").hidden = true;
  const s = state.sessions.find((x) => x.id === id);
  $("#chat-title").textContent = s ? s.title : "Conversation";
  const loading = el("div", "row notice info", "Loading conversation…");
  $("#messages").append(loading);
  try {
    const { session, events } = await api(`/api/sessions/${id}`);
    if (state.currentId !== id) return;
    loading.remove();
    $("#chat-title").textContent = session.title;
    for (const event of events) apply(event, { history: true });
    finishTurn();
    scrollToBottom(true);
    // Re-attach if Mina is still working, or if she's paused on a decision we haven't made.
    if (session.status === "running" || session.status === "rescheduling") {
      followStream();
    } else if (state.pending.size) {
      setStatus("waiting");
    }
  } catch (err) {
    loading.className = "row notice";
    loading.textContent = err.message;
  }
}

function setStatus(status) {
  const pill = $("#status-pill");
  if (!status || status === "idle") {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.className = "status-pill " + status;
  pill.textContent = status === "running" ? "Working" : "Needs your decision";
}

const scroller = $("#scroller");
let stickToBottom = true;
scroller.addEventListener("scroll", () => {
  stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  $(".topbar").classList.toggle("scrolled", scroller.scrollTop > 4);
});
function scrollToBottom(force) {
  if (force || stickToBottom) scroller.scrollTop = scroller.scrollHeight;
}

function ensureTurn() {
  if (state.turn) return state.turn;
  const row = el("div", "row mina");
  row.append(el("div", "orb"));
  const turn = el("div", "turn");
  row.append(turn);
  $("#messages").append(row);
  state.turn = turn;
  return turn;
}

function showTyping(show) {
  const existing = state.turn?.querySelector(".typing");
  if (show && !existing) {
    const t = el("div", "typing");
    t.append(el("span"), el("span"), el("span"));
    ensureTurn().append(t);
  } else if (!show && existing) {
    existing.remove();
  }
}

function finishTurn() {
  showTyping(false);
  if (state.turn) {
    for (const node of state.turn.querySelectorAll(".prose.streaming")) node.classList.remove("streaming");
    const texts = [...state.turn.querySelectorAll(".prose")];
    if (texts.length && !state.turn.querySelector(".msg-actions")) {
      const actions = el("div", "msg-actions");
      const copy = el("button");
      copy.append(svg(ICONS.copy), "Copy");
      copy.addEventListener("click", async () => {
        const text = texts.map((n) => n.dataset.raw || n.textContent).join("\n\n");
        try {
          await navigator.clipboard.writeText(text);
          toast("Copied");
        } catch {
          toast("Couldn't copy");
        }
      });
      actions.append(copy);
      state.turn.append(actions);
    }
  }
  state.turn = null;
}

function textBlock(id) {
  let block = state.blocks.get(id);
  if (!block) {
    const node = el("div", "prose");
    ensureTurn().append(node);
    block = { node, text: "" };
    state.blocks.set(id, block);
  }
  return block;
}

function paint(id) {
  // Batch markdown renders to one per frame while text streams in.
  if (state.renderQueued.has(id)) return;
  state.renderQueued.add(id);
  requestAnimationFrame(() => {
    state.renderQueued.delete(id);
    const block = state.blocks.get(id);
    if (!block) return;
    block.node.dataset.raw = block.text;
    const html = renderMarkdown(block.text);
    if (html === null) block.node.textContent = block.text;
    else block.node.innerHTML = html;
    for (const a of block.node.querySelectorAll("a")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    scrollToBottom();
  });
}

const TOOL_LABELS = {
  bash: "Ran a command",
  read: "Read a file",
  write: "Wrote a file",
  edit: "Edited a file",
  glob: "Looked for files",
  grep: "Searched files",
  web_search: "Searched the web",
  web_fetch: "Read a web page",
};
function toolLabel(name) {
  return TOOL_LABELS[name] || name.replace(/^mcp__/, "").replace(/__/g, " · ").replace(/_/g, " ");
}
function toolDetail(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ["command", "query", "url", "file_path", "path", "pattern"]) {
    if (typeof input[key] === "string") return input[key];
  }
  const first = Object.values(input).find((v) => typeof v === "string");
  return first || "";
}
// Shows a tool's input the way a person would read it: one field per line, real line breaks.
function fullInput(input) {
  if (!input || typeof input !== "object") return String(input ?? "");
  if (typeof input.command === "string" && Object.keys(input).length <= 2) return input.command;
  return Object.entries(input)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return text.includes("\n") ? `${key}:\n${text}` : `${key}: ${text}`;
    })
    .join("\n\n");
}

function addStep(e) {
  const step = el("details", "step");
  const summary = el("summary");
  summary.append(el("span", "label", toolLabel(e.name)));
  const detail = toolDetail(e.input);
  if (detail) summary.append(el("span", "detail", detail));
  const stateNode = el("span", "state");
  stateNode.append(el("span", "spinner"));
  summary.append(stateNode);
  step.append(summary);
  const body = el("div", "body");
  body.append(el("pre", "", fullInput(e.input)));
  step.append(body);
  if (e.denied) markStep(step, "error", "Blocked as too risky");
  ensureTurn().append(step);
  return step;
}

function markStep(step, status, note) {
  step.classList.remove("done", "error");
  step.classList.add(status);
  const stateNode = step.querySelector(".state");
  if (stateNode) stateNode.replaceChildren(svg(status === "done" ? ICONS.check : ICONS.x));
  if (note) step.querySelector(".body").append(el("pre", "", note));
}

function addApproval(e) {
  const card = el("div", "approval");
  const head = el("div", "approval-head");
  head.append(svg(ICONS.shield), `Mina wants to: ${toolLabel(e.name).toLowerCase()}`);
  card.append(head);
  card.append(el("p", "", "This step needs your OK before it runs. Here's exactly what she'll do:"));
  card.append(el("pre", "", fullInput(e.input)));
  const actions = el("div", "approval-actions");
  const approve = el("button", "btn btn-approve", "Approve");
  const deny = el("button", "btn", "Deny");
  const reason = el("input");
  reason.placeholder = "Reason (optional, if you deny)";
  actions.append(approve, deny, reason);
  card.append(actions);
  approve.addEventListener("click", () => decide(e.id, "allow"));
  deny.addEventListener("click", () => decide(e.id, "deny", reason.value.trim()));
  ensureTurn().append(card);
  return card;
}

function resolveApproval(toolUseId, result) {
  const card = state.tools.get(toolUseId);
  state.pending.delete(toolUseId);
  if (!card || !card.classList.contains("approval")) return;
  card.classList.add("resolved", result === "allow" ? "allowed" : "denied");
  const actions = card.querySelector(".approval-actions");
  if (actions) actions.replaceWith(el("div", "verdict", result === "allow" ? "Approved" : "Denied"));
  if (!state.pending.size && state.busy) setStatus("running");
}

async function decide(toolUseId, result, denyMessage) {
  const card = state.tools.get(toolUseId);
  card?.querySelectorAll("button, input").forEach((n) => (n.disabled = true));
  try {
    await api(`/api/sessions/${state.currentId}/confirm`, {
      method: "POST",
      body: { toolUseId, result, denyMessage: denyMessage || undefined },
    });
    resolveApproval(toolUseId, result);
    // After a reload there's no live stream; open one to watch the rest of the turn.
    if (!state.busy) followStream();
  } catch (err) {
    card?.querySelectorAll("button, input").forEach((n) => (n.disabled = false));
    toast(err.message);
  }
}

// Applies one UI event from the server, either from history or a live stream.
function apply(e, { history = false } = {}) {
  switch (e.t) {
    case "user": {
      finishTurn();
      const row = el("div", "row user");
      row.append(el("div", "bubble", e.text));
      $("#messages").append(row);
      break;
    }
    case "start":
      showTyping(false);
      textBlock(e.id).node.classList.add("streaming");
      break;
    case "delta": {
      showTyping(false);
      const block = textBlock(e.id);
      block.node.classList.add("streaming");
      block.text += e.text;
      paint(e.id);
      break;
    }
    case "text": {
      showTyping(false);
      const block = textBlock(e.id);
      block.text = e.text;
      block.node.classList.remove("streaming");
      paint(e.id);
      break;
    }
    case "thinking":
      if (!history) showTyping(true);
      break;
    case "tool": {
      showTyping(false);
      if (state.tools.has(e.id)) break;
      if (e.ask) {
        state.tools.set(e.id, addApproval(e));
        state.pending.add(e.id);
        if (!history) setStatus("waiting");
      } else {
        state.tools.set(e.id, addStep(e));
      }
      break;
    }
    case "tool_result": {
      const node = state.tools.get(e.toolUseId);
      if (node?.classList.contains("step")) markStep(node, e.isError ? "error" : "done", e.preview || null);
      break;
    }
    case "confirmed":
      resolveApproval(e.toolUseId, e.result);
      break;
    case "error":
      showTyping(false);
      ensureTurn().append(el("div", "notice", e.message));
      break;
    case "status":
      if (e.status === "running") {
        setStatus(state.pending.size ? "waiting" : "running");
        if (!state.turn || !state.turn.children.length) showTyping(true);
      } else if (e.status === "waiting") {
        setStatus("waiting");
        showTyping(false);
      }
      break;
    case "done": {
      if (e.reason === "budget_reached") {
        ensureTurn().append(
          el("div", "notice info", "This conversation reached its spending cap. Start a new one, or raise MINA_SESSION_BUDGET_CENTS on the server.")
        );
      }
      break;
    }
  }
  if (!history) scrollToBottom();
}

// ---------- streaming ----------
async function readStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
  }
}

async function runStream(url, init) {
  const sessionId = state.currentId;
  const abort = new AbortController();
  state.streamAbort = abort;
  state.busy = true;
  updateComposer();
  setStatus("running");
  markSessionStatus(sessionId, "running");
  try {
    const res = await fetch(url, { ...init, signal: abort.signal });
    if (res.status === 401) return showLogin();
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    await readStream(res, (event) => {
      if (state.currentId === sessionId) apply(event);
    });
  } catch (err) {
    if (err.name !== "AbortError" && state.currentId === sessionId) {
      ensureTurn().append(el("div", "notice", err.message || "Lost the connection to Mina."));
    }
  } finally {
    if (state.streamAbort === abort) {
      state.streamAbort = null;
      state.busy = false;
      if (state.currentId === sessionId) {
        finishTurn();
        setStatus(state.pending.size ? "waiting" : null);
        updateComposer();
      }
    }
    markSessionStatus(sessionId, "idle");
  }
}

function followStream() {
  return runStream(`/api/sessions/${state.currentId}/stream`, { method: "GET" });
}

function markSessionStatus(id, status) {
  const s = state.sessions.find((x) => x.id === id);
  if (s) {
    s.status = status;
    s.updatedAt = new Date().toISOString();
  }
  renderSessions();
}

async function send(text) {
  text = text.trim();
  if (!text || state.busy) return;
  $("#empty").hidden = true;
  if (!state.currentId) {
    try {
      const title = text.replace(/\s+/g, " ").slice(0, 60);
      const { session } = await api("/api/sessions", { method: "POST", body: { title } });
      state.sessions.unshift(session);
      state.currentId = session.id;
      $("#chat-title").textContent = session.title;
      renderSessions();
    } catch (err) {
      toast(err.message);
      $("#empty").hidden = $("#messages").children.length > 0;
      return;
    }
  }
  apply({ t: "user", text });
  showTyping(true);
  scrollToBottom(true);
  await runStream(`/api/sessions/${state.currentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// ---------- composer ----------
const input = $("#input");
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 220) + "px";
}
function updateComposer() {
  $("#send").disabled = state.busy || !input.value.trim();
  $("#send").hidden = state.busy;
  $("#stop").hidden = !state.busy;
}
input.addEventListener("input", () => {
  autosize();
  updateComposer();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) return;
  const text = input.value;
  if (!text.trim()) return;
  input.value = "";
  autosize();
  send(text);
});
$("#stop").addEventListener("click", async () => {
  if (!state.currentId) return;
  try {
    await api(`/api/sessions/${state.currentId}/interrupt`, { method: "POST" });
    toast("Stopping Mina…");
  } catch (err) {
    toast(err.message);
  }
});
for (const button of document.querySelectorAll(".suggestion")) {
  button.addEventListener("click", () => send(button.dataset.prompt));
}

// ---------- boot ----------
function greet() {
  const h = new Date().getHours();
  const part = h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("#greeting").textContent = `${part}, Abdulloh`;
}

async function boot() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me.signedIn) {
    showLogin();
    if (!me.configured) {
      $("#login-error").textContent = "Set MINA_PASSWORD on the server to unlock Mina.";
    }
    return;
  }
  showApp();
  greet();
  updateComposer();
  await loadSessions();
  input.focus();
}

boot().catch(() => showLogin());
