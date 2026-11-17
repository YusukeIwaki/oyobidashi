import { describe, expect, test } from "bun:test";
import { harness } from "./helpers.ts";
import { JobWorker, WorkerPool } from "../src/worker.ts";
import type { ConversationResult } from "../../relay/src/conversation.ts";
import type { Device, Job } from "../src/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await Bun.sleep(1);
  }
}
async function drainPush(worker: JobWorker) {
  for (let n = 0; n < 1000; n++) {
    if (!(await worker.runOnce("push"))) return;
  }
  throw new Error("push queue did not drain within the test bound");
}

describe("cloud recovery regressions", () => {
  test("re-pairing the same push destination to a new user blocks old-user queued and future notifications", async () => {
    const h = harness(),
      sent: string[] = [];
    const pairWithToken = async (uid: string) => {
      const issued = await h.call("POST", "/v1/pairing-codes", `agent-${uid}`);
      expect(issued.status).toBe(201);
      const paired = await h.call("POST", "/v1/pair", null, {
        code: issued.body.code,
        device_name: "same phone",
        platform: "ios",
        push_token: "synthetic-physical-app-token",
      });
      expect(paired.status).toBe(201);
      return paired.body;
    };
    await pairWithToken("alice");
    const oldQueued = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "old owner queued",
    });
    expect(oldQueued.status).toBe(201);
    await pairWithToken("bob"); // Alice's best-effort DELETE was lost during account switch.
    const oldFuture = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "old owner future",
    });
    const current = await h.call("POST", "/v1/requests", "agent-bob", {
      question: "current owner",
    });
    expect(oldFuture.status).toBe(201);
    expect(current.status).toBe(201);
    const worker = new JobWorker(h.service, {
      push: {
        ios: {
          send: async (_target, request) => {
            sent.push(request.id);
            return { ok: true };
          },
        },
      },
    });
    await drainPush(worker);
    expect(sent).toEqual([current.body.request.id]);
    expect(sent).not.toContain(oldQueued.body.request.id);
    expect(sent).not.toContain(oldFuture.body.request.id);
  });

  test("a reconnect hello includes every pending question beyond the recent history window", async () => {
    const h = harness(),
      device = await h.pair();
    const old = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "old but unanswered",
      expires_in_seconds: 86400,
    });
    expect(old.status).toBe(201);
    for (let i = 0; i < 205; i++) {
      if (i % 50 === 0) h.advance(61_000);
      const note = await h.call("POST", "/v1/requests", "agent-alice", {
        kind: "notification",
        question: "recent notification",
      });
      expect(note.status).toBe(201);
    }
    const frames: { type: string; pending?: { id: string }[] }[] = [];
    const socket = {
      data: {
        principal: (await h.devicePrincipal(device.device_token)) as {
          uid: string;
          role: "device";
          deviceId: string;
          tokenHash: string;
        },
        seen: new Map<string, number>(),
        ready: false,
        closed: false,
      },
      send(data: string) {
        frames.push(JSON.parse(data));
        return 1;
      },
      close() {},
      ping() {
        return 1;
      },
    };
    try {
      await h.app.open(socket);
      expect(frames[0]?.type).toBe("hello");
      expect(frames[0]?.pending?.map((r) => r.id)).toContain(
        old.body.request.id,
      );
      expect(frames[0]?.pending).toHaveLength(1);
    } finally {
      h.app.close();
    }
  });

  test("pool stop waits for an in-flight claim and never starts model work after draining begins", async () => {
    const h = harness(),
      setup = await h.setup();
    await setup.turn();
    const gate = deferred<void>();
    let claimEntered = false,
      modelCalls = 0;
    const original = h.db.claim.bind(h.db);
    h.db.claim = async (kind: Job["kind"], now: number, leaseMs: number) => {
      if (kind === "turn") {
        claimEntered = true;
        await gate.promise;
      }
      return original(kind, now, leaseMs);
    };
    const worker = new JobWorker(h.service, {
      conversation: {
        turn: async () => {
          modelCalls++;
          return new Promise<ConversationResult>(() => {});
        },
      },
    });
    const pool = new WorkerPool(worker, { turn: 1, push: 1 });
    const pumping = pool.tick();
    await until(() => claimEntered);
    let stopped = false;
    const stopping = pool.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(1);
    // stop may await the claim, or arrange to release it without executing it.
    gate.resolve();
    await pumping;
    await stopping;
    await Bun.sleep(1);
    try {
      expect(stopped).toBe(true);
      expect(modelCalls).toBe(0);
      expect(pool.active).toBe(0);
    } finally {
      // Defensive cleanup when running against an implementation with the race.
      worker.abort();
      await pool.stop();
    }
  });

  test("a priority update before first delivery retains a visible alert", async () => {
    const h = harness(),
      device = await h.pair(),
      sent: string[] = [];
    await h.call("PUT", "/v1/devices/me", device.device_token, {
      push_token: "synthetic-alert-token",
    });
    const created = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "needs a visible notification",
      delivery_mode: "text",
    });
    expect(created.status).toBe(201);
    const updated = await h.call(
      "PATCH",
      `/v1/requests/${created.body.request.id}`,
      "agent-alice",
      { priority: "high" },
    );
    expect(updated.status).toBe(200);
    const worker = new JobWorker(h.service, {
      push: {
        ios: {
          send: async (target, request) => {
            sent.push(target.type ?? "alert");
            expect(request.priority).toBe("high");
            return { ok: true };
          },
        },
      },
    });
    await drainPush(worker);
    expect(sent.filter((type) => type === "alert")).toHaveLength(1);
  });

  test("notification overload rejects atomically and recovers in the next quota window", async () => {
    const h = harness(),
      device = await h.pair();
    await h.call("PUT", "/v1/devices/me", device.device_token, {
      push_token: "synthetic-quota-token",
    });
    for (let i = 0; i < 60; i++)
      expect(
        (
          await h.call("POST", "/v1/requests", "agent-alice", {
            kind: "notification",
            question: "notification",
          })
        ).status,
      ).toBe(201);
    const rejected = await h.call("POST", "/v1/requests", "agent-alice", {
      kind: "notification",
      question: "over quota",
    });
    expect(rejected.status).toBe(429);
    expect(rejected.body.error.code).toBe("rate_limited");
    const before = await h.db.transaction("alice", (tx) =>
      tx.list("request", {}, 200),
    );
    expect(before).toHaveLength(60);
    h.advance(61_000);
    expect(
      (
        await h.call("POST", "/v1/requests", "agent-alice", {
          kind: "notification",
          question: "next window",
        })
      ).status,
    ).toBe(201);
    const after = await h.db.transaction("alice", (tx) =>
      tx.list("request", {}, 200),
    );
    expect(after).toHaveLength(61);
    const other = await h.call("POST", "/v1/requests", "agent-bob", {
      kind: "notification",
      question: "independent quota",
    });
    expect(other.status).toBe(201);
    const ds = await h.db.transaction("alice", (tx) => tx.list("device"));
    expect(ds).toHaveLength(1);
    expect(ds[0] as Device).toMatchObject({ id: device.device.id });
  });
});
