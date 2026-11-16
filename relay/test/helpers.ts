import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, type App, type AppOptions } from "../src/app.ts";
import type { Clock } from "../src/clock.ts";
import { Store } from "../src/db.ts";
import { issuePairingCode } from "../src/pairing.ts";
import type { DeviceObject } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "docs", "fixtures");

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}
export function fixture<T = any>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Asserts that `actual` has the same structure as the fixture: identical key sets, identical
 * primitive types, null exactly where the fixture has null.
 */
export function expectSameShape(actual: unknown, expected: unknown, path = "$"): void {
  if (expected === null) {
    expect(actual, `${path} should be null`).toBeNull();
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} should be an array`).toBe(true);
    if (expected.length > 0) {
      (actual as unknown[]).forEach((item, i) => expectSameShape(item, expected[0], `${path}[${i}]`));
    }
    return;
  }
  if (typeof expected === "object") {
    expect(typeof actual === "object" && actual !== null && !Array.isArray(actual), `${path} should be an object`).toBe(
      true,
    );
    expect(Object.keys(actual as object).sort(), `keys of ${path}`).toEqual(Object.keys(expected).sort());
    for (const [k, v] of Object.entries(expected)) {
      expectSameShape((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
    }
    return;
  }
  expect(typeof actual, `type of ${path}`).toBe(typeof expected);
}

export class FakeClock implements Clock {
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;
  constructor(public t = Date.parse("2026-11-15T14:00:00.000Z")) {}
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  get pendingTimers(): number {
    return this.timers.length;
  }
  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = target;
  }
}

export const AGENT_TOKEN = "ka_test-agent-token";

export interface CallOptions {
  token?: string | null;
  body?: unknown;
  rawBody?: string | Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface Harness {
  app: App;
  store: Store;
  clock: FakeClock;
  warnings: string[];
  /** The socket peer address the app sees for requests made through this harness. */
  peer: string | null;
  call(method: string, path: string, opts?: CallOptions): Promise<Response>;
  /** Same as call(), parsed. */
  json(method: string, path: string, opts?: CallOptions): Promise<{ status: number; body: any }>;
  agent(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  pair(overrides?: Record<string, unknown>): Promise<{ token: string; device: DeviceObject }>;
  ask(overrides?: Record<string, unknown>): Promise<any>;
}

export function makeHarness(overrides: Partial<AppOptions> = {}): Harness {
  const store = overrides.store ?? new Store(":memory:");
  const clock = (overrides.clock as FakeClock | undefined) ?? new FakeClock();
  const warnings: string[] = [];
  const state = { peer: "127.0.0.1" as string | null };
  const app = createApp({
    agentToken: AGENT_TOKEN,
    peerAddress: () => state.peer,
    logger: { warn: (m) => warnings.push(m) },
    ...overrides,
    store,
    clock,
  });

  const call: Harness["call"] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: RequestInit["body"];
    if (opts.rawBody !== undefined) body = opts.rawBody as RequestInit["body"];
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json; charset=utf-8";
    }
    const res = await app.fetch(new Request(`http://relay.test${path}`, { method, headers, body, signal: opts.signal }));
    if (!res) throw new Error("handler returned no response");
    return res;
  };
  const json: Harness["json"] = async (method, path, opts) => {
    const res = await call(method, path, opts);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    app,
    store,
    clock,
    warnings,
    get peer() {
      return state.peer;
    },
    set peer(value) {
      state.peer = value;
    },
    call,
    json,
    agent: (method, path, body) => json(method, path, { token: AGENT_TOKEN, body }),
    async pair(extra = {}) {
      const { code } = issuePairingCode(store, clock.now());
      const res = await json("POST", "/v1/pair", {
        body: { code, device_name: "iPhone 16", platform: "ios", ...extra },
      });
      if (res.status !== 201) throw new Error(`pairing failed: ${res.status} ${JSON.stringify(res.body)}`);
      return { token: res.body.device_token as string, device: res.body.device as DeviceObject };
    },
    async ask(extra = {}) {
      const res = await json("POST", "/v1/requests", {
        token: AGENT_TOKEN,
        body: {
          question: "本番DBのマイグレーションを実行してよいですか?",
          context: "users テーブルに列を追加します",
          choices: ["はい", "いいえ"],
          agent: { name: "claude-code", cwd: "/path/to/project" },
          ...extra,
        },
      });
      if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.request;
    },
  };
}

/** Polls until the condition holds (for state reached through real async I/O). */
export async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until(): condition not met in time");
    await new Promise((r) => setTimeout(r, 2));
  }
}
