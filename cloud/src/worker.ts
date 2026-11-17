import type {
  ConversationProvider,
  ConversationResult,
} from "../../relay/src/conversation.ts";
import { validateConversationResult } from "../../relay/src/conversation.ts";
import type { PushProviders } from "../../relay/src/push/types.ts";
import { ProviderFailure } from "./provider.ts";
import { CloudService, hash } from "./service.ts";
import {
  iso,
  liveTurn,
  turnView,
  type Job,
  type Transaction,
  type Turn,
  type CloudRequest,
} from "./types.ts";

/** Timeout/abort also frees a slot if a misbehaving provider ignores its signal. */
export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new Error("operation aborted");
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(new Error("operation aborted"));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

export interface WorkerOptions {
  conversation?: ConversationProvider;
  push?: PushProviders;
  leaseMs?: number;
  heartbeatMs?: number;
  pushTimeoutMs?: number;
  maxAttempts?: number;
  publicOrigin?: string;
}
export class JobWorker {
  readonly leaseMs: number;
  private controllers = new Set<AbortController>();
  constructor(
    readonly service: CloudService,
    readonly options: WorkerOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 15_000;
  }
  get active() {
    return this.controllers.size;
  }
  async runOnce(kind: Job["kind"]): Promise<boolean> {
    const job = await this.service.db.claim(
      kind,
      this.service.now(),
      this.leaseMs,
    );
    if (!job) return false;
    await this.execute(job);
    return true;
  }
  private valid(current: Job | null, j: Job) {
    return (
      !!current &&
      current.state === "leased" &&
      current.leaseToken === j.leaseToken &&
      (current.leaseUntil ?? 0) > this.service.now()
    );
  }
  private async fenced<T>(
    j: Job,
    fn: (tx: Transaction, current: Job) => Promise<T>,
  ) {
    return this.service.db.transaction(j.uid, async (tx) => {
      const current = await tx.job(j.id);
      if (!this.valid(current, j)) return null;
      return fn(tx, current!);
    });
  }
  private async done(tx: Transaction, j: Job) {
    j.state = "done";
    j.leaseUntil = null;
    j.leaseToken = null;
    await tx.saveJob(j);
  }
  private async failTurn(tx: Transaction, r: CloudRequest, t: Turn) {
    t.state = "failed";
    t.error = {
      code: "conversation_failed",
      message:
        "音声の応答を取得できませんでした。再試行するか、テキストで返信してください。",
    };
    await tx.put("turn", t.id, t, this.service.now() + 30 * 86400_000);
    if (r.call?.id === t.callId && r.call.turn?.id === t.id) {
      r.call.turn = turnView(t);
      await this.service.save(tx, r, "none");
    }
  }
  async execute(j: Job) {
    const controller = new AbortController();
    this.controllers.add(controller);
    let beating = false;
    const heartbeat = setInterval(
      () => {
        if (beating || controller.signal.aborted) return;
        beating = true;
        void this.fenced(j, async (tx, current) => {
          const r = await tx.get("request", j.requestId);
          const t =
            j.kind === "turn" && j.payload.turnId
              ? await tx.get("turn", j.payload.turnId)
              : null;
          if (
            j.kind === "turn" &&
            (!r ||
              r.status !== "pending" ||
              r.call?.state !== "active" ||
              !t ||
              !liveTurn(t))
          ) {
            controller.abort();
            return false;
          }
          current.leaseUntil = this.service.now() + this.leaseMs;
          await tx.saveJob(current);
          return true;
        })
          .then(
            (valid) => {
              if (!valid) controller.abort();
            },
            () => controller.abort(),
          )
          .finally(() => {
            beating = false;
          });
      },
      this.options.heartbeatMs ?? Math.max(1000, Math.floor(this.leaseMs / 3)),
    );
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(
        1,
        Math.min(
          j.deadline - this.service.now(),
          j.kind === "push" ? (this.options.pushTimeoutMs ?? 15_000) : 90_000,
        ),
      ),
    );
    try {
      if (j.kind === "turn") await this.turn(j, controller.signal);
      else await this.push(j, controller.signal);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timer);
      this.controllers.delete(controller);
      void this.service.wake(j.uid);
    }
  }
  private async turn(j: Job, signal: AbortSignal) {
    const input = await this.fenced(j, async (tx, current) => {
      await this.service.reconcile(tx);
      const r = await tx.get("request", j.requestId);
      const t = j.payload.turnId
        ? await tx.get("turn", j.payload.turnId)
        : null;
      if (
        !r ||
        !t ||
        !liveTurn(t) ||
        r.status !== "pending" ||
        r.call?.state !== "active" ||
        r.call.id !== t.callId ||
        r.call.device_id !== t.deviceId
      ) {
        await this.done(tx, current);
        return null;
      }
      if (
        t.deadline <= this.service.now() ||
        current.attempts > (this.options.maxAttempts ?? 3)
      ) {
        await this.failTurn(tx, r, t);
        await this.done(tx, current);
        return null;
      }
      t.state = "running";
      r.call.turn = turnView(t);
      await tx.put("turn", t.id, t);
      await this.service.save(tx, r, "none");
      return {
        r,
        t,
        call: {
          ...r.call,
          transcript: [
            ...r.call.transcript,
            { role: "user" as const, text: t.text },
          ],
        },
      };
    });
    if (!input) return;
    let result: ConversationResult | undefined, error: unknown;
    try {
      if (!this.options.conversation) throw new ProviderFailure(false);
      result = validateConversationResult(
        await abortable(
          this.options.conversation.turn(input.r, input.call, signal),
          signal,
        ),
      );
    } catch (e) {
      error = e;
    }
    await this.fenced(j, async (tx, current) => {
      await this.service.reconcile(tx);
      const r = await tx.get("request", j.requestId),
        t = await tx.get("turn", input.t.id);
      if (
        !r ||
        !t ||
        !liveTurn(t) ||
        r.status !== "pending" ||
        r.call?.state !== "active" ||
        r.call.id !== t.callId ||
        r.call.device_id !== t.deviceId ||
        r.call.turn?.id !== t.id
      ) {
        await this.done(tx, current);
        return;
      }
      const now = this.service.now();
      if (signal.aborted && signal.reason === "shutdown" && t.deadline > now) {
        current.state = "ready";
        current.available = now;
        current.leaseToken = null;
        current.leaseUntil = null;
        current.attempts = Math.max(0, current.attempts - 1);
        t.state = "queued";
        r.call.turn = turnView(t);
        await tx.put("turn", t.id, t);
        await this.service.save(tx, r, "none");
        await tx.saveJob(current);
        return;
      }
      if (error || !result || signal.aborted || t.deadline <= now) {
        const delay = Math.max(
          error instanceof ProviderFailure ? error.retryAfterMs : 0,
          500 * 2 ** (current.attempts - 1),
        );
        if (
          error instanceof ProviderFailure &&
          error.retryable &&
          !signal.aborted &&
          current.attempts < (this.options.maxAttempts ?? 3) &&
          now + delay < t.deadline
        ) {
          current.state = "ready";
          current.available = now + delay;
          current.leaseToken = null;
          current.leaseUntil = null;
          t.state = "queued";
          r.call.turn = turnView(t);
          await tx.put("turn", t.id, t);
          await this.service.save(tx, r, "none");
          await tx.saveJob(current);
        } else {
          await this.failTurn(tx, r, t);
          await this.done(tx, current);
        }
        return;
      }
      t.state = "completed";
      t.reply = result.reply;
      t.resolved = result.resolved;
      t.error = null;
      await tx.put("turn", t.id, t, this.service.now() + 30 * 86400_000);
      r.call.turn = turnView(t);
      r.call.transcript = [
        ...input.call.transcript,
        { role: "assistant", text: result.reply },
      ];
      r.call.updated_at = iso(now);
      if (result.resolved) {
        r.status = "answered";
        r.answer = {
          text: result.answer!,
          choice_index: null,
          input_method: "voice",
          device_id: t.deviceId,
          answered_at: iso(now),
        };
        await this.service.endCall(tx, r, "resolved");
      }
      await this.service.save(tx, r, result.resolved ? "update" : "none");
      await this.done(tx, current);
    });
  }
  private async push(j: Job, signal: AbortSignal) {
    const input = await this.fenced(j, async (tx, current) => {
      await this.service.reconcile(tx);
      const r = await tx.get("request", j.requestId),
        d = j.payload.deviceId
          ? await tx.get("device", j.payload.deviceId)
          : null;
      if (
        !r ||
        !d ||
        j.deadline <= this.service.now() ||
        (j.payload.update && j.payload.version !== r.version)
      ) {
        await this.done(tx, current);
        return null;
      }
      const update = j.payload.update === true;
      if (
        !update &&
        (!["pending", "notified"].includes(r.status) ||
          (j.payload.mode === "call" && r.delivery_mode !== "call") ||
          (j.payload.mode === "text" && r.delivery_mode === "call"))
      ) {
        await this.done(tx, current);
        return null;
      }
      const voip =
        !update &&
        r.delivery_mode === "call" &&
        r.call?.state === "ringing" &&
        d.platform === "ios";
      if (
        !update &&
        r.delivery_mode === "call" &&
        r.call?.state !== "ringing"
      ) {
        await this.done(tx, current);
        return null;
      }
      const token = voip ? d.voip_token : d.push_token;
      if (
        !token ||
        !this.options.push?.[d.platform] ||
        !(await tx.ownsPush(d, voip ? "voip_token" : "push_token"))
      ) {
        await this.done(tx, current);
        return null;
      }
      // Never put transcript/turn contents in push payloads.
      const safe = {
        ...r,
        // The short subject is intended for the native incoming call screen.
        // Ordinary notifications still retrieve all content via scoped previews.
        subject: voip ? r.subject ?? null : null,
        question: "新しい質問が届いています。アプリでご確認ください。",
        context: null,
        choices: null,
        agent: null,
        recipient_device_id: d.id,
        call: r.call ? { ...r.call, transcript: [], turn: undefined } : null,
      };
      let preview: {} | { preview_url: string; preview_token: string } = {};
      if (!update && this.options.publicOrigin) {
        const previewToken = `kp_${crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true })}`;
        const expires = this.service.now() + 300_000;
        await tx.put(
          "preview",
          hash(previewToken),
          {
            requestId: r.id,
            deviceId: d.id,
            field: voip ? "voip_token" : "push_token",
            expires,
          },
          expires,
        );
        preview = {
          preview_url: `${this.options.publicOrigin}/v1/previews/${r.id}`,
          preview_token: previewToken,
        };
      }
      return {
        r: { ...safe, ...preview },
        d,
        token,
        type: voip
          ? ("voip" as const)
          : update
            ? ("update" as const)
            : ("alert" as const),
      };
    });
    if (!input) return;
    let retry = false,
      unregistered = false;
    try {
      const result = await abortable(
        this.options.push![input.d.platform]!.send(
          {
            token: input.token,
            type: input.type,
            environment: input.d.push_environment,
          },
          input.r,
        ),
        signal,
      );
      if (!result.ok) {
        unregistered = result.unregistered;
        retry = !unregistered;
      }
    } catch {
      retry = true;
    }
    await this.fenced(j, async (tx, current) => {
      if (unregistered) {
        const d = await tx.get("device", input.d.id);
        if (d) {
          const field = input.type === "voip" ? "voip_token" : "push_token";
          if (d[field] === input.token) {
            d[field] = null;
            await tx.put("device", d.id, d);
          }
        }
      }
      const delay = 1000 * 2 ** (current.attempts - 1);
      if (
        retry &&
        current.attempts < (this.options.maxAttempts ?? 3) &&
        this.service.now() + delay < current.deadline
      ) {
        current.state = "ready";
        current.available = this.service.now() + delay;
        current.leaseToken = null;
        current.leaseUntil = null;
        await tx.saveJob(current);
      } else await this.done(tx, current);
    });
  }
  abort() {
    for (const c of this.controllers) c.abort("shutdown");
  }
}

/** One idle poll per pool, rather than one poll/timer per user or slot. */
export class WorkerPool {
  private tasks = new Set<Promise<void>>();
  private counts = { turn: 0, push: 0 };
  private pumping = false;
  private stopped = false;
  private pumpDone: Promise<void> = Promise.resolve();
  private finishPump: (() => void) | null = null;
  constructor(
    readonly worker: JobWorker,
    readonly concurrency = { turn: 8, push: 4 },
  ) {}
  get active() {
    return this.tasks.size;
  }
  async tick() {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    this.pumpDone = new Promise((resolve) => {
      this.finishPump = resolve;
    });
    try {
      for (const kind of ["push", "turn"] as const)
        while (!this.stopped && this.counts[kind] < this.concurrency[kind]) {
          const j = await this.worker.service.db.claim(
            kind,
            this.worker.service.now(),
            this.worker.leaseMs,
          );
          if (!j) break;
          if (this.stopped) {
            await this.worker.service.db.transaction(j.uid, async (tx) => {
              const current = await tx.job(j.id);
              if (current?.leaseToken === j.leaseToken) {
                current.state = "ready";
                current.leaseToken = null;
                current.leaseUntil = null;
                current.attempts = Math.max(0, current.attempts - 1);
                await tx.saveJob(current);
              }
            });
            break;
          }
          this.counts[kind]++;
          const task = this.worker
            .execute(j)
            .catch(() => {
              /* lease expiration recovers database failures */
            })
            .finally(() => {
              this.counts[kind]--;
              this.tasks.delete(task);
            });
          this.tasks.add(task);
        }
    } finally {
      this.pumping = false;
      this.finishPump?.();
      this.finishPump = null;
    }
  }
  async stop() {
    this.stopped = true;
    this.worker.abort();
    await this.pumpDone;
    this.worker.abort();
    await Promise.allSettled([...this.tasks]);
  }
}
