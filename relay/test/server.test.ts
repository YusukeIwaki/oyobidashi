import { afterEach, describe, expect, test } from "bun:test";
import { WS_CLOSE_UNPAIRED, type SocketLike } from "../src/app.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { AGENT_TOKEN, expectSameShape, fixture, makeHarness, until, type Harness } from "./helpers.ts";

/** Real Bun.serve on an ephemeral port; the peer address is the real socket address (loopback). */
interface Live {
  h: Harness;
  server: RunningServer;
  wsUrl: string;
}
const live: Live[] = [];
const clients: TestSocket[] = [];

function start(pingIntervalMs?: number): Live {
  // Requests arriving over the socket use the real peer address; direct harness calls count as loopback.
  const h = makeHarness({
    peerAddress: (req, srv) => (srv ? (srv.requestIP(req)?.address ?? null) : "127.0.0.1"),
  });
  const server = startServer(h.app, { hostname: "127.0.0.1", port: 0, sweepIntervalMs: 3_600_000, pingIntervalMs });
  const l = { h, server, wsUrl: `${server.url.replace("http", "ws")}/v1/events` };
  live.push(l);
  return l;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  for (const l of live.splice(0)) await l.server.stop();
});

interface TestSocket {
  ws: WebSocket;
  messages: any[];
  opened: Promise<boolean>;
  closed: Promise<{ code: number; reason: string }>;
  isClosed: boolean;
  next(): Promise<any>;
}

function connect(url: string, token?: string | null, extraHeaders: Record<string, string> = {}): TestSocket {
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  const ws = new (WebSocket as any)(url, { headers }) as WebSocket;
  const messages: any[] = [];
  let read = 0;
  let wakeUp: (() => void) | null = null;
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse(String(e.data)));
    wakeUp?.();
  });
  let resolveOpened!: (v: boolean) => void;
  const opened = new Promise<boolean>((r) => (resolveOpened = r));
  ws.addEventListener("open", () => resolveOpened(true));
  const sock: TestSocket = {
    ws,
    messages,
    opened,
    isClosed: false,
    closed: new Promise((resolve) => {
      ws.addEventListener("close", (e) => {
        sock.isClosed = true;
        resolveOpened(false);
        resolve({ code: e.code, reason: e.reason });
      });
    }),
    async next() {
      const deadline = Date.now() + 2000;
      while (messages.length <= read) {
        if (Date.now() > deadline) throw new Error("no websocket message within 2s");
        await new Promise<void>((r) => {
          wakeUp = r;
          setTimeout(r, 20);
        });
      }
      return messages[read++];
    },
  };
  clients.push(sock);
  return sock;
}

const quiet = () => new Promise((r) => setTimeout(r, 40));

describe("WebSocket /v1/events", () => {
  test("no upgrade and 401 without a valid device token", async () => {
    const { h, server, wsUrl } = start();
    for (const token of [null, "garbage", "kd_unknown"]) {
      const res = await fetch(`${server.url}/v1/events`, {
        headers: { upgrade: "websocket", connection: "Upgrade", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(fixture("error_unauthorized.json"));

      const sock = connect(wsUrl, token);
      expect(await sock.opened).toBe(false);
      expect(sock.messages).toEqual([]);
    }
    expect(h.app.socketCount()).toBe(0);
  });

  test("the agent token is refused (403) and a revoked device token is 401", async () => {
    const { h, server, wsUrl } = start();
    const agent = await fetch(`${server.url}/v1/events`, { headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
    expect(agent.status).toBe(403);
    expect(await connect(wsUrl, AGENT_TOKEN).opened).toBe(false);

    const { token } = await h.pair();
    await h.call("DELETE", "/v1/devices/me", { token });
    expect(await connect(wsUrl, token).opened).toBe(false);
    expect(h.app.socketCount()).toBe(0);
  });

  test("a forwarded header prevents the upgrade", async () => {
    const { h, wsUrl } = start();
    const { token } = await h.pair();
    expect(await connect(wsUrl, token, { "x-forwarded-for": "192.168.1.5" }).opened).toBe(false);
    expect(h.app.socketCount()).toBe(0);
  });

  test("a valid token without a WebSocket upgrade → 400", async () => {
    const { h, server } = start();
    const { token } = await h.pair();
    const res = await fetch(`${server.url}/v1/events`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("invalid_request");
  });

  test("hello carries the pending requests only, newest first, in the fixture shape", async () => {
    const { h, wsUrl } = start();
    const { token } = await h.pair();
    const first = await h.ask({ question: "first" });
    h.clock.advance(1000);
    const cancelled = await h.ask({ question: "cancelled" });
    await h.agent("POST", `/v1/requests/${cancelled.id}/cancel`);
    await h.agent("POST", "/v1/requests", { kind: "notification", question: "note" });
    const expired = await h.ask({ question: "expires", expires_in_seconds: 10 });
    h.clock.advance(1000);
    const second = await h.ask({ question: "second" });
    h.clock.advance(10_000);

    const sock = connect(wsUrl, token);
    expect(await sock.opened).toBe(true);
    const hello = await sock.next();
    expectSameShape(hello, fixture("event_hello.json"));
    expect(hello.type).toBe("hello");
    expect(hello.pending.map((r: any) => r.id)).toEqual([second.id, first.id]);
    expect(hello.pending[1]).toEqual(first);
    // the overdue request was expired on the way
    expect(h.store.getRequest(expired.id)!.status).toBe("expired");
  });

  test("hello with nothing pending", async () => {
    const { h, wsUrl } = start();
    const { token } = await h.pair();
    const sock = connect(wsUrl, token);
    expect(await sock.next()).toEqual({ type: "hello", pending: [] });
  });

  test("request.created for questions and notifications; delivery counts the socket", async () => {
    const { h, wsUrl } = start();
    const { token } = await h.pair();
    const sock = connect(wsUrl, token);
    await sock.next();

    const q = await h.agent("POST", "/v1/requests", { question: "質問", choices: ["a", "b"], agent: { name: "claude-code", cwd: "/x" } });
    expect(q.body.delivery).toEqual({ paired_devices: 1, websocket_delivered: 1, push_attempted: 0 });
    const created = await sock.next();
    expect(created).toEqual({ type: "request.created", request: q.body.request });
    expectSameShape(created.request, { ...fixture<object>("request_pending.json"), context: null });

    const n = await h.agent("POST", "/v1/requests", { kind: "notification", question: "ビルドが完了しました", agent: { name: "codex" } });
    expect(n.body.delivery.websocket_delivered).toBe(1);
    const note = await sock.next();
    expect(note).toEqual({ type: "request.created", request: n.body.request });
    expectSameShape(note.request, fixture("request_notification.json"));
  });

  test("request.updated on answered, cancelled and expired", async () => {
    const { h, wsUrl } = start();
    const { token, device } = await h.pair();
    const sock = connect(wsUrl, token);
    await sock.next();

    const a = await h.ask();
    await sock.next();
    const answered = await h.json("POST", `/v1/requests/${a.id}/answer`, { token, body: fixture("answer_request.json") });
    const e1 = await sock.next();
    expect(e1).toEqual({ type: "request.updated", request: answered.body.request });
    expectSameShape(e1.request, fixture("request_answered.json"));
    expect(e1.request.answer.device_id).toBe(device.id);

    const c = await h.ask();
    await sock.next();
    h.clock.advance(120_000);
    await h.agent("POST", `/v1/requests/${c.id}/cancel`);
    const e2 = await sock.next();
    const expected = fixture("event_request_updated.json");
    expectSameShape(e2, expected);
    expect(e2).toEqual({ type: "request.updated", request: { ...expected.request, id: c.id, created_at: e2.request.created_at, updated_at: e2.request.updated_at, expires_at: e2.request.expires_at } });

    const x = await h.ask({ expires_in_seconds: 10 });
    await sock.next();
    h.clock.advance(10_000);
    h.app.sweep();
    const e3 = await sock.next();
    expect(e3.type).toBe("request.updated");
    expect(e3.request).toMatchObject({ id: x.id, status: "expired", answer: null });

    // exactly one event per transition: a rejected second answer emits nothing
    await h.json("POST", `/v1/requests/${a.id}/answer`, { token, body: { text: "again" } });
    h.app.sweep();
    await quiet();
    expect(sock.messages).toHaveLength(7);
  });

  test("expiry noticed lazily by a read also emits request.updated", async () => {
    const { h, wsUrl } = start();
    const { token } = await h.pair();
    const sock = connect(wsUrl, token);
    await sock.next();
    const r = await h.ask({ expires_in_seconds: 10 });
    await sock.next();
    h.clock.advance(10_000);
    await h.agent("GET", `/v1/requests/${r.id}`);
    expect(await sock.next()).toMatchObject({ type: "request.updated", request: { id: r.id, status: "expired" } });
  });

  test("ping → pong; anything else is ignored and the connection stays up", async () => {
    const { h, wsUrl } = start();
    const { token } = await h.pair();
    const sock = connect(wsUrl, token);
    await sock.next();
    sock.ws.send(JSON.stringify({ type: "ping" }));
    expect(await sock.next()).toEqual({ type: "pong" });

    for (const junk of ["not json", "{}", "null", "[]", '"ping"', '{"type":"pong"}', '{"type":"answer","text":"x"}', '{"type":"PING"}', "x".repeat(5000)]) {
      sock.ws.send(junk);
    }
    sock.ws.send(new Uint8Array([1, 2, 3]));
    sock.ws.send(JSON.stringify({ type: "ping", extra: "ignored" }));
    expect(await sock.next()).toEqual({ type: "pong" });
    await quiet();
    expect(sock.messages).toHaveLength(3);
    expect(sock.isClosed).toBe(false);
    expect(h.app.socketCount()).toBe(1);
  });

  test("several devices all receive events; two sockets of one device count once", async () => {
    const { h, wsUrl } = start();
    const a = await h.pair();
    const b = await h.pair({ device_name: "Pixel", platform: "android" });
    await h.pair({ device_name: "offline iPad" });
    const a1 = connect(wsUrl, a.token);
    const a2 = connect(wsUrl, a.token);
    const b1 = connect(wsUrl, b.token);
    for (const s of [a1, a2, b1]) await s.next();
    expect(h.app.socketCount()).toBe(3);

    const res = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(res.body.delivery).toEqual({ paired_devices: 3, websocket_delivered: 2, push_attempted: 0 });
    for (const s of [a1, a2, b1]) expect(await s.next()).toEqual({ type: "request.created", request: res.body.request });

    const answered = await h.json("POST", `/v1/requests/${res.body.request.id}/answer`, { token: b.token, body: { text: "ok" } });
    for (const s of [a1, a2, b1]) expect(await s.next()).toEqual({ type: "request.updated", request: answered.body.request });
  });

  test("a closed socket is forgotten", async () => {
    const { h, wsUrl } = start();
    const { token } = await h.pair();
    const sock = connect(wsUrl, token);
    await sock.next();
    sock.ws.close();
    await sock.closed;
    await until(() => h.app.socketCount() === 0);
    const res = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(res.body.delivery.websocket_delivered).toBe(0);
  });

  test("DELETE /v1/devices/me disconnects that device's sockets only", async () => {
    const { h, wsUrl } = start();
    const a = await h.pair();
    const b = await h.pair({ device_name: "Pixel", platform: "android" });
    const a1 = connect(wsUrl, a.token);
    const a2 = connect(wsUrl, a.token);
    const b1 = connect(wsUrl, b.token);
    for (const s of [a1, a2, b1]) await s.next();

    await h.call("DELETE", "/v1/devices/me", { token: a.token });
    expect((await a1.closed).code).toBe(WS_CLOSE_UNPAIRED);
    expect((await a2.closed).code).toBe(WS_CLOSE_UNPAIRED);
    await until(() => h.app.socketCount() === 1);
    expect(b1.isClosed).toBe(false);
    expect(await connect(wsUrl, a.token).opened).toBe(false);

    const res = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(await b1.next()).toMatchObject({ type: "request.created" });
    expect(res.body.delivery).toEqual({ paired_devices: 1, websocket_delivered: 1, push_attempted: 0 });
    expect(a1.messages).toHaveLength(1);
  });

  test("a device revoked in the DB (CLI revoke) is disconnected by the sweep", async () => {
    const { h, wsUrl } = start();
    const a = await h.pair();
    const sock = connect(wsUrl, a.token);
    await sock.next();
    h.store.deleteDevice(a.device.id);
    h.app.sweep();
    expect((await sock.closed).code).toBe(WS_CLOSE_UNPAIRED);
    expect(h.app.socketCount()).toBe(0);
  });

  test("stopping the server closes sockets", async () => {
    const l = start();
    const { token } = await l.h.pair();
    const sock = connect(l.wsUrl, token);
    await sock.next();
    live.splice(live.indexOf(l), 1);
    await l.server.stop();
    await sock.closed;
    expect(l.h.app.socketCount()).toBe(0);
  });

  test("the server sends WebSocket ping frames on its interval", async () => {
    const { h, wsUrl } = start(25);
    const { token } = await h.pair();
    const sock = connect(wsUrl, token);
    await sock.next();
    let pings = 0;
    sock.ws.addEventListener("ping" as any, () => pings++);
    await until(() => pings >= 2, 3000);
    expect(sock.isClosed).toBe(false);
  });

  test("pingAll pings every socket and survives a dead one (unit)", () => {
    const h = makeHarness();
    const calls: string[] = [];
    const fake = (deviceId: string, broken = false): SocketLike => ({
      data: { deviceId },
      send: () => 1,
      close: () => {},
      ping: () => {
        if (broken) throw new Error("socket closed");
        calls.push(deviceId);
        return 1;
      },
    });
    h.store.insertDevice({ id: "dev_a", name: "a", platform: "ios", token_hash: "ha", push_token: null, push_environment: null, created_at: 0 });
    h.store.insertDevice({ id: "dev_b", name: "b", platform: "ios", token_hash: "hb", push_token: null, push_environment: null, created_at: 0 });
    h.app.websocket.open(fake("dev_a"));
    h.app.websocket.open(fake("dev_a", true));
    h.app.websocket.open(fake("dev_b"));
    h.app.pingAll();
    expect(calls.sort()).toEqual(["dev_a", "dev_b"]);
  });

  test("a socket whose pairing vanished before open is closed without a hello (unit)", () => {
    const h = makeHarness();
    const sent: string[] = [];
    let closedWith: number | undefined;
    h.app.websocket.open({
      data: { deviceId: "dev_gone" },
      send: (m) => sent.push(m),
      close: (code) => void (closedWith = code),
      ping: () => 1,
    });
    expect(sent).toEqual([]);
    expect(closedWith).toBe(WS_CLOSE_UNPAIRED);
    expect(h.app.socketCount()).toBe(0);
  });

  test("a socket that drops the frame (send → 0) is not counted as delivered (unit)", async () => {
    const h = makeHarness();
    const { device } = await h.pair();
    h.app.websocket.open({ data: { deviceId: device.id }, send: () => 0, close: () => {}, ping: () => 1 });
    const res = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(res.body.delivery.websocket_delivered).toBe(0);
  });
});

describe("HTTP over a real socket", () => {
  test("loopback peer: healthz, agent API and device API work end to end", async () => {
    const { h, server } = start();
    expect(await (await fetch(`${server.url}/healthz`)).json()).toEqual({ ok: true, version: "0.2.0", voice_privacy: { id: "v1:claude-code", provider: "claude-code" } });
    const { token } = await h.pair();
    const created = await fetch(`${server.url}/v1/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ question: "q" }),
    });
    expect(created.status).toBe(201);
    const { request } = (await created.json()) as any;
    const list = await fetch(`${server.url}/v1/requests?status=pending`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await list.json()) as any).requests.map((r: any) => r.id)).toEqual([request.id]);
  });

  test("a body over 64KB gets the contract's 413 error", async () => {
    const { server } = start();
    for (const size of [64 * 1024 + 1, 300_000]) {
      const res = await fetch(`${server.url}/v1/requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        body: "a".repeat(size),
      });
      expect(res.status).toBe(413);
      expect(((await res.json()) as any).error.code).toBe("payload_too_large");
    }
  });

  test("long-poll over HTTP wakes on answer", async () => {
    const { h, server } = start();
    const { token } = await h.pair();
    const r = await h.ask();
    const poll = fetch(`${server.url}/v1/requests/${r.id}?wait=300`, { headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
    await until(() => h.app.waiterCount() === 1);
    const answer = await fetch(`${server.url}/v1/requests/${r.id}/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "はい" }),
    });
    expect(answer.status).toBe(200);
    const res = await poll;
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).request.answer.text).toBe("はい");
    expect(h.app.waiterCount()).toBe(0);
  });

  test("a long-poll client that disconnects does not leak a waiter", async () => {
    const { h, server } = start();
    const r = await h.ask();
    const controller = new AbortController();
    const poll = fetch(`${server.url}/v1/requests/${r.id}?wait=300`, {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      signal: controller.signal,
    });
    await until(() => h.app.waiterCount() === 1);
    controller.abort();
    await poll.catch(() => {});
    await until(() => h.app.waiterCount() === 0);
    expect(h.clock.pendingTimers).toBe(0);
  });
});
