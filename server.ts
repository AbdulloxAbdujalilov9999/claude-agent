import "dotenv/config";
import express from "express";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

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
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
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
  console.log(`Agent server listening on port ${port}`);
});
