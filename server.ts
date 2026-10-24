import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  archiveSession,
  autoTitle,
  chatWithMina,
  confirmTool,
  createSession,
  getHistory,
  getSession,
  interrupt,
  sendMessage,
  listSessions,
  MinaConfigError,
  renameSession,
  runTurn,
  type UiEvent,
} from "./mina.js";
import { isSignedIn, login, logout, requireAuth } from "./auth.js";
import { MAC_TOOL, deviceToken, jobResult, macStatus, nextJob, requireDevice, runOnMac } from "./device.js";
import { pushPublicKey, pushToAll, removeSubscription, saveSubscription } from "./push.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const add = tool(
  "add",
  "Add two numbers together",
  { a: z.number(), b: z.number() },
  async (args) => ({
    content: [{ type: "text", text: String(args.a + args.b) }],
  })
);

const toolsServer = createSdkMcpServer({
  name: "demo-tools",
  version: "1.0.0",
  tools: [add],
});

const app = express();
// Render (and most hosts) terminate TLS at a proxy; trust it so req.secure and req.ip are right.
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));
app.get("/vendor/marked.js", (_req, res) => res.sendFile(path.join(here, "node_modules/marked/lib/marked.umd.js")));
app.get("/vendor/purify.js", (_req, res) => res.sendFile(path.join(here, "node_modules/dompurify/dist/purify.min.js")));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/me", (req, res) => {
  res.json({
    signedIn: isSignedIn(req),
    configured: Boolean(process.env.MINA_PASSWORD),
    naturalVoice: Boolean(process.env.OPENAI_API_KEY),
  });
});
app.post("/api/login", login);
app.post("/api/logout", logout);

// The Mac helper authenticates with its own pairing token, not the web cookie.
app.get("/api/device/next", requireDevice, nextJob);
app.post("/api/device/result", requireDevice, jobResult);

// Everything below costs money or touches Mina's data, so it needs the password.
app.use(["/api", "/mina", "/chat"], requireAuth);

function sendError(res: Response, err: unknown, fallback: string) {
  console.error(err);
  if (res.headersSent) return;
  if (err instanceof MinaConfigError) {
    return res.status(500).json({ error: "Mina isn't configured on the server yet (missing agent/environment id)." });
  }
  if (err instanceof Anthropic.NotFoundError) return res.status(404).json({ error: "That conversation doesn't exist." });
  if (err instanceof Anthropic.AuthenticationError) {
    return res.status(500).json({ error: "The server's Anthropic API key was rejected." });
  }
  if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "Rate limited. Try again in a moment." });
  res.status(500).json({ error: fallback });
}

app.get("/api/sessions", async (_req, res) => {
  try {
    res.json({ sessions: await listSessions() });
  } catch (err) {
    sendError(res, err, "Couldn't load conversations.");
  }
});

app.post("/api/sessions", async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 120) : undefined;
  try {
    res.json({ session: await createSession(title) });
  } catch (err) {
    sendError(res, err, "Couldn't start a conversation.");
  }
});

app.get("/api/sessions/:id", async (req, res) => {
  try {
    res.json(await getHistory(req.params.id));
  } catch (err) {
    sendError(res, err, "Couldn't load that conversation.");
  }
});

app.patch("/api/sessions/:id", async (req, res) => {
  const title = req.body?.title;
  if (typeof title !== "string" || title.trim() === "") {
    return res.status(400).json({ error: "Body must include a non-empty 'title' string." });
  }
  try {
    res.json({ session: await renameSession(req.params.id, title.trim().slice(0, 120)) });
  } catch (err) {
    sendError(res, err, "Couldn't rename that conversation.");
  }
});

app.post("/api/sessions/:id/archive", async (req, res) => {
  try {
    await archiveSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, "Couldn't archive that conversation. If Mina is still working, stop her first.");
  }
});

// Streams one turn as Server-Sent Events. With a message, sends it first; without one,
// re-attaches to a turn already in progress (for example after approving from a reloaded page).
async function streamTurn(req: express.Request, res: Response, message?: string) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  let open = true;
  const sessionId = req.params.id as string;
  let lastText = "";
  let pushedWaiting = false;
  const write = (event: UiEvent) => {
    if (event.t === "text") lastText = event.text;
    if (event.t === "status" && event.status === "waiting" && !pushedWaiting) {
      pushedWaiting = true;
      notify(sessionId, "waiting");
    }
    if (event.t === "status" && event.status === "running") pushedWaiting = false;
    if (event.t === "done") {
      notify(sessionId, event.reason === "terminated" ? "ended" : "done", lastText);
      if (message) autoTitle(sessionId).catch((err) => console.error("Couldn't title conversation", err));
    }
    if (open) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => open && res.write(": keep-alive\n\n"), 15000);
  const abort = new AbortController();
  // A turn that sent a message keeps going if the browser leaves, so the conversation's
  // state (and anything waiting on approval) is still recorded. Re-attaching streams just stop.
  const giveUp = message ? setTimeout(() => abort.abort(), 30 * 60 * 1000) : undefined;
  res.on("close", () => {
    open = false;
    if (!message) abort.abort();
  });

  try {
    await runTurn(sessionId, write, {
      message,
      signal: abort.signal,
      customTool: async (name, input) => (name === "mac" ? runOnMac(input) : null),
    });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error(err);
      write({ t: "error", message: err instanceof MinaConfigError ? err.message : "Lost the connection to Mina." });
      write({ t: "done", reason: "error" });
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(giveUp);
    if (open) res.end();
  }
}

const PUSH_TITLES = { done: "Mina is done", waiting: "Mina needs your decision", ended: "Mina stopped" } as const;

function notify(sessionId: string, kind: keyof typeof PUSH_TITLES, text = "") {
  void (async () => {
    const title = await getSession(sessionId).then((s) => s.title).catch(() => "Your conversation");
    const body = (kind === "done" && text ? text.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim() : title).slice(0, 180);
    await pushToAll({ title: PUSH_TITLES[kind], body, sessionId, kind });
  })();
}

app.get("/api/device", (req, res) => {
  const token = deviceToken();
  const origin = `${req.protocol}://${req.get("host")}`;
  res.json({
    ...macStatus(),
    install: token ? `curl -fsSL ${origin}/helper/install.sh | MINA_SERVER=${origin} bash -s -- ${token}` : null,
    tool: MAC_TOOL,
  });
});

app.get("/api/push/key", async (_req, res) => {
  res.json({ publicKey: await pushPublicKey() });
});

app.post("/api/push/subscribe", async (req, res) => {
  const sub = req.body?.subscription;
  if (typeof sub?.endpoint !== "string" || typeof sub?.keys?.p256dh !== "string" || typeof sub?.keys?.auth !== "string") {
    return res.status(400).json({ error: "Body must include a push 'subscription'." });
  }
  try {
    await saveSubscription(sub, req.get("user-agent"));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: "Push notifications aren't set up on the server yet." });
  }
});

app.post("/api/push/unsubscribe", async (req, res) => {
  if (typeof req.body?.endpoint === "string") await removeSubscription(req.body.endpoint).catch(() => {});
  res.json({ ok: true });
});

app.post("/api/sessions/:id/messages", async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || text.trim() === "") {
    return res.status(400).json({ error: "Body must include a non-empty 'text' string." });
  }
  await streamTurn(req, res, text);
});

// Mina's natural voice: OpenAI text-to-speech, streamed straight to the browser as MP3.
// Without OPENAI_API_KEY the app falls back to the device's built-in voices.
app.post("/api/tts", async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(501).json({ error: "No natural voice configured." });
  const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 4000) : "";
  if (!text.trim()) return res.status(400).json({ error: "Body must include 'text'." });
  try {
    const upstream = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.MINA_TTS_MODEL ?? "gpt-4o-mini-tts",
        voice: process.env.MINA_TTS_VOICE ?? "nova",
        input: text,
        instructions:
          "You are Mina, a warm, confident chief of staff with a touch of dry wit. Speak naturally and conversationally, at a relaxed but efficient pace, like a trusted colleague.",
        response_format: "mp3",
      }),
    });
    if (!upstream.ok || !upstream.body) {
      console.error("TTS failed", upstream.status, await upstream.text().catch(() => ""));
      return res.status(502).json({ error: "The voice service didn't answer." });
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
    const reader = upstream.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(502).json({ error: "The voice service didn't answer." });
    else res.end();
  }
});

// For a message sent while Mina is still working: it joins the turn already streaming.
app.post("/api/sessions/:id/queue", async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || text.trim() === "") {
    return res.status(400).json({ error: "Body must include a non-empty 'text' string." });
  }
  try {
    await sendMessage(req.params.id, text);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, "Couldn't send that to Mina.");
  }
});

app.get("/api/sessions/:id/stream", async (req, res) => {
  await streamTurn(req, res);
});

app.post("/api/sessions/:id/confirm", async (req, res) => {
  const { toolUseId, result, denyMessage } = req.body ?? {};
  if (typeof toolUseId !== "string" || (result !== "allow" && result !== "deny")) {
    return res.status(400).json({ error: "Body must include 'toolUseId' and 'result' ('allow' or 'deny')." });
  }
  try {
    await confirmTool(req.params.id, toolUseId, result, typeof denyMessage === "string" ? denyMessage : undefined);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, "Couldn't send your decision to Mina.");
  }
});

app.post("/api/sessions/:id/interrupt", async (req, res) => {
  try {
    await interrupt(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, "Couldn't stop Mina.");
  }
});

app.post("/mina/chat", async (req, res) => {
  const message = req.body?.message;
  const sessionId = req.body?.sessionId;
  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Body must include a non-empty 'message' string." });
  }
  try {
    const result = await chatWithMina(message, typeof sessionId === "string" ? sessionId : undefined);
    res.json(result);
  } catch (err) {
    sendError(res, err, "Internal error talking to Mina.");
  }
});

app.post("/chat", async (req, res) => {
  const prompt = req.body?.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return res.status(400).json({ error: "Body must include a non-empty 'prompt' string." });
  }

  try {
    let result: string | undefined;
    let costUsd: number | undefined;
    let usage: unknown;
    for await (const message of query({
      prompt,
      options: {
        mcpServers: { "demo-tools": toolsServer },
        allowedTools: ["mcp__demo-tools__add"],
      },
    })) {
      if (message.type === "result" && message.subtype === "success") {
        result = message.result;
        costUsd = message.total_cost_usd;
        usage = message.usage;
      }
    }
    if (result === undefined) {
      return res.status(502).json({ error: "Agent did not complete successfully." });
    }
    res.json({ result, costUsd, usage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error running agent." });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Mina is listening on http://localhost:${port}`);
});
