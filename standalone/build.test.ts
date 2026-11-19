import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEmbeddedPush } from "./build.ts";

const toPem = (der: ArrayBuffer) =>
  `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port!;
  await server.stop(true);
  return port;
}

let dir: string;
let buildHome: string;
let runHome: string;
let binary: string;
let port: number;

const run = (...argv: string[]) => {
  const p = Bun.spawnSync([binary, ...argv], { env: { ...process.env, OYOBIDASHI_HOME: runHome }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const healthy = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oyobidashi-standalone-"));
  buildHome = join(dir, "build-home");
  runHome = join(dir, "run-home");
  binary = join(dir, "out", "oyobidashi");
  port = await freePort();
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rsa = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  for (const home of [buildHome, runHome]) mkdirSync(home);
  writeFileSync(join(buildHome, "AuthKey_TEST.p8"), toPem(await crypto.subtle.exportKey("pkcs8", ec.privateKey)));
  writeFileSync(
    join(buildHome, "service-account.json"),
    JSON.stringify({ type: "service_account", client_email: "a@b", private_key: toPem(await crypto.subtle.exportKey("pkcs8", rsa.privateKey)), project_id: "proj-x" }),
  );
  writeFileSync(
    join(buildHome, "config.json"),
    JSON.stringify({
      port: 8787,
      agent_token: "ka_build",
      apns: { key_path: join(buildHome, "AuthKey_TEST.p8"), key_id: "KID", team_id: "TID", bundle_id: "com.example.app" },
      fcm: { service_account_path: join(buildHome, "service-account.json") },
    }),
  );
  // The machine that runs the binary has no credential files at all.
  writeFileSync(join(runHome, "config.json"), JSON.stringify({ port, agent_token: "ka_run" }), { mode: 0o600 });
});

afterAll(() => {
  if (existsSync(binary)) run("stop");
  rmSync(dir, { recursive: true, force: true });
});

describe("collectEmbeddedPush", () => {
  test("no config.json → nothing embedded, with a warning", () => {
    const logs: string[] = [];
    expect(collectEmbeddedPush(join(dir, "missing"), (l) => logs.push(l))).toEqual({});
    expect(logs).toHaveLength(1);
  });

  test("unreadable credentials and gcloud auth are skipped with a warning", () => {
    const home = mkdtempSync(join(dir, "bad-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ port: 8787, agent_token: "ka_x", apns: { key_path: join(home, "nope.p8"), key_id: "K", team_id: "T" }, fcm: { auth: "gcloud", project_id: "p" } }),
    );
    const logs: string[] = [];
    expect(collectEmbeddedPush(home, (l) => logs.push(l))).toEqual({});
    expect(logs).toHaveLength(2);
    expect(logs[0]).toStartWith("警告: APNs は埋め込みません");
    expect(logs[1]).toStartWith("警告: FCM は埋め込みません: gcloud");
  });
});

describe("single binary", () => {
  test("builds with the credentials from config.json embedded", () => {
    // Run as a separate process, the way scripts/build-binary.sh does: inside `bun test` the
    // bundler does not resolve the packages under mcp/node_modules.
    const build = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "build.ts"), "--home", buildHome, "--out", binary], { stdout: "pipe", stderr: "pipe" });
    const output = build.stdout.toString() + build.stderr.toString();
    expect(output).toContain("APNs: 埋め込み済み (key KID)");
    expect(output).toContain("FCM : 埋め込み済み");
    // Build output names what was embedded but never the key material.
    expect(output).not.toContain("PRIVATE KEY");
    expect(build.exitCode).toBe(0);
    expect(statSync(binary).mode & 0o077).toBe(0);
    rmSync(buildHome, { recursive: true, force: true });
  }, 120_000);

  test("status reports the embedded credentials without any key file", () => {
    const { code, out } = run("status");
    expect(code).toBe(0);
    expect(out).toContain("push APNs : 有効 (埋め込み)");
    expect(out).toContain("push FCM  : 有効 (埋め込み)");
    expect(out).toContain("停止中");
  });

  test("mcp starts the relay in the background, serves tools, and the relay outlives it", async () => {
    expect(await healthy()).toBe(false);
    const mcp = Bun.spawn([binary, "mcp"], { env: { ...process.env, OYOBIDASHI_HOME: runHome }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const send = (message: unknown) => {
      mcp.stdin.write(`${JSON.stringify(message)}\n`);
      mcp.stdin.flush();
    };
    const reader = mcp.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const receive = async (id: number): Promise<any> => {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.id === id) return message;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("mcp exited before answering");
        buffer += decoder.decode(value, { stream: true });
      }
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    expect((await receive(1)).result.serverInfo.name).toBeDefined();
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_human_status", arguments: {} } });
    const status = await receive(2);
    expect(status.result.isError ?? false).toBe(false);
    expect(await healthy()).toBe(true);

    reader.releaseLock();
    mcp.stdin.end();
    expect(await mcp.exited).toBe(0);
    expect(await new Response(mcp.stderr).text()).toContain("relay を起動しました");
    expect(await healthy()).toBe(true);
    expect(run("status").out).toContain("起動中");
    expect(readFileSync(join(runHome, "relay.log"), "utf8")).toContain("APNs 有効 (埋め込み) / FCM 有効 (埋め込み)");
  }, 60_000);

  test("stop shuts the background relay down", async () => {
    const { code, out } = run("stop");
    expect(code).toBe(0);
    expect(out).toContain("relay を停止しました");
    expect(await healthy()).toBe(false);
    expect(run("stop").out).toContain("relay は起動していません");
  }, 30_000);
});
