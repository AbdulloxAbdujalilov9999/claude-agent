import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

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

export async function chatWithMina(
  message: string,
  sessionId?: string
): Promise<{ sessionId: string; reply: string }> {
  const agentId = requireEnv("MINA_AGENT_ID");
  const environmentId = requireEnv("MINA_ENVIRONMENT_ID");

  let sid = sessionId;
  if (!sid) {
    const session = await client.beta.sessions.create({
      agent: { type: "agent", id: agentId },
      environment_id: environmentId,
      budget: { type: "limit", max_list_cost: { amount: BUDGET_CENTS, currency: "USD" } },
    });
    sid = session.id;
  }

  // Stream-first: open the stream before sending, so no early events are missed.
  const stream = await client.beta.sessions.events.stream(sid);
  await client.beta.sessions.events.send(sid, {
    events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
  });

  let reply = "";
  for await (const event of stream) {
    if (event.type === "agent.message") {
      for (const block of event.content) {
        if (block.type === "text") reply += block.text;
      }
    } else if (event.type === "session.status_terminated") {
      break;
    } else if (event.type === "session.status_idle") {
      if (event.stop_reason.type !== "requires_action") break;
    }
  }

  return { sessionId: sid, reply: reply || "(Mina didn't send a text reply for this turn.)" };
}
