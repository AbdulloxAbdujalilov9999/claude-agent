import pg from "pg";
import webpush from "web-push";

// Push notifications that reach Abdulloh's devices even when Mina is closed.
// Needs DATABASE_URL (Supabase Postgres). The VAPID keys are generated on first boot and
// kept in the database, so no push secret has to be copied around by hand.

const url = process.env.DATABASE_URL;
const local = url ? /@(localhost|127\.0\.0\.1)[:/]/.test(url) : false;
// Supabase requires TLS; its pooler certificate isn't in Node's default CA list.
const pool = url ? new pg.Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 3 }) : null;

let ready: Promise<string | null> | null = null;

async function setup(): Promise<string | null> {
  if (!pool) return null;
  await pool.query(`
    create table if not exists mina_settings (key text primary key, value text not null, updated_at timestamptz not null default now());
    create table if not exists mina_push_subscriptions (
      endpoint text primary key, p256dh text not null, auth text not null, user_agent text,
      created_at timestamptz not null default now(), last_seen timestamptz not null default now()
    );`);
  const { rows } = await pool.query("select value from mina_settings where key = 'vapid'");
  let keys: { publicKey: string; privateKey: string };
  if (rows.length) {
    keys = JSON.parse(rows[0].value);
  } else {
    keys = webpush.generateVAPIDKeys();
    // If two instances race, keep whichever landed first.
    await pool.query("insert into mina_settings (key, value) values ('vapid', $1) on conflict (key) do nothing", [JSON.stringify(keys)]);
    keys = JSON.parse((await pool.query("select value from mina_settings where key = 'vapid'")).rows[0].value);
  }
  webpush.setVapidDetails("mailto:mina@claude-agent-demo.onrender.com", keys.publicKey, keys.privateKey);
  return keys.publicKey;
}

/** The public VAPID key browsers subscribe with, or null when push isn't configured. */
export function pushPublicKey(): Promise<string | null> {
  ready ??= setup().catch((err) => {
    console.error("Push setup failed", err);
    ready = null;
    return null;
  });
  return ready;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function saveSubscription(sub: BrowserSubscription, userAgent?: string): Promise<void> {
  if (!pool || !(await pushPublicKey())) throw new Error("Push isn't configured on the server.");
  await pool.query(
    `insert into mina_push_subscriptions (endpoint, p256dh, auth, user_agent) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, last_seen = now()`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 300) ?? null]
  );
}

export async function removeSubscription(endpoint: string): Promise<void> {
  if (pool) await pool.query("delete from mina_push_subscriptions where endpoint = $1", [endpoint]);
}

export interface PushMessage {
  title: string;
  body: string;
  sessionId: string;
  kind: "done" | "waiting" | "ended";
}

/** Sends to every subscribed device. Never throws: a failed ping must not break a turn. */
export async function pushToAll(message: PushMessage): Promise<void> {
  try {
    if (!pool || !(await pushPublicKey())) return;
    const { rows } = await pool.query("select endpoint, p256dh, auth from mina_push_subscriptions");
    const payload = JSON.stringify(message);
    await Promise.all(
      rows.map(async (r) => {
        try {
          await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, {
            TTL: 60 * 60,
            urgency: message.kind === "waiting" ? "high" : "normal",
          });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410: the browser dropped this subscription (app uninstalled, permission revoked).
          if (status === 404 || status === 410) await removeSubscription(r.endpoint);
          else console.error("Push failed", status ?? err);
        }
      })
    );
  } catch (err) {
    console.error("Push failed", err);
  }
}
