import { z } from "zod";
import { abortError, systemClock, type Clock } from "./clock.ts";

/** Minimal fetch signature so tests can inject a fake relay. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// ---- Wire types (PROTOCOL.md sections 3 and 4, plus EXTENSIONS.md). Unknown fields are ignored; null == missing. ----

const AnswerSchema = z.object({
  text: z.string(),
  choice_index: z.number().int().nullish(),
  input_method: z.string().nullish(),
  device_id: z.string().nullish(),
  answered_at: z.string().nullish(),
});

const TranscriptEntrySchema = z.object({
  role: z.string(),
  text: z.string(),
});

const CallSchema = z.object({
  id: z.string().min(1),
  request_id: z.string().nullish(),
  state: z.string().nullish(),
  outcome: z.string().nullish(),
  device_id: z.string().nullish(),
  started_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  transcript: z.array(TranscriptEntrySchema).nullish(),
});

const RequestSchema = z.object({
  id: z.string().min(1),
  kind: z.string().nullish(),
  question: z.string().nullish(),
  subject: z.string().nullish(),
  context: z.string().nullish(),
  choices: z.array(z.string()).nullish(),
  urgency: z.string().nullish(),
  priority: z.string().nullish(),
  delivery_mode: z.string().nullish(),
  requested_mode: z.string().nullish(),
  call: CallSchema.nullish(),
  feedback: z.unknown().nullish(),
  status: z.string().min(1),
  answer: AnswerSchema.nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  expires_at: z.string().nullish(),
});

const DeliverySchema = z.object({
  paired_devices: z.number().nullish(),
  websocket_delivered: z.number().nullish(),
  push_attempted: z.number().nullish(),
});

const PresenceDeviceSchema = z.object({
  device_id: z.string(),
  availability: z.string().nullish(),
  until: z.string().nullish(),
  note: z.string().nullish(),
  updated_at: z.string().nullish(),
  last_seen_at: z.string().nullish(),
});

const PresenceEventSchema = z.object({
  request_id: z.string().nullish(),
  device_id: z.string().nullish(),
  event: z.string(),
  at: z.string().nullish(),
});

const PresenceSchema = z.object({
  devices: z.array(PresenceDeviceSchema).nullish(),
  recent_events: z.array(PresenceEventSchema).nullish(),
  now: z.string().nullish(),
});

const RequestEnvelopeSchema = z.object({ request: RequestSchema });
const CreateEnvelopeSchema = z.object({ request: RequestSchema, delivery: DeliverySchema.nullish() });
const UpdateEnvelopeSchema = z.object({ request: RequestSchema, feedback: z.unknown().nullish() });
const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string().nullish() }),
});

export type RelayRequest = z.infer<typeof RequestSchema>;
export type RelayAnswer = z.infer<typeof AnswerSchema>;
export type RelayCall = z.infer<typeof CallSchema>;
export type RelayDelivery = z.infer<typeof DeliverySchema>;
export type RelayPresence = z.infer<typeof PresenceSchema>;
export type RelayPresenceDevice = z.infer<typeof PresenceDeviceSchema>;
export type RelayPresenceEvent = z.infer<typeof PresenceEventSchema>;

export type RelayPriority = "low" | "normal" | "high" | "urgent";
export type RelayDeliveryMode = "auto" | "actions" | "text" | "call";

export interface CreateRequestInput {
  kind: "question" | "notification";
  question: string;
  subject?: string | undefined;
  context?: string | undefined;
  choices?: string[] | undefined;
  urgency?: "normal" | "high" | undefined;
  priority?: RelayPriority | undefined;
  deliveryMode?: RelayDeliveryMode | undefined;
  expiresInSeconds?: number | undefined;
  agent?: { name?: string | undefined; cwd?: string | undefined } | undefined;
}

export interface CreateRequestResult {
  request: RelayRequest;
  delivery: RelayDelivery | undefined;
}

export interface UpdateRequestInput {
  priority?: RelayPriority | undefined;
  deliveryMode?: RelayDeliveryMode | undefined;
}

export interface UpdateRequestResult {
  request: RelayRequest;
  /** Human feedback for this request when the relay returns it (envelope or request field). */
  feedback: unknown;
}

// ---- Errors ----

export type RelayErrorKind =
  /** TCP/DNS level failure: nothing is listening, connection reset, ... */
  | "network"
  /** The relay did not respond within the client-side timeout. */
  | "timeout"
  /** The relay answered with a non-2xx status. */
  | "http"
  /** 2xx but the body is not the JSON the contract promises. */
  | "bad_response";

export class RelayError extends Error {
  readonly kind: RelayErrorKind;
  readonly baseUrl: string;
  /** HTTP status (kind === "http" or "bad_response"). */
  readonly status: number | undefined;
  /** `error.code` from the relay's error body, if it sent a contract-conformant one. */
  readonly code: string | undefined;
  /** `error.message` from the relay's error body. */
  readonly relayMessage: string | undefined;
  readonly cloud: boolean;

  constructor(
    kind: RelayErrorKind,
    message: string,
    details: { baseUrl: string; status?: number; code?: string; relayMessage?: string; cause?: unknown; cloud?: boolean },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "RelayError";
    this.kind = kind;
    this.baseUrl = details.baseUrl;
    this.status = details.status;
    this.code = details.code;
    this.relayMessage = details.relayMessage;
    this.cloud = details.cloud ?? false;
  }

  /** Worth retrying while long-polling an existing request (the relay may come back). */
  get transient(): boolean {
    if (this.kind === "network" || this.kind === "timeout" || this.kind === "bad_response") return true;
    return this.status !== undefined && this.status >= 500;
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

// ---- Client ----

export interface RelayClientOptions {
  baseUrl: string;
  agentToken: string;
  /** Firebase token source; only explicit 401 responses trigger one forced refresh. */
  tokenProvider?: (forceRefresh: boolean, signal?: AbortSignal) => Promise<string>;
  fetch?: FetchLike;
  clock?: Clock;
  /** Client-side timeout for ordinary (non long-poll) calls. Default 15s. */
  requestTimeoutMs?: number;
  /** Extra time on top of `wait` granted to a long-poll before giving up. Default 10s. */
  pollGraceMs?: number;
}

export interface CallOptions {
  signal?: AbortSignal | undefined;
}

export const MAX_RELAY_WAIT_SECONDS = 300;

export class RelayClient {
  readonly baseUrl: string;
  private readonly agentToken: string;
  private readonly tokenProvider: RelayClientOptions["tokenProvider"];
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly requestTimeoutMs: number;
  private readonly pollGraceMs: number;

  constructor(options: RelayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.agentToken = options.agentToken;
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.clock = options.clock ?? systemClock;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.pollGraceMs = options.pollGraceMs ?? 10_000;
  }

  /** POST /v1/requests */
  async createRequest(input: CreateRequestInput, options: CallOptions = {}): Promise<CreateRequestResult> {
    const body: Record<string, unknown> = { kind: input.kind, question: input.question };
    if (input.subject !== undefined) body.subject = input.subject;
    if (input.context !== undefined) body.context = input.context;
    if (input.choices !== undefined && input.choices.length > 0) body.choices = input.choices;
    if (input.urgency !== undefined) body.urgency = input.urgency;
    if (input.priority !== undefined) body.priority = input.priority;
    if (input.deliveryMode !== undefined) body.delivery_mode = input.deliveryMode;
    if (input.expiresInSeconds !== undefined) body.expires_in_seconds = input.expiresInSeconds;
    const agent: Record<string, string> = {};
    if (input.agent?.name) agent.name = input.agent.name;
    if (input.agent?.cwd) agent.cwd = input.agent.cwd;
    if (Object.keys(agent).length > 0) body.agent = agent;

    const headers = {"Idempotency-Key":crypto.randomUUID()};
    let json: unknown;
    try {
      json = await this.call("POST", "/v1/requests", body, this.requestTimeoutMs, options.signal, headers);
    } catch (error) {
      // Cloud guarantees a durable idempotency key. The LAN relay does not, so
      // never automatically repeat a local POST after an ambiguous failure.
      if (!this.tokenProvider || !(error instanceof RelayError) || !["network", "timeout"].includes(error.kind) || options.signal?.aborted) throw error;
      await this.clock.sleep(250, options.signal);
      json = await this.call("POST", "/v1/requests", body, this.requestTimeoutMs, options.signal, headers);
    }
    const parsed = this.parse(CreateEnvelopeSchema, json, 201);
    return { request: parsed.request, delivery: parsed.delivery ?? undefined };
  }

  /** GET /v1/requests/{id}?wait=N — blocks up to `waitSeconds` (0-300) while the request is pending. */
  async getRequest(id: string, options: CallOptions & { waitSeconds?: number } = {}): Promise<RelayRequest> {
    const wait = Math.min(MAX_RELAY_WAIT_SECONDS, Math.max(0, Math.floor(options.waitSeconds ?? 0)));
    const path = `/v1/requests/${encodeURIComponent(id)}?wait=${wait}`;
    const timeoutMs = wait > 0 ? wait * 1000 + this.pollGraceMs : this.requestTimeoutMs;
    const json = await this.call("GET", path, undefined, timeoutMs, options.signal);
    return this.parse(RequestEnvelopeSchema, json, 200).request;
  }

  /** POST /v1/requests/{id}/cancel — 409 `already_resolved` if not pending (or not a withdrawable notification). */
  async cancelRequest(id: string, options: CallOptions = {}): Promise<RelayRequest> {
    const path = `/v1/requests/${encodeURIComponent(id)}/cancel`;
    const json = await this.call("POST", path, undefined, this.requestTimeoutMs, options.signal);
    return this.parse(RequestEnvelopeSchema, json, 200).request;
  }

  /** GET /v1/presence — human availability and recent feedback events. */
  async getPresence(options: CallOptions = {}): Promise<RelayPresence> {
    const json = await this.call("GET", "/v1/presence", undefined, this.requestTimeoutMs, options.signal);
    return this.parse(PresenceSchema, json, 200);
  }

  /** PATCH /v1/requests/{id} — change priority and/or requested delivery mode. */
  async updateRequest(id: string, input: UpdateRequestInput, options: CallOptions = {}): Promise<UpdateRequestResult> {
    const body: Record<string, unknown> = {};
    if (input.priority !== undefined) body.priority = input.priority;
    if (input.deliveryMode !== undefined) body.delivery_mode = input.deliveryMode;
    const path = `/v1/requests/${encodeURIComponent(id)}`;
    const json = await this.call("PATCH", path, body, this.requestTimeoutMs, options.signal);
    const parsed = this.parse(UpdateEnvelopeSchema, json, 200);
    const feedback = parsed.feedback ?? parsed.request.feedback ?? undefined;
    return { request: parsed.request, feedback };
  }

  private parse<T>(schema: z.ZodType<T>, json: unknown, status: number): T {
    const result = schema.safeParse(json);
    if (!result.success) {
      throw new RelayError("bad_response", `The relay's response does not match the oyobidashi protocol: ${z.prettifyError(result.error)}`, {
        baseUrl: this.baseUrl,
        cloud: !!this.tokenProvider,
        status,
      });
    }
    return result.data;
  }

  /** Cloud pairing codes are intentionally never included in MCP tool output. */
  async createPairingCode(options: CallOptions = {}): Promise<{code: string; expires_at: string}> {
    const result = await this.call("POST", "/v1/pairing-codes", {}, this.requestTimeoutMs, options.signal);
    return this.parse(z.object({code:z.string().min(1).max(200),expires_at:z.string().datetime()}), result, 201);
  }

  private async call(
    method: "GET" | "POST" | "PATCH", path: string, body: unknown,
    timeoutMs: number, signal: AbortSignal | undefined, extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const token = this.tokenProvider ? await this.tokenProvider(false, signal) : this.agentToken;
    try { return await this.exchange(method, path, body, timeoutMs, signal, token, extraHeaders); }
    catch (error) {
      // Only a definitive authentication rejection is replayed here. Transport
      // failures and server errors are not evidence that a mutation was rejected.
      if (!this.tokenProvider || !(error instanceof RelayError) || error.status !== 401) throw error;
      const fresh = await this.tokenProvider(true, signal);
      return this.exchange(method, path, body, timeoutMs, signal, fresh, extraHeaders);
    }
  }

  /** Performs one HTTP exchange and returns the parsed JSON body of a 2xx response. */
  private async exchange(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    token: string,
    extraHeaders: Record<string, string>,
  ): Promise<unknown> {
    if (signal?.aborted) throw abortError();

    const controller = new AbortController();
    const timerCancel = new AbortController();
    let timedOut = false;

    const timeout = this.clock.sleep(timeoutMs, timerCancel.signal).then(
      () => {
        timedOut = true;
        controller.abort();
        return "timeout" as const;
      },
      () => new Promise<never>(() => {}), // timer cancelled: never settles
    );
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => {
        controller.abort();
        resolve("aborted");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    const headers: Record<string, string> = {
      ...extraHeaders,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers, signal: controller.signal, redirect: "error" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(body);
    }

    const exchange = (async () => {
      const response = await this.fetchImpl(this.baseUrl + path, init);
      const text = await response.text();
      return { status: response.status, ok: response.ok, text };
    })();
    exchange.catch(() => {}); // avoid unhandled rejection when the race is lost

    let outcome: { status: number; ok: boolean; text: string } | "timeout" | "aborted";
    try {
      outcome = await Promise.race([exchange, timeout, aborted]);
    } catch (e) {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw this.timeoutError(timeoutMs);
      const detail = this.tokenProvider ? "connection failed" : e instanceof Error ? e.message : String(e);
      throw new RelayError("network", `Cannot connect to the oyobidashi relay at ${this.baseUrl}: ${detail}`, {
        baseUrl: this.baseUrl,
        cloud: !!this.tokenProvider,
        ...(this.tokenProvider ? {} : {cause:e}),
      });
    } finally {
      timerCancel.abort();
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    if (outcome === "aborted") throw abortError();
    if (outcome === "timeout") throw this.timeoutError(timeoutMs);

    let json: unknown;
    let isJson = true;
    try {
      json = JSON.parse(outcome.text);
    } catch {
      isJson = false;
    }

    if (!outcome.ok) {
      const envelope = isJson ? ErrorEnvelopeSchema.safeParse(json) : undefined;
      if (envelope?.success) {
        const rawCode = envelope.data.error.code;
        const safeCloudCodes = new Set(["unauthorized", "forbidden", "not_found", "invalid_request", "idempotency_conflict", "turn_in_progress", "already_resolved", "rate_limited", "overloaded", "payload_too_large", "unavailable", "internal", "service_unavailable"]);
        const code = this.tokenProvider && !safeCloudCodes.has(rawCode) ? "unexpected_status" : rawCode;
        const message = this.tokenProvider ? undefined : envelope.data.error.message;
        throw new RelayError("http", `The relay answered ${outcome.status} ${code}${message ? `: ${message}` : ""}`, {
          baseUrl: this.baseUrl,
          cloud: !!this.tokenProvider,
          status: outcome.status,
          code,
          ...(message ? { relayMessage: message } : {}),
        });
      }
      throw new RelayError("http", `The relay answered HTTP ${outcome.status} without a oyobidashi error body (${this.tokenProvider ? "unexpected body" : snippet(outcome.text)})`, {
        baseUrl: this.baseUrl,
        cloud: !!this.tokenProvider,
        status: outcome.status,
      });
    }
    if (!isJson) {
      throw new RelayError("bad_response", `The relay answered HTTP ${outcome.status} with a body that is not JSON (${this.tokenProvider ? "unexpected body" : snippet(outcome.text)})`, {
        baseUrl: this.baseUrl,
        cloud: !!this.tokenProvider,
        status: outcome.status,
      });
    }
    return json;
  }

  private timeoutError(timeoutMs: number): RelayError {
    return new RelayError("timeout", `The oyobidashi relay at ${this.baseUrl} did not respond within ${Math.round(timeoutMs / 1000)}s`, {
      baseUrl: this.baseUrl,
      cloud: !!this.tokenProvider,
    });
  }
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "empty body";
  return `body starts with ${JSON.stringify(flat.length > 80 ? `${flat.slice(0, 80)}…` : flat)}`;
}
