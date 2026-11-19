import { afterEach, describe, expect, test } from "bun:test";
import { isAbortError, RelayClient, RelayError } from "../src/relay-client.ts";
import { closedPort, errorBody, FakeClock, FakeRelay, fixture, json } from "./helpers.ts";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** Fake relay behind real HTTP + a client pointed at it. */
function served(configure?: (relay: FakeRelay) => void) {
  const relay = new FakeRelay();
  configure?.(relay);
  const server = relay.serve();
  stops.push(server.stop);
  const client = new RelayClient({ baseUrl: server.url, agentToken: relay.token });
  return { relay, client, url: server.url };
}

async function relayError(promise: Promise<unknown>): Promise<RelayError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(RelayError);
    return e as RelayError;
  }
  throw new Error("expected the call to fail");
}

describe("RelayClient over real HTTP (fake relay on Bun.serve)", () => {
  describe("POST /v1/requests", () => {
    test("sends a contract-conformant body and maps the fixture response", async () => {
      const { relay, client } = served();
      const result = await client.createRequest({
        kind: "question",
        question: "本番DBのマイグレーションを実行してよいですか?",
        context: "users テーブルに列を追加します",
        choices: ["はい", "いいえ"],
        urgency: "high",
        agent: { name: "claude-code", cwd: "/path/to/project" },
      });

      expect(relay.calls).toHaveLength(1);
      const call = relay.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.path).toBe("/v1/requests");
      expect([...call.query.keys()]).toEqual([]);
      expect(call.headers.get("authorization")).toBe("Bearer ka_test_token");
      expect(call.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(call.headers.get("accept")).toBe("application/json");
      expect(call.headers.has("x-forwarded-for")).toBe(false);
      expect(call.headers.has("x-forwarded-host")).toBe(false);
      expect(call.body).toEqual({
        kind: "question",
        question: "本番DBのマイグレーションを実行してよいですか?",
        context: "users テーブルに列を追加します",
        choices: ["はい", "いいえ"],
        urgency: "high",
        agent: { name: "claude-code", cwd: "/path/to/project" },
      });
      // UTF-8 on the wire
      expect(call.rawBody).toContain("本番DB");

      const expected = fixture("create_request_response.json");
      expect(result.request.id).toBe(expected.request.id);
      expect(result.request.status).toBe("pending");
      expect(result.request.kind).toBe("question");
      expect(result.request.answer ?? null).toBeNull();
      expect(result.request.choices).toEqual(["はい", "いいえ"]);
      expect(result.delivery).toEqual(expected.delivery);
    });

    test("omits optional fields that were not given (no nulls, no empty agent)", async () => {
      const { relay, client } = served();
      await client.createRequest({ kind: "question", question: "q" });
      expect(relay.calls[0]!.body).toEqual({ kind: "question", question: "q" });
      expect(Object.keys(relay.calls[0]!.body).sort()).toEqual(["kind", "question"]);

      await client.createRequest({ kind: "question", question: "q", context: undefined, choices: [], urgency: undefined, agent: {} });
      expect(relay.calls[1]!.body).toEqual({ kind: "question", question: "q" });

      await client.createRequest({ kind: "question", question: "q", agent: { cwd: "/only/cwd" }, expiresInSeconds: 600 });
      expect(relay.calls[2]!.body).toEqual({ kind: "question", question: "q", expires_in_seconds: 600, agent: { cwd: "/only/cwd" } });
    });

    test("notification: kind is sent and the request_notification fixture is mapped", async () => {
      const { relay, client } = served();
      const result = await client.createRequest({ kind: "notification", question: "ビルドが完了しました", agent: { name: "codex" } });
      expect(relay.calls[0]!.body).toEqual({ kind: "notification", question: "ビルドが完了しました", agent: { name: "codex" } });
      expect(result.request.id).toBe("req_01JCNTF");
      expect(result.request.kind).toBe("notification");
      expect(result.request.status).toBe("notified");
    });

    test("paired_devices 0 is passed through; a missing delivery object is tolerated", async () => {
      const a = served((r) => (r.delivery = { paired_devices: 0, websocket_delivered: 0, push_attempted: 0 }));
      expect((await a.client.createRequest({ kind: "question", question: "q" })).delivery?.paired_devices).toBe(0);
      const b = served((r) => (r.onCreate = () => json({ request: fixture("request_pending.json") }, 201)));
      expect((await b.client.createRequest({ kind: "question", question: "q" })).delivery).toBeUndefined();
    });

    test("unknown response fields are ignored (forward compatibility)", async () => {
      const { client } = served((r) => {
        r.onCreate = () =>
          json({ request: { ...fixture("request_pending.json"), brand_new: { x: 1 } }, delivery: { paired_devices: 2, extra: true }, more: 1 }, 201);
      });
      const result = await client.createRequest({ kind: "question", question: "q" });
      expect(result.request.id).toBe("req_01JCXYZ");
      expect(result.delivery?.paired_devices).toBe(2);
    });

    test("input_restricted on delivery is carried through; absent means false", async () => {
      const makeClient = (configure?: (relay: FakeRelay) => void) => {
        const clock = new FakeClock();
        const relay = new FakeRelay(clock);
        configure?.(relay);
        return new RelayClient({ baseUrl: "http://relay.test", agentToken: relay.token, clock, fetch: relay.fetch });
      };
      expect((await makeClient((r) => (r.delivery = { paired_devices: 1, websocket_delivered: 0, push_attempted: 1, input_restricted: true })).createRequest({ kind: "question", question: "q" })).delivery?.input_restricted).toBe(true);
      expect((await makeClient().createRequest({ kind: "question", question: "q" })).delivery?.input_restricted ?? false).toBe(false);
      expect((await makeClient((r) => (r.delivery = { paired_devices: 1, websocket_delivered: 0, push_attempted: 1, input_restricted: false })).createRequest({ kind: "question", question: "q" })).delivery?.input_restricted).toBe(false);
    });
  });

  describe("GET /v1/presence", () => {
    test("input_restricted on presence is carried through; absent means false", async () => {
      const makeClient = (configure?: (relay: FakeRelay) => void) => {
        const clock = new FakeClock();
        const relay = new FakeRelay(clock);
        configure?.(relay);
        return new RelayClient({ baseUrl: "http://relay.test", agentToken: relay.token, clock, fetch: relay.fetch });
      };
      expect((await makeClient((r) => (r.presence = { ...r.presence, input_restricted: true })).getPresence()).input_restricted).toBe(true);
      expect((await makeClient().getPresence()).input_restricted ?? false).toBe(false);
    });
  });

  describe("GET /v1/requests/{id}?wait=N", () => {
    test("sends method/path/query/auth and maps the answered fixture (choice)", async () => {
      const { relay, client } = served((r) => (r.current = fixture("request_answered.json")));
      const request = await client.getRequest("req_01JCXYZ", { waitSeconds: 30 });
      const call = relay.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.path).toBe("/v1/requests/req_01JCXYZ");
      expect(call.query.get("wait")).toBe("30");
      expect(call.headers.get("authorization")).toBe("Bearer ka_test_token");
      expect(call.rawBody).toBe("");
      expect(request.status).toBe("answered");
      expect(request.answer).toMatchObject({ text: "はい", choice_index: 0, input_method: "choice" });
    });

    test("maps the minimal voice fixture (nulls for context/choices/agent/choice_index)", async () => {
      const { client } = served((r) => (r.current = fixture("request_minimal_voice_answered.json")));
      const request = await client.getRequest("req_01JCMIN");
      expect(request.status).toBe("answered");
      expect(request.answer?.text).toBe("ログイン画面のバグ修正を先にやって");
      expect(request.answer?.input_method).toBe("voice");
      expect(request.answer?.choice_index ?? null).toBeNull();
      expect(request.choices ?? null).toBeNull();
    });

    test("fields that are absent instead of null are accepted (null == missing)", async () => {
      const { client } = served((r) => (r.onGet = () => json({ request: { id: "req_x", status: "pending" } })));
      const request = await client.getRequest("req_x");
      expect(request).toMatchObject({ id: "req_x", status: "pending" });
      expect(request.answer ?? null).toBeNull();
    });

    test("wait defaults to 0, is floored and capped at the contract maximum of 300", async () => {
      const { relay, client } = served((r) => (r.current = fixture("request_answered.json")));
      await client.getRequest("req_01JCXYZ");
      await client.getRequest("req_01JCXYZ", { waitSeconds: 12.7 });
      await client.getRequest("req_01JCXYZ", { waitSeconds: 9999 });
      await client.getRequest("req_01JCXYZ", { waitSeconds: -3 });
      expect(relay.calls.map((c) => c.query.get("wait"))).toEqual(["0", "12", "300", "0"]);
    });

    test("the request id is URL-encoded and the token never appears in the URL", async () => {
      const { relay, client } = served((r) => (r.onGet = () => json({ request: { id: "weird", status: "pending" } })));
      await client.getRequest("req/../x?y#z");
      expect(relay.calls[0]!.path).toBe("/v1/requests/req%2F..%2Fx%3Fy%23z");
      expect(relay.calls[0]!.query.get("wait")).toBe("0");
      expect([...relay.calls[0]!.query.keys()]).toEqual(["wait"]);
    });

    test("a real long-poll that resolves midway returns the new state", async () => {
      const { relay, client } = served();
      relay.resolveAfter(150);
      const started = Date.now();
      const request = await client.getRequest("req_01JCXYZ", { waitSeconds: 5 });
      expect(request.status).toBe("answered");
      expect(Date.now() - started).toBeLessThan(3000);
    });
  });

  describe("POST /v1/requests/{id}/cancel", () => {
    test("sends no body and maps the cancelled request", async () => {
      const { relay, client } = served();
      const request = await client.cancelRequest("req_01JCXYZ");
      const call = relay.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.path).toBe("/v1/requests/req_01JCXYZ/cancel");
      expect(call.rawBody).toBe("");
      expect(call.headers.get("authorization")).toBe("Bearer ka_test_token");
      expect(request.status).toBe("cancelled");
    });

    test("409 already_resolved (fixture) → RelayError with code", async () => {
      const { client } = served((r) => (r.current = fixture("request_answered.json")));
      const e = await relayError(client.cancelRequest("req_01JCXYZ"));
      expect(e.kind).toBe("http");
      expect(e.status).toBe(409);
      expect(e.code).toBe("already_resolved");
      expect(e.relayMessage).toBe("request is already answered");
      expect(e.transient).toBe(false);
    });
  });

  describe("error responses", () => {
    test("401 with the error_unauthorized fixture (wrong token)", async () => {
      const { relay, url } = served();
      const client = new RelayClient({ baseUrl: url, agentToken: "ka_wrong" });
      const e = await relayError(client.createRequest({ kind: "question", question: "q" }));
      expect(relay.calls[0]!.headers.get("authorization")).toBe("Bearer ka_wrong");
      expect(e).toMatchObject({ kind: "http", status: 401, code: "unauthorized", relayMessage: "invalid or missing token", transient: false });
    });

    test.each([
      [400, "invalid_request", "question is required", false],
      [403, "forbidden", "agent API is not available through the tunnel", false],
      [404, "not_found", "request not found", false],
      [413, "payload_too_large", "body too large", false],
      [429, "rate_limited", "slow down", false],
      [500, "internal", "boom", true],
      [503, "internal", "unavailable", true],
    ])("%i %s → RelayError(http) carrying code and message", async (status, code, message, transient) => {
      const { client } = served((r) => (r.onAny = () => json(errorBody(code, message), status)));
      const e = await relayError(client.getRequest("req_1", { waitSeconds: 0 }));
      expect(e).toMatchObject({ kind: "http", status, code, relayMessage: message, transient });
      expect(e.message).toContain(String(status));
    });

    test("500 with a non-JSON body → http error without code, transient", async () => {
      const { client } = served((r) => (r.onAny = () => new Response("Internal Server Error", { status: 500 })));
      const e = await relayError(client.createRequest({ kind: "question", question: "q" }));
      expect(e).toMatchObject({ kind: "http", status: 500, transient: true });
      expect(e.code).toBeUndefined();
      expect(e.message).toContain("Internal Server Error");
    });

    test("404 HTML page (something else on that port) → http 404 without code", async () => {
      const { client } = served((r) => (r.onAny = () => new Response("<html><body>Not Found</body></html>", { status: 404, headers: { "content-type": "text/html" } })));
      const e = await relayError(client.getRequest("req_1"));
      expect(e).toMatchObject({ kind: "http", status: 404 });
      expect(e.code).toBeUndefined();
    });

    test("error JSON of the wrong shape is not mistaken for a contract error", async () => {
      const { client } = served((r) => (r.onAny = () => json({ message: "nope" }, 400)));
      const e = await relayError(client.getRequest("req_1"));
      expect(e).toMatchObject({ kind: "http", status: 400 });
      expect(e.code).toBeUndefined();
    });

    test.each([
      ["HTML", "<!doctype html><html><body>hello</body></html>"],
      ["empty body", ""],
      ["truncated JSON", '{"request": {"id": "req_1", "sta'],
      ["plain text", "OK"],
    ])("200 with %s → bad_response", async (_name, body) => {
      const { client } = served((r) => (r.onAny = () => new Response(body, { status: 200 })));
      const e = await relayError(client.getRequest("req_1"));
      expect(e.kind).toBe("bad_response");
      expect(e.status).toBe(200);
      expect(e.transient).toBe(true);
    });

    test.each([
      ["JSON null", null],
      ["JSON array", []],
      ["no request key", { ok: true }],
      ["request without id", { request: { status: "pending" } }],
      ["request without status", { request: { id: "req_1" } }],
      ["status of wrong type", { request: { id: "req_1", status: 5 } }],
      ["answer without text", { request: { id: "req_1", status: "answered", answer: { input_method: "text" } } }],
      ["healthz body", { ok: true, version: "0.1.0" }],
    ])("200 with valid JSON that violates the contract (%s) → bad_response", async (_name, body) => {
      const { client } = served((r) => (r.onAny = () => json(body)));
      const e = await relayError(client.getRequest("req_1"));
      expect(e.kind).toBe("bad_response");
      expect(e.message).toContain("does not match the oyobidashi protocol");
    });

    test("connection refused → network error naming the URL", async () => {
      const port = await closedPort();
      const client = new RelayClient({ baseUrl: `http://127.0.0.1:${port}`, agentToken: "t" });
      const e = await relayError(client.createRequest({ kind: "question", question: "q" }));
      expect(e.kind).toBe("network");
      expect(e.transient).toBe(true);
      expect(e.message).toContain(`http://127.0.0.1:${port}`);
      expect(e.status).toBeUndefined();
    });

    test("relay closes the socket without answering → network error", async () => {
      const listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(socket) {
            socket.end();
          },
        },
      });
      stops.push(async () => listener.stop(true));
      const client = new RelayClient({ baseUrl: `http://127.0.0.1:${listener.port}`, agentToken: "t" });
      const e = await relayError(client.getRequest("req_1"));
      expect(e.kind).toBe("network");
      expect(e.transient).toBe(true);
    });

    test("relay answers with bytes that are not HTTP → network error", async () => {
      const listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(socket) {
            socket.write("\x00\x01garbage not http\r\n\r\n");
            socket.end();
          },
        },
      });
      stops.push(async () => listener.stop(true));
      const client = new RelayClient({ baseUrl: `http://127.0.0.1:${listener.port}`, agentToken: "t" });
      const e = await relayError(client.getRequest("req_1"));
      expect(e.transient).toBe(true);
      expect(["network", "bad_response"]).toContain(e.kind);
    });

    test("a redirect is not followed (the token must not leak to another host)", async () => {
      const { relay, client } = served((r) => (r.onAny = () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } })));
      await relayError(client.getRequest("req_1"));
      expect(relay.calls).toHaveLength(1);
    });
  });

  describe("timeouts and aborts with the real clock", () => {
    test("relay hanging on a normal call → timeout after requestTimeoutMs", async () => {
      const relay = new FakeRelay();
      relay.onAny = () => new Promise<Response>(() => {});
      const server = relay.serve();
      stops.push(server.stop);
      const client = new RelayClient({ baseUrl: server.url, agentToken: relay.token, requestTimeoutMs: 80 });
      const started = Date.now();
      const e = await relayError(client.createRequest({ kind: "question", question: "q" }));
      expect(e.kind).toBe("timeout");
      expect(e.transient).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    test("relay hanging longer than the long-poll → timeout after wait + grace", async () => {
      const relay = new FakeRelay();
      relay.onGet = () => new Promise<Response>(() => {});
      const server = relay.serve();
      stops.push(server.stop);
      const client = new RelayClient({ baseUrl: server.url, agentToken: relay.token, pollGraceMs: 100, requestTimeoutMs: 60_000 });
      const started = Date.now();
      const e = await relayError(client.getRequest("req_01JCXYZ", { waitSeconds: 1 }));
      const elapsed = Date.now() - started;
      expect(e.kind).toBe("timeout");
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(elapsed).toBeLessThan(4000);
    });

    test("headers sent but body never finishes → timeout", async () => {
      const relay = new FakeRelay();
      relay.onAny = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"request": {'));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const server = relay.serve();
      stops.push(server.stop);
      const client = new RelayClient({ baseUrl: server.url, agentToken: relay.token, requestTimeoutMs: 150 });
      const e = await relayError(client.getRequest("req_1"));
      expect(e.kind).toBe("timeout");
    });

    test("abort signal during a long-poll rejects with AbortError promptly", async () => {
      const { relay, client } = served();
      const controller = new AbortController();
      const started = Date.now();
      const promise = client.getRequest("req_01JCXYZ", { waitSeconds: 20, signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isAbortError(error)).toBe(true);
      expect(error).not.toBeInstanceOf(RelayError);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(relay.gets).toHaveLength(1);
    });

    test("an already-aborted signal never reaches the relay", async () => {
      const { relay, client } = served();
      const controller = new AbortController();
      controller.abort();
      const error = await client.createRequest({ kind: "question", question: "q" }, { signal: controller.signal }).catch((e: unknown) => e);
      expect(isAbortError(error)).toBe(true);
      expect(relay.calls).toHaveLength(0);
    });
  });
});

describe("RelayClient with injected fetch and fake clock", () => {
  test("uses the injected fetch with the full URL (base URL trailing slash stripped)", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = new RelayClient({
      baseUrl: "http://relay.test:8787/",
      agentToken: "ka_x",
      clock: new FakeClock(),
      fetch: async (url, init) => {
        seen.push({ url, init });
        return json({ request: fixture("request_pending.json") });
      },
    });
    await client.getRequest("req_01JCXYZ", { waitSeconds: 30 });
    expect(seen[0]!.url).toBe("http://relay.test:8787/v1/requests/req_01JCXYZ?wait=30");
    expect(seen[0]!.init.method).toBe("GET");
    expect(seen[0]!.init.body).toBeUndefined();
    expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe("Bearer ka_x");
  });

  test("long-poll timeout is wait + grace on the injected clock; no timer is left behind", async () => {
    const clock = new FakeClock();
    let fetchSignal: AbortSignal | undefined;
    const client = new RelayClient({
      baseUrl: "http://relay.test",
      agentToken: "t",
      clock,
      fetch: (_url, init) => {
        fetchSignal = init.signal ?? undefined;
        return new Promise<Response>(() => {}); // hangs forever and ignores the abort signal
      },
    });
    const t0 = clock.now();
    const e = await relayError(clock.run(client.getRequest("req_1", { waitSeconds: 30 })));
    expect(e.kind).toBe("timeout");
    expect(clock.now() - t0).toBe(40_000);
    expect(e.message).toContain("40s");
    expect(fetchSignal?.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
  });

  test("non-poll calls time out after requestTimeoutMs (default 15s)", async () => {
    const clock = new FakeClock();
    const client = new RelayClient({ baseUrl: "http://relay.test", agentToken: "t", clock, fetch: () => new Promise<Response>(() => {}) });
    const t0 = clock.now();
    const e = await relayError(clock.run(client.cancelRequest("req_1")));
    expect(e.kind).toBe("timeout");
    expect(clock.now() - t0).toBe(15_000);

    const t1 = clock.now();
    await relayError(clock.run(client.getRequest("req_1", { waitSeconds: 0 })));
    expect(clock.now() - t1).toBe(15_000);
  });

  test("a successful call cancels its timeout timer", async () => {
    const clock = new FakeClock();
    const client = new RelayClient({ baseUrl: "http://relay.test", agentToken: "t", clock, fetch: async () => json({ request: fixture("request_answered.json") }) });
    await client.getRequest("req_1", { waitSeconds: 30 });
    expect(clock.pendingTimers).toBe(0);
    expect(clock.sleeps).toEqual([40_000]);
  });

  test("fetch rejecting (e.g. ECONNREFUSED) → network error with the cause kept", async () => {
    const cause = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
    const clock = new FakeClock();
    const client = new RelayClient({ baseUrl: "http://relay.test", agentToken: "t", clock, fetch: () => Promise.reject(cause) });
    const e = await relayError(client.createRequest({ kind: "question", question: "q" }));
    expect(e.kind).toBe("network");
    expect(e.cause).toBe(cause);
    expect(clock.pendingTimers).toBe(0);
  });

  test("fetch throwing synchronously is also a network error", async () => {
    const client = new RelayClient({
      baseUrl: "http://relay.test",
      agentToken: "t",
      clock: new FakeClock(),
      fetch: () => {
        throw new TypeError("bad things");
      },
    });
    expect((await relayError(client.getRequest("req_1"))).kind).toBe("network");
  });

  test("abort wins over a hanging fetch that ignores the signal", async () => {
    const clock = new FakeClock();
    const client = new RelayClient({ baseUrl: "http://relay.test", agentToken: "t", clock, fetch: () => new Promise<Response>(() => {}) });
    const controller = new AbortController();
    const promise = client.getRequest("req_1", { waitSeconds: 30, signal: controller.signal });
    await clock.idle();
    controller.abort();
    const error = await promise.catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(clock.pendingTimers).toBe(0);
  });
});
