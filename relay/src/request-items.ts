import type { RequestObject } from "./types.ts";

export const MAX_ITEMS = 8;
export const MAX_ITEM_ANSWER_LENGTH = 1000;
export const ITEM_HANDOFF_TIMEOUT_MS = 60_000;

export interface RequestItem {
  id: string;
  question: string;
  context?: string;
  choices?: string[];
  applies_when?: { item_id: string; choice_index: number };
  ask_on_call?: boolean;
}

export type ItemAnswer =
  | { item_id: string; status: "answered"; text: string; choice_index?: number; input_method: "text" | "choice" | "voice" }
  | { item_id: string; status: "deferred" | "not_applicable" };

export type ItemResult = { reply: string; resolved: boolean; answer: string | null; itemAnswers: ItemAnswer[]; handoff: boolean };

function object(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

function text(raw: unknown, maximum: number): string | undefined {
  if (typeof raw !== "string" || raw.length > maximum) return undefined;
  return raw.trim() || undefined;
}

export function parseRequestItems(raw: unknown, invalid: (message: string) => Error): RequestItem[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_ITEMS)
    throw invalid(`items must contain 2 to ${MAX_ITEMS} questions`);
  const items: RequestItem[] = [];
  for (const entry of raw) {
    const v = object(entry);
    const id = v?.id;
    const question = text(v?.question, 500);
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id) || !question || items.some(item => item.id === id))
      throw invalid("each item needs a unique id and a question of 1 to 500 characters");
    const item: RequestItem = { id, question };
    if (v?.context != null) {
      const context = text(v.context, 1000);
      if (!context) throw invalid("item context must contain 1 to 1000 characters");
      item.context = context;
    }
    if (v?.choices != null) {
      const choices = Array.isArray(v.choices) ? v.choices.map(choice => text(choice, 200)) : [];
      if (!choices.length || choices.length > 5 || choices.some(choice => !choice) || new Set(choices).size !== choices.length)
        throw invalid("item choices must contain 1 to 5 distinct nonempty strings");
      item.choices = choices as string[];
    }
    if (v?.applies_when != null) {
      const condition = object(v.applies_when);
      const parent = items.find(item => item.id === condition?.item_id);
      const index = condition?.choice_index;
      if (!parent?.choices || typeof index !== "number" || !Number.isInteger(index) || parent.choices[index] === undefined)
        throw invalid("applies_when must reference a choice on an earlier item");
      item.applies_when = { item_id: parent.id, choice_index: index };
    }
    if (v?.ask_on_call != null) {
      if (typeof v.ask_on_call !== "boolean") throw invalid("ask_on_call must be a boolean");
      item.ask_on_call = v.ask_on_call;
    }
    items.push(item);
  }
  return items;
}

type Applicability = "applicable" | "blocked" | "not_applicable";

function applicability(item: RequestItem, answers: ReadonlyMap<string, ItemAnswer>): Applicability {
  const condition = item.applies_when;
  if (!condition) return "applicable";
  const parent = answers.get(condition.item_id);
  if (parent?.status === "not_applicable") return "not_applicable";
  if (parent?.status !== "answered") return "blocked";
  return parent.choice_index === condition.choice_index ? "applicable" : "not_applicable";
}

function answerMap(answers: readonly ItemAnswer[] | undefined) {
  return new Map(answers?.map(answer => [answer.item_id, answer]));
}

function applyAnswers(
  items: readonly RequestItem[],
  saved: readonly ItemAnswer[] | undefined,
  updates: ReadonlyMap<string, ItemAnswer>,
) {
  const initial = answerMap(saved);
  const answers = new Map<string, ItemAnswer>();
  for (const item of items) {
    const state = applicability(item, answers);
    if (state === "not_applicable") {
      answers.set(item.id, { item_id: item.id, status: state });
    } else if (state === "applicable") {
      const answer = updates.get(item.id) ?? initial.get(item.id);
      if (answer && answer.status !== "not_applicable") answers.set(item.id, answer);
    }
  }
  return answers;
}

function completed(items: readonly RequestItem[], answers: ReadonlyMap<string, ItemAnswer>) {
  return items.every(item => {
    const answer = answers.get(item.id);
    return answer?.status === "answered" || answer?.status === "not_applicable";
  });
}

export function itemAnswerSummary(answers: readonly ItemAnswer[]) {
  return answers.filter(answer => answer.status === "answered")
    .map(answer => `${answer.item_id}: ${answer.text}`).join("\n");
}

function parseAnswer(item: RequestItem, raw: Record<string, unknown>, method: "text" | "voice"): Extract<ItemAnswer, { status: "answered" }> | undefined {
  const index = raw.choice_index;
  if (item.choices) {
    if (typeof index !== "number" || !Number.isInteger(index)) return undefined;
    const choice = item.choices[index];
    if (choice === undefined) return undefined;
    return { item_id: item.id, status: "answered", text: choice, choice_index: index, input_method: method === "voice" ? "voice" : "choice" };
  }
  const answer = text(raw.text, MAX_ITEM_ANSWER_LENGTH);
  if (answer && index == null) return { item_id: item.id, status: "answered", text: answer, input_method: method };
}

export function submitItemAnswers(request: RequestObject, raw: unknown, invalid: (message: string) => Error): ItemAnswer[] {
  const items = request.items!;
  if (!Array.isArray(raw) || raw.length > items.length) throw invalid("item_answers is required for this request");
  const saved = answerMap(request.item_answers);
  const updates = new Map<string, ItemAnswer>();
  const seen = new Set<string>();
  for (const entry of raw) {
    const v = object(entry);
    const item = items.find(item => item.id === v?.item_id);
    const answer = item && v && parseAnswer(item, v, "text");
    if (!item || !answer || seen.has(item.id)) throw invalid("invalid or duplicate item answer");
    seen.add(item.id);
    const previous = saved.get(item.id);
    if (previous?.status === "answered") {
      if (previous.text !== answer.text || previous.choice_index !== answer.choice_index)
        throw invalid("an item was already answered; refresh the request");
      continue;
    }
    updates.set(item.id, answer);
  }
  if (request.status === "answered" && [...saved.values()].some(answer =>
    answer.status === "answered" && answer.input_method !== "voice" && !seen.has(answer.item_id)))
    throw invalid("item answers differ from the previous submission");
  const merged = applyAnswers(items, request.item_answers, updates);
  if ([...updates].some(([id, answer]) => merged.get(id) !== answer))
    throw invalid("item is not applicable");
  if (!completed(items, merged)) throw invalid("answer all applicable items");
  return [...merged.values()];
}

function nextVoiceItem(request: Pick<RequestObject, "items">, answers: ReadonlyMap<string, ItemAnswer>) {
  return request.items?.find(item =>
    item.ask_on_call !== false && !answers.has(item.id) && applicability(item, answers) === "applicable");
}

export const ITEM_CALL_HANDOFF = "ここまでの回答は保存しました。残りは、通話を切ったあとアプリで回答できます。";

export function canAskItemsOnCall(request: Pick<RequestObject, "items" | "item_answers">) {
  return !request.items || !!nextVoiceItem(request, answerMap(request.item_answers));
}

export function itemCallOpening(request: RequestObject) {
  if (!request.items) return request.question;
  const item = nextVoiceItem(request, answerMap(request.item_answers));
  return item ? `${request.question}\n${item.question}` : ITEM_CALL_HANDOFF;
}

export function itemConversationData(request: RequestObject) {
  if (!request.items) return {};
  return {
    items: request.items,
    item_answers: request.item_answers ?? [],
    current_item_id: nextVoiceItem(request, answerMap(request.item_answers))?.id ?? null,
  };
}

export function applyItemVoiceTurn(request: RequestObject, value: unknown, utterance: string): ItemResult {
  const items = request.items!;
  const v = object(value);
  if (!v || !Array.isArray(v.updates) || v.updates.length > items.length || typeof v.handoff !== "boolean")
    throw new Error("invalid item conversation output");
  const saved = answerMap(request.item_answers);
  const updates = new Map<string, ItemAnswer>();
  const seen = new Set<string>();
  const current = nextVoiceItem(request, saved);
  for (const raw of v.updates) {
    const entry = object(raw);
    const item = items.find(item => item.id === entry?.item_id);
    if (!entry || !item || seen.has(item.id)) throw new Error("invalid item update");
    seen.add(item.id);
    const evidence = text(entry.evidence, MAX_ITEM_ANSWER_LENGTH);
    if (!evidence || !utterance.includes(evidence)) continue;
    const previous = saved.get(item.id);
    if (previous?.status === "answered" && entry.correction !== true) continue;
    if (entry.deferred === true) {
      if (item.id === current?.id) updates.set(item.id, { item_id: item.id, status: "deferred" });
    } else {
      const exactChoice = item.choices?.indexOf(evidence) ?? -1;
      if (exactChoice >= 0 && exactChoice !== entry.choice_index) continue;
      const answer = parseAnswer(item, { choice_index: entry.choice_index, text: evidence }, "voice");
      if (answer) updates.set(item.id, answer);
    }
  }
  const merged = applyAnswers(items, request.item_answers, updates);
  const itemAnswers = [...merged.values()];
  if (completed(items, merged)) return {
    reply: "ありがとうございます。回答を送信しました。", resolved: true, answer: itemAnswerSummary(itemAnswers), itemAnswers, handoff: false,
  };
  const next = nextVoiceItem(request, merged);
  if (!next || v.handoff) return { reply: ITEM_CALL_HANDOFF, resolved: false, answer: null, itemAnswers, handoff: true };
  const clarification = next.id === current?.id && ![...updates].some(([id, answer]) => merged.get(id) === answer)
    ? text(v.clarification, 400) : undefined;
  return { reply: clarification ?? next.question, resolved: false, answer: null, itemAnswers, handoff: false };
}
