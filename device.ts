import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Mina's limited reach into Abdulloh's Mac. The helper on the Mac long-polls this server
// for jobs (no open ports on the laptop) and can only do the fixed actions below: open an
// app or a web page, control music, set the volume, show a notification. Nothing Mina
// sends is ever run as a command or script.

export type MacAction =
  | { action: "open_app"; name: string }
  | { action: "open_url"; url: string }
  | { action: "media"; command: "playpause" | "play" | "pause" | "next" | "previous" }
  | { action: "volume"; level: number }
  | { action: "notify"; text: string };

const MEDIA = new Set(["playpause", "play", "pause", "next", "previous"]);

/** Checks a tool call from Mina against the allowlist. Returns the clean action or an error. */
export function parseMacAction(input: unknown): MacAction | string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (i.action) {
    case "open_app": {
      const name = String(i.name ?? "").trim();
      return /^[\p{L}\p{N} .&'+()-]{1,60}$/u.test(name) ? { action: "open_app", name } : "App name looks invalid.";
    }
    case "open_url": {
      try {
        const url = new URL(String(i.url ?? ""));
        if (url.protocol !== "https:" && url.protocol !== "http:") return "Only web links can be opened.";
        return { action: "open_url", url: url.toString() };
      } catch {
        return "That isn't a valid URL.";
      }
    }
    case "media": {
      const command = String(i.command ?? "");
      return MEDIA.has(command) ? { action: "media", command: command as never } : "Unknown media command.";
    }
    case "volume": {
      const level = Number(i.level);
      return Number.isFinite(level) ? { action: "volume", level: Math.max(0, Math.min(100, Math.round(level))) } : "Volume must be 0-100.";
    }
    case "notify": {
      const text = String(i.text ?? "").trim().slice(0, 200);
      return text ? { action: "notify", text } : "Notification text is empty.";
    }
    default:
      return "Unknown action. Use open_app, open_url, media, volume or notify.";
  }
}

interface Job {
  id: string;
  action: MacAction;
  done: (result: { ok: boolean; output: string }) => void;
}

const queue: Job[] = [];
const inflight = new Map<string, Job>();
let poller: ((job: Job | null) => void) | null = null;
let lastSeen = 0;

// The helper's token is derived from MINA_PASSWORD, so changing the password unpairs the Mac.
export function deviceToken(): string | null {
  const secret = process.env.MINA_PASSWORD;
  return secret ? createHmac("sha256", secret).update("mina-device-v1").digest("hex") : null;
}

export function requireDevice(req: Request, res: Response, next: NextFunction) {
  const expected = deviceToken();
  const given = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const ok =
    expected !== null && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: "This Mac isn't paired with Mina." });
  lastSeen = Date.now();
  next();
}

export function macStatus() {
  return { online: Date.now() - lastSeen < 60_000, lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null };
}

/** Sends one allowed action to the Mac and waits for the helper's answer. */
export function runOnMac(input: unknown, timeoutMs = 30_000): Promise<{ ok: boolean; output: string }> {
  const action = parseMacAction(input);
  if (typeof action === "string") return Promise.resolve({ ok: false, output: action });
  if (!macStatus().online) {
    return Promise.resolve({
      ok: false,
      output: "Abdulloh's Mac helper isn't connected right now (the laptop may be asleep or offline). Tell him, and give him the link instead.",
    });
  }
  return new Promise((resolve) => {
    const job: Job = {
      id: randomUUID(),
      action,
      done: (result) => {
        clearTimeout(timer);
        inflight.delete(job.id);
        resolve(result);
      },
    };
    const timer = setTimeout(() => {
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
      job.done({ ok: false, output: "The Mac didn't answer in time." });
    }, timeoutMs);
    inflight.set(job.id, job);
    if (poller) {
      const deliver = poller;
      poller = null;
      deliver(job);
    } else {
      queue.push(job);
    }
  });
}

/** GET /api/device/next: the helper's long poll. Answers with a job, or 204 after 25 seconds. */
export function nextJob(req: Request, res: Response) {
  const queued = queue.shift();
  if (queued) return res.json({ id: queued.id, ...queued.action });
  poller?.(null); // one helper at a time; a newer poll replaces an older one
  let settled = false;
  const finish = (job: Job | null) => {
    if (settled) {
      if (job) queue.unshift(job);
      return;
    }
    settled = true;
    clearTimeout(wait);
    if (poller === finish) poller = null;
    if (job) res.json({ id: job.id, ...job.action });
    else res.status(204).end();
  };
  const wait = setTimeout(() => finish(null), 25_000);
  poller = finish;
  res.on("close", () => {
    if (!settled) {
      settled = true;
      clearTimeout(wait);
      if (poller === finish) poller = null;
    }
  });
}

/** POST /api/device/result: the helper reports how a job went. */
export function jobResult(req: Request, res: Response) {
  const { id, ok, output } = req.body ?? {};
  const job = typeof id === "string" ? inflight.get(id) : undefined;
  if (job) job.done({ ok: Boolean(ok), output: String(output ?? "").slice(0, 2000) });
  res.json({ ok: true });
}

/** The tool definition to add to the Mina agent in Claude Console. */
export const MAC_TOOL = {
  type: "custom",
  name: "mac",
  description:
    "Do something on Abdulloh's MacBook. Allowed actions only: open_app (name), open_url (url), media (command: playpause|play|pause|next|previous, for Spotify or Apple Music), volume (level 0-100), notify (text). Use it when he asks you to open an app or site, play/pause/skip music, or change the volume. If the helper is offline, say so and give him the link.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["open_app", "open_url", "media", "volume", "notify"] },
      name: { type: "string", description: "App name for open_app, e.g. 'Spotify', 'Safari', 'Notes'." },
      url: { type: "string", description: "https URL for open_url." },
      command: { type: "string", enum: ["playpause", "play", "pause", "next", "previous"] },
      level: { type: "number", description: "0-100 for volume." },
      text: { type: "string", description: "Message for notify." },
    },
    required: ["action"],
  },
} as const;
