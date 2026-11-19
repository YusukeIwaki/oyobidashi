import { deliveryMode } from "./policy.ts";
import type { ConversationProvider } from "./conversation.ts";
import { systemClock, type Clock } from "./clock.ts";
import { toDeviceObject, toRequestObject, type DeviceRow, type RequestRow, type Store } from "./db.ts";
import { newDeviceId, newDeviceToken, newRequestId, safeEqualHex, sha256Hex } from "./ids.ts";
import { isLoopbackAddress, isPrivateAddress } from "./net.ts";
import type { PushProviders } from "./push/types.ts";
import { validPushClientId } from "./push/lifecycle.ts";
import {
  INPUT_METHODS,
  KINDS,
  PLATFORMS,
  PUSH_ENVIRONMENTS,
  STATUSES,
  URGENCIES,
  VERSION,
  type Call,
  type Priority,
  type RequestedMode,
  type Presence,
  type Delivery,
  type InputMethod,
  type Kind,
  type Platform,
  type PushEnvironment,
  type RequestObject,
  type ServerEvent,
  type Status,
  type Urgency,
} from "./types.ts";

export const MAX_BODY_BYTES = 64 * 1024;
export const PAIR_FAILURE_LIMIT = 10;
export const PAIR_FAILURE_WINDOW_MS = 60_000;
/** WebSocket close code sent when the device's pairing has been deleted. */
export const WS_CLOSE_UNPAIRED = 4001;

export interface WsData {
  deviceId: string;
}

/** The subset of Bun's ServerWebSocket the app relies on. */
export interface SocketLike {
  data: WsData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
  ping(): number;
}

/** The subset of Bun's Server the app relies on (absent when the handler is called directly in tests). */
export interface ServerLike {
  upgrade(req: Request, options: { data: WsData }): boolean;
  requestIP(req: Request): { address: string } | null;
  timeout(req: Request, seconds: number): void;
}

export interface Logger {
  warn(message: string): void;
}

export interface AppOptions {
  store: Store;
  conversation?: ConversationProvider;
  conversationTimeoutMs?: number;
  /** Explicit HTTPS origin served by a reverse proxy on loopback. Agent routes still reject proxy traffic. */
  trustedProxyOrigin?: string;
  agentToken: string;
  clock?: Clock;
  /** Push providers per platform. Omit (or leave a platform out) to disable push. */
  push?: PushProviders;
  pushTimeoutMs?: number;
  logger?: Logger;
  /**
   * Source of the peer (socket) address used for access control. Defaults to `server.requestIP(req)`.
   * It must never be derived from a request header. Null / unparseable is treated as a public address.
   */
  peerAddress?: (req: Request, server?: ServerLike) => string | null;
}

export interface App {
  fetch(req: Request, server?: ServerLike): Promise<Response | undefined>;
  websocket: {
    open(ws: SocketLike): void;
    message(ws: SocketLike, message: string | Buffer): void;
    close(ws: SocketLike): void;
  };
  /** Periodic housekeeping: expire overdue requests, drop sockets of revoked devices. */
  sweep(): void;
  /** Sends a WebSocket ping frame to every connected device. */
  pingAll(): void;
  /** Resolves when all in-flight push sends have settled. */
  idle(): Promise<void>;
  /** Wakes every long-poll and closes every socket. */
  close(): void;
  waiterCount(): number;
  socketCount(): number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const errorResponse = (status: number, code: string, message: string) => json(status, { error: { code, message } });

const invalid = (message: string) => new HttpError(400, "invalid_request", message);
const unauthorized = () => new HttpError(401, "unauthorized", "invalid or missing token");
const forbidden = (message: string) => new HttpError(403, "forbidden", message);
const notFound = (message = "not found") => new HttpError(404, "not_found", message);

type Obj = Record<string, unknown>;

/** Length in characters (code points), short-circuiting the common cases. */
function tooLong(s: string, max: number): boolean {
  if (s.length <= max) return false;
  if (s.length > max * 2) return true;
  let n = 0;
  for (const _ of s) if (++n > max) return true;
  return false;
}

/** null and a missing field are the same thing (PROTOCOL.md section 2). */
function optString(obj: Obj, key: string, max: number, label = key): string | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw invalid(`${label} must be a string`);
  if (tooLong(v, max)) throw invalid(`${label} must be at most ${max} characters`);
  return v;
}

function reqString(obj: Obj, key: string, max: number): string {
  const v = optString(obj, key, max);
  if (v === null) throw invalid(`${key} is required`);
  if (v.length === 0) throw invalid(`${key} must not be empty`);
  return v;
}

function optEnum<T extends string>(obj: Obj, key: string, values: readonly T[]): T | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw invalid(`${key} must be one of: ${values.join(", ")}`);
  }
  return v as T;
}

function optInt(obj: Obj, key: string, min: number, max: number): number | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw invalid(`${key} must be an integer between ${min} and ${max}`);
  }
  return v;
}

function queryInt(params: URLSearchParams, key: string, min: number, max: number, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw invalid(`${key} must be an integer between ${min} and ${max}`);
  const n = Number(raw);
  if (n < min || n > max) throw invalid(`${key} must be an integer between ${min} and ${max}`);
  return n;
}

async function readJsonObject(req: Request): Promise<Obj> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "request body exceeds 64KB");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "payload_too_large", "request body exceeds 64KB");
      }
      chunks.push(value);
    }
  }
  if (size === 0) throw invalid("request body must be a JSON object");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("request body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("request body must be a JSON object");
  }
  return value as Obj;
}

type Auth = { role: "agent" } | { role: "device"; device: DeviceRow };

export function createApp(opts: AppOptions): App {
  const { store } = opts;
  const clock = opts.clock ?? systemClock;
  const push = opts.push ?? {};
  const pushTimeoutMs = opts.pushTimeoutMs ?? 15_000;
  const log = opts.logger ?? { warn: (m: string) => console.warn(m) };
  const agentTokenHash = sha256Hex(opts.agentToken);
  const peerAddress = opts.peerAddress ?? ((req: Request, server?: ServerLike) => server?.requestIP(req)?.address ?? null);

  const sockets = new Map<string, Set<SocketLike>>();
  const waiters = new Map<string, Set<() => void>>();
  const pairFailures = new Map<string, number[]>();
  const inflightPush = new Set<Promise<void>>();
  const turns = new Map<string, AbortController>();
  const iso = (ms: number) => new Date(ms).toISOString();
  const priorities = ["low", "normal", "high", "urgent"] as const;
  const modes = ["auto", "actions", "text", "call"] as const;

  function callOf(row: RequestRow): Call | null { return row.call_json ? JSON.parse(row.call_json) as Call : null; }

  function endCall(row: RequestRow, outcome: NonNullable<Call["outcome"]>, fallback = false): RequestRow {
    const call = callOf(row);
    if (!call || call.state === "ended") return row;
    turns.get(row.id)?.abort();
    const now = clock.now();
    const next = store.saveCall(row.id, { ...call, state: "ended", outcome, updated_at: iso(now) }, now);
    store.feedback(row.id, call.device_id, outcome, now);
    return fallback ? store.updateRouting(row.id, row.priority, "text", row.requested_mode, now) ?? next : next;
  }

  function routeMode(row: RequestRow, priority: Priority, requested: RequestedMode) {
    return deliveryMode({requested,priority,question:row.question,choices:row.choices ? JSON.parse(row.choices) : null,context:row.context,presence:store.listPresence(clock.now()),anotherCall:store.liveCalls().some(x=>x.id!==row.id) || callOf(row)?.state === "ended"});
  }

  function startCall(row: RequestRow): RequestRow {
    const now = clock.now();
    return store.saveCall(row.id, {id:crypto.randomUUID(),request_id:row.id,state:"ringing",outcome:null,device_id:null,started_at:iso(now),updated_at:iso(now),transcript:[]},now);
  }

  // ---- auth ----

  function authenticate(req: Request): Auth | null {
    const header = req.headers.get("authorization");
    if (!header) return null;
    const m = /^Bearer +(\S+)$/i.exec(header.trim());
    if (!m) return null;
    const hash = sha256Hex(m[1]!);
    if (safeEqualHex(hash, agentTokenHash)) return { role: "agent" };
    const device = store.getDeviceByTokenHash(hash);
    return device ? { role: "device", device } : null;
  }

  /** The agent API is for the same machine only. Checked before the token so it cannot be probed from the LAN. */
  function requireAgent(peer: string | null): (req: Request) => void {
    return (req) => {
      if (!isLoopbackAddress(peer) || req.headers.has("x-forwarded-host") || req.headers.has("x-forwarded-for")) throw forbidden("agent API is only available from the local machine");
      const auth = authenticate(req);
      if (!auth) throw unauthorized();
      if (auth.role !== "agent") throw forbidden("agent token required");
    };
  }

  function requireDevice(req: Request): DeviceRow {
    const auth = authenticate(req);
    if (!auth) throw unauthorized();
    if (auth.role !== "device") throw forbidden("device token required");
    store.touchDevice(auth.device.id, clock.now());
    return auth.device;
  }

  // ---- events ----

  function broadcast(event: ServerEvent): number {
    if (sockets.size === 0) return 0;
    const payload = JSON.stringify(event);
    let devices = 0;
    for (const set of sockets.values()) {
      let delivered = false;
      for (const ws of set) {
        try {
          // 0 = dropped; -1 = queued under backpressure (still delivered).
          if (ws.send(payload) !== 0) delivered = true;
        } catch {
          // socket already gone; the close handler removes it
        }
      }
      if (delivered) devices++;
    }
    return devices;
  }

  function wake(id: string): void {
    const set = waiters.get(id);
    if (!set) return;
    for (const finish of [...set]) finish();
  }

  function emitUpdated(row: RequestRow, notify = true): RequestObject {
    if (!["pending", "notified"].includes(row.status)) row = endCall(row, row.status === "answered" ? "resolved" : row.status === "expired" ? "expired" : "cancelled");
    const request = toRequestObject(row);
    broadcast({ type: "request.updated", request });
    wake(row.id);
    if (notify) dispatchPush(request, store.listDevices(), true);
    return request;
  }

  function expireDue(): void {
    for (const row of store.expireDue(clock.now())) emitUpdated(row);
  }

  function closeDeviceSockets(deviceId: string): void {
    const set = sockets.get(deviceId);
    if (!set) return;
    sockets.delete(deviceId);
    for (const ws of set) {
      try {
        ws.close(WS_CLOSE_UNPAIRED, "unpaired");
      } catch {
        // already closed
      }
    }
  }

  // ---- push ----

  function dispatchPush(request: RequestObject, devices: DeviceRow[], update = false): number {
    store.prunePushRegistrations(clock.now());
    let attempted = 0;
    const fallbackAlert = update && request.status === "pending" && request.delivery_mode === "text" && request.call?.state === "ended" && ["declined","hangup","missed","failed"].includes(request.call.outcome ?? "");
    for (const previous of devices) {
      const device = store.getDevice(previous.id);
      if (!device) continue;
      const provider = push[device.platform];
      const isVoip = !update && device.platform === "ios" && request.delivery_mode === "call" && request.call?.state === "ringing" && !!device.voip_token;
      const token = isVoip ? device.voip_token : device.push_token;
      if (!provider || !token) continue;
      attempted++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const task = (async () => {
        try {
          const result = await Promise.race([
            // Wrapped so that a provider throwing synchronously is also contained.
            (async () => provider.send({ token, environment: device.push_environment, ...(isVoip ? {type:"voip" as const} : update && !fallbackAlert ? {type:"update" as const} : {}) }, request))(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("push timed out")), pushTimeoutMs);
            }),
          ]);
          if (result.ok) return;
          if (result.unregistered) {
            if (isVoip) store.clearVoipToken(device.id, token);
            else store.clearPushToken(device.id, token);
            log.warn(`push: token of ${device.id} is no longer registered (${result.reason}); cleared`);
          } else {
            log.warn(`push: delivery to ${device.id} failed (${result.reason})`);
          }
        } catch (e) {
          log.warn(`push: delivery to ${device.id} failed (${(e as Error)?.message ?? e})`);
        } finally {
          clearTimeout(timer);
        }
      })();
      inflightPush.add(task);
      void task.finally(() => inflightPush.delete(task));
    }
    return attempted;
  }

  // ---- handlers ----

  async function createRequest(req: Request, peer: string | null): Promise<Response> {
    requireAgent(peer)(req);
    const body = await readJsonObject(req);
    const kind: Kind = optEnum(body, "kind", KINDS) ?? "question";
    const question = reqString(body, "question", 4000);
    const subject = optString(body, "subject", 40)?.trim().replace(/\s+/gu, " ") || null;
    const context = optString(body, "context", 8000);
    const urgency: Urgency = optEnum(body, "urgency", URGENCIES) ?? "normal";
    const priority: Priority = optEnum(body, "priority", priorities) ?? (urgency === "high" ? "high" : "normal");
    const requestedMode: RequestedMode = optEnum(body, "delivery_mode", modes) ?? "auto";
    const expiresIn = optInt(body, "expires_in_seconds", 10, 86400) ?? 3600;

    let choices: string[] | null = null;
    const rawChoices = body.choices;
    if (rawChoices !== undefined && rawChoices !== null) {
      if (!Array.isArray(rawChoices)) throw invalid("choices must be an array of strings");
      if (rawChoices.length > 8) throw invalid("choices must have at most 8 items");
      for (const c of rawChoices) {
        if (typeof c !== "string" || c.length === 0 || tooLong(c, 200)) {
          throw invalid("each choice must be a string of 1 to 200 characters");
        }
      }
      if (rawChoices.length > 0) choices = rawChoices as string[];
    }

    let agentName: string | null = null;
    let agentCwd: string | null = null;
    const rawAgent = body.agent;
    if (rawAgent !== undefined && rawAgent !== null) {
      if (typeof rawAgent !== "object" || Array.isArray(rawAgent)) throw invalid("agent must be an object");
      agentName = optString(rawAgent as Obj, "name", 100, "agent.name");
      agentCwd = optString(rawAgent as Obj, "cwd", 1000, "agent.cwd");
    }

    const now = clock.now();
    let row = store.insertRequest({
      id: newRequestId(now),
      kind,
      question,
      subject,
      context,
      choices,
      urgency,
      priority,
      requested_mode: requestedMode,
      delivery_mode: kind === "notification" ? "text" : deliveryMode({ requested:requestedMode, priority, question, choices, context, presence:store.listPresence(now), anotherCall:store.liveCalls().length > 0 }),
      status: kind === "notification" ? "notified" : "pending",
      agent_name: agentName,
      agent_cwd: agentCwd,
      created_at: now,
      expires_at: now + expiresIn * 1000,
    });
    if (row.delivery_mode === "call") row = startCall(row);
    const request = toRequestObject(row);
    const devices = store.listDevices();
    const delivery: Delivery = {
      paired_devices: devices.length,
      websocket_delivered: broadcast({ type: "request.created", request }),
      push_attempted: dispatchPush(request, devices),
    };
    return json(201, { request, delivery });
  }

  async function getRequest(
    req: Request,
    id: string,
    params: URLSearchParams,
    peer: string | null,
    server?: ServerLike,
  ): Promise<Response> {
    const auth = authenticate(req);
    if (!auth) throw unauthorized();
    let wait = 0;
    if (auth.role === "agent") {
      if (!isLoopbackAddress(peer) || req.headers.has("x-forwarded-host") || req.headers.has("x-forwarded-for")) throw forbidden("agent API is only available from the local machine");
      wait = queryInt(params, "wait", 0, 300, 0);
    }
    expireDue();
    let row = store.getRequest(id);
    if (!row) throw notFound("request not found");
    if (wait > 0 && row.status === "pending") {
      const remaining = Math.max(0, Math.min(wait * 1000, row.expires_at - clock.now()));
      server?.timeout(req, 0); // long-poll: disable Bun's idle timeout for this request
      await new Promise<void>((resolve) => {
        let set = waiters.get(id);
        if (!set) waiters.set(id, (set = new Set()));
        const waitSet = set;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clock.clearTimeout(timer);
          waitSet.delete(finish);
          if (waitSet.size === 0 && waiters.get(id) === waitSet) waiters.delete(id);
          req.signal.removeEventListener("abort", finish);
          resolve();
        };
        waitSet.add(finish);
        const timer = clock.setTimeout(finish, remaining);
        req.signal.addEventListener("abort", finish);
        if (req.signal.aborted) finish();
      });
      expireDue();
      row = store.getRequest(id);
      if (!row) throw notFound("request not found");
    }
    return json(200, { request: toRequestObject(row) });
  }

  function alreadyResolved(status: Status): HttpError {
    return new HttpError(409, "already_resolved", `request is already ${status}`);
  }

  function cancelRequest(req: Request, id: string, peer: string | null): Response {
    requireAgent(peer)(req);
    expireDue();
    const now = clock.now();
    const updated = store.cancelRequest(id, now);
    if (!updated) {
      const row = store.getRequest(id);
      if (!row) throw notFound("request not found");
      throw alreadyResolved(row.status);
    }
    return json(200, { request: emitUpdated(updated) });
  }

  async function answerRequest(req: Request, id: string): Promise<Response> {
    const device = requireDevice(req);
    const body = await readJsonObject(req);
    const text = reqString(body, "text", 10000);
    const choiceIndexRaw = body.choice_index;
    if (
      choiceIndexRaw !== undefined &&
      choiceIndexRaw !== null &&
      (typeof choiceIndexRaw !== "number" || !Number.isInteger(choiceIndexRaw))
    ) {
      throw invalid("choice_index must be an integer");
    }
    const hasIndex = typeof choiceIndexRaw === "number";
    const inputMethod: InputMethod = optEnum(body, "input_method", INPUT_METHODS) ?? (hasIndex ? "choice" : "text");
    if (inputMethod === "choice" && !hasIndex) throw invalid("choice_index is required when input_method is choice");

    // No await below this point: lookup, checks and the conditional UPDATE are one atomic step.
    expireDue();
    const row = store.getRequest(id);
    if (!row) throw notFound("request not found");
    if (row.status !== "pending") throw alreadyResolved(row.status);
    if (hasIndex) {
      const count = row.choices === null ? 0 : (JSON.parse(row.choices) as unknown[]).length;
      if (choiceIndexRaw < 0 || choiceIndexRaw >= count) throw invalid("choice_index is out of range");
    }
    const updated = store.answerRequest(
      id,
      {
        text: inputMethod === "choice" && hasIndex ? (JSON.parse(row.choices!) as string[])[choiceIndexRaw]! : text,
        // choice_index is only meaningful for a choice answer.
        choice_index: inputMethod === "choice" && hasIndex ? choiceIndexRaw : null,
        input_method: inputMethod,
        device_id: device.id,
      },
      clock.now(),
    );
    if (!updated) throw alreadyResolved(store.getRequest(id)?.status ?? "expired");
    return json(200, { request: emitUpdated(updated) });
  }

  async function updateRequest(req: Request, id: string, peer: string | null): Promise<Response> {
    requireAgent(peer)(req);
    const body = await readJsonObject(req);
    const priority = optEnum(body, "priority", priorities);
    const requested = optEnum(body, "delivery_mode", modes);
    if (!priority && !requested) throw invalid("priority or delivery_mode is required");
    expireDue();
    let row = store.getRequest(id);
    if (!row) throw notFound("request not found");
    if (row.status !== "pending") throw alreadyResolved(row.status);
    const mode = routeMode(row, priority ?? row.priority, requested ?? row.requested_mode);
    if (mode !== "call") row = endCall(row, "cancelled");
    row = store.updateRouting(id, priority ?? row.priority, mode, requested ?? row.requested_mode, clock.now())!;
    if (mode === "call" && !callOf(row)) {
      row = startCall(row);
      const request = emitUpdated(row, false);
      dispatchPush(request, store.listDevices());
      return json(200, {request});
    }
    return json(200, {request:emitUpdated(row)});
  }

  function getPresence(req: Request, peer: string | null): Response {
    const auth=authenticate(req);
    if (!auth) throw unauthorized();
    if(auth.role === "agent") requireAgent(peer)(req);
    else store.touchDevice(auth.device.id,clock.now());
    const devices=store.listPresence(clock.now());
    return json(200, {devices:auth.role === "agent" ? devices : devices.filter(x=>x.device_id===auth.device.id),recent_events:auth.role === "agent" ? store.recentFeedback() : [],now:iso(clock.now())});
  }

  async function putPresence(req: Request): Promise<Response> {
    const device = requireDevice(req);
    const body = await readJsonObject(req);
    const availability: Presence["availability"] | null = optEnum(body, "availability", ["available","busy","away"]);
    if (!availability) throw invalid("availability is required");
    const untilString = optString(body, "until", 100);
    const until = untilString === null ? null : Date.parse(untilString);
    if (until !== null && (!Number.isFinite(until) || until <= clock.now() || until > clock.now()+86400_000*7)) throw invalid("until must be a future ISO8601 date within 7 days");
    const note = optString(body, "note", 500);
    store.setPresence(device.id,availability,until,note,clock.now());
    // Stop ringing if the human explicitly becomes unavailable, without disturbing an active call.
    if (availability !== "available") for (const row of store.liveCalls()) if (callOf(row)?.state === "ringing") emitUpdated(endCall(row,"declined",true));
    return json(200, {presence:store.listPresence(clock.now()).find(x=>x.device_id===device.id)});
  }

  async function callEvent(req: Request, id: string, server?: ServerLike): Promise<Response> {
    const device = requireDevice(req);
    const body = await readJsonObject(req);
    const event = optEnum(body, "event", ["answer","decline","hangup","turn","failed"] as const);
    if (!event) throw invalid("call event is required");
    const text = event === "turn" ? reqString(body,"text",10000).trim() : null;
    if (event === "turn" && !text) throw invalid("text must not be blank");
    expireDue();
    let row = store.getRequest(id);
    if (!row) throw notFound("request not found");
    if (row.status !== "pending") throw alreadyResolved(row.status);
    let call = callOf(row);
    if (!call || call.state === "ended") throw new HttpError(409,"call_ended","call is no longer available; reply by text");
    if (call.device_id && call.device_id !== device.id) throw new HttpError(409,"call_claimed","call was answered on another device");
    if (event === "answer") {
      if (call.state === "active") return json(200,{request:toRequestObject(row),call,reply:call.transcript[0]?.text ?? row.question,resolved:false});
      const reply = row.question;
      call = {...call,state:"active",device_id:device.id,updated_at:iso(clock.now()),transcript:[{role:"assistant",text:reply}]};
      row = store.saveCall(id,call,clock.now());
      store.feedback(id,device.id,"answered_call",clock.now());
      return json(200,{request:emitUpdated(row),call,reply,resolved:false});
    }
    if (event !== "turn") {
      const outcome = event === "decline" ? "declined" : event === "failed" ? "failed" : "hangup";
      if (!call.device_id) row = store.saveCall(id,{...call,device_id:device.id},clock.now());
      row = endCall(row,outcome,true);
      return json(200,{request:emitUpdated(row),call:callOf(row),resolved:false});
    }
    if (call.state !== "active") throw new HttpError(409,"call_not_active","answer the call before speaking");
    if (turns.has(id)) throw new HttpError(409,"turn_in_progress","wait for the current turn to complete");
    if (!opts.conversation) throw new HttpError(503,"voice_unavailable","conversation provider is unavailable; reply by text");
    if (call.transcript.length >= 60) throw new HttpError(409,"call_too_long","continue with text");
    const controller = new AbortController();
    turns.set(id,controller);
    const abort = () => controller.abort();
    req.signal.addEventListener("abort",abort,{once:true});
    const timer = setTimeout(abort,opts.conversationTimeoutMs ?? 90_000);
    server?.timeout(req,0);
    try {
      const conversation = {...call,transcript:[...call.transcript,{role:"user" as const,text:text!}]};
      const result = await opts.conversation.turn(toRequestObject(row),conversation,controller.signal);
      // The CLI may finish after a human hung up, another device replied, or an agent cancelled.
      expireDue();
      row = store.getRequest(id)!;
      call = callOf(row)!;
      if (controller.signal.aborted || row.status !== "pending" || call.state !== "active" || call.device_id !== device.id) throw new HttpError(409,"call_ended","call ended while preparing reply");
      call = {...call,updated_at:iso(clock.now()),transcript:[...conversation.transcript,{role:"assistant",text:result.reply}]};
      if (result.resolved) {
        if (!result.answer?.trim()) throw new Error("resolved call has no answer");
        call = {...call,state:"ended",outcome:"resolved"};
      }
      row = store.saveCall(id,call,clock.now());
      if (result.resolved) {
        row = store.answerRequest(id,{text:result.answer!,choice_index:null,input_method:"voice",device_id:device.id},clock.now())!;
        store.feedback(id,device.id,"resolved",clock.now());
      }
      return json(200,{request:emitUpdated(row),call,reply:result.reply,resolved:result.resolved});
    } catch (error) {
      if (error instanceof HttpError) throw error;
      log.warn(`conversation failed: ${error instanceof Error ? error.message : "unknown"}`);
      throw new HttpError(503,"conversation_failed","音声の応答を取得できませんでした。もう一度話すか、テキストで返信してください");
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort",abort);
      if (turns.get(id) === controller) turns.delete(id);
    }
  }

  function listRequests(req: Request, params: URLSearchParams): Response {
    requireDevice(req);
    const statusRaw = params.get("status");
    let status: Status | null = null;
    if (statusRaw !== null) {
      if (!STATUSES.includes(statusRaw as Status)) throw invalid(`status must be one of: ${STATUSES.join(", ")}`);
      status = statusRaw as Status;
    }
    const limit = queryInt(params, "limit", 1, 200, 50);
    expireDue();
    return json(200, { requests: store.listRequests(status, limit).map(toRequestObject) });
  }

  function recentFailures(ip: string, now: number): number[] {
    const list = pairFailures.get(ip);
    if (!list) return [];
    const fresh = list.filter((t) => now - t < PAIR_FAILURE_WINDOW_MS);
    if (fresh.length === 0) pairFailures.delete(ip);
    else pairFailures.set(ip, fresh);
    return fresh;
  }

  function pushClientId(body: Obj): string | undefined {
    if (body.push_client_id == null) return undefined;
    if (!validPushClientId(body.push_client_id)) throw invalid("invalid push_client_id");
    return body.push_client_id;
  }

  function pushTokenField(body: Obj): string | null | undefined {
    const v = body.push_token;
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    if (typeof v !== "string") throw invalid("push_token must be a string");
    if (v.length > 4096) throw invalid("push_token must be at most 4096 characters");
    return v;
  }

  async function pair(req: Request, peer: string | null): Promise<Response> {
    const body = await readJsonObject(req);
    const code = reqString(body, "code", 200);
    const name = reqString(body, "device_name", 200);
    const platform: Platform | null = optEnum(body, "platform", PLATFORMS);
    if (!platform) throw invalid("platform is required");
    const pushToken = pushTokenField(body) ?? null;
    const clientId = pushClientId(body);
    const env: PushEnvironment | null = optEnum(body, "push_environment", PUSH_ENVIRONMENTS);

    const now = clock.now();
    const ip = peer ?? "unknown";
    const failures = recentFailures(ip, now);
    if (failures.length >= PAIR_FAILURE_LIMIT) {
      throw new HttpError(429, "rate_limited", "too many failed pairing attempts; try again later");
    }
    if (!store.consumePairingCode(sha256Hex(code), now)) {
      failures.push(now);
      pairFailures.set(ip, failures);
      throw new HttpError(401, "pairing_code_invalid", "pairing code is invalid, expired or already used");
    }
    const deviceToken = newDeviceToken();
    const device = store.insertDevice({
      id: newDeviceId(now),
      name,
      platform,
      token_hash: sha256Hex(deviceToken),
      push_token: pushToken,
      push_client_id: clientId,
      push_environment: platform === "ios" ? (env ?? "production") : null,
      created_at: now,
    });
    if (pushToken) store.clearPushTokenFromOthers(platform, pushToken, device.id);
    for (const id of store.retirePushClients(device)) closeDeviceSockets(id);
    return json(201, { device: toDeviceObject(device), device_token: deviceToken });
  }

  async function updateDevice(req: Request): Promise<Response> {
    const device = requireDevice(req);
    const body = await readJsonObject(req);
    const clientId = pushClientId(body);
    // Parsing can yield while a new pairing revokes or binds this device.
    const current = store.getDevice(device.id);
    if (!current) throw unauthorized();
    if (clientId && current.push_client_id && clientId !== current.push_client_id) throw invalid("push_client_id cannot change within a pairing");
    const pushToken = pushTokenField(body);
    const voipToken = body.voip_token === null || body.voip_token === "" ? null : optString(body,"voip_token",4096);
    if (voipToken !== null && device.platform !== "ios") throw invalid("voip_token is only available on iOS");
    const env = optEnum(body, "push_environment", PUSH_ENVIRONMENTS);
    const name = optString(body, "device_name", 200);
    if (name !== null && name.length === 0) throw invalid("device_name must not be empty");
    const updated = store.updateDevice(device.id, {
      name: name ?? undefined,
      push_client_id: clientId,
      push_token: pushToken,
      voip_token: body.voip_token === undefined ? undefined : voipToken,
      push_environment: env !== null && device.platform === "ios" ? env : undefined,
    }, clock.now());
    if (!updated) throw unauthorized();
    for (const id of store.retirePushClients(updated)) closeDeviceSockets(id);
    if (pushToken) store.clearPushTokenFromOthers(updated.platform, pushToken, updated.id);
    if (voipToken) store.clearVoipTokenFromOthers(voipToken, updated.id);
    return json(200, { device: toDeviceObject(updated) });
  }

  function deleteDevice(req: Request): Response {
    const device = requireDevice(req);
    store.deleteDevice(device.id);
    closeDeviceSockets(device.id);
    return new Response(null, { status: 204 });
  }

  function events(req: Request, server?: ServerLike): Response | undefined {
    const device = requireDevice(req);
    if (!server || !server.upgrade(req, { data: { deviceId: device.id } })) {
      throw invalid("websocket upgrade required");
    }
    return undefined;
  }

  async function route(req: Request, server?: ServerLike): Promise<Response | undefined> {
    const peer = peerAddress(req, server);
    if (req.headers.has("x-forwarded-for") || req.headers.has("x-forwarded-host")) {
      // Never derive agent authorization or device identity from forwarding headers.
      // Only an explicitly configured local TLS proxy may forward device traffic.
      const origin = opts.trustedProxyOrigin ? new URL(opts.trustedProxyOrigin) : null;
      if (!origin || origin.protocol !== "https:" || !isLoopbackAddress(peer) || req.headers.get("x-forwarded-proto") !== "https" || req.headers.get("x-forwarded-host") !== origin.host) {
        throw forbidden("requests through an unconfigured proxy are not allowed");
      }
    } else if (!isPrivateAddress(peer)) throw forbidden("the relay is only reachable from the local network");

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/v1/presence") {
      if (method === "GET") return getPresence(req, peer);
      if (method === "PUT") return putPresence(req);
    }
    if (path === "/healthz" && method === "GET") return json(200, { ok: true, version: VERSION, voice_ai: { provider: "claude-code" } });
    if (path === "/v1/requests") {
      if (method === "POST") return createRequest(req, peer);
      if (method === "GET") return listRequests(req, url.searchParams);
    } else if (path.startsWith("/v1/requests/")) {
      const parts = path.slice("/v1/requests/".length).split("/");
      const id = parts[0]!;
      if (id.length > 0) {
        if (parts.length === 1 && method === "PATCH") return updateRequest(req,id,peer);
        if (parts.length === 1 && method === "GET") return getRequest(req, id, url.searchParams, peer, server);
        if (parts.length === 2 && method === "POST") {
          if (parts[1] === "call") return callEvent(req,id,server);
          if (parts[1] === "answer") return answerRequest(req, id);
          if (parts[1] === "cancel") return cancelRequest(req, id, peer);
        }
      }
    } else if (path === "/v1/pair") {
      if (method === "POST") return pair(req, peer);
    } else if (path === "/v1/devices/me") {
      if (method === "PUT") return updateDevice(req);
      if (method === "DELETE") return deleteDevice(req);
    } else if (path === "/v1/events") {
      if (method === "GET") return events(req, server);
    }
    throw notFound();
  }

  return {
    async fetch(req, server) {
      try {
        return await route(req, server);
      } catch (e) {
        if (e instanceof HttpError) return errorResponse(e.status, e.code, e.message);
        log.warn(`internal error: ${(e as Error)?.stack ?? e}`);
        return errorResponse(500, "internal", "internal server error");
      }
    },

    websocket: {
      open(ws) {
        const { deviceId } = ws.data;
        // The pairing may have been deleted between the upgrade and now.
        if (!store.getDevice(deviceId)) {
          ws.close(WS_CLOSE_UNPAIRED, "unpaired");
          return;
        }
        // Expire first so that hello is the first frame this socket sees and reflects the current state.
        expireDue();
        store.touchDevice(deviceId,clock.now());
        let set = sockets.get(deviceId);
        if (!set) sockets.set(deviceId, (set = new Set()));
        set.add(ws);
        const hello: ServerEvent = { type: "hello", pending: store.listRequests("pending", 200).map(toRequestObject) };
        ws.send(JSON.stringify(hello));
      },
      message(ws, message) {
        if (typeof message !== "string") return;
        if (message.length > 256) return;
        try {
          const parsed = JSON.parse(message) as { type?: unknown } | null;
          if (parsed && typeof parsed === "object" && parsed.type === "ping") { store.touchDevice(ws.data.deviceId,clock.now()); ws.send('{"type":"pong"}'); }
        } catch {
          // anything that is not a ping is ignored
        }
      },
      close(ws) {
        const set = sockets.get(ws.data.deviceId);
        if (!set) return;
        set.delete(ws);
        if (set.size === 0) sockets.delete(ws.data.deviceId);
      },
    },

    sweep() {
      store.prunePushRegistrations(clock.now());
      expireDue();
      const now = clock.now();
      for (const row of store.liveCalls()) {
        const call = callOf(row)!;
        if (call.state === "ringing" && now - Date.parse(call.started_at) >= 45_000) emitUpdated(endCall(row,"missed",true));
        else if (call.state === "active" && now-Date.parse(call.updated_at) >= 10*60_000) emitUpdated(endCall(row,"failed",true));
      }
      for (const ip of [...pairFailures.keys()]) recentFailures(ip, now);
      if (sockets.size > 0) {
        // `revoke` from the CLI deletes the row directly in the DB; notice it here.
        const alive = new Set(store.listDeviceIds());
        for (const deviceId of [...sockets.keys()]) {
          if (!alive.has(deviceId)) closeDeviceSockets(deviceId);
        }
      }
    },

    pingAll() {
      for (const set of sockets.values()) {
        for (const ws of set) {
          try {
            ws.ping();
          } catch {
            // already closed
          }
        }
      }
    },

    async idle() {
      while (inflightPush.size > 0) await Promise.allSettled([...inflightPush]);
    },

    close() {
      for (const controller of turns.values()) controller.abort();
      for (const row of store.liveCalls()) emitUpdated(endCall(row,"failed",true));
      for (const set of [...waiters.values()]) for (const finish of [...set]) finish();
      for (const deviceId of [...sockets.keys()]) {
        const set = sockets.get(deviceId)!;
        sockets.delete(deviceId);
        for (const ws of set) {
          try {
            ws.close(1001, "server shutting down");
          } catch {
            // already closed
          }
        }
      }
    },

    waiterCount() {
      let n = 0;
      for (const set of waiters.values()) n += set.size;
      return n;
    },

    socketCount() {
      let n = 0;
      for (const set of sockets.values()) n += set.size;
      return n;
    },
  };
}
