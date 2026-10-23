import "dotenv/config";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// A simple custom tool. Swap the body for whatever you want the agent to be able to do
// (call an API, query a database, read a file, etc).
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

async function main() {
  const prompt = process.argv[2] ?? "What is 19 + 23? Use the add tool to compute it.";

  for await (const message of query({
    prompt,
    options: {
      mcpServers: { "demo-tools": toolsServer },
      allowedTools: ["mcp__demo-tools__add"],
    },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    } else if (message.type === "result") {
      console.error("Agent did not finish successfully:", message.subtype);
    }
  }
}

main();
