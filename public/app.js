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
  speaker: '<path d="M11 5L6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />',
  play: '<path d="M8 5v14l11-7z" />',
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
const THEMES = ["dark", "light", "system"];
function applyTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("#theme-label").textContent = `Theme: ${theme}`;
}
function currentTheme() {
  try {
    return localStorage.getItem("mina-theme") || "dark";
  } catch {
    return "dark";
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
    const badge = STATE_BADGES[s.state];
    if (badge) {
      const dot = el("span", `state-dot ${s.state}`);
      dot.title = badge;
      dot.setAttribute("aria-label", badge);
      item.append(dot);
    }
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
  updateBadge();
}

const STATE_BADGES = { working: "Mina is working", waiting: "Waiting for your input", done: "Done" };

async function loadSessions({ quiet = false } = {}) {
  try {
    const { sessions } = await api("/api/sessions");
    const before = new Map(state.sessions.map((s) => [s.id, s.state]));
    state.sessions = sessions;
    renderSessions();
    const current = sessions.find((x) => x.id === state.currentId);
    if (current && !document.querySelector(".session input")) $("#chat-title").textContent = current.title;
    // Tell Abdulloh when a conversation he isn't looking at moves on by itself.
    for (const s of sessions) {
      const was = before.get(s.id);
      if (was && was !== s.state && !(s.id === state.currentId && state.busy)) announce(s);
    }
  } catch (err) {
    if (!quiet) toast(err.message);
  }
}

// Keep the sidebar honest: poll quickly while anything is working, slowly otherwise.
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = state.sessions.some((s) => s.state === "working");
  pollTimer = setTimeout(async () => {
    if (!$("#app").hidden) await loadSessions({ quiet: true });
    schedulePoll();
  }, busy ? 6000 : 30000);
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
    if (session.state === "working") {
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
      const listen = el("button");
      listen.append(svg(ICONS.speaker), "Read aloud");
      listen.addEventListener("click", () => {
        if (speech.active) return stopSpeaking();
        speak(texts.map((n) => n.dataset.raw || n.textContent).join("\n\n"));
      });
      actions.append(copy, listen);
      state.turn.append(actions);
      addMedia(state.turn, texts, state.autoplay);
    }
  }
  state.autoplay = false;
  state.turn = null;
}

// ---------- YouTube and links Mina finds: play them right here ----------
function youtubeId(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)youtu\.be$/.test(u.hostname)) return u.pathname.slice(1, 12) || null;
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
      return m ? m[1] : null;
    }
  } catch {}
  return null;
}

function addMedia(turn, texts, autoplay) {
  // Read links from the raw text: the markdown render may still be a frame away.
  const raw = [...state.blocks.values()].filter((b) => turn.contains(b.node)).map((b) => b.text).join("\n");
  const links = raw.match(/https?:\/\/[^\s)\]>"'<]+/g) || [];
  const seen = new Set();
  let first = true;
  for (const href of links) {
    const id = youtubeId(href);
    if (!id || seen.has(id) || seen.size >= 3) continue;
    seen.add(id);
    const frame = el("iframe", "yt");
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0&playsinline=1${autoplay && first ? "&autoplay=1" : ""}`;
    frame.title = "YouTube video";
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    frame.loading = "lazy";
    const card = el("div", "media");
    card.append(frame);
    turn.insertBefore(card, turn.querySelector(".msg-actions"));
    first = false;
  }
  // A YouTube search link can't be embedded; make it one tap away (and open it when asked by voice).
  const search = links.find((h) => /youtube\.com\/results/.test(h));
  if (!seen.size && search) {
    const open = el("a", "btn media-link");
    open.href = search;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.append(svg(ICONS.play), "Open on YouTube");
    turn.insertBefore(open, turn.querySelector(".msg-actions"));
    if (autoplay) window.open(search, "_blank", "noopener");
  }
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
  markSessionState(sessionId, "working");
  let ended = null;
  try {
    const res = await fetch(url, { ...init, signal: abort.signal });
    if (res.status === 401) return showLogin();
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    await readStream(res, (event) => {
      if (event.t === "status" && event.status === "waiting") {
        markSessionState(sessionId, "waiting");
        announce(sessionById(sessionId), "waiting");
        if (voice.speakNext) speak("I need your OK before the next step. It's on screen.");
      } else if (event.t === "status" && event.status === "running") {
        markSessionState(sessionId, "working");
      } else if (event.t === "done") {
        ended = event.reason === "terminated" ? "ended" : "done";
      }
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
        state.autoplay = Boolean(ended); // a finished live turn may start the video it found
        finishTurn();
        setStatus(state.pending.size ? "waiting" : null);
        updateComposer();
      }
    }
    if (ended) {
      markSessionState(sessionId, ended);
      // Mina names the conversation a few seconds after she answers.
      setTimeout(() => loadSessions({ quiet: true }), 6000);
      announce(sessionById(sessionId), ended, lastReplyText());
      // Don't talk over a video she just started.
      const reply = lastReplyText();
      if ((voice.speakNext || autoSpeak()) && state.currentId === sessionId && !/youtu\.?be/.test(reply)) speak(reply);
      voice.speakNext = false;
    } else {
      loadSessions({ quiet: true });
    }
    schedulePoll();
  }
}

function followStream() {
  return runStream(`/api/sessions/${state.currentId}/stream`, { method: "GET" });
}

function sessionById(id) {
  return state.sessions.find((x) => x.id === id);
}

function markSessionState(id, next) {
  const s = sessionById(id);
  if (s && s.state !== next) {
    s.state = next;
    s.updatedAt = new Date().toISOString();
    renderSessions();
  }
}

function lastReplyText() {
  const blocks = [...state.blocks.values()];
  return blocks.length ? blocks[blocks.length - 1].text : "";
}

// Mina is mid-turn: add the message to the conversation; she picks it up as she goes.
async function queueMessage(text) {
  const sessionId = state.currentId;
  apply({ t: "user", text });
  showTyping(true);
  scrollToBottom(true);
  try {
    await api(`/api/sessions/${sessionId}/queue`, { method: "POST", body: { text } });
    // The turn may have ended just before the message landed; watch the next one.
    if (!state.busy && state.currentId === sessionId) followStream();
  } catch (err) {
    showTyping(false);
    toast(err.message);
  }
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  if (state.busy && state.currentId) return queueMessage(text);
  if (state.busy) return;
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
  const hasText = Boolean(input.value.trim());
  $("#send").disabled = !hasText;
  // While Mina works: Stop when the box is empty, Send (queue) once you type.
  $("#send").hidden = state.busy && !hasText;
  $("#stop").hidden = !state.busy || hasText;
  input.placeholder = state.busy ? "Add to the conversation… Mina will pick it up" : "Message Mina…";
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
  const text = input.value;
  if (!text.trim()) return;
  input.value = "";
  autosize();
  updateComposer();
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

// ---------- notifications, app install, badge ----------
function notificationsOn() {
  return "Notification" in window && Notification.permission === "granted" && pref("mina-notify", "on") === "on";
}

function pref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const ANNOUNCE = {
  waiting: "Mina needs your decision",
  done: "Mina is done",
  ended: "Mina stopped",
};

async function announce(session, kind = session?.state, text = "") {
  updateBadge();
  // With server push on, the server sends these itself (even when Mina is closed).
  if (!session || !ANNOUNCE[kind] || !notificationsOn() || pushActive) return;
  if (!document.hidden && session.id === state.currentId) return;
  const body = (text ? plainText(text) : session.title).slice(0, 180);
  const options = { body, tag: `${session.id}:${kind}`, icon: "/icons/icon-192.png", badge: "/icons/badge.png", data: { sessionId: session.id } };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) await reg.showNotification(ANNOUNCE[kind], options);
    else new Notification(ANNOUNCE[kind], options);
  } catch {}
}

function updateBadge() {
  const waiting = state.sessions.filter((s) => s.state === "waiting").length;
  document.title = waiting ? `(${waiting}) Mina` : "Mina";
  try {
    if (waiting) navigator.setAppBadge?.(waiting);
    else navigator.clearAppBadge?.();
  } catch {}
}

function renderToggles() {
  const notify = $("#notify-toggle");
  if (!("Notification" in window)) notify.hidden = true;
  else $("#notify-label").textContent = `Notifications: ${notificationsOn() ? "on" : "off"}`;
  const wake = $("#wake-toggle");
  wake.hidden = !Recognition;
  $("#wake-label").textContent = `“Hey Mina”: ${voice.wakeEnabled ? "on" : "off"}`;
  wake.classList.toggle("on", voice.wakeEnabled);
  notify.classList.toggle("on", notificationsOn());
}

// ---------- server push (works when Mina is closed) ----------
let pushActive = false;

function urlBase64ToBytes(base64) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function enablePush() {
  pushActive = false;
  try {
    if (!("PushManager" in window) || !navigator.serviceWorker) return;
    const { publicKey } = await api("/api/push/key");
    if (!publicKey) return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const key = urlBase64ToBytes(publicKey);
    const sameKey = sub && sub.options.applicationServerKey &&
      new Uint8Array(sub.options.applicationServerKey).every((b, i) => b === key[i]);
    if (sub && !sameKey) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    pushActive = true;
  } catch (err) {
    console.warn("Push unavailable", err);
  }
}

async function disablePush() {
  pushActive = false;
  try {
    const reg = await navigator.serviceWorker?.ready;
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {}
}

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("#install").hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("#install").hidden = true;
  toast("Mina is installed. Open her from your Dock or home screen.");
});

function setupExtras() {
  if (setupExtras.done) return;
  setupExtras.done = true;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.open) openSession(e.data.open);
    });
  }
  $("#install").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    $("#install").hidden = true;
  });
  $("#notify-toggle").addEventListener("click", async () => {
    if (notificationsOn()) {
      setPref("mina-notify", "off");
      disablePush();
    } else {
      const result = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (result === "granted") {
        setPref("mina-notify", "on");
        await enablePush();
        toast(
          pushActive
            ? "Notifications on, even when Mina is closed."
            : "Notifications on. Mina will ping you when she's done or needs you."
        );
      } else {
        toast("Notifications are blocked for this site. Allow them in your browser's site settings.");
      }
    }
    renderToggles();
  });
  $("#wake-toggle").addEventListener("click", () => setWake(!voice.wakeEnabled));
  $("#speaking-stop").addEventListener("click", stopSpeaking);
  $("#auto-speak").addEventListener("click", () => {
    const on = !autoSpeak();
    setPref("mina-auto-speak", on ? "on" : "off");
    renderAutoSpeak();
    if (on) {
      // Tapping here also unlocks audio playback for later replies.
      toast("Mina will read her replies aloud.");
      const last = lastReplyText() || [...document.querySelectorAll(".row.mina .prose")].map((n) => n.dataset.raw || n.textContent).pop();
      if (last) speak(last);
    } else {
      stopSpeaking();
      toast("Voice replies off.");
    }
  });
  renderAutoSpeak();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && speech.active) stopSpeaking();
  });
  // Tapping the mic again sends right away instead of waiting for the pause.
  $("#mic").addEventListener("click", () => (voice.mode === "dictate" ? stopDictation(true) : startDictation()));
  $("#mic").hidden = !Recognition;
  $("#voice-send").addEventListener("click", () => {
    if (voice.mode === "dictate") return stopDictation(true);
    if (voice.mode === "command" && voice.pending) finishCommand(voice.pending);
  });
  $("#voice-cancel").addEventListener("click", () => {
    if (voice.mode === "dictate") {
      input.value = voice.dictateBase || "";
      autosize();
      updateComposer();
      return stopDictation(false);
    }
    clearTimeout(voice.commandTimer);
    voice.mode = voice.wakeEnabled ? "wake" : "off";
    showListening(false);
  });
  renderToggles();
  updateBadge();
  setupMac();
  if (notificationsOn()) enablePush();
  const deepLink = new URLSearchParams(location.search).get("s");
  if (deepLink) {
    history.replaceState(null, "", "/");
    openSession(deepLink);
  }
  if (voice.wakeEnabled) setWake(true, { quiet: true });
}

// ---------- Mac helper ----------
async function refreshMac() {
  try {
    const d = await api("/api/device");
    $("#mac-label").textContent = d.online ? "Your Mac: connected" : "Connect your Mac";
    $("#mac-dot").hidden = !d.online;
    $("#mac-dot").className = "state-dot done";
    $("#mac-status").textContent = d.online
      ? "Your Mac is connected. Try: “Open Spotify and play some music.”"
      : d.lastSeen
        ? `Not connected right now (last seen ${new Date(d.lastSeen).toLocaleString()}). Is the Mac awake?`
        : "Not connected yet. Two steps:";
    $("#mac-install").textContent = d.install || "Set MINA_PASSWORD on the server first.";
    $("#mac-tool").textContent = JSON.stringify(d.tool, null, 2);
  } catch {}
}

function setupMac() {
  $("#mac-open").addEventListener("click", () => {
    $("#mac-panel").hidden = false;
    refreshMac();
  });
  $("#mac-close").addEventListener("click", () => ($("#mac-panel").hidden = true));
  $("#mac-panel").addEventListener("click", (e) => {
    if (e.target.id === "mac-panel") $("#mac-panel").hidden = true;
  });
  for (const btn of document.querySelectorAll("[data-copy]")) {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText($("#" + btn.dataset.copy).textContent);
        toast("Copied");
      } catch {
        toast("Couldn't copy. Select the text instead.");
      }
    });
  }
  refreshMac();
  setInterval(refreshMac, 60000);
}

// ---------- voice: dictation, "Hey Mina", spoken replies ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const WAKE = /\b(?:hey|hi|okay|ok|hello)[\s,.!]*(?:mina|meena|mena|nina|mena|minah|mino)\b[\s,.!?]*/i;

const voice = {
  rec: null,
  mode: "off", // off | wake | command | dictate
  wakeEnabled: pref("mina-wake", "off") === "on",
  speakNext: false, // read the reply to this turn aloud
  commandTimer: null,
  restartTimer: null,
  pauseTimer: null,
  pending: "", // what's been heard so far for the current request
  start: 0, // result index where "Hey Mina" was heard
};

function chime(up = true) {
  try {
    const ctx = (chime.ctx ||= new AudioContext());
    const t = ctx.currentTime;
    for (const [i, f] of (up ? [660, 990] : [990, 660]).entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.2);
    }
  } catch {}
}

function showListening(show, text = "") {
  $("#voice-overlay").hidden = !show;
  $("#voice-text").textContent = text || "Listening…";
  $("#mic").classList.toggle("live", show && voice.mode === "dictate");
}

function stopRecognition() {
  clearTimeout(voice.restartTimer);
  const rec = voice.rec;
  voice.rec = null;
  if (rec) {
    rec.onend = null;
    try {
      rec.abort();
    } catch {}
  }
}

function startRecognition({ continuous }) {
  stopRecognition();
  const rec = new Recognition();
  rec.lang = navigator.language || "en-US";
  rec.continuous = continuous;
  rec.interimResults = true;
  rec.onresult = onSpeech;
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      toast("Mina can't use the microphone. Allow it in your browser's site settings.");
      voice.wakeEnabled = false;
      setPref("mina-wake", "off");
      voice.mode = "off";
      renderToggles();
      showListening(false);
    }
  };
  rec.onend = () => {
    if (voice.rec !== rec) return;
    voice.rec = null;
    // Some browsers (Android) stop listening on their own; act on what was heard so far.
    if (voice.mode === "dictate") {
      if (voice.pending) return stopDictation(true);
      voice.mode = "off";
      showListening(false);
    }
    if (voice.mode === "command" && voice.pending) finishCommand(voice.pending);
    // Browsers end recognition every so often; keep the wake word alive.
    if (voice.wakeEnabled && !speechSynthesis.speaking) {
      if (voice.mode === "off") voice.mode = "wake";
      voice.restartTimer = setTimeout(() => voice.wakeEnabled && !voice.rec && startRecognition({ continuous: true }), 400);
    }
  };
  try {
    rec.start();
    voice.rec = rec;
  } catch {}
}

// Joins everything heard in this recognition run from result `start` on.
function heardFrom(e, start) {
  let text = "";
  for (let i = start; i < e.results.length; i++) text += e.results[i][0].transcript;
  return text.trim();
}

// Mina waits for a real pause before acting, so she doesn't cut you off mid-sentence.
const PAUSE_MS = 5000;
function armPause(done) {
  clearTimeout(voice.pauseTimer);
  voice.pauseTimer = setTimeout(done, PAUSE_MS);
}

function onSpeech(e) {
  if (voice.mode === "wake") {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (WAKE.test(e.results[i][0].transcript)) {
        voice.mode = "command";
        voice.start = i;
        voice.pending = "";
        chime(true);
        showListening(true, "Yes, Abdulloh?");
        armCommandTimeout();
        break;
      }
    }
    if (voice.mode !== "command") return;
  }

  if (voice.mode === "command") {
    const text = heardFrom(e, voice.start).replace(WAKE, "").trim();
    if (!text) return;
    voice.pending = text;
    clearTimeout(voice.commandTimer);
    showListening(true, text);
    armPause(() => finishCommand(voice.pending));
    return;
  }

  if (voice.mode === "dictate") {
    const text = heardFrom(e, 0);
    if (!text) return;
    voice.pending = text;
    input.value = (voice.dictateBase + " " + text).trim();
    autosize();
    updateComposer();
    showListening(true, text);
    armPause(() => stopDictation(true));
  }
}

function armCommandTimeout() {
  clearTimeout(voice.commandTimer);
  voice.commandTimer = setTimeout(() => {
    if (voice.mode !== "command" || voice.pending) return;
    voice.mode = "wake";
    showListening(false);
    chime(false);
  }, 8000);
}

function finishCommand(text) {
  clearTimeout(voice.commandTimer);
  clearTimeout(voice.pauseTimer);
  voice.mode = "wake";
  voice.pending = "";
  showListening(false);
  if (!text) return;
  voice.speakNext = true;
  send(text);
}

function startDictation() {
  if (!Recognition) return;
  stopSpeaking();
  voice.mode = "dictate";
  voice.pending = "";
  voice.dictateBase = input.value.trim();
  showListening(true);
  startRecognition({ continuous: true });
}

function stopDictation(submit = false) {
  clearTimeout(voice.pauseTimer);
  voice.mode = voice.wakeEnabled ? "wake" : "off";
  voice.pending = "";
  showListening(false);
  if (submit && input.value.trim()) {
    voice.speakNext = true;
    $("#composer").requestSubmit();
  }
  if (voice.wakeEnabled) startRecognition({ continuous: true });
  else stopRecognition();
}

function setWake(on, { quiet = false } = {}) {
  if (!Recognition) return toast("This browser can't listen for “Hey Mina”. Use Chrome.");
  voice.wakeEnabled = on;
  setPref("mina-wake", on ? "on" : "off");
  renderToggles();
  if (on) {
    voice.mode = "wake";
    startRecognition({ continuous: true });
    if (!quiet) toast("Listening for “Hey Mina” while Mina is open.");
  } else {
    voice.mode = "off";
    stopRecognition();
    showListening(false);
  }
}

function plainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\-*+\s]+/gm, "")
    .replace(/[*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Picks the most natural voice the device has. Premium/Enhanced system voices and Google's
// network voices sound far better than the default.
function bestVoice(lang) {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  const rank = (v) => {
    const n = v.name;
    if (/premium/i.test(n)) return 0;
    if (/enhanced|neural|natural/i.test(n)) return 1;
    if (/Google US English|Google UK English Female/i.test(n)) return 2;
    if (/^(Ava|Zoe|Samantha|Allison|Susan|Serena|Karen|Moira|Tessa)\b/i.test(n)) return 3;
    if (/Google/i.test(n)) return 4;
    if (!v.localService) return 5;
    return 6;
  };
  return voices.sort((a, b) => rank(a) - rank(b))[0] || null;
}
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};

// Speaker button in the top bar: read every reply aloud.
function autoSpeak() {
  return pref("mina-auto-speak", "off") === "on";
}
function renderAutoSpeak() {
  const on = autoSpeak();
  const btn = $("#auto-speak");
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Voice replies on" : "Voice replies off";
}

// What Mina is saying right now, so it can be stopped from anywhere.
const speech = { active: false, audio: null, naturalVoice: false };

function setSpeaking(on) {
  speech.active = on;
  $("#speaking").hidden = !on;
  if (!on && voice.wakeEnabled && !voice.rec) {
    voice.mode = "wake";
    startRecognition({ continuous: true });
  }
}

function stopSpeaking() {
  if (speech.audio) {
    speech.audio.pause();
    URL.revokeObjectURL(speech.audio.src);
    speech.audio = null;
  }
  speech.abort?.abort();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  setSpeaking(false);
}

async function speak(markdown) {
  const text = plainText(markdown).slice(0, 3000);
  if (!text) return;
  stopSpeaking();
  stopRecognition(); // don't let Mina hear herself
  setSpeaking(true);
  if (speech.naturalVoice) {
    const abort = new AbortController();
    speech.abort = abort;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error("tts");
      const audio = new Audio(URL.createObjectURL(await res.blob()));
      if (!speech.active) return;
      speech.audio = audio;
      audio.onended = audio.onerror = () => {
        if (speech.audio === audio) stopSpeaking();
      };
      await audio.play();
      return;
    } catch (err) {
      if (err.name === "AbortError" || !speech.active) return;
      // Fall through to the device voice.
    }
  }
  if (!("speechSynthesis" in window)) return setSpeaking(false);
  const lang = navigator.language || "en-US";
  const v = bestVoice(lang);
  // Chrome cuts long utterances off after ~15 seconds, so speak sentence by sentence.
  const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part.trim());
    u.lang = v?.lang || lang;
    u.voice = v;
    u.rate = 1;
    u.pitch = 1.02;
    if (i === parts.length - 1) u.onend = u.onerror = () => speech.active && !speech.audio && setSpeaking(false);
    speechSynthesis.speak(u);
  });
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
  speech.naturalVoice = Boolean(me.naturalVoice);
  greet();
  updateComposer();
  await loadSessions();
  schedulePoll();
  setupExtras();
  input.focus();
}

boot().catch(() => showLogin());
