import { deliveryMode } from "../../relay/src/policy.ts";
import { PUSH_FIELDS, registrationField, freshPushRegistration, validPushClientId } from "../../relay/src/push/lifecycle.ts";
import type { Priority, RequestedMode } from "../../relay/src/types.ts";
import {
  CloudError,
  conflict,
  enumeration,
  integer,
  invalid,
  missing,
  string,
  unauthorized,
} from "./errors.ts";
import {
  entitled,
  iso,
  liveTurn,
  turnView,
  type CloudRequest,
  type Database,
  type Device,
  type Transaction,
  type Turn,
  type WakeBus,
} from "./types.ts";

export const hash = (s: string) =>
  new Bun.CryptoHasher("sha256").update(s).digest("hex");
const secret = () =>
  crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
export type Principal =
  | { uid: string; role: "agent" }
  | { uid: string; role: "device"; deviceId: string; tokenHash: string };
const priorities = ["low", "normal", "high", "urgent"] as const;
const modes = ["auto", "actions", "text", "call"] as const;
const VOICE_TURNS_PER_HOUR = 30;
const VOICE_WINDOW_MS = 60 * 60_000;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const publicDevice = (d: Device) => ({
  id: d.id,
  name: d.name,
  platform: d.platform,
  created_at: d.created_at,
});

export class CloudService {
  constructor(
    readonly db: Database,
    readonly bus: WakeBus,
    readonly now: () => number = Date.now,
  ) {}
  voiceTrainingPolicy: { free: boolean | null; plus: boolean | null } = {
    free: null,
    plus: null,
  };
  voiceProofRequired = false;
  async run<T>(p: Principal, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(p.uid, async (tx) => {
      if (await tx.get("ban", "current"))
        throw new CloudError(403, "account_banned", "このアカウントは利用を停止しました。");
      if (p.role === "device") {
        const device = await tx.get("device", p.deviceId);
        if (!device || device.tokenHash !== p.tokenHash) throw unauthorized();
        await this.prunePush(tx, device);
        if (this.now() - device.lastSeen > 30_000) {
          device.lastSeen = this.now();
          await tx.put("device", device.id, device);
        }
      }
      await this.reconcile(tx);
      return fn(tx);
    });
  }
  async wake(uid: string) {
    try {
      await this.bus.publish(uid);
    } catch {
      /* DB is authoritative; periodic reconciliation recovers. */
    }
  }
  private async quota(tx: Transaction, key: string, limit: number) {
    const window = Math.floor(this.now() / 60_000);
    const previous = await tx.get("quota", key);
    const q = previous?.window === window ? previous : { window, count: 0 };
    if (q.count >= limit)
      throw new CloudError(
        429,
        "rate_limited",
        "しばらく待ってから、もう一度お試しください。",
      );
    q.count++;
    await tx.put("quota", key, q, (window + 1) * 60_000);
  }
  private async recentVoiceTurns(tx: Transaction, now: number) {
    const usage = await tx.get("voice_turn_usage", "current");
    return (usage?.recent ?? []).filter((turn) => turn.at > now - VOICE_WINDOW_MS);
  }

  /** Distinct turn IDs sent faster than a person can speak, including while a turn is pending. */
  private async voiceHammer(tx: Transaction) {
    const attempts = (await tx.get("voice_attempts", "current")) ?? { recent: [] };
    attempts.recent = attempts.recent.filter((at) => at > this.now() - 60_000);
    attempts.recent.push(this.now());
    await tx.put("voice_attempts", "current", attempts, this.now() + 60_000);
    if (attempts.recent.length >= 30) {
      await tx.put("ban", "current", { at: this.now(), reason: "voice_hammer" });
      return true;
    }
    return false;
  }

  async accountLinkAttempt(tx: Transaction) {
    await this.quota(tx, "account_link", 10);
  }
  async billingAttempt(tx: Transaction) {
    await this.quota(tx, "billing", 30);
  }
  async voiceProofAttempt(tx: Transaction) {
    await this.quota(tx, "voice_proof", 12);
  }
  /** True when this owner's voice calls may be used for model training. */
  async voiceTraining(tx: Transaction) {
    const { free, plus } = this.voiceTrainingPolicy;
    if (free === plus) return free === true;
    const active = entitled(await tx.get("entitlement", "current"), this.now());
    return (active ? plus : free) === true;
  }
  async oauthAttempt(tx: Transaction) {
    await this.quota(tx, "oauth_authorize", 20);
  }
  async request(tx: Transaction, id: string) {
    const r = await tx.get("request", id);
    if (!r) throw missing();
    return r;
  }
  private due(r: CloudRequest) {
    if (r.status !== "pending") return this.now() + 30 * 86400_000;
    const expiry = Date.parse(r.expires_at);
    const call = r.call;
    if (call?.state === "ringing")
      return Math.min(expiry, Date.parse(call.started_at) + 45_000);
    if (call?.state === "active")
      return Math.min(
        expiry,
        Date.parse(call.updated_at) + 600_000,
        liveTurn(call.turn) ? (call.turn?.deadline ?? Infinity) : Infinity,
      );
    return expiry;
  }
  async save(
    tx: Transaction,
    r: CloudRequest,
    notify: "initial" | "update" | "fallback" | "none" = "update",
  ) {
    r.version++;
    r.updated_at = iso(Math.max(this.now(), Date.parse(r.updated_at) + 1));
    await tx.put("request", r.id, r, this.due(r));
    if (notify !== "none")
      for (const d of await tx.list("device", {}, 33)) {
        await this.prunePush(tx, d);
        const target =
          notify === "update"
            ? d.push_token
            : r.delivery_mode === "call" && d.platform === "ios"
              ? d.voip_token
              : d.push_token;
        if (!target) continue;
        const stage = r.delivery_mode === "call" ? "call" : "text";
        const intent =
          notify === "update" ? `update:${r.version}` : `alert:${stage}`;
        await tx.enqueue({
          id: `push:${r.id}:${intent}:${d.id}`,
          kind: "push",
          requestId: r.id,
          payload: {
            deviceId: d.id,
            update: notify === "update",
            version: r.version,
            mode: stage,
          },
          available: this.now(),
          deadline:
            notify === "update"
              ? this.now() + 3600_000
              : Math.min(Date.parse(r.expires_at), this.now() + 300_000),
        });
      }
  }
  async endCall(
    tx: Transaction,
    r: CloudRequest,
    outcome: NonNullable<NonNullable<CloudRequest["call"]>["outcome"]>,
    fallback = false,
  ) {
    const c = r.call;
    if (!c || c.state === "ended") return;
    if (liveTurn(c.turn)) {
      const t = await tx.get("turn", c.turn!.id);
      if (t) {
        t.state = "cancelled";
        t.error = {
          code: "call_ended",
          message:
            "通話が終了しました。必要であればテキストで返信してください。",
        };
        await tx.put("turn", t.id, t, this.now() + 30 * 86400_000);
        c.turn = turnView(t);
      }
    }
    c.state = "ended";
    c.outcome = outcome;
    c.updated_at = iso(this.now());
    if (fallback) r.delivery_mode = "text";
    await tx.put(
      "feedback",
      crypto.randomUUID(),
      {
        request_id: r.id,
        device_id: c.device_id,
        event: outcome,
        at: iso(this.now()),
      },
      this.now() + 7 * 86400_000,
    );
  }
  async reconcile(tx: Transaction) {
    const now = this.now();
    for (const due of await tx.due(now)) {
      if (due.kind !== "request") {
        await tx.remove(due.kind, due.id);
        continue;
      }
      const r = due.doc as CloudRequest;
      if (r.status !== "pending") {
        await tx.remove("request", r.id);
        continue;
      }
      if (Date.parse(r.expires_at) <= now) {
        r.status = "expired";
        await this.endCall(tx, r, "expired");
        await this.save(tx, r);
      } else if (
        r.call?.state === "ringing" &&
        now - Date.parse(r.call.started_at) >= 45_000
      ) {
        await this.endCall(tx, r, "missed", true);
        await this.save(tx, r, "fallback");
      } else if (
        r.call?.state === "active" &&
        now - Date.parse(r.call.updated_at) >= 600_000
      ) {
        await this.endCall(tx, r, "failed", true);
        await this.save(tx, r, "fallback");
      } else if (r.call?.state === "active" && liveTurn(r.call.turn)) {
        const t = await tx.get("turn", r.call.turn!.id);
        if (t && t.deadline <= now) {
          t.state = "failed";
          t.error = {
            code: "conversation_failed",
            message:
              "応答の準備に時間がかかっています。再試行するか、テキストで返信してください。",
          };
          await tx.put("turn", t.id, t, now + 30 * 86400_000);
          r.call.turn = turnView(t);
          await this.save(tx, r, "none");
        }
      }
    }
  }
  async routeMode(
    tx: Transaction,
    r: CloudRequest,
    priority: Priority,
    requested: RequestedMode,
  ) {
    const now = this.now();
    if (requested === "call" && !r.call &&
        (await this.recentVoiceTurns(tx, now)).length >= VOICE_TURNS_PER_HOUR)
      return "text";
    const presence = (await tx.list("presence", {}, 33)).map((p) =>
      p.until && Date.parse(p.until) <= now
        ? { ...p, availability: "available" as const }
        : p,
    );
    const another = (await tx.list("request", { status: "pending" }, 201)).some(
      (x) =>
        x.id !== r.id &&
        (x.call?.state === "active" || x.call?.state === "ringing"),
    );
    const declined = await tx.get("call_cooldown", "declined");
    return deliveryMode({
      requested,
      priority,
      question: r.question,
      context: r.context,
      choices: r.choices,
      presence,
      anotherCall: another || r.call?.state === "ended" || !!(declined && declined.until > now),
    });
  }
  async create(
    tx: Transaction,
    body: Record<string, unknown>,
    key: string | null,
  ) {
    if (key && !/^[A-Za-z0-9_-]{16,128}$/.test(key))
      throw invalid("invalid Idempotency-Key");
    const fingerprint = hash(JSON.stringify(body));
    if (key) {
      const previous = await tx.get("dedupe", key);
      if (previous && previous.expires > this.now()) {
        if (previous.fingerprint !== fingerprint)
          throw conflict(
            "idempotency_conflict",
            "key was used with different input",
          );
        return this.created(tx, await this.request(tx, previous.requestId));
      }
    }
    const kind = enumeration(
      body,
      "kind",
      ["question", "notification"] as const,
      "question",
    );
    await this.quota(tx, "create", 60);
    if (kind === "notification") await this.quota(tx, "notification", 10);
    const urgency = enumeration(
      body,
      "urgency",
      ["normal", "high"] as const,
      "normal",
    );
    const priority = enumeration(
      body,
      "priority",
      priorities,
      urgency === "high" ? "high" : "normal",
    );
    const requested = enumeration(body, "delivery_mode", modes, "auto");
    const question = string(body, "question", 4000, true)!;
    const subject = string(body, "subject", 40)?.replace(/[\p{C}\s]+/gu, " ").trim() || null;
    const context = string(body, "context", 8000);
    const choices = body.choices;
    if (
      choices !== undefined &&
      choices !== null &&
      (!Array.isArray(choices) ||
        choices.length > 8 ||
        choices.some(
          (x) =>
            typeof x !== "string" || !x.length || Array.from(x).length > 200,
        ))
    )
      throw invalid(
        "choices must contain at most eight nonempty strings of up to 200 characters",
      );
    let agent = null;
    if (body.agent !== undefined && body.agent !== null) {
      if (typeof body.agent !== "object" || Array.isArray(body.agent))
        throw invalid("agent must be an object");
      agent = {
        name: string(body.agent as Record<string, unknown>, "name", 100)?.replace(/[\p{C}\s]+/gu, " ").trim() || null,
        cwd: string(body.agent as Record<string, unknown>, "cwd", 1000),
      };
    }
    if ((await tx.list("request", { status: "pending" }, 201)).length >= 200)
      throw new CloudError(
        429,
        "rate_limited",
        "未回答の質問が多いため、先に回答または取り消しをしてください。",
      );
    const history = await tx.list("request", {}, 1001);
    if (history.length >= 1000) {
      const oldestTerminal = history.reverse().find((item) => item.status !== "pending");
      if (oldestTerminal) await tx.remove("request", oldestTerminal.id);
    }
    const now = this.now();
    const r: CloudRequest = {
      id: `req_${crypto.randomUUID()}`,
      kind,
      question,
      ...(subject ? { subject } : {}),
      context,
      choices: Array.isArray(choices) && choices.length ? choices : null,
      urgency,
      priority,
      requested_mode: requested,
      delivery_mode: "text",
      status: kind === "notification" ? "notified" : "pending",
      answer: null,
      agent,
      created_at: iso(now),
      updated_at: iso(now),
      expires_at: iso(
        now + 1000 * integer(body.expires_in_seconds, 10, 86400, 3600),
      ),
      call: null,
      version: 0,
    };
    if (kind !== "notification")
      r.delivery_mode = await this.routeMode(tx, r, priority, requested);
    if (r.delivery_mode === "call")
      r.call = {
        id: crypto.randomUUID(),
        request_id: r.id,
        state: "ringing",
        outcome: null,
        device_id: null,
        started_at: iso(now),
        updated_at: iso(now),
        transcript: [],
      };
    await this.save(tx, r, "initial");
    if (key)
      await tx.put(
        "dedupe",
        key,
        { fingerprint, requestId: r.id, expires: now + 86400_000 },
        now + 86400_000,
      );
    return this.created(tx, r);
  }
  private async created(tx: Transaction, r: CloudRequest) {
    const ds = await tx.list("device", {}, 33);
    return {
      request: r,
      delivery: {
        paired_devices: ds.length,
        websocket_delivered: 0,
        push_attempted: ds.filter((d) => d.push_token || d.voip_token).length,
        ...((await this.voiceTraining(tx)) ? { voice_training: true } : {}),
      },
    };
  }
  async cancel(tx: Transaction, id: string) {
    const r = await this.request(tx, id);
    if (!["pending", "notified"].includes(r.status))
      throw conflict("already_resolved", "request is already closed");
    r.status = "cancelled";
    await this.endCall(tx, r, "cancelled");
    await this.save(tx, r);
    return { request: r };
  }
  async answer(
    tx: Transaction,
    id: string,
    deviceId: string,
    b: Record<string, unknown>,
  ) {
    const r = await this.request(tx, id);
    const text = string(b, "text", 10000, true)!;
    const input = enumeration(
      b,
      "input_method",
      ["text", "voice", "choice"] as const,
      "text",
    );
    const index = b.choice_index;
    if (
      index !== null &&
      index !== undefined &&
      (typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= (r.choices?.length ?? 0))
    )
      throw invalid("invalid choice_index");
    if (input === "choice" && (index === null || index === undefined))
      throw invalid("choice_index is required");
    // The answer is idempotent for its owning device and identical content. A
    // lost HTTP response must not force a second answer or discard the draft.
    const actual = input === "choice" ? r.choices![index as number]! : text;
    if (
      r.status === "answered" &&
      r.answer?.device_id === deviceId &&
      r.answer.text === actual &&
      r.answer.input_method === input
    )
      return { request: r };
    if (r.status !== "pending")
      throw conflict("already_resolved", "request is already closed");
    r.status = "answered";
    r.answer = {
      text: actual,
      choice_index: input === "choice" ? (index as number) : null,
      input_method: input,
      device_id: deviceId,
      answered_at: iso(this.now()),
    };
    await this.endCall(tx, r, "resolved");
    await this.save(tx, r);
    return { request: r };
  }
  async update(tx: Transaction, id: string, b: Record<string, unknown>) {
    const r = await this.request(tx, id);
    if (r.status !== "pending")
      throw conflict("already_resolved", "request is already closed");
    if (b.priority == null && b.delivery_mode == null)
      throw invalid("priority or delivery_mode is required");
    await this.quota(tx, "update", 60);
    const priority = enumeration(
      b,
      "priority",
      priorities,
      r.priority ?? "normal",
    );
    const requested = enumeration(
      b,
      "delivery_mode",
      modes,
      r.requested_mode ?? "auto",
    );
    const mode = await this.routeMode(tx, r, priority, requested);
    const fallback = mode !== "call" && r.call?.state === "ringing";
    if (mode !== "call") await this.endCall(tx, r, "cancelled");
    r.priority = priority;
    r.requested_mode = requested;
    r.delivery_mode = mode;
    let initial = false;
    if (mode === "call" && !r.call) {
      initial = true;
      r.call = {
        id: crypto.randomUUID(),
        request_id: r.id,
        state: "ringing",
        outcome: null,
        device_id: null,
        started_at: iso(this.now()),
        updated_at: iso(this.now()),
        transcript: [],
      };
    }
    await this.save(
      tx,
      r,
      initial ? "initial" : fallback ? "fallback" : "update",
    );
    return { request: r };
  }
  envelope(r: CloudRequest, t?: Turn) {
    return {
      request: r,
      call: r.call,
      ...(t ? { turn: turnView(t), reply: t.reply, resolved: t.resolved } : {}),
    };
  }
  async call(
    tx: Transaction,
    id: string,
    deviceId: string,
    b: Record<string, unknown>,
    voiceToken?: string | null,
  ): Promise<{
    status: number;
    body: { error: { code: string; message: string } } | (ReturnType<CloudService["envelope"]> & {
      reply?: string | null;
      resolved?: boolean;
    });
  }> {
    const event = enumeration(
      b,
      "event",
      ["answer", "decline", "hangup", "turn", "failed"] as const,
      "answer",
    );
    if (!b.event) throw invalid("event is required");
    const r = await this.request(tx, id);
    let turnId: string | null = null,
      text: string | null = null;
    if (event === "turn") {
      turnId = string(b, "turn_id", 36, true);
      text = string(b, "text", 10000, true)!.trim();
      if (!uuid.test(turnId!)) throw invalid("turn_id must be a UUID");
      const previous = await tx.get("turn", turnId!);
      if (previous) {
        if (previous.requestId !== id || previous.deviceId !== deviceId)
          throw missing();
        if (previous.text !== text)
          throw conflict(
            "idempotency_conflict",
            "turn ID was used with different text",
          );
        return {
          status: liveTurn(previous) ? 202 : 200,
          body: this.envelope(r, previous),
        };
      }
    }
    if (r.status !== "pending")
      throw conflict("already_resolved", "request is already closed");
    const c = r.call;
    if (!c || c.state === "ended")
      throw conflict(
        "call_ended",
        "通話は終了しました。テキストで返信できます。",
      );
    if (c.device_id && c.device_id !== deviceId)
      throw conflict("call_claimed", "call was answered on another device");
    if (this.voiceProofRequired && (event === "answer" || event === "turn")) {
      const access = await tx.get("voice_access", deviceId);
      if (!voiceToken || !access || access.expires <= this.now() || access.tokenHash !== hash(voiceToken))
        throw new CloudError(403, "voice_proof_required", "通話を続けるには端末の確認が必要です。");
    }
    if (event === "answer") {
      if (c.state === "ringing") {
        c.state = "active";
        c.device_id = deviceId;
        c.updated_at = iso(this.now());
        c.transcript = [{ role: "assistant", text: r.question }];
        await this.save(tx, r);
      }
      return {
        status: 200,
        body: {
          ...this.envelope(r),
          reply: c.transcript[0]?.text ?? r.question,
          resolved: false,
        },
      };
    }
    if (event !== "turn") {
      if (event === "decline")
        await tx.put("call_cooldown", "declined", { until: this.now() + 5 * 60_000 }, this.now() + 5 * 60_000);
      await this.endCall(
        tx,
        r,
        event === "decline"
          ? "declined"
          : event === "failed"
            ? "failed"
            : "hangup",
        true,
      );
      await this.save(tx, r, "fallback");
      return { status: 200, body: { ...this.envelope(r), resolved: false } };
    }
    if (c.state !== "active")
      throw conflict("call_not_active", "answer the call before speaking");
    if (await this.voiceHammer(tx))
      return { status: 403, body: { error: { code: "account_banned", message: "このアカウントは利用を停止しました。" } } };
    if (liveTurn(c.turn))
      return { status: 409, body: { error: { code: "turn_in_progress", message: "応答を準備しています。少しお待ちください。" } } };
    if (b.async !== true)
      throw conflict(
        "client_upgrade_required",
        "音声通話にはアプリの更新が必要です。テキストで返信できます。",
      );
    const now = this.now();
    const recent = await this.recentVoiceTurns(tx, now);
    if (recent.length >= VOICE_TURNS_PER_HOUR) {
      await this.endCall(tx, r, "failed", true);
      await this.save(tx, r, "fallback");
      return {
        status: 409,
        body: { error: { code: "call_ended", message: "直近1時間の音声利用の上限に達しました。テキストで返信できます。" } },
      };
    }
    if ((c.turn_count ?? 0) >= 30)
      throw conflict("call_too_long", "テキストで会話を続けてください。");
    const oversized = Array.from(text!).length > 2000;
    const fiveMinuteStart = Math.floor(now / 60_000) * 60_000 - 4 * 60_000;
    if (oversized && recent.filter((turn) => turn.oversized && turn.at >= fiveMinuteStart).length >= 2) {
      await tx.put("ban", "current", { at: now, reason: "voice_oversize" });
      return { status: 403, body: { error: { code: "account_banned", message: "このアカウントは利用を停止しました。" } } };
    }
    // Admission, turn creation and the model job commit together. Replays return above.
    recent.push({ at: now, oversized });
    await tx.put("voice_turn_usage", "current", { recent }, now + VOICE_WINDOW_MS);
    c.turn_count = (c.turn_count ?? 0) + 1;
    const t: Turn = {
      id: turnId!,
      requestId: id,
      callId: c.id,
      deviceId,
      text: text!,
      state: "queued",
      reply: null,
      resolved: false,
      error: null,
      deadline: Math.min(now + 90_000, Date.parse(r.expires_at)),
    };
    c.turn = turnView(t);
    c.updated_at = iso(now);
    // Save only once, in the same database transaction as the job. The user text
    // is appended by successful completion, so retries never duplicate history.
    await tx.put("turn", t.id, t);
    await this.save(tx, r, "none");
    await tx.enqueue({
      id: `turn:${t.id}`,
      kind: "turn",
      requestId: id,
      payload: { turnId: t.id },
      deadline: t.deadline,
      available: now,
    });
    return { status: 202, body: this.envelope(r, t) };
  }
  async getTurn(tx: Transaction, id: string, turnId: string, deviceId: string) {
    const r = await this.request(tx, id),
      t = await tx.get("turn", turnId);
    if (!t || t.requestId !== id || t.deviceId !== deviceId) throw missing();
    return this.envelope(r, t);
  }
  async issuePairing(tx: Transaction) {
    await this.quota(tx, "pairing", 20);
    // Capacity is checked when consuming the code: a reinstall may replace a
    // registered phone even when all device slots are occupied.
    const code = secret(),
      expires = this.now() + 600_000;
    await tx.put("pairing", hash(code), { expires, used: false }, expires);
    return { code, expires_at: iso(expires) };
  }
  async pair(b: Record<string, unknown>) {
    const code = string(b, "code", 200, true)!,
      name = string(b, "device_name", 200, true)!;
    const platform = enumeration(
      b,
      "platform",
      ["ios", "android"] as const,
      "ios",
    );
    if (!b.platform) throw invalid("platform is required");
    const token = string(b, "push_token", 4096);
    const clientId = this.pushClientId(b);
    const environment = enumeration(
      b,
      "push_environment",
      ["development", "production"] as const,
      "production",
    );
    const key = hash(code),
      uid = await this.db.findPairing(key);
    const bad = () =>
      new CloudError(
        401,
        "pairing_code_invalid",
        "pairing code is invalid, expired or already used",
      );
    if (!uid) throw bad();
    return this.db.transaction(uid, async (tx) => {
      if (await tx.get("ban", "current"))
        throw new CloudError(403, "account_banned", "このアカウントは利用を停止しました。");
      const pairing = await tx.get("pairing", key);
      if (!pairing || pairing.used || pairing.expires <= this.now())
        throw bad();
      if ((await tx.list("device", {}, 33)).filter(d => !(clientId && d.platform === platform && d.push_client_id === clientId)).length >= 32)
        throw new CloudError(
          429,
          "device_limit",
          "paired device limit reached",
        );
      pairing.used = true;
      await tx.put("pairing", key, pairing, pairing.expires);
      const deviceToken = `kd_${secret()}`;
      const d: Device = {
        id: `dev_${crypto.randomUUID()}`,
        name,
        platform,
        created_at: iso(this.now()),
        tokenHash: hash(deviceToken),
        push_token: token,
        push_client_id: clientId,
        push_registered_at: token ? this.now() : null,
        voip_registered_at: null,
        voip_token: null,
        push_environment: platform === "ios" ? environment : null,
        lastSeen: this.now(),
      };
      await this.clearDuplicatePush(tx, d);
      await tx.claimPush(d);
      await tx.put("device", d.id, d);
      return { device: publicDevice(d), device_token: deviceToken };
    });
  }
  async clearDuplicatePush(tx: Transaction, device: Device) {
    for (const other of await tx.list("device", {}, 33))
      if (other.id !== device.id) {
        let changed = false;
        if (
          device.push_token &&
          other.platform === device.platform &&
          other.push_token === device.push_token
        ) {
          other.push_token = null;
          changed = true;
        }
        if (device.voip_token && other.voip_token === device.voip_token) {
          other.voip_token = null;
          changed = true;
        }
        if (changed) await tx.put("device", other.id, other);
      }
  }
  async updateDevice(
    tx: Transaction,
    deviceId: string,
    b: Record<string, unknown>,
  ) {
    const d = await tx.get("device", deviceId);
    if (!d) throw unauthorized();
    const clientId = this.pushClientId(b);
    if (clientId && d.push_client_id && d.push_client_id !== clientId) throw invalid("push_client_id cannot change within a pairing");
    if (clientId) d.push_client_id = clientId;
    await this.quota(tx, "device_update", 120);
    if (b.device_name !== undefined)
      d.name = string(b, "device_name", 200, true)!;
    if (b.push_token !== undefined) {
      d.push_token = string(b, "push_token", 4096) || null;
      d.push_registered_at = d.push_token ? this.now() : null;
    }
    if (b.voip_token !== undefined) {
      d.voip_token = string(b, "voip_token", 4096) || null;
      d.voip_registered_at = d.voip_token ? this.now() : null;
      if (d.voip_token && d.platform !== "ios")
        throw invalid("VoIP token is only supported on iOS");
    }
    if (b.push_environment !== undefined && d.platform === "ios")
      d.push_environment = enumeration(
        b,
        "push_environment",
        ["development", "production"] as const,
        "production",
      );
    const fields = (["push_token", "voip_token"] as const).filter(
      (field) => b[field] !== undefined || b.push_environment !== undefined,
    );
    await this.clearDuplicatePush(tx, d);
    await tx.claimPush(d, fields);
    await tx.put("device", d.id, d);
    return { device: publicDevice(d) };
  }

  private pushClientId(b: Record<string, unknown>): string | undefined {
    if (b.push_client_id == null) return undefined;
    if (!validPushClientId(b.push_client_id)) throw invalid("invalid push_client_id");
    return b.push_client_id;
  }

  async prunePush(tx: Transaction, d: Device) {
    let changed = false;
    for (const field of PUSH_FIELDS) {
      const timestamp = registrationField(field);
      if (d[field] && d[timestamp] == null) {
        d[timestamp] = d.lastSeen ?? Date.parse(d.created_at);
        changed = true;
      }
      if (d[field] && !freshPushRegistration(d[timestamp]!, this.now())) {
        d[field] = null;
        d[timestamp] = null;
        changed = true;
      }
    }
    if (changed) await tx.put("device", d.id, d);
  }
  async presence(tx: Transaction, p: Principal) {
    const devices = await tx.list("device", {}, 33);
    const stored = await tx.list("presence", {}, 33);
    return {
      devices: devices
        .filter((d) => p.role === "agent" || p.deviceId === d.id)
        .map((d) => {
          const v = stored.find((x) => x.device_id === d.id);
          return {
            device_id: d.id,
            availability:
              v && (!v.until || Date.parse(v.until) > this.now())
                ? v.availability
                : "available",
            until: v?.until ?? null,
            note: v?.note ?? null,
            updated_at: v?.updated_at ?? d.created_at,
            last_seen_at: iso(d.lastSeen),
          };
        }),
      recent_events:
        p.role === "agent" ? await tx.list("feedback", {}, 100) : [],
      now: iso(this.now()),
      ...(p.role === "agent" && (await this.voiceTraining(tx))
        ? { voice_training: true }
        : {}),
    };
  }
  async putPresence(
    tx: Transaction,
    deviceId: string,
    b: Record<string, unknown>,
  ) {
    await this.quota(tx, "presence", 120);
    const availability = enumeration(
      b,
      "availability",
      ["available", "busy", "away"] as const,
      "available",
    );
    if (!b.availability) throw invalid("availability is required");
    const until = string(b, "until", 100),
      note = string(b, "note", 500);
    if (
      until &&
      (!Number.isFinite(Date.parse(until)) ||
        Date.parse(until) <= this.now() ||
        Date.parse(until) > this.now() + 7 * 86400_000)
    )
      throw invalid("until must be a future ISO8601 date within seven days");
    const v = {
      device_id: deviceId,
      availability,
      until,
      note,
      updated_at: iso(this.now()),
      last_seen_at: iso(this.now()),
    };
    await tx.put("presence", deviceId, v);
    if (availability !== "available")
      for (const r of await tx.list("request", { status: "pending" }, 201))
        if (r.call?.state === "ringing") {
          await this.endCall(tx, r, "declined", true);
          await this.save(tx, r, "fallback");
        }
    return { presence: v };
  }
}
