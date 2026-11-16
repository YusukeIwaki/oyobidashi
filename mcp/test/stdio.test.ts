import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closedPort, FakeRelay, fixture } from "./helpers.ts";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Spawns the real server process and speaks raw newline-delimited JSON-RPC to it. */
function spawnServer(env: Record<string, string>, cwd?: string) {
  const proc = Bun.spawn(["bun", "run", ENTRY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd ? { cwd } : {}),
    // deliberately minimal env: nothing from the developer's real oyobidashi setup leaks in
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  cleanups.push(() => {
    proc.kill();
  });

  let stdout = "";
  const messages: any[] = [];
  const waiters: { id: number; resolve: (m: any) => void }[] = [];
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      stdout += text;
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // judged later by the stdout purity assertion
        }
        messages.push(message);
        const index = waiters.findIndex((w) => w.id === message.id);
        if (index >= 0) waiters.splice(index, 1)[0]!.resolve(message);
      }
    }
  })();
  const stderr = new Response(proc.stderr).text();

  const send = (message: unknown) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method} within 10s; stdout so far: ${stdout}`)), 10_000);
      waiters.push({
        id,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
    send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return response;
  };
  const initialize = async (clientName = "stdio-test-client") => {
    const response = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return response;
  };
  /** Closes stdin and returns everything the process wrote. */
  const finish = async () => {
    proc.stdin.end();
    const exitCode = await Promise.race([proc.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000))]);
    if (exitCode === "timeout") proc.kill();
    await pump;
    return { stdout, stderr: await stderr, exitCode, messages };
  };
  return { request, send, initialize, finish };
}

/** Every non-empty stdout line must be a JSON-RPC 2.0 message. */
function expectOnlyJsonRpc(stdout: string): any[] {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  expect(lines.length).toBeGreaterThan(0);
  return lines.map((line) => {
    let message: any;
    expect(() => (message = JSON.parse(line)), `stdout line is not JSON: ${line}`).not.toThrow();
    expect(message.jsonrpc).toBe("2.0");
    expect("id" in message || "method" in message).toBe(true);
    return message;
  });
}

describe("real stdio server process", () => {
  test("initialize + tools/list + tools/call against a fake relay; stdout is pure JSON-RPC", async () => {
    const relay = new FakeRelay();
    const http = relay.serve();
    cleanups.push(http.stop);
    relay.resolveAfter(300);
    const workdir = mkdtempSync(join(tmpdir(), "oyobidashi-mcp-cwd-"));
    cleanups.push(() => rmSync(workdir, { recursive: true, force: true }));

    const server = spawnServer(
      {
        OYOBIDASHI_RELAY_URL: http.url,
        OYOBIDASHI_AGENT_TOKEN: relay.token,
        OYOBIDASHI_HOME: join(workdir, "no-home"),
        // garbage on purpose: forces a diagnostic log line, which must go to stderr
        OYOBIDASHI_DEFAULT_WAIT_SECONDS: "not-a-number",
      },
      workdir,
    );

    const init = await server.initialize("stdio-test-client");
    expect(init.result.serverInfo.name).toBe("oyobidashi");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.instructions).toContain("ask_human");

    const list = await server.request("tools/list", {});
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(
      ["ask_human", "cancel_request", "get_human_status", "notify_human", "update_request", "wait_for_answer"].sort(),
    );

    const called = await server.request("tools/call", { name: "ask_human", arguments: { question: "本番DBのマイグレーションを実行してよいですか?", choices: ["はい", "いいえ"] } });
    expect(called.error).toBeUndefined();
    expect(called.result.isError).toBeFalsy();
    expect(called.result.structuredContent).toEqual({ status: "answered", request_id: "req_01JCXYZ", answer: "はい", input_method: "choice", choice_index: 0, priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(called.result.content[0].text).toContain("はい");

    // what the real process sent to the relay
    expect(relay.creates).toHaveLength(1);
    const { realpathSync } = await import("node:fs");
    expect(relay.creates[0]!.body).toEqual({
      kind: "question",
      question: "本番DBのマイグレーションを実行してよいですか?",
      choices: ["はい", "いいえ"],
      agent: { name: "stdio-test-client", cwd: realpathSync(workdir) },
    });
    expect(relay.creates[0]!.headers.get("authorization")).toBe(`Bearer ${relay.token}`);
    expect(relay.creates[0]!.headers.has("x-forwarded-for")).toBe(false);
    expect(relay.creates[0]!.headers.has("x-forwarded-host")).toBe(false);
    expect(relay.gets[0]!.query.get("wait")).toBe("30");

    const notify = await server.request("tools/call", { name: "notify_human", arguments: { message: "ビルドが完了しました" } });
    expect(notify.result.structuredContent).toEqual({ status: "notified", request_id: "req_01JCNTF", priority: "normal", delivery_mode: "text", requested_mode: "auto" });

    const out = await server.finish();
    expect(out.exitCode).toBe(0); // exits cleanly when the client closes stdin
    const messages = expectOnlyJsonRpc(out.stdout);
    expect(messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(out.stderr).toContain("[oyobidashi-mcp] OYOBIDASHI_DEFAULT_WAIT_SECONDS=\"not-a-number\" is not a number");
    expect(out.stdout).not.toContain("[oyobidashi-mcp]");
    expect(out.stdout).not.toContain("is not a number");
  }, 30_000);

  test("reads $OYOBIDASHI_HOME/config.json; errors (relay down, bad input, bad JSON-RPC) stay on the protocol", async () => {
    const home = mkdtempSync(join(tmpdir(), "oyobidashi-mcp-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const port = await closedPort();
    writeFileSync(join(home, "config.json"), JSON.stringify({ port, agent_token: "ka_from_file" }), { mode: 0o600 });

    const server = spawnServer({ OYOBIDASHI_HOME: home });
    await server.initialize();

    // relay is not running yet
    const down = await server.request("tools/call", { name: "ask_human", arguments: { question: "q" } });
    expect(down.result.isError).toBe(true);
    expect(down.result.structuredContent.error_code).toBe("relay_unreachable");
    expect(down.result.content[0].text).toContain("cd relay && bun run serve");
    expect(down.result.content[0].text).toContain(`http://127.0.0.1:${port}`);

    // relay comes up later on the configured port: the same server process now works (lazy resolution)
    const relay = new FakeRelay();
    (relay as { token: string }).token = "ka_from_file";
    relay.current = fixture("request_answered.json");
    const http = Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => relay.handle(req) });
    cleanups.push(() => http.stop(true));
    const up = await server.request("tools/call", { name: "wait_for_answer", arguments: { request_id: "req_01JCXYZ" } });
    expect(up.result.isError).toBeFalsy();
    expect(up.result.structuredContent.answer).toBe("はい");
    expect(relay.gets[0]!.headers.get("authorization")).toBe("Bearer ka_from_file");

    const invalid = await server.request("tools/call", { name: "ask_human", arguments: { question: "" } });
    expect(invalid.result.isError).toBe(true);

    const unknownMethod = await server.request("no/such/method", {});
    expect(unknownMethod.error.code).toBe(-32601);

    const out = await server.finish();
    expectOnlyJsonRpc(out.stdout);
    expect(out.stderr).toContain("tool call failed");
    expect(out.stdout).not.toContain("[oyobidashi-mcp]");
  }, 30_000);

  test("missing config: the process still starts and lists tools; the call explains what to do", async () => {
    const home = mkdtempSync(join(tmpdir(), "oyobidashi-mcp-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const server = spawnServer({ OYOBIDASHI_HOME: home });
    await server.initialize();
    const list = await server.request("tools/list", {});
    expect(list.result.tools).toHaveLength(6);
    const result = await server.request("tools/call", { name: "notify_human", arguments: { message: "m" } });
    expect(result.result.isError).toBe(true);
    expect(result.result.structuredContent.error_code).toBe("config_missing");
    expect(result.result.content[0].text).toContain(join(home, "config.json"));
    const out = await server.finish();
    expectOnlyJsonRpc(out.stdout);
  }, 30_000);
});
