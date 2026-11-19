import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { isServing, localHost, readServeState } from "./cli.ts";
import { loadOrCreateConfig, readConfig, resolveHome } from "./config.ts";

export const relayLogPath = (home: string) => join(home, "relay.log");

export interface EnsureRelayDeps {
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** argv that runs this program's own CLI (`serve` is appended). Defaults to {@link selfCommand}. */
  command?: string[];
  /** Starts the relay in the background; injectable for tests. */
  spawnDetached?: (argv: string[], home: string) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface EnsuredRelay {
  home: string;
  port: number;
  agentToken: string;
  /** True when this call launched the relay. */
  started: boolean;
  /** "ready": our relay answers. "foreign": another relay (different home) holds the port. "timeout": nothing answered in time. */
  state: "ready" | "foreign" | "timeout";
}

/** argv[0..] that re-runs this program: the binary itself when compiled, `bun <entry>` from source. */
export function selfCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");
  return compiled ? [process.execPath] : [process.execPath, Bun.main];
}

/** Launches `<command> serve` in its own session so it outlives the MCP process that started it. */
function spawnRelay(argv: string[], home: string): void {
  const log = openSync(relayLogPath(home), "a", 0o600);
  try {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: home,
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

/**
 * Makes sure a relay for `$OYOBIDASHI_HOME` is running and reports how to reach it.
 * Several MCP processes may race here: each spawns a relay, one binds the port and the
 * others exit on the bind error, so all of them end up observing the same relay.
 */
export async function ensureRelayRunning(deps: EnsureRelayDeps = {}): Promise<EnsuredRelay> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? fetch;
  const home = resolveHome(env);
  const first = loadOrCreateConfig(home).config;

  const probe = async (): Promise<Pick<EnsuredRelay, "port" | "agentToken" | "state">> => {
    // Re-read each time: the relay (or a racing MCP process) may have rewritten the port or token.
    const config = readConfig(home) ?? first;
    const serve = readServeState(home);
    const host = localHost(serve?.host);
    const port = serve?.port ?? config.port;
    const base = { port, agentToken: config.agent_token };
    if (!(await isServing(host, port, fetchFn))) return { ...base, state: "timeout" };
    try {
      const res = await fetchFn(`http://${host}:${port}/v1/presence`, {
        headers: { authorization: `Bearer ${config.agent_token}` },
        signal: AbortSignal.timeout(1000),
      });
      await res.body?.cancel();
      return { ...base, state: res.ok ? "ready" : "foreign" };
    } catch {
      return { ...base, state: "timeout" };
    }
  };

  let current = await probe();
  if (current.state !== "timeout") return { home, started: false, ...current };

  (deps.spawnDetached ?? spawnRelay)([...(deps.command ?? selfCommand()), "serve"], home);
  const deadline = Date.now() + (deps.timeoutMs ?? 10_000);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, deps.pollIntervalMs ?? 100));
    current = await probe();
    if (current.state !== "timeout" || Date.now() >= deadline) return { home, started: true, ...current };
  }
}
