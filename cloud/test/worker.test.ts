import { describe, expect, test } from "bun:test";
import { harness } from "./helpers.ts";
import { MemoryDatabase } from "./memory.ts";
import { JobWorker, WorkerPool } from "../src/worker.ts";
import { ProviderFailure } from "../src/provider.ts";
import type {
  ConversationProvider,
  ConversationResult,
} from "../../relay/src/conversation.ts";

const result = {
  reply: "承知しました。お伝えします。",
  resolved: true,
  answer: "進めてください",
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition did not become true");
    await Bun.sleep(1);
  }
}

describe("leased voice jobs", () => {
  test("identical client turn UUIDs from two users enqueue independent jobs", async () => {
    const h = harness(),
      a = await h.setup(),
      b = await h.setup("bob"),
      id = crypto.randomUUID();
    expect((await a.turn("alice answer", id)).status).toBe(202);
    expect((await b.turn("bob answer", id)).status).toBe(202);
    const worker = new JobWorker(h.service, {
      conversation: {
        turn: async (request) => ({
          reply: "ok",
          resolved: true,
          answer: request.question,
        }),
      },
    });
    expect(await worker.runOnce("turn")).toBe(true);
    expect(await worker.runOnce("turn")).toBe(true);
    expect((await h.turn(id, "alice"))!.state).toBe("completed");
    expect((await h.turn(id, "bob"))!.state).toBe("completed");
  });
  test("a completed result survives worker replacement and duplicate POST", async () => {
    const h = harness(),
      s = await h.setup(),
      t = await s.turn();
    const worker = new JobWorker(h.service, {
      conversation: { turn: async () => result },
    });
    expect(await worker.runOnce("turn")).toBe(true);
    expect(worker.active).toBe(0);
    expect((await h.turn(t.turnId))!.state).toBe("completed");
    const response = await s.turn("はい", t.turnId);
    expect(response.status).toBe(200);
    expect(response.body.reply).toBe(result.reply);
    expect(response.body.request.status).toBe("answered");
    expect(
      response.body.call.transcript.map((x: { role: string }) => x.role),
    ).toEqual(["assistant", "user", "assistant"]);
    expect(await new JobWorker(h.service).runOnce("turn")).toBe(false);
  });
  test("worker crash before execution lets a new worker recover after lease expiry", async () => {
    const h = harness(),
      s = await h.setup(),
      t = await s.turn();
    const abandoned = await h.db.claim("turn", h.clock.now, 100);
    expect(abandoned).not.toBeNull();
    expect(await h.db.claim("turn", h.clock.now, 100)).toBeNull();
    h.advance(101);
    const worker = new JobWorker(h.service, {
      conversation: { turn: async () => result },
    });
    await worker.runOnce("turn");
    expect((await h.turn(t.turnId))!.state).toBe("completed");
  });
  test("an old worker returning after takeover cannot overwrite a newer result", async () => {
    const h = harness(),
      s = await h.setup(),
      t = await s.turn(),
      gate = deferred<ConversationResult>();
    const old = new JobWorker(h.service, {
      leaseMs: 100,
      heartbeatMs: 999_999,
      conversation: { turn: () => gate.promise },
    });
    const running = old.runOnce("turn");
    await until(() => old.active === 1);
    await until(() =>
      [...(h.db as MemoryDatabase).records.values()].some(
        (r) =>
          r.kind === "turn" && (r.doc as { state: string }).state === "running",
      ),
    );
    h.advance(101);
    await new JobWorker(h.service, {
      conversation: { turn: async () => ({ ...result, reply: "new worker" }) },
    }).runOnce("turn");
    gate.resolve({ ...result, reply: "stale worker" });
    await running;
    expect((await h.turn(t.turnId))!.reply).toBe("new worker");
  });
  for (const action of ["hangup", "cancel", "text", "expire"] as const)
    test(`late model completion after ${action} cannot resolve the request`, async () => {
      const h = harness(),
        s = await h.setup(),
        t = await s.turn(),
        gate = deferred<ConversationResult>();
      let entered = false;
      const worker = new JobWorker(h.service, {
        conversation: {
          turn: () => {
            entered = true;
            return gate.promise;
          },
        },
      });
      const pending = worker.runOnce("turn");
      await until(() => entered);
      if (action === "cancel")
        await h.call("POST", `/v1/requests/${s.id}/cancel`);
      else if (action === "text")
        await h.call("POST", `/v1/requests/${s.id}/answer`, s.d.device_token, {
          text: "text wins",
        });
      else if (action === "expire") {
        h.advance(3600_001);
        await h.db.transaction("alice", (tx) => h.service.reconcile(tx));
      } else
        await h.call("POST", `/v1/requests/${s.id}/call`, s.d.device_token, {
          event: "hangup",
        });
      gate.resolve(result);
      await pending;
      expect((await h.turn(t.turnId))!.state).toBe("cancelled");
      const r = (await h.call("GET", `/v1/requests/${s.id}`)).body.request;
      expect(r.status).toBe(
        action === "cancel"
          ? "cancelled"
          : action === "text"
            ? "answered"
            : action === "expire"
              ? "expired"
              : "pending",
      );
      expect(r.answer?.text).not.toBe(result.answer);
    });
  test("retryable provider failure backs off without changing transcript", async () => {
    const h = harness(),
      s = await h.setup(),
      t = await s.turn();
    let attempts = 0;
    const worker = new JobWorker(h.service, {
      conversation: {
        turn: async () => {
          if (++attempts === 1) throw new ProviderFailure(true);
          return result;
        },
      },
    });
    await worker.runOnce("turn");
    expect((await h.turn(t.turnId))!.state).toBe("queued");
    expect(await worker.runOnce("turn")).toBe(false);
    h.advance(501);
    await worker.runOnce("turn");
    expect((await h.turn(t.turnId))!.state).toBe("completed");
    expect(attempts).toBe(2);
    expect(
      (await h.call("GET", `/v1/requests/${s.id}`)).body.request.call
        .transcript,
    ).toHaveLength(3);
  });
  test("attempt exhaustion becomes explicit failure and permits an explicit new utterance", async () => {
    const h = harness(),
      s = await h.setup(),
      t = await s.turn();
    const worker = new JobWorker(h.service, {
      maxAttempts: 2,
      conversation: {
        turn: async () => {
          throw new ProviderFailure(true);
        },
      },
    });
    await worker.runOnce("turn");
    h.advance(501);
    await worker.runOnce("turn");
    expect((await h.turn(t.turnId))!.state).toBe("failed");
    expect(
      (await h.call("GET", `/v1/requests/${s.id}`)).body.request.status,
    ).toBe("pending");
    expect((await s.turn("もう一度")).status).toBe(202);
  });
  test("invalid or nonretryable model output fails closed without invented answers", async () => {
    const h = harness(),
      s = await h.setup(),
      t = await s.turn();
    await new JobWorker(h.service, {
      conversation: {
        turn: async () => ({ reply: "ok", resolved: true, answer: null }),
      },
    }).runOnce("turn");
    expect((await h.turn(t.turnId))!.state).toBe("failed");
    expect(
      (await h.call("GET", `/v1/requests/${s.id}`)).body.request.answer,
    ).toBeNull();
  });
  test("a queued turn times out even when every worker is offline", async () => {
    const h = harness(),
      s = await h.setup(),
      t = await s.turn();
    h.advance(90_001);
    expect(
      (
        await h.call(
          "GET",
          `/v1/requests/${s.id}/turns/${t.turnId}`,
          s.d.device_token,
        )
      ).body.turn.state,
    ).toBe("failed");
    expect((await s.turn("retry")).status).toBe(202);
  });
  test("graceful worker shutdown requeues the turn rather than failing the call", async () => {
    const h = harness(),
      s = await h.setup(),
      t = await s.turn();
    let entered = false;
    const worker = new JobWorker(h.service, {
      conversation: {
        turn: async () => {
          entered = true;
          return new Promise(() => {});
        },
      },
    });
    const running = worker.runOnce("turn");
    await until(() => entered);
    worker.abort();
    await running;
    expect(worker.active).toBe(0);
    expect((await h.turn(t.turnId))!.state).toBe("queued");
    await new JobWorker(h.service, {
      conversation: { turn: async () => result },
    }).runOnce("turn");
    expect((await h.turn(t.turnId))!.state).toBe("completed");
  });
  test("a provider ignoring AbortSignal cannot retain the worker slot after shutdown", async () => {
    const h = harness(),
      s = await h.setup();
    await s.turn();
    const worker = new JobWorker(h.service, {
      conversation: { turn: () => new Promise(() => {}) },
    });
    const running = worker.runOnce("turn");
    await until(() => worker.active === 1);
    await Bun.sleep(1);
    worker.abort();
    await running;
    expect(worker.active).toBe(0);
  });
  test("pool bounds active LLM work and keeps separate push capacity", async () => {
    const h = harness(),
      gate = deferred<ConversationResult>();
    let entered = 0;
    for (const uid of ["alice", "bob", "charlie"]) {
      const s = await h.setup(uid);
      await s.turn();
    }
    const provider: ConversationProvider = {
      turn: () => {
        entered++;
        return gate.promise;
      },
    };
    const pool = new WorkerPool(
      new JobWorker(h.service, { conversation: provider }),
      { turn: 2, push: 1 },
    );
    await pool.tick();
    await until(() => entered === 2);
    expect(pool.active).toBeLessThanOrEqual(3);
    await pool.tick();
    expect(entered).toBe(2);
    gate.resolve(result);
    await until(() => pool.active === 0);
    await pool.tick();
    await until(() => entered === 3);
    await pool.stop();
  });
});

describe("durable push jobs", () => {
  test("crash/retry reuses durable push work, revocation removes dead token only", async () => {
    const h = harness(),
      d = await h.pair();
    await h.call("PUT", "/v1/devices/me", d.device_token, {
      push_token: "dead",
      voip_token: "keep",
    });
    await h.call("POST", "/v1/requests", "agent-alice", { question: "q" });
    let attempts = 0;
    const worker = new JobWorker(h.service, {
      push: {
        ios: {
          send: async () => {
            attempts++;
            return { ok: false, unregistered: true, reason: "UNREGISTERED" };
          },
        },
      },
    });
    await worker.runOnce("push");
    expect(attempts).toBe(1);
    const stored = await h.db.transaction("alice", (tx) =>
      tx.get("device", d.device.id),
    );
    expect(stored!.push_token).toBeNull();
    expect(stored!.voip_token).toBe("keep");
  });
  test("a cancelled ringing call never sends an old VoIP push", async () => {
    const h = harness(),
      d = await h.pair();
    await h.call("PUT", "/v1/devices/me", d.device_token, {
      voip_token: "voip",
      push_token: "normal",
    });
    const r = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "q",
      priority: "urgent",
      delivery_mode: "call",
    });
    await h.call("POST", `/v1/requests/${r.body.request.id}/cancel`);
    const sent: string[] = [];
    const worker = new JobWorker(h.service, {
      push: {
        ios: {
          send: async (target) => {
            sent.push(target.type!);
            return { ok: true };
          },
        },
      },
    });
    while (await worker.runOnce("push")) {}
    expect(sent).toEqual(["update"]);
  });
  test("push failure retries with a deadline, without rolling back the question", async () => {
    const h = harness(),
      d = await h.pair();
    await h.call("PUT", "/v1/devices/me", d.device_token, {
      push_token: "normal",
    });
    const r = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "q",
    });
    let calls = 0;
    const worker = new JobWorker(h.service, {
      push: {
        ios: {
          send: async () => {
            if (++calls === 1) throw new Error("network");
            return { ok: true };
          },
        },
      },
    });
    await worker.runOnce("push");
    expect(await worker.runOnce("push")).toBe(false);
    h.advance(1001);
    await worker.runOnce("push");
    expect(calls).toBe(2);
    expect(
      (await h.call("GET", `/v1/requests/${r.body.request.id}`)).body.request
        .status,
    ).toBe("pending");
  });
  test("a rotated token is not cleared by an old in-flight invalid-token response", async () => {
    const h = harness(),
      d = await h.pair();
    await h.call("PUT", "/v1/devices/me", d.device_token, {
      push_token: "old",
    });
    await h.call("POST", "/v1/requests", "agent-alice", { question: "q" });
    const gate = deferred<any>();
    let entered = false;
    const worker = new JobWorker(h.service, {
      push: {
        ios: {
          send: async () => {
            entered = true;
            return gate.promise;
          },
        },
      },
    });
    const running = worker.runOnce("push");
    await until(() => entered);
    await h.call("PUT", "/v1/devices/me", d.device_token, {
      push_token: "new",
    });
    gate.resolve({ ok: false, unregistered: true, reason: "unregistered" });
    await running;
    expect(
      (await h.db.transaction("alice", (tx) => tx.get("device", d.device.id)))!
        .push_token,
    ).toBe("new");
  });
});
