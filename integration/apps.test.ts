// 結合テスト: アプリの通信クライアント (iOS: OyobidashiKit / Android: core) を本物の relay に接続する。
// アプリのUI・Push・音声認識は対象外 (実機が必要)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const RELAY_CLI = join(ROOT, "relay/src/cli.ts");

let home: string;
let port: number;
let relay: Subprocess;
let env: Record<string, string>;
let agentToken: string;

async function run(cmd: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd, env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, output: out + err };
}

async function newPairingUri(): Promise<string> {
  const { output } = await run(["bun", "run", RELAY_CLI, "pair"], ROOT);
  const m = output.match(/oyobidashi:\/\/pair\?\S+/);
  if (!m) throw new Error("no pairing uri in: " + output);
  return m[0];
}

async function agent(path: string, init: RequestInit = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${agentToken}` },
  });
  return (await r.json()) as any;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "oyobidashi-apps-"));
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  port = s.port!;
  await s.stop(true);
  env = { ...(process.env as Record<string, string>), OYOBIDASHI_HOME: home };
  relay = Bun.spawn(["bun", "run", RELAY_CLI, "serve", "--port", String(port)], { env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
    await Bun.sleep(50);
  }
  agentToken = (await Bun.file(join(home, "config.json")).json()).agent_token;
});

afterAll(async () => {
  relay?.kill("SIGINT");
  await relay?.exited;
  rmSync(home, { recursive: true, force: true });
});

async function scenario(label: string, cmd: string[], cwd: string, expectedAnswer: string) {
  const subject = `${label} 呼び出しの用件`;
  const created = await agent("/v1/requests", {
    method: "POST",
    body: JSON.stringify({ question: `${label} クライアントへの質問`, subject, choices: ["はい", "いいえ"], agent: { name: "apps-e2e" } }),
  });
  const id = created.request.id as string;
  const uri = await newPairingUri();
  const waiting = agent(`/v1/requests/${id}?wait=280`);
  const result = await run(cmd, cwd, { OYOBIDASHI_LIVE_PAIRING_URI: uri, OYOBIDASHI_LIVE_REQUEST_ID: id, OYOBIDASHI_LIVE_SUBJECT: subject });
  if (result.code !== 0) console.error(result.output.slice(-4000));
  expect(result.code).toBe(0);
  // スキップされていないこと (環境変数が届いて実際に走ったこと) は、エージェント側に回答が届くことで確認する
  const final = (await waiting).request;
  expect(final.status).toBe("answered");
  expect(final.subject).toBe(subject);
  expect(final.answer.text).toBe(expectedAnswer);
  expect(final.answer.input_method).toBe("voice");
  // クライアントが最後にペアリング解除しているので、デバイスは残っていない
  const devices = await run(["bun", "run", RELAY_CLI, "devices"], ROOT);
  expect(devices.output).not.toContain(final.answer.device_id);
}

describe("アプリの通信クライアント ↔ 本物の relay", () => {
  test("iOS (OyobidashiKit / URLSession)", async () => {
    await scenario("iOS", ["swift", "test", "--filter", "LiveRelayTests"], join(ROOT, "ios/OyobidashiKit"), "iOSから回答");
  }, 600_000);

  test("Android (core / OkHttp)", async () => {
    await scenario(
      "Android",
      ["./gradlew", ":core:test", "--tests", "*LiveRelayTest", "--rerun-tasks", "-q"],
      join(ROOT, "android"),
      "Androidから回答",
    );
  }, 600_000);
});
