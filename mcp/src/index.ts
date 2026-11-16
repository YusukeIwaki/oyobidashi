#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

// stdout carries the MCP protocol only. Route any stray console output to stderr.
const toStderr = (...args: unknown[]) => {
  process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ")}\n`);
};
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;

const server = createServer();
const transport = new StdioServerTransport();

const shutdown = () => {
  void server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

try {
  await server.connect(transport);
} catch (e) {
  process.stderr.write(`[oyobidashi-mcp] failed to start: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
}
