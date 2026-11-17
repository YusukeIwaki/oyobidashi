// 結合テスト: 本物の relay (serve/pair/revoke CLI) + 本物の mcp (stdio) + スマホ役のHTTP/WebSocketクライアント。
// Push (APNs/FCM) は資格情報なしのため対象外 (WebSocket配信のみ)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Subprocess } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const RELAY_CLI = join(ROOT, "relay/src/cli.ts");
const MCP_ENTRY = join(ROOT, "mcp/src/index.ts");

let home: string;
let port: number;
let relay: Subprocess | null = null;
let mcp: Client;
let env: Record<string, string>;

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port!;
  await s.stop(true);
  return p;
}

async function startRelay(): Promise<void> {
  relay = Bun.spawn(["bun", "run", RELAY_CLI, "serve", "--port", String(port)], {
    env, stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("relay did not start");
}

async function stopRelay(): Promise<void> {
  if (!relay) return;
  relay.kill("SIGINT");
  await relay.exited;
  relay = null;
}

async function cli(...args: string[]): Promise<string> {
  const p = Bun.spawn(["bun", "run", RELAY_CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return out + err;
}

/** スマホ役 */
class Phone {
  events: any[] = [];
  ws: WebSocket | null = null;
  closed = false;
  constructor(public base: string, public token: string, public deviceId: string) {}

  static async pair(name: string, platform: "ios" | "android"): Promise<Phone> {
    const out = await cli("pair");
    const m = out.match(/oyobidashi:\/\/pair\?\S+/);
    if (!m) throw new Error("no pairing uri in: " + out);
    const u = new URL(m[0]);
    const base = u.searchParams.get("url")!;
    const code = u.searchParams.get("code")!;
    const r = await fetch(`${base}/v1/pair`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device_name: name, platform }),
    });
    expect(r.status).toBe(201);
    const j: any = await r.json();
    return new Phone(base, j.device_token, j.device.id);
  }

  async connect(): Promise<void> {
    const url = this.base.replace(/^http/, "ws") + "/v1/events";
    // Bun の WebSocket はヘッダー指定可
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.token}` } } as any);
    this.ws = ws;
    ws.onmessage = (e) => this.events.push(JSON.parse(String(e.data)));
    ws.onclose = () => { this.closed = true; };
    await this.waitEvent((e) => e.type === "hello");
  }

  async waitEvent(pred: (e: any) => boolean, timeoutMs = 5000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const i = this.events.findIndex(pred);
      if (i >= 0) return this.events.splice(i, 1)[0];
      await Bun.sleep(20);
    }
    throw new Error("event not received; got " + JSON.stringify(this.events));
  }

  api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.base + path, {
      ...init,
      headers: { "content-type": "application/json", Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    });
  }

  answer(id: string, body: object): Promise<Response> {
    return this.api(`/v1/requests/${id}/answer`, { method: "POST", body: JSON.stringify(body) });
  }
}

const call = async (name: string, args: object) => {
  const r: any = await mcp.callTool({ name, arguments: args as any }, undefined, { timeout: 120_000 });
  return { isError: !!r.isError, sc: r.structuredContent as any, text: (r.content?.[0]?.text ?? "") as string };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "oyobidashi-e2e-"));
  port = await freePort();
  env = { ...(process.env as Record<string, string>), OYOBIDASHI_HOME: home };
  delete env.OYOBIDASHI_RELAY_URL; delete env.OYOBIDASHI_AGENT_TOKEN; delete env.OYOBIDASHI_DEFAULT_WAIT_SECONDS;
  await startRelay();
  mcp = new Client({ name: "e2e-agent", version: "0.0.1" });
  await mcp.connect(new StdioClientTransport({ command: "bun", args: ["run", MCP_ENTRY], env, cwd: ROOT }));
});

afterAll(async () => {
  await mcp?.close().catch(() => {});
  await stopRelay();
  rmSync(home, { recursive: true, force: true });
});

describe("oyobidashi e2e (relay + mcp + phone)", () => {
  let phone: Phone;

  test("MCP が6つのツールを公開する", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ask_human", "cancel_request", "get_human_status", "notify_human", "update_request", "wait_for_answer"]);
  });

  test("ペアリング前: 質問は作成され、デバイス無しの警告が付く", async () => {
    const r = await call("ask_human", { question: "誰かいますか?", wait_seconds: 0 });
    expect(r.isError).toBe(false);
    expect(r.sc.status).toBe("pending");
    expect(r.sc.warning).toBeTruthy();
    await call("cancel_request", { request_id: r.sc.request_id });
  });

  test("ペアリング: QRのURLはLAN内プライベートIPで、コードは再利用できない", async () => {
    phone = await Phone.pair("e2e-iphone", "ios");
    expect(new URL(phone.base).protocol).toBe("http:");
    expect(new URL(phone.base).hostname).toMatch(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
    expect(new URL(phone.base).port).toBe(String(port));
    const bad = await fetch(`${phone.base}/v1/pair`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "0".repeat(32), device_name: "x", platform: "ios" }),
    });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as any).error.code).toBe("pairing_code_invalid");
    await phone.connect();
  });

  test("質問 → スマホが音声で回答 → エージェントに回答が返る", async () => {
    const pending = call("ask_human", { question: "次は何をしますか?", subject: "次の作業の確認", context: "テスト中", wait_seconds: 20 });
    const created = await phone.waitEvent((e) => e.type === "request.created");
    expect(created.request.question).toBe("次は何をしますか?");
    expect(created.request.subject).toBe("次の作業の確認");
    expect(created.request.context).toBe("テスト中");
    expect(created.request.status).toBe("pending");
    expect(created.request.agent.name).toBe("e2e-agent");
    expect(created.request.agent.cwd).toBe(ROOT);
    const res = await phone.answer(created.request.id, { text: "ログイン画面を直して", input_method: "voice" });
    expect(res.status).toBe(200);
    const r = await pending;
    expect(r.isError).toBe(false);
    expect(r.sc.status).toBe("answered");
    expect(r.sc.answer).toBe("ログイン画面を直して");
    expect(r.sc.input_method).toBe("voice");
    expect(r.text).toContain("ログイン画面を直して");
    const upd = await phone.waitEvent((e) => e.type === "request.updated" && e.request.id === created.request.id);
    expect(upd.request.status).toBe("answered");
    expect(upd.request.subject).toBe("次の作業の確認");
    expect(upd.request.answer.device_id).toBe(phone.deviceId);
    // 二重回答は 409
    const again = await phone.answer(created.request.id, { text: "やっぱり別の", input_method: "text" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error.code).toBe("already_resolved");
  });

  test("選択肢つき質問 → 選択で回答", async () => {
    const pending = call("ask_human", { question: "デプロイしますか?", choices: ["はい", "いいえ"], urgency: "high", wait_seconds: 20 });
    const created = await phone.waitEvent((e) => e.type === "request.created");
    expect(created.request.choices).toEqual(["はい", "いいえ"]);
    expect(created.request.urgency).toBe("high");
    const oob = await phone.answer(created.request.id, { text: "?", choice_index: 5, input_method: "choice" });
    expect(oob.status).toBe(400);
    expect((await phone.answer(created.request.id, { text: "いいえ", choice_index: 1, input_method: "choice" })).status).toBe(200);
    const r = await pending;
    expect(r.sc.status).toBe("answered");
    expect(r.sc.answer).toBe("いいえ");
    expect(r.sc.choice_index).toBe(1);
    expect(r.sc.input_method).toBe("choice");
  });

  test("待ち時間切れ → pending → wait_for_answer で回答を受け取る / 一覧取得", async () => {
    const first = await call("ask_human", { question: "あとで答えて", wait_seconds: 1 });
    expect(first.isError).toBe(false);
    expect(first.sc.status).toBe("pending");
    const id = first.sc.request_id;
    const list: any = await (await phone.api("/v1/requests?status=pending")).json();
    expect(list.requests.map((x: any) => x.id)).toContain(id);
    const waiting = call("wait_for_answer", { request_id: id, wait_seconds: 20 });
    await Bun.sleep(300);
    expect((await phone.answer(id, { text: "遅れてごめん", input_method: "text" })).status).toBe(200);
    const r = await waiting;
    expect(r.sc.status).toBe("answered");
    expect(r.sc.answer).toBe("遅れてごめん");
    phone.events.length = 0;
  });

  test("2台目をペアリング: 両方に届き、先着の回答だけが成功する", async () => {
    const phone2 = await Phone.pair("e2e-pixel", "android");
    await phone2.connect();
    const pending = call("ask_human", { question: "どちらが先?", wait_seconds: 20 });
    const c1 = await phone.waitEvent((e) => e.type === "request.created");
    const c2 = await phone2.waitEvent((e) => e.type === "request.created");
    expect(c1.request.id).toBe(c2.request.id);
    const [a, b] = await Promise.all([
      phone.answer(c1.request.id, { text: "A", input_method: "text" }),
      phone2.answer(c1.request.id, { text: "B", input_method: "text" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const r = await pending;
    expect(r.sc.answer).toBe(a.status === 200 ? "A" : "B");
    // 2台目を revoke → トークン失効、WebSocket切断
    const out = await cli("revoke", phone2.deviceId);
    expect(out).not.toMatch(/error/i);
    expect((await phone2.api("/v1/requests")).status).toBe(401);
    for (let i = 0; i < 400 && !phone2.closed; i++) await Bun.sleep(20);
    expect(phone2.closed).toBe(true);
    phone.events.length = 0;
  });

  test("cancel_request → スマホに通知され、回答は 409", async () => {
    const first = await call("ask_human", { question: "取り消される質問", wait_seconds: 0 });
    const id = first.sc.request_id;
    await phone.waitEvent((e) => e.type === "request.created" && e.request.id === id);
    const c = await call("cancel_request", { request_id: id });
    expect(c.isError).toBe(false);
    expect(c.sc.status).toBe("cancelled");
    const upd = await phone.waitEvent((e) => e.type === "request.updated" && e.request.id === id);
    expect(upd.request.status).toBe("cancelled");
    expect((await phone.answer(id, { text: "遅い", input_method: "text" })).status).toBe(409);
    const w = await call("wait_for_answer", { request_id: id, wait_seconds: 5 });
    expect(w.isError).toBe(false);
    expect(w.sc.status).toBe("cancelled");
  });

  test("notify_human → 一方向通知が届き、回答はできない", async () => {
    const r = await call("notify_human", { message: "ビルドが終わりました" });
    expect(r.isError).toBe(false);
    const ev = await phone.waitEvent((e) => e.type === "request.created" && e.request.kind === "notification");
    expect(ev.request.question).toBe("ビルドが終わりました");
    expect(ev.request.status).toBe("notified");
    expect((await phone.answer(ev.request.id, { text: "了解", input_method: "text" })).status).toBe(409);
  });

  test("MCPが在席と拒否を受け取り、優先度変更とテキスト移行を追跡する", async () => {
    expect((await phone.api("/v1/presence", {method:"PUT",body:JSON.stringify({availability:"busy",until:new Date(Date.now()+60000).toISOString()})})).status).toBe(200);
    const busy=await call("get_human_status",{});
    expect(busy.sc.devices.find((d:any)=>d.device_id===phone.deviceId).availability).toBe("busy");
    const request=await call("ask_human",{question:"通話で確認したい質問",priority:"high",delivery_mode:"call",wait_seconds:0});
    expect(request.sc.delivery_mode).toBe("text");
    await phone.api("/v1/presence", {method:"PUT",body:JSON.stringify({availability:"available",until:null})});
    const raised=await call("update_request",{request_id:request.sc.request_id,priority:"urgent",delivery_mode:"call"});
    expect(raised.sc.delivery_mode).toBe("call");
    const declined=await phone.api(`/v1/requests/${request.sc.request_id}/call`,{method:"POST",body:JSON.stringify({event:"decline"})});
    expect(declined.status).toBe(200);
    const waiting=await call("wait_for_answer",{request_id:request.sc.request_id,wait_seconds:0});
    expect(waiting.sc.delivery_mode).toBe("text");
    expect(waiting.sc.call.outcome).toBe("declined");
    const feedback=await call("get_human_status",{});
    expect(feedback.sc.recent_events.some((e:any)=>e.event==="declined" && e.device_id===phone.deviceId)).toBe(true);
    await call("cancel_request",{request_id:request.sc.request_id});
  });

  test("在席resourceの購読で人間の状態変化を受け取れる",async()=>{
    const uri="human://status";
    expect((await mcp.listResources()).resources.some(r=>r.uri===uri)).toBe(true);
    const changes:string[]=[];
    mcp.setNotificationHandler(ResourceUpdatedNotificationSchema, notification=>{changes.push(notification.params.uri);});
    await mcp.subscribeResource({uri});
    await phone.api("/v1/presence",{method:"PUT",body:JSON.stringify({availability:"away"})});
    const start=Date.now();
    while(changes.length===0 && Date.now()-start<10000) await Bun.sleep(20);
    expect(changes).toContain(uri);
    const resource=await mcp.readResource({uri});
    const content=resource.contents[0] as {text:string};
    expect(JSON.parse(content.text).devices.some((d:any)=>d.device_id===phone.deviceId && d.availability==="away")).toBe(true);
    await mcp.unsubscribeResource({uri});
    await phone.api("/v1/presence",{method:"PUT",body:JSON.stringify({availability:"available"})});
  },15000);

  test("MCPから一方向通知も取り消せる",async()=>{
    const notification=await call("notify_human",{message:"不要になったお知らせ"});
    const cancelled=await call("cancel_request",{request_id:notification.sc.request_id});
    expect(cancelled.sc.status).toBe("cancelled");
  });

  test("異常系: 存在しない request_id / 空の質問", async () => {
    const w = await call("wait_for_answer", { request_id: "req_does_not_exist", wait_seconds: 1 });
    expect(w.isError).toBe(true);
    const e = await call("ask_human", { question: "   " });
    expect(e.isError).toBe(true);
  });

  test("アクセス制御: LAN IP 経由では agent API を叩けない / デバイストークンでは質問を作れない / 転送ヘッダーは拒否", async () => {
    const cfg = await Bun.file(join(home, "config.json")).json();
    const viaLan = await fetch(`${phone.base}/v1/requests`, {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${cfg.agent_token}` },
      body: JSON.stringify({ question: "LANから" }),
    });
    expect(viaLan.status).toBe(403);
    const viaDeviceToken = await fetch(`http://127.0.0.1:${port}/v1/requests`, {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${phone.token}` },
      body: JSON.stringify({ question: "デバイスから" }),
    });
    expect(viaDeviceToken.status).toBe(403);
    const forwarded = await phone.api("/v1/requests", { headers: { "X-Forwarded-For": "203.0.113.5" } });
    expect(forwarded.status).toBe(403);
    expect((await fetch(`${phone.base}/v1/requests`)).status).toBe(401);
  });

  test("relay 停止中はエラー、再起動後は質問・ペアリングが保持され続きから待てる", async () => {
    const first = await call("ask_human", { question: "再起動をまたぐ質問", wait_seconds: 0 });
    const id = first.sc.request_id;
    await stopRelay();
    const down = await call("ask_human", { question: "落ちてる?", wait_seconds: 0 });
    expect(down.isError).toBe(true);
    expect(down.text).toMatch(/serve/);
    await startRelay();
    // 同じデバイストークンのまま回答できる (ペアリングは永続化されている)
    expect((await phone.answer(id, { text: "再起動後に回答", input_method: "text" })).status).toBe(200);
    const r = await call("wait_for_answer", { request_id: id, wait_seconds: 10 });
    expect(r.isError).toBe(false);
    expect(r.sc.status).toBe("answered");
    expect(r.sc.answer).toBe("再起動後に回答");
  }, 60_000);

  test("ペアリング解除 (DELETE /v1/devices/me) 後は 401", async () => {
    expect((await phone.api("/v1/devices/me", { method: "DELETE" })).status).toBe(204);
    expect((await phone.api("/v1/requests")).status).toBe(401);
    const out = await cli("devices");
    expect(out).not.toContain(phone.deviceId);
  });
});
