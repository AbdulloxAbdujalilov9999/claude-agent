import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Single-owner password login. The cookie holds an HMAC of a fixed label keyed by the
// password, so changing MINA_PASSWORD signs everyone out.
const COOKIE = "mina_auth";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function password(): string | undefined {
  return process.env.MINA_PASSWORD || undefined;
}

function token(secret: string): string {
  return createHmac("sha256", secret).update("mina-web-session-v1").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function isSignedIn(req: Request): boolean {
  const secret = password();
  const cookie = readCookie(req, COOKIE);
  return Boolean(secret && cookie && safeEqual(cookie, token(secret)));
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!password()) {
    return res.status(503).json({ error: "MINA_PASSWORD is not set on the server, so Mina is locked." });
  }
  if (!isSignedIn(req)) return res.status(401).json({ error: "Sign in first." });
  next();
}

// Slow down password guessing: at most 10 failed attempts per IP per 15 minutes.
const failures = new Map<string, { count: number; since: number }>();
const WINDOW_MS = 15 * 60 * 1000;

export function login(req: Request, res: Response) {
  const secret = password();
  if (!secret) {
    return res.status(503).json({ error: "MINA_PASSWORD is not set on the server, so Mina is locked." });
  }
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const entry = failures.get(ip);
  if (entry && now - entry.since < WINDOW_MS && entry.count >= 10) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }

  const given = typeof req.body?.password === "string" ? req.body.password : "";
  if (!safeEqual(token(given), token(secret))) {
    const fresh = !entry || now - entry.since >= WINDOW_MS;
    failures.set(ip, { count: fresh ? 1 : entry.count + 1, since: fresh ? now : entry.since });
    return res.status(401).json({ error: "That password isn't right." });
  }

  failures.delete(ip);
  res.cookie(COOKIE, token(secret), {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    maxAge: MAX_AGE_MS,
    path: "/",
  });
  res.json({ ok: true });
}

export function logout(_req: Request, res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
}
