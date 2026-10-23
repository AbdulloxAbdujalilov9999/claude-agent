import Anthropic from "@anthropic-ai/sdk";

// User-scoped keys (sk-ant-usr-...) must name a workspace on every request.
const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
const client = new Anthropic(
  workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}
);

// $2 per session by default — a session is a cumulative spend cap across every
// message sent in it, not a per-message cap. Raise MINA_SESSION_BUDGET_CENTS
// in Render's env vars if a conversation needs more room.
const BUDGET_CENTS = process.env.MINA_SESSION_BUDGET_CENTS ?? "200";

export class MinaConfigError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new MinaConfigError(`${name} is not set`);
  return value;
}

type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
type StreamEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;

// The compact shape the web app renders. One server event maps to at most one UI event.
export type UiEvent =
  | { t: "user"; id: string; text: string }
  | { t: "start"; id: string }
  | { t: "delta"; id: string; text: string }
  | { t: "text"; id: string; text: string }
  | { t: "thinking" }
  | { t: "tool"; id: string; name: string; input: unknown; ask: boolean; denied: boolean }
  | { t: "tool_result"; toolUseId: string; isError: boolean; preview: string }
  | { t: "confirmed"; toolUseId: string; result: "allow" | "deny" }
  | { t: "error"; message: string }
  | { t: "status"; status: "running" | "idle" | "waiting" }
  | { t: "done"; reason: string };

// What the sidebar shows: working (glitch dot), waiting on Abdulloh (orange), done (blue).
export type SessionState = "new" | "working" | "waiting" | "done" | "ended";

export interface SessionSummary {
  id: string;
  title: string;
  status: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
}

function textOf(blocks: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
  if (!blocks) return "";
  return blocks.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
}

function preview(value: string, max = 400): string {
  return value.length > max ? value.slice(0, max) + "…" : value;
}

export function toUiEvent(event: SessionEvent | StreamEvent): UiEvent | null {
  switch (event.type) {
    case "user.message":
      return { t: "user", id: event.id, text: textOf(event.content) };
    case "event_start":
      return event.event.type === "agent.message" ? { t: "start", id: event.event.id } : null;
    case "event_delta": {
      const content = event.delta.content as { type: string; text?: string };
      return content.type === "text" && content.text
        ? { t: "delta", id: event.event_id, text: content.text }
        : null;
    }
    case "agent.message":
      return { t: "text", id: event.id, text: textOf(event.content) };
    case "agent.thinking":
      return { t: "thinking" };
    case "agent.tool_use":
    case "agent.mcp_tool_use":
      return {
        t: "tool",
        id: event.id,
        name: event.name,
        input: event.input,
        ask: event.evaluated_permission === "ask",
        denied: event.evaluated_permission === "deny",
      };
    case "agent.custom_tool_use":
      return { t: "tool", id: event.id, name: event.name, input: event.input, ask: false, denied: false };
    case "agent.tool_result":
      return {
        t: "tool_result",
        toolUseId: event.tool_use_id,
        isError: Boolean(event.is_error),
        preview: preview(textOf(event.content)),
      };
    case "agent.mcp_tool_result":
      return {
        t: "tool_result",
        toolUseId: event.mcp_tool_use_id,
        isError: Boolean(event.is_error),
        preview: preview(textOf(event.content)),
      };
    case "user.tool_confirmation":
      return { t: "confirmed", toolUseId: event.tool_use_id, result: event.result };
    case "session.error": {
      const err = event.error as { message?: string; type?: string };
      return { t: "error", message: err.message ?? err.type ?? "Something went wrong." };
    }
    case "session.status_running":
      return { t: "status", status: "running" };
    case "session.status_idle":
      return event.stop_reason.type === "requires_action"
        ? { t: "status", status: "waiting" }
        : { t: "status", status: "idle" };
    default:
      return null;
  }
}

function stateOf(s: Anthropic.Beta.Sessions.BetaManagedAgentsSession): SessionState {
  if (s.status === "running" || s.status === "rescheduling") return "working";
  if (s.status === "terminated") return "ended";
  const saved = s.metadata?.mina_state;
  return saved === "waiting" || saved === "done" ? saved : "new";
}

// The API doesn't say whether an idle session is paused on an approval, so runTurn
// records it in the session's metadata, where every device can read it.
async function saveState(sessionId: string, state: "waiting" | "done"): Promise<void> {
  try {
    await client.beta.sessions.update(sessionId, { metadata: { mina_state: state } });
  } catch (err) {
    console.error("Couldn't save session state", err);
  }
}

function toSummary(s: Anthropic.Beta.Sessions.BetaManagedAgentsSession): SessionSummary {
  return {
    id: s.id,
    title: s.title || "New conversation",
    status: s.status,
    state: stateOf(s),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

export async function listSessions(): Promise<SessionSummary[]> {
  const agentId = requireEnv("MINA_AGENT_ID");
  const page = await client.beta.sessions.list({ agent_id: agentId, limit: 50 });
  return page.data.map(toSummary);
}

export async function createSession(title?: string): Promise<SessionSummary> {
  const agentId = requireEnv("MINA_AGENT_ID");
  const environmentId = requireEnv("MINA_ENVIRONMENT_ID");
  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: agentId },
    environment_id: environmentId,
    title: title ?? null,
    budget: { type: "limit", max_list_cost: { amount: BUDGET_CENTS, currency: "USD" } },
  });
  return toSummary(session);
}

export async function renameSession(sessionId: string, title: string): Promise<SessionSummary> {
  return toSummary(await client.beta.sessions.update(sessionId, { title }));
}

export async function archiveSession(sessionId: string): Promise<void> {
  await client.beta.sessions.archive(sessionId);
}

export async function getHistory(sessionId: string): Promise<{ session: SessionSummary; events: UiEvent[] }> {
  const session = toSummary(await client.beta.sessions.retrieve(sessionId));
  const events: UiEvent[] = [];
  for await (const event of client.beta.sessions.events.list(sessionId)) {
    const ui = toUiEvent(event);
    if (ui && ui.t !== "status" && ui.t !== "thinking") events.push(ui);
  }
  return { session, events };
}

export async function confirmTool(
  sessionId: string,
  toolUseId: string,
  result: "allow" | "deny",
  denyMessage?: string
): Promise<void> {
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.tool_confirmation",
        tool_use_id: toolUseId,
        result,
        ...(result === "deny" && denyMessage ? { deny_message: denyMessage } : {}),
      },
    ],
  });
}

export async function interrupt(sessionId: string): Promise<void> {
  await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
}

/**
 * Follow a session's live stream, optionally sending a user message first, and pass each
 * UI event to `emit`. Keeps going through approval pauses (requires_action) so a tool the
 * user approves from the web app carries on in the same stream. Returns when the turn ends
 * or `signal` aborts (the browser went away).
 */
export async function runTurn(
  sessionId: string,
  emit: (event: UiEvent) => void,
  opts: { message?: string; signal?: AbortSignal; denyApprovals?: boolean } = {}
): Promise<void> {
  // Stream-first: open the stream before sending, so no early events are missed.
  const stream = await client.beta.sessions.events.stream(
    sessionId,
    { event_deltas: ["agent.message"] },
    { signal: opts.signal }
  );
  if (opts.message) {
    await client.beta.sessions.events.send(sessionId, {
      events: [{ type: "user.message", content: [{ type: "text", text: opts.message }] }],
    });
  }

  for await (const event of stream) {
    const ui = toUiEvent(event);
    // The browser already shows the message it sent.
    if (ui && ui.t !== "user") emit(ui);

    if (
      opts.denyApprovals &&
      (event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use") &&
      event.evaluated_permission === "ask"
    ) {
      // Nobody is watching this turn, so nothing that needs approval may run.
      await confirmTool(sessionId, event.id, "deny", "Approvals need the Mina web app; this request came from the API.");
    } else if (event.type === "agent.custom_tool_use") {
      // Custom tools aren't wired into the web app yet; answer so the session doesn't hang.
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{ type: "text", text: `The tool "${event.name}" isn't available in this app yet.` }],
            is_error: true,
          },
        ],
      });
    } else if (event.type === "session.status_terminated") {
      emit({ t: "done", reason: "terminated" });
      return;
    } else if (event.type === "session.status_idle" && event.stop_reason.type === "requires_action") {
      await saveState(sessionId, "waiting");
    } else if (event.type === "session.status_idle") {
      await saveState(sessionId, "done");
      emit({ t: "done", reason: event.stop_reason.type });
      return;
    }
  }
}

export async function chatWithMina(
  message: string,
  sessionId?: string
): Promise<{ sessionId: string; reply: string }> {
  const sid = sessionId ?? (await createSession()).id;
  let reply = "";
  await runTurn(
    sid,
    (event) => {
      if (event.t === "text") reply += event.text;
    },
    { message, denyApprovals: true }
  );
  return { sessionId: sid, reply: reply || "(Mina didn't send a text reply for this turn.)" };
}
