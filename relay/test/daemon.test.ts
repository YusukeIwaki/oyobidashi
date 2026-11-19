import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, startServe, type ServeHandle } from "../src/cli.ts";
import { configPath, readConfig } from "../src/config.ts";
import { ensureRelayRunning } from "../src/daemon.ts";

const temps: string[] = [];
const handles: ServeHandle[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "oyobidashi-daemon-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const quiet = { out: () => {}, err: () => {} };
async function serve(home: string): Promise<ServeHandle> {
  const handle = await startServe({ port: 0, host: "127.0.0.1" }, { env: { OYOBIDASHI_HOME: home }, ...quiet });
  handles.push(handle);
  return handle;
}

describe("ensureRelayRunning", () => {
  test("a relay that is already running is reused, not started again", async () => {
    const home = tempHome();
    const running = await serve(home);
    const spawned: string[][] = [];
    const relay = await ensureRelayRunning({ env: { OYOBIDASHI_HOME: home }, spawnDetached: (argv) => void spawned.push(argv) });
    expect(spawned).toEqual([]);
    expect(relay).toEqual({ home, port: running.port, agentToken: readConfig(home)!.agent_token, started: false, state: "ready" });
  });

  test("no relay → creates the config, starts `<command> serve` and waits until it answers", async () => {
    const home = tempHome();
    const spawned: string[][] = [];
    const relay = await ensureRelayRunning({
      env: { OYOBIDASHI_HOME: home },
      command: ["/path/to/oyobidashi"],
      pollIntervalMs: 10,
      spawnDetached: (argv, spawnHome) => {
        spawned.push(argv);
        expect(spawnHome).toBe(home);
        void serve(home);
      },
    });
    expect(spawned).toEqual([["/path/to/oyobidashi", "serve"]]);
    expect(relay.started).toBe(true);
    expect(relay.state).toBe("ready");
    expect(relay.port).toBe(handles[0]!.port);
    expect(relay.agentToken).toBe(readConfig(home)!.agent_token);
  });

  test("a relay that never comes up is reported as a timeout", async () => {
    const home = tempHome();
    writeFileSync(configPath(home), JSON.stringify({ port: 1, agent_token: "ka_x" }), { mode: 0o600 });
    const relay = await ensureRelayRunning({ env: { OYOBIDASHI_HOME: home }, timeoutMs: 50, pollIntervalMs: 10, spawnDetached: () => {} });
    expect(relay).toMatchObject({ started: true, state: "timeout", port: 1, agentToken: "ka_x" });
  });

  test("another home's relay on the configured port is reported as foreign and left alone", async () => {
    const other = await serve(tempHome());
    const home = tempHome();
    writeFileSync(configPath(home), JSON.stringify({ port: other.port, agent_token: "ka_mine" }), { mode: 0o600 });
    const spawned: string[][] = [];
    const relay = await ensureRelayRunning({ env: { OYOBIDASHI_HOME: home }, spawnDetached: (argv) => void spawned.push(argv) });
    expect(spawned).toEqual([]);
    expect(relay).toMatchObject({ started: false, state: "foreign", port: other.port });
  });
});

describe("single-binary CLI wording", () => {
  test("usage and hints name the binary instead of `bun run`", async () => {
    const home = join(tempHome(), "fresh");
    const out: string[] = [];
    const deps = { env: { OYOBIDASHI_HOME: home }, out: (l: string) => out.push(l), err: () => {}, program: "oyobidashi", extraUsage: "  mcp   MCP" };
    expect(await runCli(["help"], deps)).toBe(0);
    expect(out.join("\n")).toContain("Usage: oyobidashi <command> [options]");
    expect(out.join("\n")).toContain("Commands:\n  mcp   MCP\n  serve");
    out.length = 0;
    expect(await runCli(["status"], deps)).toBe(0);
    expect(out.join("\n")).toContain("`oyobidashi serve`");
  });

  test("stop without a running relay is a no-op, and never signals a relay in this process", async () => {
    const home = tempHome();
    const out: string[] = [];
    const err: string[] = [];
    const deps = { env: { OYOBIDASHI_HOME: home }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await runCli(["stop"], deps)).toBe(0);
    expect(out).toEqual(["relay は起動していません。"]);
    await serve(home);
    expect(await runCli(["stop"], deps)).toBe(1);
    expect(err[0]).toContain("同じプロセス内");
  });
});
