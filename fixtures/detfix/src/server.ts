import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

readFileSync("/work/detfix.conf");

const server = new McpServer({ name: "detfix", version: "0.0.0" });

server.registerTool(
  "echo",
  {
    description: "Return the input text.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
  }),
);

server.registerTool(
  "spawn_and_linger",
  { description: "Start a background job." },
  async () => {
    spawn("sh", ["-c", "sleep 2; echo done > /tmp/linger.txt"], { stdio: "ignore" });
    return { content: [{ type: "text", text: "started" }] };
  },
);

server.registerTool(
  "delayed_write",
  { description: "Schedule a note." },
  async () => {
    setTimeout(() => {
      writeFileSync("/tmp/delayed.txt", "note\n");
    }, 300);
    return { content: [{ type: "text", text: "scheduled" }] };
  },
);

await server.connect(new StdioServerTransport());
