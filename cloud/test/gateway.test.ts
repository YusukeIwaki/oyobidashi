import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CloudApp, type Socket, type SocketData } from "../src/app.ts";
import { hash } from "../src/service.ts";
import type { CloudRequest, Transaction } from "../src/types.ts";
import { harness } from "./helpers.ts";
import { MemoryDatabase } from "./memory.ts";

type Harness = ReturnType<typeof harness>;
type Frame = { type: string; pending?: CloudRequest[]; request?: CloudRequest };
const apps = new Set<CloudApp>();
const unsubscribers: (() => void)[] = [];
const servers: Bun.Server<SocketData>[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  for (const ws of clients.splice(0)) ws.close();
  for (const app of apps) app.close();
  apps.clear();
  for (const server of servers.splice(0)) await server.stop(true);
});

function setup(db?: MemoryDatabase) {
  const h = harness(db);
  apps.add(h.app);
  return h;
}

function replica(h: Harness, maxSockets?: number) {
  const app = new CloudApp(h.service, h.app.verifier, maxSockets);
  apps.add(app);
  return app;
}

async function until(predicate: () => boolean, label: string, timeout = 1500) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(1);
  }
}

async function call(
  app: CloudApp,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = (await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    }),
  ))!;
  return {
    status: response.status,
    body: response.status === 204 ? null : ((await response.json()) as any),
  };
}

interface FakeSocket extends Socket {
  frames: Frame[];
  closes: { code?: number; reason?: string }[];
  buffered: number;
  sendResult: number;
  brokenSend: boolean;
  brokenClose: boolean;
  pings: number;
}

async function socket(
  h: Harness,
  token: string,
  app: CloudApp = h.app,
  upgraded?: SocketData,
): Promise<FakeSocket> {
  const principal = await h.devicePrincipal(token);
  if (principal.role !== "device") throw new Error("device principal expected");
  const ws: FakeSocket = {
    data: upgraded ?? {
      principal,
      seen: new Map(),
      ready: false,
      closed: false,
    },
    frames: [],
    closes: [],
    buffered: 0,
    sendResult: 1,
    brokenSend: false,
    brokenClose: false,
    pings: 0,
    send(payload) {
      if (this.brokenSend) throw new Error("injected disconnected socket");
      this.frames.push(JSON.parse(payload) as Frame);
      return this.sendResult;
    },
    close(code, reason) {
      this.closes.push({ code, reason });
      if (this.brokenClose) throw new Error("socket was already destroyed");
    },
    ping() {
      this.pings++;
      return 1;
    },
    getBufferedAmount() {
      return this.buffered;
    },
  };
  await app.open(ws);
  await until(
    () => ws.frames.length > 0 || ws.closes.length > 0,
    "initial snapshot",
  );
  return ws;
}

async function subscribe(h: Harness, ...gateways: CloudApp[]) {
  unsubscribers.push(
    await h.bus.subscribe((digest) => {
      for (const app of gateways) app.onWake(digest);
    }),
  );
}

describe("gateway identity, replicas and snapshots", () => {
  test("hello contains only the device owner's pending requests, with no credential material", async () => {
    const h = setup(),
      alice = await h.pair(),
      bob = await h.pair("bob");
    const a = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "alice question",
    });
    const b = await h.call("POST", "/v1/requests", "agent-bob", {
      question: "bob question",
    });
    const done = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "already answered",
    });
    await h.call(
      "POST",
      `/v1/requests/${done.body.request.id}/answer`,
      alice.device_token,
      { text: "done" },
    );
    await h.call("POST", "/v1/requests", "agent-alice", {
      kind: "notification",
      question: "one way",
    });
    const ws = await socket(h, alice.device_token),
      other = await socket(h, bob.device_token);
    expect(ws.frames[0]!.type).toBe("hello");
    expect(ws.frames[0]!.pending!.map((r) => r.id)).toEqual([
      a.body.request.id,
    ]);
    expect(other.frames[0]!.pending!.map((r) => r.id)).toEqual([
      b.body.request.id,
    ]);
    const wire = JSON.stringify(ws.frames);
    expect(wire).not.toContain(alice.device_token);
    expect(wire).not.toContain(hash(alice.device_token));
    expect(wire).not.toContain("bob question");
    expect(wire).not.toContain("agent-alice");
  });

  test("WebSocket upgrade requires device auth and capacity rejection does not evict an existing connection", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h, 1);
    let upgraded: SocketData | undefined;
    const server = {
      upgrade(_req: Request, options: { data: SocketData }) {
        upgraded = options.data;
        return true;
      },
    };
    for (const [token, status] of [
      ["invalid", 401],
      ["agent-alice", 403],
    ] as const) {
      const result = await app.fetch(
        new Request("http://localhost/v1/events", {
          headers: { authorization: `Bearer ${token}` },
        }),
        server,
      );
      expect(result!.status).toBe(status);
      expect(upgraded).toBeUndefined();
    }
    const response = await app.fetch(
      new Request("http://localhost/v1/events?uid=bob", {
        headers: { authorization: `Bearer ${d.device_token}` },
      }),
      server,
    );
    expect(response).toBeUndefined();
    expect(upgraded!.principal.uid).toBe("alice");
    const ws = await socket(h, d.device_token, app, upgraded);
    const rejected = await app.fetch(
      new Request("http://localhost/v1/events", {
        headers: { authorization: `Bearer ${d.device_token}` },
      }),
      server,
    );
    expect(rejected!.status).toBe(429);
    expect(app.socketCount).toBe(1);
    expect(ws.closes).toEqual([]);
  });

  test("one account cannot consume the WebSocket capacity reserved for others", async () => {
    const h = setup(), alice = await h.pair("alice"), bob = await h.pair("bob"), app = replica(h, 20);
    for (let i = 0; i < 8; i++) await socket(h, alice.device_token, app);
    expect(app.socketCount).toBe(8);
    const rejected = await app.fetch(new Request("http://localhost/v1/events", {
      headers: { authorization: `Bearer ${alice.device_token}` },
    }), { upgrade: () => true });
    expect(rejected!.status).toBe(429);
    await socket(h, bob.device_token, app);
    expect(app.socketCount).toBe(9);
  });

  test("accepted upgrades reserve capacity before asynchronous open callbacks arrive", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h, 1);
    let upgrades = 0;
    const server = {
      upgrade() {
        upgrades++;
        return true;
      },
    };
    const request = () =>
      new Request("http://localhost/v1/events", {
        headers: { authorization: `Bearer ${d.device_token}` },
      });
    expect(await app.fetch(request(), server)).toBeUndefined();
    const next = await app.fetch(request(), server);
    expect(next!.status).toBe(429);
    expect(upgrades).toBe(1);
  });

  test("a rejected transport upgrade cannot leak connection capacity", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h, 1);
    const request = () =>
      new Request("http://localhost/v1/events", {
        headers: { authorization: `Bearer ${d.device_token}` },
      });
    expect(
      (await app.fetch(request(), {
        upgrade() {
          return false;
        },
      }))!.status,
    ).toBe(400);
    expect(
      await app.fetch(request(), {
        upgrade() {
          return true;
        },
      }),
    ).toBeUndefined();
  });

  test("another replica receives hashed owner wakeups and never broadcasts across users", async () => {
    const h = setup(),
      alice = await h.pair(),
      bob = await h.pair("bob"),
      app = replica(h);
    const a = await socket(h, alice.device_token, app),
      b = await socket(h, bob.device_token, app);
    const digests: string[] = [];
    unsubscribers.push(
      await h.bus.subscribe((digest) => {
        digests.push(digest);
        app.onWake(digest);
      }),
    );
    const request = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "replicated",
    });
    await until(
      () => a.frames.some((f) => f.request?.id === request.body.request.id),
      "remote replica update",
    );
    expect(b.frames).toHaveLength(1);
    expect(digests).toContain(hash("alice"));
    expect(digests.every((d) => /^[0-9a-f]{64}$/.test(d))).toBe(true);
    expect(digests).not.toContain("alice");
    const count = a.frames.length;
    app.onWake(hash("alice"));
    app.onWake(hash("alice"));
    await app.reconcileSockets();
    await Bun.sleep(5);
    expect(a.frames).toHaveLength(count);
    app.onWake(hash("nobody-connected"));
    expect(b.frames).toHaveLength(1);
  });

  test("missed Redis notifications are repaired from DB, including terminal updates", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h),
      ws = await socket(h, d.device_token, app);
    const created = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "missed event",
    });
    expect(ws.frames).toHaveLength(1); // deliberately no bus subscription
    await app.reconcileSockets();
    expect(ws.frames[1]).toMatchObject({
      type: "request.created",
      request: { id: created.body.request.id, status: "pending" },
    });
    await h.call(
      "POST",
      `/v1/requests/${created.body.request.id}/answer`,
      d.device_token,
      { text: "saved" },
    );
    expect(ws.frames).toHaveLength(2);
    await app.reconcileSockets();
    expect(ws.frames[2]).toMatchObject({
      type: "request.updated",
      request: { status: "answered", answer: { text: "saved" } },
    });
    await app.reconcileSockets();
    expect(ws.frames).toHaveLength(3);
  });

  test("gateway shutdown leaves active calls and queued turns durable for another replica", async () => {
    const h = setup(),
      s = await h.setup(),
      t = await s.turn(),
      app = replica(h);
    const before = (await h.call("GET", `/v1/requests/${s.id}`)).body.request;
    const jobs = structuredClone([...(h.db as MemoryDatabase).jobs.values()]);
    const ws = await socket(h, s.d.device_token, app);
    app.close();
    expect(ws.closes).toEqual([{ code: 1012, reason: "reconnect to resume" }]);
    expect(app.socketCount).toBe(0);
    expect((await h.call("GET", `/v1/requests/${s.id}`)).body.request).toEqual(
      before,
    );
    expect([...(h.db as MemoryDatabase).jobs.values()]).toEqual(jobs);
    const next = replica(h),
      resumed = await socket(h, s.d.device_token, next);
    expect(resumed.frames[0]!.pending![0]).toMatchObject({
      id: s.id,
      call: { state: "active", turn: { id: t.turnId, state: "queued" } },
    });
    expect((await h.turn(t.turnId))!.state).toBe("queued");
  });

  test("a DB snapshot finishing after gateway shutdown cannot send another frame", async () => {
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    class DelayedDatabase extends MemoryDatabase {
      pause = false;
      entered = false;
      override async transaction<T>(
        uid: string,
        fn: (tx: Transaction) => Promise<T>,
      ): Promise<T> {
        const result = await super.transaction(uid, fn);
        if (this.pause) {
          this.entered = true;
          await paused;
        }
        return result;
      }
    }
    const db = new DelayedDatabase(),
      h = setup(db),
      d = await h.pair(),
      app = replica(h);
    const ws = await socket(h, d.device_token, app);
    await h.call("POST", "/v1/requests", "agent-alice", {
      question: "snapshot races shutdown",
    });
    db.pause = true;
    const refreshing = app.refresh("alice");
    try {
      await until(() => db.entered, "paused database snapshot");
      app.close();
    } finally {
      resume();
    }
    await refreshing;
    expect(ws.closes[0]!.code).toBe(1012);
    expect(ws.frames).toHaveLength(1);
    expect(app.socketCount).toBe(0);
  });

  test("revocation on another replica closes only that device with 4001", async () => {
    const h = setup(),
      alice = await h.pair(),
      bob = await h.pair("bob"),
      app = replica(h);
    const a = await socket(h, alice.device_token, app),
      b = await socket(h, bob.device_token, app);
    await subscribe(h, app);
    expect(
      (await h.call("DELETE", "/v1/devices/me", alice.device_token)).status,
    ).toBe(204);
    await until(() => a.closes.length > 0, "remote revocation");
    expect(a.closes).toEqual([{ code: 4001, reason: "unpaired" }]);
    expect(a.data.closed).toBe(true);
    expect(app.socketCount).toBe(1);
    expect(b.closes).toEqual([]);
    app.message(a, '{"type":"ping"}');
    expect(a.frames).toHaveLength(1);
  });

  test("a previously seen pending request still gets a terminal update outside the latest history window", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h);
    const old = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "old pending",
    });
    const ws = await socket(h, d.device_token, app);
    await h.db.transaction("alice", async (tx) => {
      for (let i = 0; i < 220; i++) {
        const r: CloudRequest = {
          ...structuredClone(old.body.request),
          id: `history-${i}`,
          status: "answered",
          created_at: new Date(h.clock.now + i + 1).toISOString(),
        };
        await tx.put("request", r.id, r);
      }
    });
    await h.call(
      "POST",
      `/v1/requests/${old.body.request.id}/answer`,
      d.device_token,
      { text: "late answer" },
    );
    await app.reconcileSockets();
    expect(ws.frames.at(-1)).toMatchObject({
      type: "request.updated",
      request: { id: old.body.request.id, status: "answered" },
    });
    expect(ws.frames.filter((f) => f.type !== "hello")).toHaveLength(1);
  });
});

describe("backpressure and infrastructure failure", () => {
  test("slow sockets close with 1013 before another frame is allocated", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h),
      ws = await socket(h, d.device_token, app);
    ws.buffered = 256 * 1024 + 1;
    await h.call("POST", "/v1/requests", "agent-alice", {
      question: "backpressure",
    });
    await app.reconcileSockets();
    expect(ws.frames).toHaveLength(1);
    expect(ws.closes).toEqual([{ code: 1013, reason: "reconnect to resume" }]);
    expect(app.socketCount).toBe(0);
    expect(ws.data.closed).toBe(true);
    app.message(ws, '{"type":"ping"}');
    expect(ws.frames).toHaveLength(1);
  });

  test("a dropped send and a destroyed socket are both removed without failing healthy peers", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h);
    const dropped = await socket(h, d.device_token, app),
      broken = await socket(h, d.device_token, app),
      healthy = await socket(h, d.device_token, app);
    dropped.sendResult = 0;
    broken.brokenSend = true;
    broken.brokenClose = true;
    await h.call("POST", "/v1/requests", "agent-alice", {
      question: "deliver to healthy peer",
    });
    await app.reconcileSockets();
    expect(dropped.closes[0]!.code).toBe(1013);
    expect(broken.closes[0]!.code).toBe(1013);
    expect(app.socketCount).toBe(1);
    expect(healthy.frames.at(-1)!.request!.question).toBe(
      "deliver to healthy peer",
    );
    app.ping();
    expect(healthy.pings).toBe(1);
    expect(dropped.pings).toBe(0);
    expect(broken.pings).toBe(0);
  });

  test("a queued send is accepted while below the explicit buffer limit", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h),
      ws = await socket(h, d.device_token, app);
    ws.sendResult = -1;
    ws.buffered = 100;
    await h.call("POST", "/v1/requests", "agent-alice", {
      question: "temporarily queued",
    });
    await app.reconcileSockets();
    expect(ws.closes).toEqual([]);
    expect(app.socketCount).toBe(1);
    expect(ws.frames.at(-1)!.request!.question).toBe("temporarily queued");
  });

  test("seen-version memory stays bounded across a long connected session", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h);
    const created = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "template",
    });
    const ws = await socket(h, d.device_token, app);
    for (let batch = 0; batch < 5; batch++) {
      await h.db.transaction("alice", async (tx) => {
        for (let i = 0; i < 100; i++) {
          const r: CloudRequest = {
            ...structuredClone(created.body.request),
            id: `request-${batch}-${i}`,
            created_at: new Date(
              h.clock.now + batch * 100 + i + 1,
            ).toISOString(),
          };
          await tx.put("request", r.id, r);
        }
      });
      await app.reconcileSockets();
      expect(ws.data.seen.size).toBeLessThanOrEqual(400);
    }
    expect(ws.closes).toEqual([]);
    expect(
      ws.frames.filter((f) => f.type === "request.created").length,
    ).toBeGreaterThanOrEqual(500);
  });

  test("temporary DB failure returns sanitized 503, disconnects stale sockets, then restores snapshot", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h),
      ws = await socket(h, d.device_token, app);
    const created = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "durable through outage",
    });
    const db = h.db as MemoryDatabase;
    db.fail = true;
    for (const path of ["/readyz", "/v1/requests"]) {
      const response = await call(app, "GET", path, d.device_token);
      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).not.toContain("injected");
      expect(JSON.stringify(response.body)).not.toContain("private details");
      expect(JSON.stringify(response.body)).not.toContain(d.device_token);
    }
    await app.reconcileSockets();
    expect(ws.closes[0]!.code).toBe(1013);
    expect(app.socketCount).toBe(0);
    db.fail = false;
    const restored = await socket(h, d.device_token, app);
    expect(restored.frames[0]!.pending!.map((r) => r.id)).toEqual([
      created.body.request.id,
    ]);
    expect((await call(app, "GET", "/readyz", d.device_token)).status).toBe(
      200,
    );
  });
});

describe("long poll cleanup and replica wakeups", () => {
  test("an aborted HTTP request releases its waiter and never cancels the question", async () => {
    const h = setup(),
      app = replica(h),
      created = await h.call("POST", "/v1/requests", "agent-alice", {
        question: "pending",
      });
    const controller = new AbortController();
    const waiting = call(
      app,
      "GET",
      `/v1/requests/${created.body.request.id}?wait=300`,
      "agent-alice",
      undefined,
      controller.signal,
    );
    await until(() => app.waiterCount === 1, "long poll registration");
    controller.abort();
    expect((await waiting).body.request.status).toBe("pending");
    expect(app.waiterCount).toBe(0);
    expect(
      (await h.call("GET", `/v1/requests/${created.body.request.id}`)).body
        .request.status,
    ).toBe("pending");
  });

  test("an already aborted request does not allocate a waiter", async () => {
    const h = setup(),
      app = replica(h),
      created = await h.call("POST", "/v1/requests", "agent-alice", {
        question: "pending",
      });
    const controller = new AbortController();
    controller.abort();
    const response = await call(
      app,
      "GET",
      `/v1/requests/${created.body.request.id}?wait=300`,
      "agent-alice",
      undefined,
      controller.signal,
    );
    expect(response.body.request.status).toBe("pending");
    expect(app.waiterCount).toBe(0);
  });

  test("an answer on another replica wakes the agent before the fallback timer", async () => {
    const h = setup(),
      d = await h.pair(),
      app = replica(h),
      created = await h.call("POST", "/v1/requests", "agent-alice", {
        question: "pending",
      });
    await subscribe(h, app);
    const waiting = call(
      app,
      "GET",
      `/v1/requests/${created.body.request.id}?wait=300`,
      "agent-alice",
    );
    await until(() => app.waiterCount === 1, "remote long poll registration");
    const started = performance.now();
    await h.call(
      "POST",
      `/v1/requests/${created.body.request.id}/answer`,
      d.device_token,
      { text: "from other replica" },
    );
    const response = await waiting;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(response.body.request.answer.text).toBe("from other replica");
    expect(app.waiterCount).toBe(0);
  });

  test("gateway close clears every long-poll timer and refuses new work without mutating durable requests", async () => {
    const h = setup(),
      app = replica(h),
      created = await h.call("POST", "/v1/requests", "agent-alice", {
        question: "pending",
      });
    const timers = spyOn(globalThis, "setTimeout"),
      clears = spyOn(globalThis, "clearTimeout");
    try {
      const waiting = [1, 2].map(() =>
        call(
          app,
          "GET",
          `/v1/requests/${created.body.request.id}?wait=300`,
          "agent-alice",
        ),
      );
      await until(() => app.waiterCount === 2, "both long polls");
      app.close();
      const results = await Promise.all(waiting);
      expect(results.every((r) => r.body.request.status === "pending")).toBe(
        true,
      );
      expect(app.waiterCount).toBe(0);
      let ownedTimers = 0;
      for (let i = 0; i < timers.mock.calls.length; i++) {
        const result = timers.mock.results[i];
        if (timers.mock.calls[i]![1] === 2000 && result?.type === "return") {
          ownedTimers++;
          expect(
            clears.mock.calls.some((args) => args[0] === result.value),
          ).toBe(true);
        }
      }
      expect(ownedTimers).toBe(2);
      expect((await call(app, "GET", "/healthz", "agent-alice")).status).toBe(
        503,
      );
    } finally {
      timers.mockRestore();
      clears.mockRestore();
    }
    expect(
      (await h.call("GET", `/v1/requests/${created.body.request.id}`)).body
        .request.status,
    ).toBe("pending");
  });
});

function serve(app: CloudApp) {
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req, srv) => app.fetch(req, srv),
    websocket: {
      open: (ws) => {
        void app.open(ws);
      },
      message: (ws, message) => app.message(ws, message),
      close: (ws) => app.closeSocket(ws),
      backpressureLimit: 256 * 1024,
      closeOnBackpressureLimit: true,
    },
  });
  servers.push(server);
  return `ws://127.0.0.1:${server.port}/v1/events`;
}

function connect(url: string, token: string) {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  clients.push(ws);
  const frames: Frame[] = [],
    closes: number[] = [];
  ws.addEventListener("message", (event) =>
    frames.push(JSON.parse(String(event.data)) as Frame),
  );
  ws.addEventListener("close", (event) => closes.push(event.code));
  return { ws, frames, closes };
}

test("real WebSocket force-disconnect and reconnect recover a scoped snapshot without stale unanswered questions", async () => {
  const h = setup(),
    s = await h.setup(),
    t = await s.turn();
  const ordinary = await h.call("POST", "/v1/requests", "agent-alice", {
    question: "answer during outage",
  });
  await h.pair("bob");
  await h.call("POST", "/v1/requests", "agent-bob", {
    question: "private to bob",
  });
  const app1 = replica(h),
    first = connect(serve(app1), s.d.device_token);
  await until(() => first.frames.length > 0, "real WebSocket hello");
  expect(first.frames[0]!.pending!.map((r) => r.id).sort()).toEqual(
    [s.id, ordinary.body.request.id].sort(),
  );
  // Terminate the TCP server without running gateway.close: the worker/DB survive.
  await servers[0]!.stop(true);
  await until(() => first.closes.length > 0, "forced TCP disconnection");
  await h.call(
    "POST",
    `/v1/requests/${ordinary.body.request.id}/answer`,
    s.d.device_token,
    { text: "saved while disconnected" },
  );
  const app2 = replica(h),
    next = connect(serve(app2), s.d.device_token);
  await until(() => next.frames.length > 0, "reconnected WebSocket snapshot");
  expect(next.frames[0]!.pending!.map((r) => r.id)).toEqual([s.id]);
  expect(next.frames[0]!.pending![0]!.call).toMatchObject({
    state: "active",
    turn: { id: t.turnId, state: "queued" },
  });
  expect(JSON.stringify(next.frames)).not.toContain("private to bob");
  next.ws.send('{"type":"ping"}');
  await until(
    () => next.frames.some((f) => f.type === "pong"),
    "application heartbeat",
  );
  await call(app2, "DELETE", "/v1/devices/me", s.d.device_token);
  await until(() => next.closes.length > 0, "revoked real WebSocket");
  expect(next.closes).toEqual([4001]);
  expect(app2.socketCount).toBe(0);
});
