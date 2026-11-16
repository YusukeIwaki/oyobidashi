import { afterEach, describe, expect, test } from "bun:test";
import { RelayClient } from "../src/relay-client.ts";
import type { ServerDeps } from "../src/server.ts";
import { connect, envFor, FakeClock, FakeRelay, fixture, json, textOf, type Harness, type ToolCallResult } from "./helpers.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});


/** Asserts the recorded call carried the fake relay's agent token as a bearer token. */
function expectAgentAuth(headers: Headers, relay: FakeRelay): void {
  const scheme = "Bearer ";
  const value = headers.get("authorization") ?? "";
  expect(value.startsWith(scheme)).toBe(true);
  expect(value.slice(scheme.length)).toBe(relay.token);
}

async function setup(options: { deps?: ServerDeps; env?: Record<string, string | undefined> } = {}) {
  const clock = new FakeClock();
  const relay = new FakeRelay(clock);
  harness = await connect({ env: { ...envFor(relay), ...options.env }, fetch: relay.fetch, clock, ...options.deps });
  const h = harness;
  const call = (name: string, args: Record<string, unknown>) =>
    clock.run(h.client.callTool({ name, arguments: args })) as Promise<ToolCallResult>;
  return { clock, relay, h, call };
}

describe("ask_human extensions", () => {
  test("forwards priority/delivery_mode/expires_in_seconds as snake-case JSON", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(0);
    const result = await call("ask_human", {
      question: "Deploy now?",
      priority: "high",
      delivery_mode: "text",
      expires_in_seconds: 600,
    });
    expect(result.isError).toBeFalsy();
    expect(relay.creates).toHaveLength(1);
    const body = relay.creates[0]!.body;
    expect(body.priority).toBe("high");
    expect(body.delivery_mode).toBe("text");
    expect(body.expires_in_seconds).toBe(600);
    // compatibility: high priority also sends urgency high for old relays
    expect(body.urgency).toBe("high");
  });

  test("low priority maps to urgency normal; urgent maps to high", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(0);
    await call("ask_human", { question: "q", priority: "low", wait_seconds: 0 });
    expect(relay.creates[0]!.body).toMatchObject({ priority: "low", urgency: "normal" });
    await call("ask_human", { question: "q", priority: "urgent", wait_seconds: 0 });
    expect(relay.creates[1]!.body).toMatchObject({ priority: "urgent", urgency: "high" });
  });

  test("urgency-only still sends just urgency (v1 preserved)", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(0);
    await call("ask_human", { question: "q", urgency: "high", wait_seconds: 0 });
    expect(relay.creates[0]!.body).toMatchObject({ urgency: "high" });
    expect("priority" in relay.creates[0]!.body).toBe(false);
    expect("delivery_mode" in relay.creates[0]!.body).toBe(false);
  });

  test("priority wins over conflicting urgency", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(0);
    await call("ask_human", { question: "q", priority: "low", urgency: "high", wait_seconds: 0 });
    expect(relay.creates[0]!.body).toMatchObject({ priority: "low", urgency: "normal" });
  });

  test("omitted optionals are not sent (relay applies normal/auto defaults)", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(0);
    await call("ask_human", { question: "q", wait_seconds: 0 });
    const body = relay.creates[0]!.body;
    expect("priority" in body).toBe(false);
    expect("delivery_mode" in body).toBe(false);
    expect("urgency" in body).toBe(false);
    expect("expires_in_seconds" in body).toBe(false);
  });

  test.each([[10], [86400]])("expires_in_seconds boundary %p is accepted", async (value) => {
    const { relay, call } = await setup();
    relay.resolveAfter(0);
    const result = await call("ask_human", { question: "q", expires_in_seconds: value, wait_seconds: 0 });
    expect(result.isError).toBeFalsy();
    expect(relay.creates[0]!.body.expires_in_seconds).toBe(value);
    await harness!.close();
  });

  test.each([
    ["bad priority", { question: "q", priority: "critical" }, /priority/],
    ["bad delivery_mode", { question: "q", delivery_mode: "smoke" }, /delivery_mode/],
    ["expires too small", { question: "q", expires_in_seconds: 9 }, /expires_in_seconds/],
    ["expires too large", { question: "q", expires_in_seconds: 86401 }, /expires_in_seconds/],
    ["expires fractional", { question: "q", expires_in_seconds: 60.5 }, /expires_in_seconds/],
    ["expires wrong type", { question: "q", expires_in_seconds: "soon" }, /expires_in_seconds/],
  ])("ask_human rejects %s without contacting the relay", async (_name, args, pattern) => {
    const { relay, call } = await setup();
    const result = await call("ask_human", args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(pattern);
    expect(relay.calls).toHaveLength(0);
    await harness!.close();
  });
});

describe("get_human_status", () => {
  test("GET /v1/presence wiring and full structured result", async () => {
    const { relay, call } = await setup();
    relay.presence = {
      devices: [
        { device_id: "dev_01", availability: "available", until: null, note: null, updated_at: "2026-11-15T14:00:00.000Z", last_seen_at: "2026-11-15T14:05:00.000Z" },
        { device_id: "dev_02", availability: "busy", until: "2026-11-15T15:00:00.000Z", note: "in a meeting", updated_at: "2026-11-15T14:00:00.000Z", last_seen_at: "2026-11-15T14:04:00.000Z" },
      ],
      recent_events: [
        { request_id: "req_01JCXYZ", device_id: "dev_01", event: "answered", at: "2026-11-15T14:01:00.000Z" },
        { request_id: "req_01JCXYZ", device_id: "dev_02", event: "call.declined", at: "2026-11-15T14:02:00.000Z" },
      ],
      now: "2026-11-15T14:06:00.000Z",
    };
    const result = await call("get_human_status", {});
    expect(result.isError).toBeFalsy();
    expect(relay.presenceGets).toHaveLength(1);
    expectAgentAuth(relay.presenceGets[0]!.headers, relay);
    expect(result.structuredContent?.status).toBe("ok");
    expect(result.structuredContent?.devices).toHaveLength(2);
    expect(result.structuredContent?.recent_events).toHaveLength(2);
    expect(result.structuredContent?.now).toBe("2026-11-15T14:06:00.000Z");
    const text = textOf(result);
    expect(text).toContain("dev_01");
    expect(text).toContain("busy");
    expect(text).toContain("call.declined");
    expect(text).toMatch(/do NOT.*redial|do NOT escalate/i);
    expect(text).toMatch(/not guaranteed/i);
  });

  test("no devices and no events", async () => {
    const { relay, call } = await setup();
    relay.presence = { devices: [], recent_events: [], now: "2026-11-15T14:00:00.000Z" };
    const result = await call("get_human_status", {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "ok", devices: [], recent_events: [] });
    expect(textOf(result)).toMatch(/No devices are paired/);
  });

  test("relay 500 on presence is an error", async () => {
    const { relay, call } = await setup();
    relay.onPresence = () => json({ error: { code: "internal", message: "boom" } }, 500);
    const result = await call("get_human_status", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_code).toBe("internal");
  });
});

describe("update_request", () => {
  test("PATCH wiring: priority and delivery_mode as snake-case, effective mode and call survive", async () => {
    const { relay, call } = await setup();
    const result = await call("update_request", { request_id: "req_01JCXYZ", priority: "urgent", delivery_mode: "call" });
    expect(result.isError).toBeFalsy();
    expect(relay.updates).toHaveLength(1);
    const patch = relay.updates[0]!;
    expect(patch.method).toBe("PATCH");
    expect(patch.path).toBe("/v1/requests/req_01JCXYZ");
    expectAgentAuth(patch.headers, relay);
    expect(patch.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(patch.body).toEqual({ priority: "urgent", delivery_mode: "call" });
    expect(result.structuredContent?.status).toBe("pending");
    expect(result.structuredContent?.priority).toBe("urgent");
    expect(result.structuredContent?.delivery_mode).toBe("call");
    expect(result.structuredContent?.requested_mode).toBe("call");
    expect(result.structuredContent?.call).toMatchObject({ id: "call_01", state: "ringing" });
    expect(textOf(result)).toContain("Effective delivery mode");
  });

  test("priority-only and delivery-only patches omit the other field", async () => {
    const { relay, call } = await setup();
    await call("update_request", { request_id: "req_01JCXYZ", priority: "low" });
    expect(relay.updates[0]!.body).toEqual({ priority: "low" });
    await call("update_request", { request_id: "req_01JCXYZ", delivery_mode: "text" });
    expect(relay.updates[1]!.body).toEqual({ delivery_mode: "text" });
  });

  test("envelope feedback is returned in structuredContent", async () => {
    const { relay, call } = await setup();
    relay.updateFeedback = [{ event: "call.declined", at: "2026-11-15T14:02:00.000Z", device_id: "dev_01" }];
    const result = await call("update_request", { request_id: "req_01JCXYZ", priority: "high" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.feedback).toEqual(relay.updateFeedback);
  });

  test("call downgraded to text without high/urgent priority", async () => {
    const { call } = await setup();
    const result = await call("update_request", { request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "call" });
    expect(result.structuredContent?.delivery_mode).toBe("text");
  });

  test("requires at least one field; validates enums; trims request_id", async () => {
    const { relay, call } = await setup();
    const empty = await call("update_request", { request_id: "req_01JCXYZ" });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toMatch(/priority.*delivery_mode/);
    expect(relay.updates).toHaveLength(0);

    const bad = await call("update_request", { request_id: "req_01JCXYZ", priority: "critical" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/priority/);
    expect(relay.updates).toHaveLength(0);

    const ok = await call("update_request", { request_id: "  req_01JCXYZ\n", priority: "low" });
    expect(ok.isError).toBeFalsy();
    expect(relay.updates[0]!.path).toBe("/v1/requests/req_01JCXYZ");
  });

  test("404 unknown id and 409 resolved", async () => {
    const { relay, call } = await setup();
    const missing = await call("update_request", { request_id: "req_nope", priority: "high" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ status: "error", request_id: "req_nope", error_code: "not_found" });

    relay.current = fixture("request_answered.json");
    const resolved = await call("update_request", { request_id: "req_01JCXYZ", priority: "high" });
    expect(resolved.isError).toBe(true);
    expect(resolved.structuredContent?.error_code).toBe("already_resolved");
  });
});

describe("pending telemetry and notification withdrawal", () => {
  test("wait_for_answer pending carries priority/delivery_mode/call", async () => {
    const { relay, call } = await setup();
    relay.current = {
      ...fixture("request_pending.json"),
      priority: "high",
      delivery_mode: "call",
      requested_mode: "call",
      call: { id: "call_01", request_id: "req_01JCXYZ", state: "ringing", outcome: null, device_id: null, started_at: "2026-11-15T14:00:00.000Z", updated_at: "2026-11-15T14:00:00.000Z", transcript: [] },
    };
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ", wait_seconds: 0 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "pending",
      request_id: "req_01JCXYZ",
      priority: "high",
      delivery_mode: "call",
      requested_mode: "call",
    });
    expect(result.structuredContent?.call).toMatchObject({ id: "call_01", state: "ringing" });
    expect(textOf(result)).toContain("Delivery: call");
  });

  test("declined call warns not to redial", async () => {
    const { relay, call } = await setup();
    relay.current = {
      ...fixture("request_pending.json"),
      priority: "urgent",
      delivery_mode: "text",
      requested_mode: "call",
      call: { id: "call_01", request_id: "req_01JCXYZ", state: "ended", outcome: "declined", device_id: "dev_01", started_at: "2026-11-15T14:00:00.000Z", updated_at: "2026-11-15T14:01:00.000Z", transcript: [] },
    };
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ", wait_seconds: 0 });
    expect(textOf(result)).toMatch(/do NOT redial/);
  });

  test("v1-style pending without new fields still returns the plain shape", async () => {
    const { relay, call } = await setup();
    const v1 = { ...fixture("request_pending.json") } as Record<string, unknown>;
    for (const key of ["priority", "delivery_mode", "requested_mode", "call", "feedback"]) delete v1[key];
    relay.current = v1;
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ", wait_seconds: 0 });
    expect(result.structuredContent).toEqual({ status: "pending", request_id: "req_01JCXYZ" });
  });

  test("cancel_request withdraws a one-way notification", async () => {
    const { relay, call } = await setup();
    relay.current = fixture("request_notification.json");
    const result = await call("cancel_request", { request_id: "req_01JCNTF" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "cancelled", request_id: "req_01JCNTF", priority: "normal", delivery_mode: "text", requested_mode: "auto" });
  });

  test("cancel_request description mentions notifications", async () => {
    const { h } = await setup();
    const { tools } = await h.client.listTools();
    const cancel = tools.find((t) => t.name === "cancel_request")!.description!;
    expect(cancel).toMatch(/notification/i);
  });
});

describe("RelayClient extension wiring", () => {
  test("create sends new snake-case fields only when given", async () => {
    const clock = new FakeClock();
    const relay = new FakeRelay(clock);
    const client = new RelayClient({ baseUrl: "http://relay.test", agentToken: relay.token, clock, fetch: relay.fetch });
    await client.createRequest({ kind: "question", question: "q" });
    expect(relay.creates[0]!.body).toEqual({ kind: "question", question: "q" });
    await client.createRequest({ kind: "question", question: "q", priority: "low", deliveryMode: "actions", expiresInSeconds: 60 });
    expect(relay.creates[1]!.body).toEqual({ kind: "question", question: "q", priority: "low", delivery_mode: "actions", expires_in_seconds: 60 });
  });

  test("new request fields survive parsing; old fixtures still parse", async () => {
    const clock = new FakeClock();
    const relay = new FakeRelay(clock);
    relay.current = {
      ...fixture("request_pending.json"),
      priority: "urgent",
      delivery_mode: "call",
      requested_mode: "call",
      call: { id: "call_9", request_id: "req_01JCXYZ", state: "active", outcome: null, device_id: "dev_01", started_at: "2026-11-15T14:00:00.000Z", updated_at: "2026-11-15T14:01:00.000Z", transcript: [{ role: "user", text: "yes" }] },
      feedback: [{ event: "call.answered", at: "2026-11-15T14:00:30.000Z" }],
    };
    const client = new RelayClient({ baseUrl: "http://relay.test", agentToken: relay.token, clock, fetch: relay.fetch });
    const full = await client.getRequest("req_01JCXYZ");
    expect(full.priority).toBe("urgent");
    expect(full.delivery_mode).toBe("call");
    expect(full.requested_mode).toBe("call");
    expect(full.call?.state).toBe("active");
    expect(full.call?.transcript).toHaveLength(1);
    expect(full.feedback).toHaveLength(1);

    const v1 = { ...fixture("request_pending.json") } as Record<string, unknown>;
    for (const key of ["priority", "delivery_mode", "requested_mode", "call", "feedback"]) delete v1[key];
    relay.current = v1;
    const old = await client.getRequest("req_01JCXYZ");
    expect(old.priority ?? null).toBeNull();
    expect(old.call ?? null).toBeNull();
  });

  test("getPresence and updateRequest use auth and JSON", async () => {
    const clock = new FakeClock();
    const relay = new FakeRelay(clock);
    const client = new RelayClient({ baseUrl: "http://relay.test", agentToken: relay.token, clock, fetch: relay.fetch });
    const presence = await client.getPresence();
    expectAgentAuth(relay.presenceGets[0]!.headers, relay);
    expect(presence.devices).toHaveLength(1);
    const updated = await client.updateRequest("req_01JCXYZ", { priority: "high" });
    expect(relay.updates[0]!.body).toEqual({ priority: "high" });
    expect(updated.request.id).toBe("req_01JCXYZ");
  });
});
