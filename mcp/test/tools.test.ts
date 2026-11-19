import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import type { ServerDeps } from "../src/server.ts";
import { connect, envFor, FakeClock, FakeRelay, fixture, json, textOf, type Harness, type ToolCallResult } from "./helpers.ts";
import { PRIVACY_NOTICE } from "../src/results.ts";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: { deps?: ServerDeps; clientName?: string; env?: Record<string, string | undefined> } = {}) {
  const clock = new FakeClock();
  const relay = new FakeRelay(clock);
  harness = await connect({ env: { ...envFor(relay), ...options.env }, fetch: relay.fetch, clock, ...options.deps }, options.clientName);
  const h = harness;
  const call = (name: string, args: Record<string, unknown>, opts?: Parameters<Harness["client"]["callTool"]>[2]) =>
    clock.run(h.client.callTool({ name, arguments: args }, undefined, opts)) as Promise<ToolCallResult>;
  return { clock, relay, h, call };
}

const waits = (relay: FakeRelay) => relay.gets.map((c) => c.query.get("wait"));

describe("tool listing", () => {
  test("exposes exactly the 6 contract tools with valid JSON schemas", async () => {
    const { h } = await setup();
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["ask_human", "cancel_request", "get_human_status", "notify_human", "update_request", "wait_for_answer"].sort(),
    );

    const requestOutput = ["answer", "call", "choice_index", "delivery_mode", "error_code", "feedback", "input_method", "priority", "privacy_notice", "request_id", "requested_mode", "status", "warning"].sort();
    const presenceOutput = ["devices", "error_code", "now", "privacy_notice", "recent_events", "status", "warning"].sort();
    const ajv = new Ajv({ strict: false });
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(() => ajv.compile(tool.inputSchema)).not.toThrow();
      expect(tool.outputSchema?.type).toBe("object");
      expect(() => ajv.compile(tool.outputSchema!)).not.toThrow();
      expect(Object.keys(tool.outputSchema!.properties ?? {}).sort()).toEqual(
        tool.name === "get_human_status" ? presenceOutput : requestOutput,
      );
      expect(tool.outputSchema!.required).toEqual(["status"]);
      expect(tool.description!.length).toBeGreaterThan(100);
      for (const [name, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect((prop as { description?: string }).description, `${tool.name}.${name} description`).toBeTruthy();
      }
    }

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName.ask_human!.inputSchema.properties!).sort()).toEqual(
      ["choices", "context", "delivery_mode", "expires_in_seconds", "priority", "question", "subject", "urgency", "wait_seconds"].sort(),
    );
    expect(byName.ask_human!.inputSchema.required).toEqual(["question"]);
    expect(Object.keys(byName.wait_for_answer!.inputSchema.properties!).sort()).toEqual(["request_id", "wait_seconds"]);
    expect(byName.wait_for_answer!.inputSchema.required).toEqual(["request_id"]);
    expect(Object.keys(byName.notify_human!.inputSchema.properties!)).toEqual(["message"]);
    expect(byName.notify_human!.inputSchema.required).toEqual(["message"]);
    expect(Object.keys(byName.cancel_request!.inputSchema.properties!)).toEqual(["request_id"]);
    expect(byName.cancel_request!.inputSchema.required).toEqual(["request_id"]);
    expect(Object.keys(byName.get_human_status!.inputSchema.properties ?? {}).sort()).toEqual([]);
    expect(Object.keys(byName.update_request!.inputSchema.properties!).sort()).toEqual(["delivery_mode", "priority", "request_id"].sort());
    expect(byName.update_request!.inputSchema.required).toEqual(["request_id"]);

    const props = byName.ask_human!.inputSchema.properties as Record<string, any>;
    expect(props.question.maxLength).toBe(4000);
    expect(props.context.maxLength).toBe(8000);
    expect(props.choices.maxItems).toBe(8);
    expect(props.choices.items.maxLength).toBe(200);
    expect(props.urgency.enum).toEqual(["normal", "high"]);
    expect(props.priority.enum).toEqual(["low", "normal", "high", "urgent"]);
    expect(props.delivery_mode.enum).toEqual(["auto", "actions", "text", "call"]);
    expect(props.expires_in_seconds.minimum).toBe(10);
    expect(props.expires_in_seconds.maximum).toBe(86400);
    expect(props.wait_seconds.type).toBe("number");
    const updateProps = byName.update_request!.inputSchema.properties as Record<string, any>;
    expect(updateProps.priority.enum).toEqual(["low", "normal", "high", "urgent"]);
    expect(updateProps.delivery_mode.enum).toEqual(["auto", "actions", "text", "call"]);
  });

  test("descriptions tell the agent when to call, about voice errors, and how to continue on pending", async () => {
    const { h } = await setup();
    const { tools } = await h.client.listTools();
    const ask = tools.find((t) => t.name === "ask_human")!.description!;
    expect(ask).toMatch(/phone/i);
    expect(ask).toMatch(/only the human can decide/i);
    expect(ask).toMatch(/speech-to-text/i);
    expect(ask).toMatch(/recognition errors/i);
    expect(ask).toContain("wait_for_answer");
    expect(ask).toContain('"pending"');
    const wait = tools.find((t) => t.name === "wait_for_answer")!.description!;
    expect(wait).toContain("request_id");
    expect(wait).toMatch(/pending/);
    expect(tools.find((t) => t.name === "notify_human")!.description!).toMatch(/one-way/i);
    expect(ask).toContain("privacy_notice");
    expect(ask).toMatch(/personal or confidential/i);
    expect(tools.find((t) => t.name === "get_human_status")!.description!).toContain("privacy_notice");
    expect(tools.find((t) => t.name === "notify_human")!.description!).toContain("privacy_notice");
    expect(h.client.getInstructions()).toContain("ask_human");
    expect(h.client.getInstructions()).toContain("privacy_notice");
    expect(h.client.getServerVersion()?.name).toBe("oyobidashi");
  });
});

describe("ask_human", () => {
  test("answered immediately (already answered in the create response): no polling", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(0);
    const result = await call("ask_human", { question: "本番DBのマイグレーションを実行してよいですか?" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "answered", request_id: "req_01JCXYZ", answer: "はい", input_method: "choice", choice_index: 0, priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(relay.creates).toHaveLength(1);
    expect(relay.gets).toHaveLength(0);
  });

  test("answered during the first poll; request body is contract-conformant", async () => {
    const { relay, call, clock } = await setup();
    relay.resolveAfter(2_000);
    const t0 = clock.now();
    const result = await call("ask_human", { question: "本番DBのマイグレーションを実行してよいですか?" });

    expect(relay.creates).toHaveLength(1);
    const create = relay.creates[0]!;
    expect(create.headers.get("authorization")).toBe("Bearer ka_test_token");
    expect(create.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(create.body).toEqual({
      kind: "question",
      question: "本番DBのマイグレーションを実行してよいですか?",
      agent: { name: "claude-code", cwd: "/work/project" },
    });

    expect(waits(relay)).toEqual(["30"]);
    expect(relay.gets[0]!.path).toBe("/v1/requests/req_01JCXYZ");
    expect(clock.now() - t0).toBe(2_000);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "answered", request_id: "req_01JCXYZ", answer: "はい", input_method: "choice", choice_index: 0, priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    const text = textOf(result);
    expect(text).toContain("はい");
    expect(text).toContain("choice #1");
    expect(text).toContain("req_01JCXYZ");
    expect(clock.pendingTimers).toBe(0);
  });

  test("forwards a one-line call subject and omits blank subjects", async () => {
    const { relay, call } = await setup();
    await call("ask_human", { question: "実行してよいですか？", subject: " 本番デプロイ\nの承認 ", wait_seconds: 0 });
    expect(relay.creates[0]!.body.subject).toBe("本番デプロイ の承認");
    await call("ask_human", { question: "q", subject: " \n\t ", wait_seconds: 0 });
    expect(relay.creates[1]!.body.subject).toBeUndefined();
    const invalid = await call("ask_human", { question: "q", subject: "用".repeat(41), wait_seconds: 0 });
    expect(invalid.isError).toBe(true);
    expect(relay.creates).toHaveLength(2);
    const unicode = await call("ask_human", { question: "q", subject: "😀".repeat(40), wait_seconds: 0 });
    expect(unicode.isError).toBeFalsy();
    expect(relay.creates[2]!.body.subject).toBe("😀".repeat(40));
  });

  test("optional arguments are forwarded; blank context and empty choices are omitted", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(0);
    await call("ask_human", { question: "  Deploy now?  ", context: "v1.2.3 to production", choices: ["Yes", "No"], urgency: "high" });
    expect(relay.creates[0]!.body).toEqual({
      kind: "question",
      question: "Deploy now?",
      context: "v1.2.3 to production",
      choices: ["Yes", "No"],
      urgency: "high",
      agent: { name: "claude-code", cwd: "/work/project" },
    });
    await call("ask_human", { question: "Deploy now?", context: "   ", choices: [] });
    expect(relay.creates[1]!.body).toEqual({ kind: "question", question: "Deploy now?", agent: { name: "claude-code", cwd: "/work/project" } });
  });

  test("agent.name comes from the MCP client's clientInfo.name (truncated to 100 chars)", async () => {
    const a = await setup({ clientName: "codex-mcp-client" });
    a.relay.resolveAfter(0);
    await a.call("ask_human", { question: "q" });
    expect(a.relay.creates[0]!.body.agent).toEqual({ name: "codex-mcp-client", cwd: "/work/project" });
    await harness!.close();

    const b = await setup({ clientName: "x".repeat(150), deps: { cwd: () => `/${"d".repeat(1500)}` } });
    b.relay.resolveAfter(0);
    await b.call("ask_human", { question: "q" });
    expect(b.relay.creates[0]!.body.agent.name).toBe("x".repeat(100));
    expect(b.relay.creates[0]!.body.agent.cwd).toHaveLength(1000);
  });

  test("agent.cwd defaults to process.cwd(); a failing cwd() is tolerated", async () => {
    const clock = new FakeClock();
    const relay = new FakeRelay(clock);
    relay.resolveAfter(0);
    const { createServer } = await import("../src/server.ts");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    for (const cwd of [undefined, () => { throw new Error("ENOENT: cwd deleted"); }] as const) {
      const server = createServer({ env: envFor(relay), fetch: relay.fetch, clock, log: () => {}, ...(cwd ? { cwd } : {}) });
      const client = new Client({ name: "claude-code", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      await client.connect(a);
      const result = (await client.callTool({ name: "ask_human", arguments: { question: "q" } })) as ToolCallResult;
      expect(result.isError).toBeFalsy();
      await client.close();
      await server.close();
    }
    expect(relay.creates[0]!.body.agent).toEqual({ name: "claude-code", cwd: process.cwd() });
    expect(relay.creates[1]!.body.agent).toEqual({ name: "claude-code" });
  });

  test("answered after several poll cycles of at most 30s each", async () => {
    const { relay, call, clock } = await setup();
    relay.resolveAfter(75_000);
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q", wait_seconds: 120 });
    expect(waits(relay)).toEqual(["30", "30", "30"]);
    expect(relay.gets.map((c) => c.at - t0)).toEqual([0, 30_000, 60_000]);
    expect(clock.now() - t0).toBe(75_000);
    expect(result.structuredContent?.status).toBe("answered");
    expect(result.structuredContent?.answer).toBe("はい");
    expect(relay.creates).toHaveLength(1);
  });

  test("default wait is 50s: polls 30s + 20s then returns pending (not an error)", async () => {
    const { relay, call, clock } = await setup();
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q" });
    expect(waits(relay)).toEqual(["30", "20"]);
    expect(clock.now() - t0).toBe(50_000);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "pending", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    const text = textOf(result);
    expect(text).toContain("wait_for_answer");
    expect(text).toContain("req_01JCXYZ");
    expect(text).toContain("not an error");
    expect(text).toContain("50s");
    expect(clock.pendingTimers).toBe(0);
  });

  test("timeout → pending, then wait_for_answer → answered", async () => {
    const { relay, call } = await setup();
    const first = await call("ask_human", { question: "q", wait_seconds: 10 });
    expect(first.structuredContent).toEqual({ status: "pending", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(waits(relay)).toEqual(["10"]);

    const second = await call("wait_for_answer", { request_id: first.structuredContent!.request_id as string, wait_seconds: 10 });
    expect(second.structuredContent).toEqual({ status: "pending", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(second.isError).toBeFalsy();

    relay.resolveAfter(4_000);
    const third = await call("wait_for_answer", { request_id: "req_01JCXYZ" });
    expect(third.isError).toBeFalsy();
    expect(third.structuredContent).toEqual({ status: "answered", request_id: "req_01JCXYZ", answer: "はい", input_method: "choice", choice_index: 0, priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(relay.creates).toHaveLength(1); // the question was only sent once
    expect(waits(relay)).toEqual(["10", "10", "30"]);
  });

  test("voice answer: text, input_method voice, no choice_index, transcription caveat in the text", async () => {
    const { relay, call } = await setup();
    const voice = fixture("request_minimal_voice_answered.json");
    relay.current = { ...voice, status: "pending", answer: null };
    relay.resolveAfter(5_000, voice);
    const result = await call("ask_human", { question: "次はどのタスクをやりますか?", urgency: "high" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      status: "answered",
      request_id: "req_01JCMIN",
      answer: "ログイン画面のバグ修正を先にやって",
      input_method: "voice",
      priority: "normal",
      delivery_mode: "text",
      requested_mode: "auto",
    });
    expect("choice_index" in result.structuredContent!).toBe(false);
    const text = textOf(result);
    expect(text).toContain("ログイン画面のバグ修正を先にやって");
    expect(text).toMatch(/speech-to-text/);
    expect(text).toMatch(/recognition errors/);
  });

  test("typed text answer", async () => {
    const { relay, call } = await setup();
    const answered = fixture("request_answered.json");
    answered.answer = { text: "来週にして", choice_index: null, input_method: "text", device_id: "dev_01", answered_at: "2026-11-15T14:01:00.000Z" };
    relay.resolveAfter(1_000, answered);
    const result = await call("ask_human", { question: "q" });
    expect(result.structuredContent).toEqual({ status: "answered", request_id: "req_01JCXYZ", answer: "来週にして", input_method: "text", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(textOf(result)).toContain("typing");
  });

  test("cancelled while waiting → isError false, status cancelled", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(3_000, fixture("event_request_updated.json").request);
    const result = await call("ask_human", { question: "q" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "cancelled", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(textOf(result)).toMatch(/cancelled/);
  });

  test("expired while waiting → isError false, status expired", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(40_000, { ...fixture("request_pending.json"), status: "expired" });
    const result = await call("ask_human", { question: "q" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "expired", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(textOf(result)).toMatch(/expired/);
    expect(waits(relay)).toEqual(["30", "20"]);
  });

  test("wait_seconds 0 → creates the request and returns pending without polling", async () => {
    const { relay, call, clock } = await setup();
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q", wait_seconds: 0 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "pending", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(relay.creates).toHaveLength(1);
    expect(relay.gets).toHaveLength(0);
    expect(clock.now()).toBe(t0);
  });

  test("paired_devices 0 → warning field and text, still waits for an answer", async () => {
    const { relay, call } = await setup();
    relay.delivery = { paired_devices: 0, websocket_delivered: 0, push_attempted: 0 };
    const result = await call("ask_human", { question: "q", wait_seconds: 5 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe("pending");
    expect(result.structuredContent?.warning).toMatch(/No device is paired/);
    expect(textOf(result)).toMatch(/WARNING: No device is paired/);
    expect(waits(relay)).toEqual(["5"]);
  });

  test("no warning when a device is paired or when delivery info is absent", async () => {
    const { relay, call } = await setup();
    const a = await call("ask_human", { question: "q", wait_seconds: 0 });
    expect("warning" in a.structuredContent!).toBe(false);
    relay.onCreate = () => json({ request: fixture("request_pending.json") }, 201);
    const b = await call("ask_human", { question: "q", wait_seconds: 0 });
    expect("warning" in b.structuredContent!).toBe(false);
  });

  test("input_restricted on create adds privacy_notice to pending and answered; absent adds nothing", async () => {
    const notice = PRIVACY_NOTICE;
    const { relay, call } = await setup();
    relay.delivery = { paired_devices: 1, websocket_delivered: 1, push_attempted: 0, input_restricted: true };
    const pending = await call("ask_human", { question: "q", wait_seconds: 0 });
    expect(pending.structuredContent?.privacy_notice).toBe(notice);
    expect(textOf(pending)).toContain(notice);
    relay.resolveAfter(0);
    const answered = await call("ask_human", { question: "q" });
    expect(answered.structuredContent?.status).toBe("answered");
    expect(answered.structuredContent?.privacy_notice).toBe(notice);
    expect(textOf(answered)).toContain(notice);
    relay.delivery = { paired_devices: 1, websocket_delivered: 1, push_attempted: 0 };
    const plain = await call("ask_human", { question: "q", wait_seconds: 0 });
    expect("privacy_notice" in plain.structuredContent!).toBe(false);
    expect(textOf(plain)).not.toContain(notice);
  });

  test("progress notification per pending poll cycle when the client sent a progress token", async () => {
    const { relay, call } = await setup();
    const progress: { progress: number; total?: number | undefined; message?: string | undefined }[] = [];
    relay.resolveAfter(75_000);
    await call("ask_human", { question: "q", wait_seconds: 120 }, { onprogress: (p) => progress.push(p) });
    expect(progress.map((p) => [p.progress, p.total])).toEqual([
      [30, 120],
      [60, 120],
    ]);
    expect(progress[0]!.message).toContain("Waiting");
  });

  test("a relay that returns pending instantly (ignores wait) does not cause a busy loop", async () => {
    const { relay, call, clock } = await setup();
    relay.onGet = () => json({ request: fixture("request_pending.json") });
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q", wait_seconds: 5 });
    expect(result.structuredContent?.status).toBe("pending");
    expect(clock.now() - t0).toBe(5_000);
    expect(relay.gets).toHaveLength(5); // paced at >= 1s per cycle
  });
});

describe("wait_seconds clamping and defaults", () => {
  test("negative → 0", async () => {
    const { relay, call } = await setup();
    const result = await call("ask_human", { question: "q", wait_seconds: -30 });
    expect(result.structuredContent?.status).toBe("pending");
    expect(relay.gets).toHaveLength(0);
  });

  test("above 3600 → clamped to 3600 (120 polls of 30s)", async () => {
    const { relay, call, clock } = await setup();
    const t0 = clock.now();
    const result = await call("ask_human", { question: "q", wait_seconds: 999_999 });
    expect(result.structuredContent).toEqual({ status: "pending", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(clock.now() - t0).toBe(3_600_000);
    expect(relay.gets).toHaveLength(120);
    expect(new Set(waits(relay))).toEqual(new Set(["30"]));
    expect(textOf(result)).toContain("3600s");
  });

  test("fractional values are floored", async () => {
    const { relay, call } = await setup();
    await call("wait_for_answer", { request_id: "req_01JCXYZ", wait_seconds: 12.9 });
    expect(waits(relay)).toEqual(["12"]);
  });

  test("OYOBIDASHI_DEFAULT_WAIT_SECONDS sets the default; an explicit argument wins", async () => {
    const { relay, call } = await setup({ env: { OYOBIDASHI_DEFAULT_WAIT_SECONDS: "70" } });
    await call("ask_human", { question: "q" });
    expect(waits(relay)).toEqual(["30", "30", "10"]);
    await call("wait_for_answer", { request_id: "req_01JCXYZ", wait_seconds: 7 });
    expect(waits(relay).slice(3)).toEqual(["7"]);
  });

  test("OYOBIDASHI_DEFAULT_WAIT_SECONDS above range is clamped; garbage falls back to 50 with a log line", async () => {
    const a = await setup({ env: { OYOBIDASHI_DEFAULT_WAIT_SECONDS: "100000" } });
    await a.call("wait_for_answer", { request_id: "req_01JCXYZ" });
    expect(a.relay.gets).toHaveLength(120);
    await harness!.close();

    const b = await setup({ env: { OYOBIDASHI_DEFAULT_WAIT_SECONDS: "forever" } });
    await b.call("wait_for_answer", { request_id: "req_01JCXYZ" });
    expect(waits(b.relay)).toEqual(["30", "20"]);
    expect(b.h.logs.join("\n")).toContain("OYOBIDASHI_DEFAULT_WAIT_SECONDS");
  });

  test.each([["abc"], [null], [[10]], [{ seconds: 10 }], [true]])("non-numeric wait_seconds %p is rejected without contacting the relay", async (value) => {
    const { relay, call } = await setup();
    const result = await call("ask_human", { question: "q", wait_seconds: value });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("wait_seconds");
    expect(relay.calls).toHaveLength(0);
  });
});

describe("input validation", () => {
  test.each([
    ["empty question", { question: "" }, /question/],
    ["whitespace-only question", { question: "  \n\t " }, /question/],
    ["missing question", {}, /question/],
    ["question of wrong type", { question: 42 }, /question/],
    ["question over 4000 chars", { question: "x".repeat(4001) }, /question/],
    ["context over 8000 chars", { question: "q", context: "x".repeat(8001) }, /context/],
    ["more than 8 choices", { question: "q", choices: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }, /choices/],
    ["empty choice", { question: "q", choices: ["Yes", ""] }, /choices/],
    ["blank choice", { question: "q", choices: ["Yes", "   "] }, /choices/],
    ["choice over 200 chars", { question: "q", choices: ["x".repeat(201)] }, /choices/],
    ["choices not an array", { question: "q", choices: "Yes,No" }, /choices/],
    ["invalid urgency", { question: "q", urgency: "critical" }, /urgency/],
  ])("ask_human rejects %s", async (_name, args, pattern) => {
    const { relay, call } = await setup();
    const result = await call("ask_human", args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(pattern);
    expect(relay.calls).toHaveLength(0);
  });

  test("limits are inclusive: 4000-char question, 8 choices of 200 chars, 8000-char context are accepted", async () => {
    const { relay, call } = await setup();
    relay.resolveAfter(0);
    const result = await call("ask_human", { question: "x".repeat(4000), context: "c".repeat(8000), choices: Array.from({ length: 8 }, () => "y".repeat(200)) });
    expect(result.isError).toBeFalsy();
    expect(relay.creates[0]!.body.question).toHaveLength(4000);
    expect(relay.creates[0]!.body.choices).toHaveLength(8);
  });

  test.each([
    ["wait_for_answer", {}],
    ["wait_for_answer", { request_id: "" }],
    ["wait_for_answer", { request_id: "   " }],
    ["wait_for_answer", { request_id: 12 }],
    ["cancel_request", {}],
    ["cancel_request", { request_id: "" }],
    ["notify_human", {}],
    ["notify_human", { message: "" }],
    ["notify_human", { message: "   " }],
    ["notify_human", { message: "x".repeat(4001) }],
  ])("%s rejects %p", async (tool, args) => {
    const { relay, call } = await setup();
    const result = await call(tool, args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/request_id|message/);
    expect(relay.calls).toHaveLength(0);
  });

  test("unknown tool name is an error", async () => {
    const { relay, call } = await setup();
    const result = await call("ask_dog", { question: "q" });
    expect(result.isError).toBe(true);
    expect(relay.calls).toHaveLength(0);
  });
});

describe("wait_for_answer", () => {
  test("already answered → returns immediately with the answer", async () => {
    const { relay, call, clock } = await setup();
    relay.current = fixture("request_answered.json");
    const t0 = clock.now();
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "answered", request_id: "req_01JCXYZ", answer: "はい", input_method: "choice", choice_index: 0, priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(relay.gets).toHaveLength(1);
    expect(relay.gets[0]!.path).toBe("/v1/requests/req_01JCXYZ");
    expect(relay.gets[0]!.headers.get("authorization")).toBe("Bearer ka_test_token");
    expect(clock.now()).toBe(t0);
  });

  test("wait_seconds 0 → a single non-blocking GET (wait=0) reporting the current state", async () => {
    const { relay, call } = await setup();
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ", wait_seconds: 0 });
    expect(waits(relay)).toEqual(["0"]);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "pending", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
  });

  test("request_id is trimmed", async () => {
    const { relay, call } = await setup();
    relay.current = fixture("request_answered.json");
    await call("wait_for_answer", { request_id: "  req_01JCXYZ\n" });
    expect(relay.gets[0]!.path).toBe("/v1/requests/req_01JCXYZ");
  });

  test.each([["cancelled"], ["expired"]])("%s request → isError false", async (status) => {
    const { relay, call } = await setup();
    relay.current = { ...fixture("request_pending.json"), status };
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status, request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
  });

  test("a notification request → nothing to wait for (not an error)", async () => {
    const { relay, call } = await setup();
    relay.current = fixture("request_notification.json");
    const result = await call("wait_for_answer", { request_id: "req_01JCNTF" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "notified", request_id: "req_01JCNTF", priority: "normal", delivery_mode: "text", requested_mode: "auto" });
    expect(textOf(result)).toMatch(/cannot be answered/);
  });

  test("unknown future status is passed through without crashing", async () => {
    const { relay, call } = await setup();
    relay.current = { ...fixture("request_pending.json"), status: "snoozed" };
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "snoozed", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
  });

  test("status answered but answer missing → isError with a way forward", async () => {
    const { relay, call } = await setup();
    relay.current = { ...fixture("request_pending.json"), status: "answered", answer: null };
    const result = await call("wait_for_answer", { request_id: "req_01JCXYZ" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error_code).toBe("bad_response");
  });
});

describe("notify_human", () => {
  test("creates a notification request and does not wait", async () => {
    const { relay, call, clock } = await setup({ clientName: "codex" });
    const t0 = clock.now();
    const result = await call("notify_human", { message: "ビルドが完了しました" });
    expect(relay.calls).toHaveLength(1);
    expect(relay.creates[0]!.body).toEqual({ kind: "notification", question: "ビルドが完了しました", agent: { name: "codex", cwd: "/work/project" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "notified", request_id: "req_01JCNTF", priority: "normal", delivery_mode: "text", requested_mode: "auto" });
    expect(textOf(result)).toMatch(/Notification sent/);
    expect(clock.now()).toBe(t0);
  });

  test("paired_devices 0 → warning", async () => {
    const { relay, call } = await setup();
    relay.delivery = { paired_devices: 0, websocket_delivered: 0, push_attempted: 0 };
    const result = await call("notify_human", { message: "done" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.status).toBe("notified");
    expect(result.structuredContent?.warning).toMatch(/No device is paired/);
    expect(textOf(result)).toMatch(/WARNING/);
  });
});

describe("cancel_request", () => {
  test("pending request → cancelled", async () => {
    const { relay, call } = await setup();
    const result = await call("cancel_request", { request_id: "req_01JCXYZ" });
    expect(relay.calls).toHaveLength(1);
    expect(relay.cancels[0]!.path).toBe("/v1/requests/req_01JCXYZ/cancel");
    expect(relay.cancels[0]!.rawBody).toBe("");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "cancelled", request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
  });

  test("409 already_resolved (already answered) → not an error; reports the answer", async () => {
    const { relay, call } = await setup();
    relay.current = fixture("request_answered.json");
    const result = await call("cancel_request", { request_id: "req_01JCXYZ" });
    expect(relay.cancels).toHaveLength(1);
    expect(waits(relay)).toEqual(["0"]);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "answered", request_id: "req_01JCXYZ", answer: "はい", input_method: "choice", choice_index: 0, priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
    expect(textOf(result)).toMatch(/Nothing was cancelled/);
    expect(textOf(result)).toContain("はい");
  });

  test("409 already_resolved (already cancelled / expired) → reports that state", async () => {
    for (const status of ["cancelled", "expired"]) {
      const { relay, call } = await setup();
      relay.current = { ...fixture("request_pending.json"), status };
      const result = await call("cancel_request", { request_id: "req_01JCXYZ" });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ status, request_id: "req_01JCXYZ", priority: "normal", delivery_mode: "actions", requested_mode: "auto" });
      await harness!.close();
    }
  });

  test("409 already_resolved and the follow-up lookup fails → isError with the relay's message", async () => {
    const { relay, call } = await setup();
    relay.current = fixture("request_answered.json");
    relay.onGet = () => json({ error: { code: "internal", message: "db is locked" } }, 500);
    const result = await call("cancel_request", { request_id: "req_01JCXYZ" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ status: "error", request_id: "req_01JCXYZ", error_code: "already_resolved" });
    expect(textOf(result)).toContain("request is already answered");
  });
});

describe("lazy connection resolution", () => {
  test("config.json created after the server started is picked up on the next call", async () => {
    const home = mkdtempSync(join(tmpdir(), "oyobidashi-mcp-lazy-"));
    try {
      const clock = new FakeClock();
      const relay = new FakeRelay(clock);
      const urls: string[] = [];
      harness = await connect({
        env: { OYOBIDASHI_HOME: home },
        clock,
        fetch: (url, init) => {
          urls.push(url);
          return relay.fetch(url, init);
        },
      });
      const call = (args: Record<string, unknown>) => clock.run(harness!.client.callTool({ name: "notify_human", arguments: args })) as Promise<ToolCallResult>;

      const before = await call({ message: "hi" });
      expect(before.isError).toBe(true);
      expect(before.structuredContent?.error_code).toBe("config_missing");
      expect(urls).toHaveLength(0);

      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 18787, agent_token: relay.token }));
      const after = await call({ message: "hi" });
      expect(after.isError).toBeFalsy();
      expect(urls).toEqual(["http://127.0.0.1:18787/v1/requests"]);

      // token rotated / port changed while the server keeps running
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 18788, agent_token: "ka_other" }));
      const rotated = await call({ message: "hi" });
      expect(urls[1]).toBe("http://127.0.0.1:18788/v1/requests");
      expect(rotated.isError).toBe(true);
      expect(rotated.structuredContent?.error_code).toBe("unauthorized");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("env vars take precedence over the config file inside the server too", async () => {
    const home = mkdtempSync(join(tmpdir(), "oyobidashi-mcp-lazy-"));
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ port: 18787, agent_token: "ka_file" }));
      const clock = new FakeClock();
      const relay = new FakeRelay(clock);
      const urls: string[] = [];
      harness = await connect({
        env: { OYOBIDASHI_HOME: home, OYOBIDASHI_RELAY_URL: "http://127.0.0.1:20000", OYOBIDASHI_AGENT_TOKEN: relay.token },
        clock,
        fetch: (url, init) => {
          urls.push(url);
          return relay.fetch(url, init);
        },
      });
      const result = (await clock.run(harness.client.callTool({ name: "notify_human", arguments: { message: "hi" } }))) as ToolCallResult;
      expect(result.isError).toBeFalsy();
      expect(urls).toEqual(["http://127.0.0.1:20000/v1/requests"]);
      expect(relay.creates[0]!.headers.get("authorization")).toBe(`Bearer ${relay.token}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
