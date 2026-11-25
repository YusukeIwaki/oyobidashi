import { expect, test } from "bun:test";
import type { ConversationProvider } from "../../relay/src/conversation.ts";
import { configuredPlanConversations, planVoiceProviders } from "../src/provider.ts";
import { CloudService } from "../src/service.ts";
import { JobWorker } from "../src/worker.ts";
import { harness } from "./helpers.ts";

const plans = { free: "meta", plus: "gemini" } as const;
const items = [
  { id: "route", question: "配送方法は？", choices: ["通常便", "速達"] },
  { id: "day", question: "発送日は？" },
  { id: "label", question: "ラベルの版は？", ask_on_call: false },
];
const turnBody = (text: string) => ({ event: "turn", text, turn_id: crypto.randomUUID(), async: true });
const routeResult = { updates: [{ item_id: "route", evidence: "通常便", choice_index: 0 }], handoff: false };
const dayResult = { updates: [{ item_id: "day", evidence: "金曜日" }], handoff: false };
const itemProvider = (itemTurn: NonNullable<ConversationProvider["itemTurn"]>): ConversationProvider => ({
  turn: async () => { throw new Error("expected an item turn"); },
  itemTurn,
});

async function setup(plus = false) {
  const h = harness();
  h.service.planVoiceProviders = plans;
  const setPlus = (active: boolean) => h.db.transaction("alice", tx => tx.put("entitlement", "current", {
    sources: active ? {
      test: { store: "apple", product_id: "plus", shared: false, expires: h.clock.now + 60_000 },
    } : {},
  }));
  await setPlus(plus);
  const phone = await h.pair();
  const token = phone.device_token;
  const created = await h.call("POST", "/v1/requests", "agent-alice", {
    question: "発送方法の確認", priority: "high", delivery_mode: "call", items,
  });
  expect(created.status).toBe(201);
  const path = `/v1/requests/${created.body.request.id}`;
  const event = (body: object, provider?: string) => h.call("POST", `${path}/call`, token, body,
    provider ? { "X-Oyobidashi-Voice-Provider": provider } : {});
  return { ...h, created, token, path, event, setPlus };
}

test("a plan selects and discloses its provider, and the worker uses only that route", async () => {
  for (const tier of ["free", "plus"] as const) {
    const h = await setup(tier === "plus");
    const provider = plans[tier];
    expect((await h.call("GET", "/v1/voice/disclosure", h.token)).body).toEqual({ provider });
    expect(h.created.body.request.call).toMatchObject({ voice_provider: provider, voice_plan: tier });
    expect((await h.event({ event: "answer" }, provider)).status).toBe(200);
    const calls: string[] = [];
    const worker = new JobWorker(h.service, {
      freeConversation: itemProvider(async () => { calls.push("meta"); return routeResult; }),
      conversation: itemProvider(async () => { calls.push("gemini"); return routeResult; }),
    });
    expect((await h.event(turnBody("通常便で"), provider)).status).toBe(202);
    await worker.runOnce("turn");
    expect(calls).toEqual([provider]);
    expect((await h.call("GET", h.path, h.token)).body.request.item_answers).toMatchObject([
      { item_id: "route", text: "通常便", input_method: "voice" },
    ]);
  }
});

test("missing or stale consent on answer or turn prevents transmission and offers text", async () => {
  for (const consent of [undefined, "meta"]) {
    const h = await setup(true);
    const result = await h.event({ event: "answer" }, consent);
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("voice_handoff");
    expect((await h.call("GET", h.path, h.token)).body.request).toMatchObject({
      status: "pending", delivery_mode: "text", call: { end_call: true, state: "ended", transcript: [] },
    });
  }
  const h = await setup(true);
  expect((await h.event({ event: "answer" }, "gemini")).status).toBe(200);
  expect((await h.event(turnBody("通常便"), "meta")).status).toBe(409);
  expect(await new JobWorker(h.service, {}).runOnce("turn")).toBe(false);
});

test("upgrade or lapse after a committed answer preserves it for text handoff", async () => {
  for (const startingPlus of [false, true]) {
    const h = await setup(startingPlus);
    const provider = startingPlus ? "gemini" : "meta";
    await h.event({ event: "answer" }, provider);
    await h.event(turnBody("通常便"), provider);
    const model = itemProvider(async () => routeResult);
    const worker = new JobWorker(h.service, { conversation: model, freeConversation: model });
    await worker.runOnce("turn");
    await h.setPlus(!startingPlus);
    expect((await h.event(turnBody("金曜日"), provider)).status).toBe(409);
    expect(await worker.runOnce("turn")).toBe(false);
    const snapshot = await h.call("GET", h.path, h.token);
    expect(snapshot.body.request).toMatchObject({
      status: "pending", delivery_mode: "text", call: { end_call: true, state: "ended" },
      item_answers: [{ item_id: "route", text: "通常便", input_method: "voice" }],
    });
    const response = await h.call("POST", `${h.path}/answer`, h.token, {
      item_answers: [{ item_id: "day", text: "金曜日" }, { item_id: "label", text: "第2版" }],
    });
    expect(response.body.request).toMatchObject({
      status: "answered",
      item_answers: [
        { item_id: "route", text: "通常便", input_method: "voice" },
        { item_id: "day", text: "金曜日", input_method: "text" },
        { item_id: "label", text: "第2版", input_method: "text" },
      ],
    });
  }
});

test("an expired plan or a worker still on the old config never delivers queued audio text", async () => {
  for (const oldWorker of [false, true]) {
    const h = await setup(true);
    await h.event({ event: "answer" }, "gemini");
    const body = turnBody("通常便");
    await h.event(body, "gemini");
    if (!oldWorker) await h.setPlus(false);
    let sends = 0;
    const model = itemProvider(async () => { sends++; return routeResult; });
    const worker = new JobWorker(oldWorker ? new CloudService(h.db, h.bus, () => h.clock.now) : h.service,
      { conversation: model, freeConversation: model });
    expect(await worker.runOnce("turn")).toBe(true);
    expect(sends).toBe(0);
    expect((await h.event(body, "gemini")).body).toMatchObject({
      request: { delivery_mode: "text", call: { state: "ended", end_call: true }, item_answers: [] },
      turn: { state: "cancelled", error: { code: "voice_handoff" } },
    });
  }
});

test("an in-flight result is saved at the original provider before ending the call", async () => {
  const h = await setup(true);
  await h.event({ event: "answer" }, "gemini");
  let entered!: () => void;
  let release!: (result: typeof dayResult) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<typeof dayResult>(resolve => { release = resolve; });
  let alternateSends = 0;
  const worker = new JobWorker(h.service, {
    conversation: itemProvider(async () => { entered(); return response; }),
    freeConversation: itemProvider(async () => { alternateSends++; return routeResult; }),
  });
  const body = turnBody("金曜日");
  expect((await h.event(body, "gemini")).status).toBe(202);
  const running = worker.runOnce("turn");
  await started;
  await h.setPlus(false);
  release(dayResult);
  await running;
  expect(alternateSends).toBe(0);
  expect((await h.event(body, "gemini")).body).toMatchObject({
    request: { status: "pending", item_answers: [{ item_id: "day", text: "金曜日" }] },
    turn: { state: "completed", end_call: true, reply: "残りの質問に回答してください。" },
  });
  expect((await h.event({ event: "hangup" })).body.request).toMatchObject({
    delivery_mode: "text", item_answers: [{ item_id: "day", text: "金曜日" }],
  });
});

test("new selectors use provider-specific credentials and fixed FREE and PLUS profiles", async () => {
  const env = { FREE_AI_PROVIDER: "meta", PLUS_AI_PROVIDER: "gemini", META_API_KEY: "meta-test", GEMINI_API_KEY: "gemini-test" };
  expect(planVoiceProviders(env)).toEqual(plans);
  const models: string[] = [];
  const send = (async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url) === "https://api.meta.ai/v1/messages") {
      expect(headers.get("authorization")).toBe("Bearer meta-test");
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      expect(body.output_config.effort).toBe("medium");
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(routeResult) }] });
    }
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(headers.get("x-goog-api-key")).toBe("gemini-test");
    expect(headers.get("authorization")).toBeNull();
    models.push("gemini-3.5-flash-lite");
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(routeResult) }] } }] });
  }) as typeof fetch;
  const configurations = configuredPlanConversations(plans, env, send);
  const h = await setup();
  const request = h.created.body.request;
  for (const provider of [configurations.free, configurations.standard]) {
    await provider.itemTurn!(request, request.call, new AbortController().signal);
  }
  expect(models).toEqual(["muse-ember-1.0", "gemini-3.5-flash-lite"]);
  expect(() => configuredPlanConversations(plans, { META_API_KEY: "meta-test" })).toThrow("GEMINI_API_KEY");
  expect(() => planVoiceProviders({ FREE_AI_PROVIDER: "meta", PLUS_AI_PROVIDER: "invalid" })).toThrow("PLUS_AI_PROVIDER");
  expect(() => planVoiceProviders({ PLUS_AI_PROVIDER: "gemini" })).toThrow("FREE_AI_PROVIDER");
});
