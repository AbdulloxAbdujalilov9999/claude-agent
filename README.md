# Mina

Mina is Abdulloh's chief of staff: a private chat web app on top of a Claude Managed Agent. Claude runs Mina's agent loop and her workspace; this app is the front door.

- **Chat like Claude.ai.** Replies stream in as Mina writes them. Conversations are listed in the sidebar and can be renamed or archived.
- **Approve or Deny.** When Mina wants to use a tool that needs your OK, the app shows exactly what she'll do, with Approve and Deny buttons. If you reload the page, the card is still there.
- **See her work.** Every command, file, or web step she takes shows up as a small expandable row.
- **Private.** One password. Every API route is locked until you sign in.

## How it fits together

```
Browser (public/)  ──HTTPS──▶  server.ts (Express)  ──Anthropic SDK──▶  Managed Agent "Mina"
  chat UI, approvals            password login                          agent loop + sandbox
                                SSE streaming per turn                   sessions = conversations
```

- `server.ts`: routes, Server-Sent Events streaming, static files.
- `mina.ts`: everything that talks to the Managed Agents API (sessions, events, approvals).
- `auth.ts`: password login with an HttpOnly cookie, plus a cap on failed attempts.
- `public/`: the web app. Plain HTML, CSS and JavaScript, no build step.
- `prompts/mina-system.md`: Mina's system prompt, to set on the agent.

Each conversation is a Managed Agents session. Each session has a spend cap (`MINA_SESSION_BUDGET_CENTS`, $2 by default).

## Run it locally

```bash
npm install
cp .env.example .env   # then fill it in
npm run dev            # http://localhost:3000
```

| Variable | What it is |
| --- | --- |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `MINA_AGENT_ID` | The Mina agent's id (`agent_...`) |
| `MINA_ENVIRONMENT_ID` | The environment her sessions run in (`env_...`) |
| `MINA_PASSWORD` | Password for the web app. Until it is set, the app stays locked. |
| `MINA_SESSION_BUDGET_CENTS` | Optional spend cap per conversation in US cents (default 200) |

`npm run typecheck` checks the TypeScript.

## The approval gate

The app shows an approval card for every tool call that the agent marks as needing permission (`evaluated_permission: "ask"`). Which tools ask is set **on the agent**, not in this app. Tools that can act on the outside world, like sending email, posting, paying or deleting, should use `permission_policy: { type: "always_ask" }`. For the rest, `auto` is fine.

The old JSON endpoint `POST /mina/chat` still works, behind the same login. It has nobody to ask, so it automatically denies any call that needs approval.

## Deploy (Render)

1. Create a **Web Service** from this repo. Build command: `npm install`. Start command: `npm start`.
2. Add the environment variables from the table above.
3. Open the service URL and sign in.

The free plan sleeps when idle. Mina will still work, but the first page load after a pause is slow. Check Render's current pricing before moving to an always-on plan.
