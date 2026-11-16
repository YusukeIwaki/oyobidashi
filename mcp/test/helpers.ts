import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { abortError, systemClock, type Clock } from "../src/clock.ts";
import type { FetchLike } from "../src/relay-client.ts";
import { createServer, type ServerDeps } from "../src/server.ts";

export const FIXTURES_DIR = join(import.meta.dir, "..", "..", "docs", "fixtures");

/** Loads a contract fixture from docs/fixtures (fresh copy each time). */
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8")) as T;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Timer {
  at: number;
  resolve: () => void;
}

/**
 * Deterministic clock: time only moves when the test advances it.
 * `run(promise)` is a tiny discrete-event loop: whenever everything is idle it jumps to the next timer.
 */
export class FakeClock implements Clock {
  private t = 1_000_000;
  private timers: Timer[] = [];
  /** Every sleep() duration requested, in order. */
  readonly sleeps: number[] = [];

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(ms);
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timer: Timer = { at: this.t + Math.max(0, ms), resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((x) => x !== timer);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Jumps to the earliest timer and fires it. Returns false if there is none. */
  advanceToNext(): boolean {
    if (this.timers.length === 0) return false;
    const next = this.timers.reduce((a, b) => (b.at < a.at ? b : a));
    this.timers = this.timers.filter((x) => x !== next);
    this.t = Math.max(this.t, next.at);
    next.resolve();
    return true;
  }

  /** Lets pending microtasks/IO settle without moving time. */
  async idle(): Promise<void> {
    for (let i = 0; i < 3; i++) await tick();
  }

  /** Drives time forward until `promise` settles, then returns its outcome. */
  async run<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const mark = () => {
      done = true;
    };
    promise.then(mark, mark);
    let stalls = 0;
    while (!done) {
      await this.idle();
      if (done) break;
      if (this.advanceToNext()) {
        stalls = 0;
      } else if (++stalls > 200) {
        throw new Error("FakeClock.run: promise never settles and no timer is pending (deadlock)");
      }
    }
    return promise;
  }

  /** Drives time forward until `predicate` holds. */
  async runUntil(predicate: () => boolean): Promise<void> {
    let stalls = 0;
    for (;;) {
      await this.idle();
      if (predicate()) return;
      if (this.advanceToNext()) {
        stalls = 0;
      } else if (++stalls > 200) {
        throw new Error("FakeClock.runUntil: condition never became true and no timer is pending");
      }
    }
  }
}

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  rawBody: string;
  /** Parsed JSON body, or undefined when there was no body. */
  body: any;
  /** Fake/real clock time at which the call arrived. */
  at: number;
  signal: AbortSignal;
}

type Handler = (call: RecordedCall, relay: FakeRelay) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * Scriptable stand-in for the relay's Agent API (PROTOCOL.md section 4), answering with the
 * contract fixtures. Works both as an injected `fetch` and behind a real `Bun.serve`.
 */
export class FakeRelay {
  readonly calls: RecordedCall[] = [];
  readonly token = "ka_test_token";
  /** Current state of the single request this relay knows. */
  current: any = fixture("request_pending.json");
  delivery: any = fixture("create_request_response.json").delivery;
  /** Presence returned by GET /v1/presence. */
  presence: any = {
    devices: [{ device_id: "dev_01", availability: "available", until: null, note: null, updated_at: "2026-11-15T14:00:00.000Z", last_seen_at: "2026-11-15T14:00:00.000Z" }],
    recent_events: [],
    now: "2026-11-15T14:00:00.000Z",
  };
  /** Envelope feedback returned by PATCH /v1/requests/{id} (when set). */
  updateFeedback: any = undefined;
  /** When set, the request turns into `resolveTo` once the clock reaches this time. */
  resolveAt: number | undefined;
  resolveTo: any = fixture("request_answered.json");
  checkAuth = true;

  onCreate: Handler | undefined;
  onGet: Handler | undefined;
  onCancel: Handler | undefined;
  onUpdate: Handler | undefined;
  onPresence: Handler | undefined;
  /** Overrides everything (after recording the call). */
  onAny: Handler | undefined;

  constructor(readonly clock: Clock = systemClock) {}

  get creates(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "POST" && c.path === "/v1/requests");
  }
  get gets(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/requests/"));
  }
  get cancels(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "POST" && c.path.endsWith("/cancel"));
  }
  get updates(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/v1/requests/"));
  }
  get presenceGets(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "GET" && c.path === "/v1/presence");
  }

  /** Makes the request resolve `ms` after now (as seen by a long-poll). */
  resolveAfter(ms: number, to: any = fixture("request_answered.json")): void {
    this.resolveAt = this.clock.now() + ms;
    this.resolveTo = to;
  }

  private applyResolution(): void {
    if (this.resolveAt !== undefined && this.clock.now() >= this.resolveAt) {
      this.current = this.resolveTo;
      this.resolveAt = undefined;
    }
  }

  readonly fetch: FetchLike = (url, init) => this.handle(new Request(url, init));

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rawBody = await req.text();
    let body: any;
    if (rawBody !== "") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = undefined;
      }
    }
    const call: RecordedCall = {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      rawBody,
      body,
      at: this.clock.now(),
      signal: req.signal,
    };
    this.calls.push(call);
    if (this.onAny) return this.onAny(call, this);

    if (this.checkAuth && req.headers.get("authorization") !== `Bearer ${this.token}`) {
      return json(fixture("error_unauthorized.json"), 401);
    }
    if (req.headers.has("x-forwarded-for") || req.headers.has("x-forwarded-host")) {
      return json(errorBody("forbidden", "agent API is not available through the tunnel"), 403);
    }

    if (call.method === "POST" && call.path === "/v1/requests") {
      if (this.onCreate) return this.onCreate(call, this);
      if (body?.kind === "notification") {
        this.current = fixture("request_notification.json");
        return json({ request: this.current, delivery: this.delivery }, 201);
      }
      this.applyResolution();
      return json({ request: this.current, delivery: this.delivery }, 201);
    }

    if (call.method === "GET" && call.path === "/v1/presence") {
      if (this.onPresence) return this.onPresence(call, this);
      return json(this.presence);
    }

    const match = /^\/v1\/requests\/([^/]+)(\/cancel)?$/.exec(call.path);
    if (match && call.method === "GET" && !match[2]) {
      if (this.onGet) return this.onGet(call, this);
      if (decodeURIComponent(match[1]!) !== this.current.id) return json(errorBody("not_found", "request not found"), 404);
      return this.longPoll(call);
    }
    if (match && call.method === "POST" && match[2]) {
      if (this.onCancel) return this.onCancel(call, this);
      if (decodeURIComponent(match[1]!) !== this.current.id) return json(errorBody("not_found", "request not found"), 404);
      this.applyResolution();
      // Pending questions and notified one-way notifications can be withdrawn.
      if (this.current.status !== "pending" && this.current.status !== "notified") {
        return json(fixture("error_already_resolved.json"), 409);
      }
      if (this.current.status === "notified") {
        this.current = { ...this.current, status: "cancelled" };
        return json({ request: this.current });
      }
      this.current = fixture("event_request_updated.json").request; // the cancelled Request fixture
      return json({ request: this.current });
    }
    if (match && call.method === "PATCH" && !match[2]) {
      if (this.onUpdate) return this.onUpdate(call, this);
      if (decodeURIComponent(match[1]!) !== this.current.id) return json(errorBody("not_found", "request not found"), 404);
      this.applyResolution();
      if (this.current.status !== "pending") return json(fixture("error_already_resolved.json"), 409);
      if (body?.priority !== undefined) this.current = { ...this.current, priority: body.priority };
      if (body?.delivery_mode !== undefined) {
        const requested = body.delivery_mode as string;
        const priority = (body.priority as string | undefined) ?? this.current.priority ?? "normal";
        let effective = requested;
        if (requested === "auto") {
          const choices = (this.current.choices as string[] | null) ?? [];
          const context = (this.current.context as string | null) ?? "";
          effective = choices.length > 0 && choices.length <= 3 && context.length <= 160 ? "actions" : "text";
        } else if (requested === "call" && priority !== "high" && priority !== "urgent") {
          effective = "text";
        }
        this.current = { ...this.current, requested_mode: requested, delivery_mode: effective };
        if (effective === "call") {
          this.current = {
            ...this.current,
            call: {
              id: "call_01",
              request_id: this.current.id,
              state: "ringing",
              outcome: null,
              device_id: null,
              started_at: "2026-11-15T14:00:00.000Z",
              updated_at: "2026-11-15T14:00:00.000Z",
              transcript: [],
            },
          };
        }
      }
      const envelope: Record<string, unknown> = { request: this.current };
      if (this.updateFeedback !== undefined) envelope.feedback = this.updateFeedback;
      return json(envelope);
    }
    return json(errorBody("not_found", "no such route"), 404);
  }

  /** Default GET behaviour: block up to `wait` seconds while pending, like the real relay. */
  async longPoll(call: RecordedCall): Promise<Response> {
    const wait = Number(call.query.get("wait") ?? "0");
    this.applyResolution();
    if (this.current.status === "pending" && wait > 0) {
      const until = this.resolveAt !== undefined ? Math.min(this.resolveAt - this.clock.now(), wait * 1000) : wait * 1000;
      await this.clock.sleep(Math.max(0, until), call.signal);
      this.applyResolution();
    }
    return json({ request: this.current });
  }

  /** Serves this fake over real HTTP on an ephemeral port. */
  serve(): { url: string; port: number; stop: () => Promise<void> } {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => this.handle(req) });
    return { url: `http://127.0.0.1:${server.port}`, port: server.port!, stop: () => server.stop(true) };
  }
}

/** A port on which nothing is listening. */
export async function closedPort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const port = server.port!;
  await server.stop(true);
  return port;
}

export interface Harness {
  client: Client;
  server: McpServer;
  logs: string[];
  close: () => Promise<void>;
}

/** Real MCP Client <-> our server over the SDK's in-memory transport pair. */
export async function connect(deps: ServerDeps = {}, clientName = "claude-code"): Promise<Harness> {
  const logs: string[] = [];
  const server = createServer({ cwd: () => "/work/project", log: (m) => logs.push(m), ...deps });
  const client = new Client({ name: clientName, version: "9.9.9" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    logs,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export interface ToolCallResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function textOf(result: ToolCallResult): string {
  return result.content.map((c) => c.text).join("\n");
}

/** Env for a server that should talk to `relay` (never reads the real ~/.oyobidashi). */
export function envFor(relay: FakeRelay, baseUrl = "http://relay.test:8787"): Record<string, string | undefined> {
  return { OYOBIDASHI_RELAY_URL: baseUrl, OYOBIDASHI_AGENT_TOKEN: relay.token, OYOBIDASHI_HOME: "/nonexistent/oyobidashi-home" };
}
