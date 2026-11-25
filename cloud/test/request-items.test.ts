import { expect, test } from "bun:test";
import { harness } from "./helpers.ts";
import { JobWorker } from "../src/worker.ts";
import { ITEM_CALL_HANDOFF } from "../../relay/src/request-items.ts";

const items = [
  { id: "route", question: "通常便ですか、速達ですか？", choices: ["通常便", "速達"] },
  { id: "day", question: "発送日はいつですか？" },
  { id: "label", question: "ラベルの版はどれですか？", ask_on_call: false },
];

async function setup() {
  const h = harness();
  const phone = await h.pair();
  const token = phone.device_token;
  const created = await h.call("POST", "/v1/requests", "agent-alice", {
    question: "発送方法の確認です。", items, priority: "high", delivery_mode: "call",
  });
  expect(created.status).toBe(201);
  const path = `/v1/requests/${created.body.request.id}`;
  const event = (body: object) => h.call("POST", `${path}/call`, token, body);
  const opening = await event({ event: "answer" });
  expect(opening.body.reply).toContain(items[0]!.question);
  expect(opening.body.reply).not.toContain(items[1]!.question);
  return { h, token, path, event };
}

test("cloud worker saves a batch before app handoff and polling or duplicate posts preserve it", async () => {
  const { h, token, path, event } = await setup();
  const body = { event: "turn", turn_id: crypto.randomUUID(), async: true, text: "通常便で、木曜日に" };
  expect((await event(body)).status).toBe(202);
  const worker = new JobWorker(h.service, { conversation: {
    turn: async () => { throw new Error("legacy turn should be unused"); },
    itemTurn: async () => ({
      updates: [
        { item_id: "route", evidence: "通常便", choice_index: 0 },
        { item_id: "day", evidence: "木曜日" },
      ], handoff: false,
    }),
  } });
  expect(await worker.runOnce("turn")).toBe(true);
  const completed = await event(body);
  expect(completed).toMatchObject({ status: 200, body: {
    reply: ITEM_CALL_HANDOFF, end_call: true, turn: { end_call: true }, resolved: false, request: {
      status: "pending",
      item_answers: [
        { item_id: "route", status: "answered", text: "通常便", input_method: "voice" },
        { item_id: "day", status: "answered", text: "木曜日", input_method: "voice" },
      ],
    },
  } });
  expect((await event({ event: "hangup" })).body.request).toMatchObject({ status: "pending", delivery_mode: "text" });
  const otherPhone = (await h.pair("alice", "android")).device_token;
  const pending = await h.call("GET", path, otherPhone);
  expect(pending.body.request.item_answers).toEqual(completed.body.request.item_answers);
  const response = await h.call("POST", `${path}/answer`, otherPhone, { item_answers: [{ item_id: "label", text: "第2版" }] });
  expect(response.body.request).toMatchObject({
    status: "answered", answer: { input_method: "text" },
    item_answers: [...pending.body.request.item_answers, { item_id: "label", status: "answered", text: "第2版", input_method: "text" }],
  });
  expect((await h.call("POST", `${path}/answer`, token, { item_answers: [{ item_id: "label", text: "第1版" }] })).status).toBe(409);
});

test("cloud hangup during model execution retains the previous item and fences out the late result", async () => {
  const { h, token, path, event } = await setup();
  const send = (text: string) => event({ event: "turn", turn_id: crypto.randomUUID(), async: true, text });
  const goodWorker = new JobWorker(h.service, { conversation: {
    turn: async () => { throw new Error("legacy turn should be unused"); },
    itemTurn: async () => ({ handoff: false, updates: [{ item_id: "route", evidence: "通常便", choice_index: 0 }] }),
  } });
  await send("通常便");
  expect(await goodWorker.runOnce("turn")).toBe(true);
  let entered!: () => void;
  let complete!: (value: object) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<object>(resolve => { complete = resolve; });
  const worker = new JobWorker(h.service, { conversation: {
    turn: async () => { throw new Error("legacy turn should be unused"); },
    itemTurn: () => { entered(); return gate; },
  } });
  await send("金曜日");
  const running = worker.runOnce("turn");
  await started;
  await event({ event: "hangup" });
  complete({ handoff: false, updates: [{ item_id: "day", evidence: "金曜日" }] });
  await running;
  const response = await h.call("GET", path, token);
  expect(response.body.request).toMatchObject({
    status: "pending", delivery_mode: "text",
    item_answers: [{ item_id: "route", status: "answered", choice_index: 0, input_method: "voice" }],
  });
  expect(response.body.request.item_answers).toHaveLength(1);
});

test("cloud handoff closes automatically when the device cannot send hangup", async () => {
  const { h, token, path, event } = await setup();
  const body = { event: "turn", turn_id: crypto.randomUUID(), async: true, text: "通常便で。残りはアプリで答えます" };
  await event(body);
  const worker = new JobWorker(h.service, { conversation: {
    turn: async () => { throw new Error("legacy turn should be unused"); },
    itemTurn: async () => ({
      updates: [{ item_id: "route", evidence: "通常便", choice_index: 0 }], handoff: true,
    }),
  } });
  expect(await worker.runOnce("turn")).toBe(true);
  expect((await event(body)).body).toMatchObject({ end_call: true, resolved: false });
  h.advance(60_001);
  const request = (await h.call("GET", path, token)).body.request;
  expect(request).toMatchObject({
    status: "pending", delivery_mode: "text", call: { state: "ended", outcome: "hangup" },
    item_answers: [{ item_id: "route", status: "answered", text: "通常便" }],
  });
});
