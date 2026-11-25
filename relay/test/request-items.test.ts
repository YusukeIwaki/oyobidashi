import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import {
  applyItemVoiceTurn, ITEM_CALL_HANDOFF, itemCallOpening, parseRequestItems, submitItemAnswers, type ItemAnswer, type RequestItem,
} from "../src/request-items.ts";
import type { RequestObject } from "../src/types.ts";
import { makeHarness } from "./helpers.ts";

const questions: RequestItem[] = [
  { id: "environment", question: "本番とステージングのどちらまで進めますか？", choices: ["本番", "ステージング"] },
  { id: "owner", question: "検証の担当は誰ですか？" },
  { id: "time", question: "本番の実施時刻はいつですか？", applies_when: { item_id: "environment", choice_index: 0 } },
  { id: "notice", question: "本番の告知は必要ですか？", choices: ["必要", "不要"], applies_when: { item_id: "environment", choice_index: 0 } },
  { id: "channel", question: "告知先はどこですか？", applies_when: { item_id: "notice", choice_index: 0 } },
  { id: "notes", question: "確認用リンクはどれですか？", ask_on_call: false },
];
const snapshot = (item_answers: ItemAnswer[] = [], items = questions): RequestObject => ({
  id: "test", kind: "question", question: "リリースの進め方を確認です。", context: null, choices: null,
  urgency: "normal", status: "pending", answer: null, agent: null, created_at: "", updated_at: "", expires_at: "", items, item_answers,
});
const decision = (item_id: string, evidence: string, choice_index?: number) => ({ item_id, evidence, choice_index });
function turn(request: RequestObject, utterance: string, updates: object[], options: { handoff?: boolean; clarification?: string } = {}) {
  return applyItemVoiceTurn(request, { updates, handoff: false, ...options }, utterance);
}

describe("item call progression", () => {
  test("orders one question at a time and skips a branch made irrelevant by the opening decision", () => {
    expect(itemCallOpening(snapshot())).toBe("リリースの進め方を確認です。\n本番とステージングのどちらまで進めますか？");
    const first = turn(snapshot(), "ステージング", [decision("environment", "ステージング", 1)]);
    expect(first.reply).toBe(questions[1]!.question);
    expect(first.itemAnswers).toEqual([
      expect.objectContaining({ item_id: "environment", status: "answered", choice_index: 1 }),
      ...["time", "notice", "channel"].map(item_id => ({ item_id, status: "not_applicable" })),
    ]);
    const second = turn(snapshot(first.itemAnswers), "チームAです", [decision("owner", "チームA")]);
    expect(second).toMatchObject({ reply: ITEM_CALL_HANDOFF, resolved: false, handoff: true, answer: null });
    expect(second.itemAnswers).toContainEqual({ item_id: "owner", status: "answered", text: "チームA", input_method: "voice" });
  });

  test("accepts several answers in one utterance in any update order, including newly applicable items", () => {
    const result = turn(snapshot(), "本番、明日の10時で、告知は必要。開発チャンネルに。", [
      decision("channel", "開発チャンネル"), decision("time", "明日の10時"),
      decision("notice", "必要", 0), decision("environment", "本番", 0),
    ]);
    expect(result.reply).toBe(questions[1]!.question);
    expect(result.itemAnswers.map(a => a.item_id)).toEqual(["environment", "time", "notice", "channel"]);
    const next = turn(snapshot(result.itemAnswers), "チームBです", [decision("owner", "チームB")]);
    expect(next.handoff).toBe(true);
    expect(next.itemAnswers.find(a => a.item_id === "channel")).toEqual({
      item_id: "channel", status: "answered", text: "開発チャンネル", input_method: "voice",
    });
  });

  test("continues past an explicit deferral, then waits for the app", () => {
    const first = turn(snapshot(), "環境は後で決めます", [{ ...decision("environment", "後で決めます"), deferred: true }]);
    expect(first.reply).toBe(questions[1]!.question);
    expect(first.itemAnswers).toEqual([{ item_id: "environment", status: "deferred" }]);
    const second = turn(snapshot(first.itemAnswers), "チームA", [decision("owner", "チームA")]);
    expect(second.handoff).toBe(true);
    expect(second.resolved).toBe(false);
    expect(() => submitItemAnswers(snapshot(second.itemAnswers), [{ item_id: "environment", choice_index: 0 }], Error)).toThrow("all applicable");
    expect(submitItemAnswers(snapshot(second.itemAnswers), [
      { item_id: "environment", choice_index: 1 }, { item_id: "notes", text: "リンクA" },
    ], Error)).toContainEqual({ item_id: "time", status: "not_applicable" });
  });

  test("keeps ambiguous or fabricated evidence open and accepts only supported choices", () => {
    const outcome = turn(snapshot(), "明日なら空いています", [
      decision("environment", "承認します", 0),
      decision("notice", "明日", 19),
      decision("time", "明日"),
    ], { clarification: "本番とステージングのどちらまで進めますか？" });
    expect(outcome).toMatchObject({
      itemAnswers: [], resolved: false, reply: "本番とステージングのどちらまで進めますか？",
    });
  });

  test("preserves existing answers unless corrected and drops a changed branch's earlier answers", () => {
    const first = turn(snapshot(), "本番、明日の10時", [decision("environment", "本番", 0), decision("time", "明日の10時")]);
    const previous = snapshot(first.itemAnswers);
    expect(turn(previous, "ステージング", [decision("environment", "ステージング", 1)]).itemAnswers).toEqual(first.itemAnswers);
    const correction = turn(previous, "訂正、ステージングです", [{ ...decision("environment", "ステージング", 1), correction: true }]);
    expect(correction.itemAnswers).toContainEqual({ item_id: "time", status: "not_applicable" });
    expect(correction.itemAnswers).toContainEqual(expect.objectContaining({ item_id: "environment", choice_index: 1 }));
  });

  test("completes a fully answered call and keeps the explicit answers in item order", () => {
    const request = snapshot([], questions.slice(0, 2));
    const result = turn(request, "本番で、担当はチームC", [decision("owner", "チームC"), decision("environment", "本番", 0)]);
    expect(result).toMatchObject({ resolved: true, answer: "environment: 本番\nowner: チームC", handoff: false });
    expect(result.reply).toBe("ありがとうございます。回答を送信しました。");
  });
});

test("item validation rejects duplicate IDs, forward dependencies and empty choice labels", () => {
  for (const bad of [
    [questions[0], questions[0]],
    [questions[2], questions[0]],
    [questions[1], { ...questions[0], choices: [" "] }],
    [{ ...questions[0], id: "__invalid." }, questions[1]],
  ]) {
    expect(() => parseRequestItems(bad, Error)).toThrow();
  }
});

test("text validation cannot overwrite a voice reply, answer a skipped item or finalize partially", () => {
  const partial = turn(snapshot(), "ステージング", [decision("environment", "ステージング", 1)]).itemAnswers;
  const request = snapshot(partial);
  for (const invalid of [
    [{ item_id: "environment", choice_index: 0 }],
    [{ item_id: "time", text: "今夜" }],
    [{ item_id: "owner", text: "チームA" }, { item_id: "owner", text: "チームA" }],
    [{ item_id: "owner", text: "チームA" }],
    [{ item_id: "owner", text: "あ".repeat(1001) }],
    [{ item_id: "unknown", text: "回答" }],
  ]) {
    expect(() => submitItemAnswers(request, invalid, Error)).toThrow();
  }
});

test("LAN persists voice progress through a hangup and SQLite reopen, then the app completes the request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oyobidashi-item-answers-"));
  const path = join(dir, "relay.sqlite");
  let store = new Store(path);
  try {
    const h = makeHarness({ store, conversation: {
      turn: async () => { throw new Error("legacy provider path"); },
      itemTurn: async () => ({ handoff: false, updates: [decision("environment", "ステージング", 1)] }),
    } });
    const device = await h.pair();
    const request = await h.ask({ ...snapshot(), choices: null, priority: "high", delivery_mode: "call" });
    const url = `/v1/requests/${request.id}`;
    const event = (event: string, text?: string) => h.json("POST", `${url}/call`, { token: device.token, body: { event, text } });
    expect((await event("answer")).body.reply).toBe(itemCallOpening(snapshot()));
    expect((await event("turn", "ステージング")).body.reply).toBe(questions[1]!.question);
    expect((await event("hangup")).body.request).toMatchObject({ status: "pending", delivery_mode: "text" });
    store.close();
    store = new Store(path);
    const reopened = makeHarness({ store });
    const submit = (body: object) => reopened.json("POST", `${url}/answer`, { token: device.token, body });
    const fetched = await reopened.json("GET", url, { token: device.token });
    expect(fetched.body.request.item_answers[0]).toMatchObject({ item_id: "environment", input_method: "voice" });
    expect((await submit({ text: "旧クライアントの返信" })).status).toBe(400);
    const body = { item_answers: [{ item_id: "owner", text: "チームA" }, { item_id: "notes", text: "リンクA" }] };
    const response = await submit(body);
    expect(response.body.request).toMatchObject({ status: "answered", answer: { text: "environment: ステージング\nowner: チームA\nnotes: リンクA" } });
    expect((await submit(body)).body.request).toEqual(response.body.request);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LAN ignores results from a provider that finishes a turn after hangup", async () => {
  let started!: () => void;
  let complete!: (payload: object) => void;
  const begin = new Promise<void>(resolve => { started = resolve; });
  const result = new Promise<object>(resolve => { complete = resolve; });
  const h = makeHarness({ conversation: {
    turn: async () => { throw new Error("legacy provider path"); },
    itemTurn: () => { started(); return result; },
  } });
  const d = await h.pair();
  const r = await h.ask({ ...snapshot(), choices: null, priority: "high", delivery_mode: "call" });
  const url = `/v1/requests/${r.id}`;
  const event = (event: string, text?: string) => h.json("POST", `${url}/call`, { token: d.token, body: { event, text } });
  await event("answer");
  const pending = event("turn", "ステージング");
  await begin;
  await event("hangup");
  complete({ handoff: false, updates: [decision("environment", "ステージング", 1)] });
  expect((await pending).status).toBe(409);
  expect((await h.agent("GET", url)).body.request).toMatchObject({ status: "pending", item_answers: [] });
});
