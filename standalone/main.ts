#!/usr/bin/env bun
/**
 * Entry point of the self-built single binary (see build.ts): the relay CLI plus an `mcp`
 * command that serves MCP over stdio and starts the relay in the background when needed.
 */
import { runCli } from "../relay/src/cli.ts";
import { ensureRelayRunning, relayLogPath } from "../relay/src/daemon.ts";

const PROGRAM = "oyobidashi";
const EXTRA_USAGE = "  mcp                                                 stdio MCP サーバーとして起動する (中継サーバーが未起動なら裏で起動する)";

async function runMcp(): Promise<void> {
  const note = (message: string) => void process.stderr.write(`[oyobidashi] ${message}\n`);
  // An explicitly configured relay is used as is; otherwise this binary's own relay is the target,
  // even when cloud credentials exist in the same home.
  if (!process.env.OYOBIDASHI_RELAY_URL?.trim()) {
    const relay = await ensureRelayRunning();
    if (relay.started && relay.state === "ready") note(`relay を起動しました (port ${relay.port}, log: ${relayLogPath(relay.home)})`);
    if (relay.state === "foreign") note(`警告: port ${relay.port} では別の設定 (OYOBIDASHI_HOME) の relay が動いています。そちらを停止するか、同じ OYOBIDASHI_HOME を指定してください。`);
    if (relay.state === "timeout") note(`警告: relay が起動しませんでした。${relayLogPath(relay.home)} を確認してください。`);
    process.env.OYOBIDASHI_RELAY_URL = `http://127.0.0.1:${relay.port}`;
    process.env.OYOBIDASHI_AGENT_TOKEN = relay.agentToken;
  }
  await import("../mcp/src/index.ts");
}

const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
  await runMcp();
} else {
  process.exit(await runCli(argv, { program: PROGRAM, extraUsage: EXTRA_USAGE }));
}
