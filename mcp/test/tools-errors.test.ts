import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerDeps } from "../src/server.ts";
import { closedPort, connect, envFor, errorBody, FakeClock, FakeRelay, fixture, json, textOf, type Harness, type ToolCallResult } from "./helpers.ts";

let harness: Harness | undefined;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(options: { deps?: ServerDeps; env?: Record<string, string | undefined> } = {}) {
  const clock = new FakeClock();
  const relay = new FakeRelay(clock);
  harness = await connect({ env: { ...envFor(relay), ...options.env }, fetch: relay.fetch, clock, ...options.deps });
  const h = harness;
  const call = (name: string, args: Record<string, unknown>, opts?: Parameters<Harness["client"]["callTool"]>[2]) =>
    clock.run(h.client.callTool({ name, arguments: args }, undefined, opts)) as Promise<ToolCallResult>;
  return { clock, relay, h, call };
}

const refused = () => Promise.reject(Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }));

describe("relay unreachable", () => {
  test("connection refused (real socket, real clock) → isError telling how to start the relay", async () => {
    const port = await closedPort();
    harness = await connect({ env: { OYOBIDASHI_RELAY_URL: `http://127.0.0.1:${port}`, OYOBIDASHI_AGENT_TOKEN: "ka_x", OYOBIDASHI_HOME: "/nonexistent" } });
    for (const [name, args] of [
      ["ask_human", { question: "q" }],
      ["notify_human", { message: "m" }],
      ["wait_for_answer", { request_id: "req_1" }],
      ["cancel_request", { request_id: "req_1" }],
    ] as const) {
      const result = (await harness.client.callTool({ name, arguments: args })) as ToolCallResult;
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.status).toBe("error");
      expect(result.structuredContent?.error_code).toBe("relay_unreachable");
      const text = textOf(result);
      expect(text).toContain("cd relay && bun run serve");
      expect(text).toContain(`http://127.0.0.1:${port}`);
      expect(text).toContain("OYOBIDASHI_RELAY_URL");
    }
    expect(harness.logs.length).toBeGreaterThan(0); // diagnostics go to the injected (stderr) logger
  });

  test("ask_human: nothing was created, so no request_id and no 'do not ask again' advice", async () => {
    const { relay, call } = await setup();
    relay.onAny = refused;
    const result = await call("ask_human", { question: "q" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", error_code: "relay_unreachable" });
    expect(textOf(result)).not.toContain("wait_for_answer");
    expect(relay.calls).toHaveLength(1); // no retry of a create (it is not idempotent)
  });

  test("wait_for_answer: a first poll that fails is reported immediately (no blind retries)", async () => {
    const { relay, call, clock } = await setup();
    relay.onAny = refused;
    const t0 = clock.now();
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", request_id: "req_01JCXYZ", error_code: "relay_unreachable" });
    expect(textOf(result)).toContain('wait_for_answer with request_id "req_01JCXYZ"');
    expect(relay.calls).toHaveLength(1);
    expect(clock.now()).toBe(t0);
  });
});

describe("configuration problems", () => {
  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), "oyobidashi-mcp-err-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    return home;
  }

  test("missing config file and no env → isError with setup instructions; relay never contacted", async () => {
    const home = tempHome();
    let fetched = 0;
    harness = await connect({ env: { OYOBIDASHI_HOME: home }, fetch: async () => (fetched++, json({})) });
    for (const [name, args] of [
      ["ask_human", { question: "q" }],
      ["wait_for_answer", { request_id: "req_1" }],
      ["notify_human", { message: "m" }],
      ["cancel_request", { request_id: "req_1" }],
    ] as const) {
      const result = (await harness.client.callTool({ name, arguments: args })) as ToolCallResult;
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error_code).toBe("config_missing");
      const text = textOf(result);
      expect(text).toContain(join(home, "config.json"));
      expect(text).toContain("cd relay && bun run serve");
      expect(text).toContain("OYOBIDASHI_AGENT_TOKEN");
    }
    expect(fetched).toBe(0);
  });

  test.each([
    ["malformed JSON", "{ not json", /not valid JSON/],
    ["wrong shape", "[1,2,3]", /must be a JSON object/],
    ["bad port", JSON.stringify({ port: "abc", agent_token: "ka_x" }), /invalid "port"/],
    ["no token", JSON.stringify({ port: 8787 }), /has no "agent_token"/],
  ])("%s config → isError", async (_name, content, pattern) => {
    const home = tempHome();
    writeFileSync(join(home, "config.json"), content);
    harness = await connect({ env: { OYOBIDASHI_HOME: home }, fetch: async () => json({}) });
    const result = (await harness.client.callTool({ name: "ask_human", arguments: { question: "q" } })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(pattern);
    expect(String(result.structuredContent?.error_code)).toMatch(/^config_/);
  });

  test("invalid OYOBIDASHI_RELAY_URL → isError", async () => {
    harness = await connect({ env: { OYOBIDASHI_RELAY_URL: "localhost:8787", OYOBIDASHI_AGENT_TOKEN: "t", OYOBIDASHI_HOME: "/nonexistent" }, fetch: async () => json({}) });
    const result = (await harness.client.callTool({ name: "notify_human", arguments: { message: "m" } })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_code).toBe("config_invalid");
    expect(textOf(result)).toContain("OYOBIDASHI_RELAY_URL");
  });
});

describe("HTTP errors from the relay", () => {
  test("401 (error_unauthorized fixture, wrong token) → explains where the token comes from", async () => {
    const { relay, call } = await setup({ env: { OYOBIDASHI_AGENT_TOKEN: "ka_wrong" } });
    for (const [name, args] of [
      ["ask_human", { question: "q" }],
      ["wait_for_answer", { request_id: "req_01JCXYZ" }],
      ["notify_human", { message: "m" }],
      ["cancel_request", { request_id: "req_01JCXYZ" }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent?.error_code).toBe("unauthorized");
      const text = textOf(result);
      expect(text).toContain("401");
      expect(text).toContain("agent_token");
      expect(text).toContain("OYOBIDASHI_AGENT_TOKEN");
      expect(text).toContain("invalid or missing token");
      expect(text).not.toContain("ka_wrong"); // never echo the token
    }
    expect(relay.calls).toHaveLength(4); // no retries on auth failure
  });

  test("403 forbidden → explains tunnel / proxy / token role", async () => {
    const { relay, call } = await setup();
    relay.onAny = () => json(errorBody("forbidden", "agent API is not available through the tunnel"), 403);
    const result = await call("ask_human", { question: "q" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", error_code: "forbidden" });
    const text = textOf(result);
    expect(text).toContain("403");
    expect(text).toMatch(/tunnel/);
    expect(text).toContain("X-Forwarded");
    expect(relay.calls).toHaveLength(1);
  });

  test("404 for an unknown request_id (wait_for_answer and cancel_request)", async () => {
    const { relay, call } = await setup();
    const waited = await call("wait_for_answer", { request_id: "req_unknown" });
    expect(waited.isError).toBe(true);
    expect(waited.structuredContent).toEqual({ status: "error", request_id: "req_unknown", error_code: "not_found" });
    expect(textOf(waited)).toContain('Unknown request_id "req_unknown"');
    expect(relay.gets).toHaveLength(1);

    const cancelled = await call("cancel_request", { request_id: "req_unknown" });
    expect(cancelled.isError).toBe(true);
    expect(cancelled.structuredContent).toEqual({ status: "error", request_id: "req_unknown", error_code: "not_found" });
    expect(textOf(cancelled)).toContain('Unknown request_id "req_unknown"');
  });

  test("404 without a oyobidashi error body on create → 'not the oyobidashi relay' hint", async () => {
    const { relay, call } = await setup();
    relay.onAny = () => new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } });
    const result = await call("ask_human", { question: "q" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does not look like the oyobidashi relay/);
    expect(textOf(result)).toContain("OYOBIDASHI_RELAY_URL");
  });

  test("400 invalid_request → the relay's validation message is passed through", async () => {
    const { relay, call } = await setup();
    relay.onCreate = () => json(errorBody("invalid_request", "choices[2] must be 1-200 characters"), 400);
    const result = await call("ask_human", { question: "q", choices: ["a", "b", "c"] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", error_code: "invalid_request" });
    expect(textOf(result)).toContain("choices[2] must be 1-200 characters");
    expect(relay.calls).toHaveLength(1);

    relay.onCreate = () => json(errorBody("invalid_request", "question is required"), 400);
    const notify = await call("notify_human", { message: "m" });
    expect(notify.isError).toBe(true);
    expect(textOf(notify)).toContain("question is required");
  });

  test("413 and 429 are reported with their meaning", async () => {
    const { relay, call } = await setup();
    relay.onCreate = () => json(errorBody("payload_too_large", "body exceeds 64KB"), 413);
    const big = await call("ask_human", { question: "q" });
    expect(big.isError).toBe(true);
    expect(big.structuredContent?.error_code).toBe("payload_too_large");
    expect(textOf(big)).toMatch(/too large/);
    relay.onCreate = () => json(errorBody("rate_limited", "slow down"), 429);
    const limited = await call("ask_human", { question: "q" });
    expect(limited.isError).toBe(true);
    expect(limited.structuredContent?.error_code).toBe("rate_limited");
  });

  test("500 on create → isError, not retried (create is not idempotent)", async () => {
    const { relay, call } = await setup();
    relay.onCreate = () => json(errorBody("internal", "sqlite: database is locked"), 500);
    const result = await call("ask_human", { question: "q" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", error_code: "internal" });
    expect(textOf(result)).toContain("HTTP 500");
    expect(textOf(result)).toContain("sqlite: database is locked");
    expect(relay.calls).toHaveLength(1);
  });

  test("500 with a plain-text body on cancel", async () => {
    const { relay, call } = await setup();
    relay.onCancel = () => new Response("Internal Server Error", { status: 500 });
    const result = await call("cancel_request", { request_id: "req_01JCXYZ" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", request_id: "req_01JCXYZ", error_code: "internal" });
  });

  test("409 on cancel with an unexpected code is an error (only already_resolved is special)", async () => {
    const { relay, call } = await setup();
    relay.onCancel = () => json(errorBody("conflict", "busy"), 409);
    const result = await call("cancel_request", { request_id: "req_01JCXYZ" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_code).toBe("conflict");
    expect(relay.gets).toHaveLength(0);
  });
});

describe("garbage responses", () => {
  test.each([
    ["HTML page", () => new Response("<!doctype html><html><body>It works!</body></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["empty body", () => new Response("", { status: 201 })],
    ["truncated JSON", () => new Response('{"request":{"id":"req_', { status: 201 })],
    ["JSON of the wrong shape", () => json({ ok: true, version: "0.1.0" })],
    ["binary junk", () => new Response(new Uint8Array([0, 255, 254, 1, 2, 3]), { status: 200 })],
  ])("%s on create → isError bad_response", async (_name, respond) => {
    const { relay, call } = await setup();
    relay.onCreate = respond;
    const result = await call("ask_human", { question: "q" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", error_code: "bad_response" });
    expect(textOf(result)).toMatch(/something other than the oyobidashi relay|does not match/);
    expect(relay.calls).toHaveLength(1);
  });

  test("garbage on the first wait_for_answer poll → isError with the request_id", async () => {
    const { relay, call } = await setup();
    relay.onGet = () => new Response("<html>proxy error</html>", { status: 200 });
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", request_id: "req_01JCXYZ", error_code: "bad_response" });
  });

  test("garbage on notify → isError", async () => {
    const { relay, call } = await setup();
    relay.onCreate = () => new Response("OK", { status: 200 });
    const result = await call("notify_human", { message: "m" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_code).toBe("bad_response");
  });
});

describe("relay hanging", () => {
  test("create never answers → client-side timeout (15s) → isError", async () => {
    const { relay, call, clock } = await setup();
    relay.onCreate = () => new Promise<Response>(() => {});
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q" });
    expect(clock.now() - t0).toBe(15_000);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", error_code: "relay_timeout" });
    expect(textOf(result)).toMatch(/did not respond within 15s/);
    expect(clock.pendingTimers).toBe(0);
  });

  test("long-poll hangs past wait + grace → timed out, retried, then error that keeps the request_id", async () => {
    const { relay, call, clock } = await setup();
    relay.onGet = () => new Promise<Response>(() => {});
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q" }); // 50s budget
    // poll 1: wait=30 → gives up at 40s; backoff 1s; poll 2: wait=9 → gives up at 60s, budget used up
    expect(relay.gets.map((c) => [c.at - t0, c.query.get("wait")])).toEqual([
      [0, "30"],
      [41_000, "9"],
    ]);
    expect(clock.now() - t0).toBe(60_000);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", request_id: "req_01JCXYZ", error_code: "relay_timeout" });
    const text = textOf(result);
    expect(text).toContain("do NOT ask it again");
    expect(text).toContain('wait_for_answer with request_id "req_01JCXYZ"');
    expect(relay.creates).toHaveLength(1);
    expect(relay.gets.every((c) => c.signal.aborted)).toBe(true); // hung requests were aborted
    expect(clock.pendingTimers).toBe(0);
  });

  test("short real timeouts against a real hanging HTTP server", async () => {
    const relay = new FakeRelay();
    relay.onCreate = () => new Promise<Response>(() => {});
    const server = relay.serve();
    cleanups.push(server.stop);
    harness = await connect({ env: envFor(relay, server.url), requestTimeoutMs: 100 });
    const started = Date.now();
    const result = (await harness.client.callTool({ name: "notify_human", arguments: { message: "m" } })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_code).toBe("relay_timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("relay failing between polls", () => {
  test("dies after the first poll, then recovers → the answer is still delivered", async () => {
    const { relay, call, clock } = await setup();
    let n = 0;
    relay.onGet = (c, r) => {
      n += 1;
      if (n === 2 || n === 3) return refused();
      if (n === 4) r.current = fixture("request_answered.json");
      return r.longPoll(c);
    };
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q", wait_seconds: 120 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "answered", request_id: "req_01JCXYZ", answer: "はい", input_method: "choice", choice_index: 0, priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    // poll(30s) → refused → +1s → refused → +2s → answered
    expect(relay.gets.map((c) => c.at - t0)).toEqual([0, 30_000, 31_000, 33_000]);
    expect(relay.creates).toHaveLength(1);
  });

  test("5xx and garbage between polls are retried too", async () => {
    const { relay, call } = await setup();
    let n = 0;
    relay.onGet = (c, r) => {
      n += 1;
      if (n === 1) return json(errorBody("internal", "boom"), 500);
      if (n === 2) return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      if (n === 3) return new Response("not json", { status: 200 });
      r.current = fixture("request_minimal_voice_answered.json");
      return r.longPoll(c);
    };
    const result = await call("ask_human", { question: "q", wait_seconds: 120 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe("answered");
    expect(result.structuredContent?.input_method).toBe("voice");
    expect(relay.gets).toHaveLength(4);
  });

  test("the retry counter resets after a successful poll", async () => {
    const { relay, call } = await setup();
    let n = 0;
    relay.onGet = (c, r) => {
      n += 1;
      // 3 failures, success (pending), 3 failures, answered: only ever 3 in a row
      if ([1, 2, 3, 5, 6, 7].includes(n)) return refused();
      if (n === 8) r.current = fixture("request_answered.json");
      return r.longPoll(c);
    };
    const result = await call("ask_human", { question: "q", wait_seconds: 600 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe("answered");
    expect(relay.gets).toHaveLength(8);
  });

  test("stays dead → gives up after 3 retries with an error that keeps the request_id", async () => {
    const { relay, call, clock } = await setup();
    let n = 0;
    relay.onGet = (c, r) => (++n === 1 ? r.longPoll(c) : refused());
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q", wait_seconds: 300 });
    expect(relay.gets.map((c) => c.at - t0)).toEqual([0, 30_000, 31_000, 33_000, 37_000]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", request_id: "req_01JCXYZ", error_code: "relay_unreachable" });
    const text = textOf(result);
    expect(text).toContain("cd relay && bun run serve");
    expect(text).toContain("do NOT ask it again");
    expect(text).toContain('wait_for_answer with request_id "req_01JCXYZ"');
    expect(clock.pendingTimers).toBe(0);
  });

  test("…and a later wait_for_answer succeeds once the relay is back", async () => {
    const { relay, call } = await setup();
    relay.onGet = refused;
    const failed = await call("ask_human", { question: "q", wait_seconds: 300 });
    expect(failed.isError).toBe(true);
    relay.onGet = undefined;
    relay.resolveAfter(1_000);
    const result = await call("wait_for_answer", { request_id: failed.structuredContent!.request_id as string });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.answer).toBe("はい");
    expect(relay.creates).toHaveLength(1);
  });

  test("wait_for_answer also retries once it has seen the request", async () => {
    const { relay, call } = await setup();
    let n = 0;
    relay.onGet = (c, r) => {
      n += 1;
      if (n === 2) return refused();
      if (n === 3) r.current = fixture("request_answered.json");
      return r.longPoll(c);
    };
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ", wait_seconds: 100 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe("answered");
    expect(relay.gets).toHaveLength(3);
  });

  test("non-transient errors mid-polling are not retried (401 after token rotation, 404 after DB reset)", async () => {
    for (const [status, code] of [
      [401, "unauthorized"],
      [404, "not_found"],
      [403, "forbidden"],
    ] as const) {
      const { relay, call } = await setup();
      let n = 0;
      relay.onGet = (c, r) => (++n === 1 ? r.longPoll(c) : json(errorBody(code, "nope"), status));
      const result = await call("ask_human", { question: "q", wait_seconds: 120 });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ status: "error", request_id: "req_01JCXYZ", error_code: code });
      expect(relay.gets).toHaveLength(2);
      await harness!.close();
    }
  });

  test("the time budget ends during the outage → error (not a misleading 'pending')", async () => {
    const { relay, call, clock } = await setup();
    let n = 0;
    relay.onGet = (c, r) => (++n === 1 ? r.longPoll(c) : refused());
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q", wait_seconds: 32 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.request_id).toBe("req_01JCXYZ");
    expect(clock.now() - t0).toBeLessThanOrEqual(32_000);
  });
});

describe("MCP request cancellation", () => {
  test("aborting the tool call mid-poll stops polling and aborts the in-flight HTTP request", async () => {
    const { relay, clock, h } = await setup();
    const controller = new AbortController();
    const promise = h.client.callTool({ name: "ask_human", arguments: { question: "q", wait_seconds: 600 } }, undefined, { signal: controller.signal });
    const outcome = promise.then(
      () => "resolved",
      (e: unknown) => e,
    );

    await clock.runUntil(() => relay.gets.length === 2); // in the middle of the 2nd long-poll
    expect(relay.gets[1]!.signal.aborted).toBe(false);
    controller.abort("user pressed escape");
    expect(await outcome).not.toBe("resolved");
    await clock.idle();

    expect(relay.gets[1]!.signal.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0); // no poll, timeout or backoff timer is left running
    while (clock.advanceToNext()) await clock.idle();
    await clock.idle();
    expect(relay.gets).toHaveLength(2); // no further polling
    expect(relay.cancels).toHaveLength(0);

    // the server is still healthy and serves the next call
    relay.current = fixture("request_answered.json");
    const next = (await clock.run(h.client.callTool({ name: "wait_for_answer", arguments: { request_id: "req_01JCXYZ" } }))) as ToolCallResult;
    expect(next.structuredContent?.status).toBe("answered");
  });

  test("aborting during a retry backoff sleep stops as well", async () => {
    const { relay, clock, h } = await setup({ deps: { retryBackoffMs: [60_000, 60_000, 60_000] } });
    let n = 0;
    relay.onGet = (c, r) => (++n === 1 ? r.longPoll(c) : refused());
    const controller = new AbortController();
    const outcome = h.client
      .callTool({ name: "wait_for_answer", arguments: { request_id: "req_01JCXYZ", wait_seconds: 600 } }, undefined, { signal: controller.signal })
      .then(
        () => "resolved",
        (e: unknown) => e,
      );
    await clock.runUntil(() => relay.gets.length === 2);
    await clock.idle();
    expect(clock.pendingTimers).toBe(1); // the backoff sleep
    controller.abort();
    expect(await outcome).not.toBe("resolved");
    await clock.idle();
    expect(clock.pendingTimers).toBe(0);
    expect(relay.gets).toHaveLength(2);
  });

  test("aborting while the create request is in flight", async () => {
    const { relay, clock, h } = await setup();
    relay.onCreate = () => new Promise<Response>(() => {});
    const controller = new AbortController();
    const outcome = h.client.callTool({ name: "ask_human", arguments: { question: "q" } }, undefined, { signal: controller.signal }).then(
      () => "resolved",
      (e: unknown) => e,
    );
    await clock.runUntil(() => relay.creates.length === 1);
    controller.abort();
    expect(await outcome).not.toBe("resolved");
    await clock.idle();
    expect(relay.creates[0]!.signal.aborted).toBe(true);
    expect(clock.pendingTimers).toBe(0);
    expect(relay.gets).toHaveLength(0);
  });
});
