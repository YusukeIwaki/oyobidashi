import { describe, expect, test } from "bun:test";
import { CloudApp, type Socket } from "../src/app.ts";
import { LocalWakeBus } from "../src/bus.ts";
import { CloudService, hash } from "../src/service.ts";
import type { CloudRequest, Device, Transaction } from "../src/types.ts";
import { JobWorker, WorkerPool } from "../src/worker.ts";
import { MemoryDatabase } from "./memory.ts";

/** Counts work at database boundaries; it does not simulate hardware throughput. */
class ObservedDatabase extends MemoryDatabase {
  revisionBatches: string[][] = [];
  snapshotOwners: string[] = [];
  concurrentSnapshots = 0;
  peakSnapshots = 0;
  observe = false;
  override async revisions(uids: string[]) {
    this.revisionBatches.push([...uids]);
    return super.revisions(uids);
  }
  override async transaction<T>(
    uid: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    if (!this.observe) return super.transaction(uid, fn);
    this.snapshotOwners.push(uid);
    this.concurrentSnapshots++;
    this.peakSnapshots = Math.max(this.peakSnapshots, this.concurrentSnapshots);
    try {
      // Allow parallel snapshot requests to overlap, so a missing concurrency cap
      // is observable without timing-sensitive assertions or artificial latency.
      await Promise.resolve();
      return await super.transaction(uid, fn);
    } finally {
      this.concurrentSnapshots--;
    }
  }
  reset() {
    this.revisionBatches = [];
    this.snapshotOwners = [];
    this.concurrentSnapshots = 0;
    this.peakSnapshots = 0;
  }
}

/** A persisted, silent call after its initial notification jobs have completed. */
function idleFixture(count: number) {
  const db = new ObservedDatabase(),
    bus = new LocalWakeBus();
  const now = Date.now();
  const service = new CloudService(db, bus, () => now),
    app = new CloudApp(service, {
      verify: async () => {
        throw new Error("unused in authenticated socket fixture");
      },
    });
  const uids: string[] = [],
    sockets: Socket[] = [],
    frames = new Map<string, unknown[]>();
  for (let i = 0; i < count; i++) {
    const uid = `silent-owner-${String(i).padStart(4, "0")}`,
      deviceId = `device-${i}`,
      requestId = `request-${i}`;
    const device: Device = {
      id: deviceId,
      name: "phone",
      platform: "ios",
      created_at: new Date(now).toISOString(),
      tokenHash: hash(`test-device-${i}`),
      push_token: null,
      voip_token: null,
      push_environment: "production",
      lastSeen: now,
    };
    const request: CloudRequest = {
      id: requestId,
      version: 1,
      kind: "question",
      question: "確認をお願いします",
      context: null,
      choices: null,
      urgency: "high",
      priority: "high",
      delivery_mode: "call",
      requested_mode: "call",
      status: "pending",
      answer: null,
      agent: null,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      expires_at: new Date(now + 3_600_000).toISOString(),
      call: {
        id: `call-${i}`,
        request_id: requestId,
        state: "active",
        outcome: null,
        device_id: deviceId,
        started_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
        transcript: [{ role: "assistant", text: "確認をお願いします" }],
      },
    };
    // Seed already-persisted states directly; this test measures idle work, not
    // enrollment, ringing, push delivery or the speed of the in-memory double.
    db.records.set(`${uid}:device:${deviceId}`, {
      uid,
      kind: "device",
      id: deviceId,
      doc: device,
      due: null,
    });
    db.records.set(`${uid}:request:${requestId}`, {
      uid,
      kind: "request",
      id: requestId,
      doc: request,
      due: now + 600_000,
    });
    db.versions.set(uid, 1);
    uids.push(uid);
    frames.set(uid, []);
    sockets.push({
      data: {
        principal: {
          uid,
          role: "device",
          deviceId,
          tokenHash: device.tokenHash,
        },
        seen: new Map(),
        ready: false,
        closed: false,
      },
      send: (raw) => {
        frames.get(uid)!.push(JSON.parse(raw));
        return 1;
      },
      close() {
        this.data.closed = true;
      },
      ping() {
        return 1;
      },
    });
  }
  return { db, bus, service, app, uids, sockets, frames };
}

describe("structural scalability and silent-call resource usage", () => {
  test("1000 silent active calls reserve no voice jobs or worker execution slots", async () => {
    const h = idleFixture(1000);
    let modelCalls = 0;
    const worker = new JobWorker(h.service, {
      conversation: {
        turn: async () => {
          modelCalls++;
          return { reply: "unused", resolved: false, answer: null };
        },
      },
    });
    const pool = new WorkerPool(worker, { turn: 8, push: 4 });
    try {
      for (const socket of h.sockets) await h.app.open(socket);
      expect(h.app.socketCount).toBe(1000);
      expect(
        [...h.db.records.values()].filter(
          (row) =>
            row.kind === "request" &&
            (row.doc as CloudRequest).call?.state === "active",
        ),
      ).toHaveLength(1000);
      expect(
        [...h.db.jobs.values()].filter((job) => job.kind === "turn"),
      ).toHaveLength(0);
      for (let i = 0; i < 5; i++) {
        await pool.tick();
        expect(pool.active).toBe(0);
        expect(worker.active).toBe(0);
      }
      expect(modelCalls).toBe(0);
      expect(h.db.jobs.size).toBe(0);
      expect(
        [...h.frames.values()].every((events) => events.length === 1),
      ).toBe(true);
    } finally {
      await pool.stop();
      h.app.close();
      h.bus.close();
    }
  }, 15_000);

  test("1000 unchanged connected owners use revision batches of at most500 and no snapshot transactions", async () => {
    const h = idleFixture(1000);
    try {
      for (const socket of h.sockets) await h.app.open(socket);
      h.db.reset();
      h.db.observe = true;
      for (let i = 0; i < 3; i++) await h.app.reconcileSockets();
      expect(h.db.revisionBatches.map((batch) => batch.length)).toEqual([
        500, 500, 500, 500, 500, 500,
      ]);
      expect(new Set(h.db.revisionBatches.slice(0, 2).flat()).size).toBe(1000);
      expect(h.db.snapshotOwners).toEqual([]);
      expect(h.db.peakSnapshots).toBe(0);
      expect(
        [...h.frames.values()].every((events) => events.length === 1),
      ).toBe(true);
    } finally {
      h.app.close();
      h.bus.close();
    }
  }, 15_000);

  test("a changed-owner reconciliation bounds concurrent full snapshots to four", async () => {
    const h = idleFixture(1000);
    try {
      for (const socket of h.sockets) await h.app.open(socket);
      // Simulate commits from other replicas after all initial snapshots.
      for (const uid of h.uids) h.db.versions.set(uid, 2);
      h.db.reset();
      h.db.observe = true;
      await h.app.reconcileSockets();
      expect(h.db.revisionBatches.map((batch) => batch.length)).toEqual([
        500, 500,
      ]);
      expect(new Set(h.db.snapshotOwners).size).toBe(1000);
      expect(h.db.snapshotOwners).toHaveLength(1000);
      expect(h.db.peakSnapshots).toBeGreaterThan(1);
      expect(h.db.peakSnapshots).toBeLessThanOrEqual(4);
      expect(h.db.concurrentSnapshots).toBe(0);
      h.db.reset();
      await h.app.reconcileSockets();
      expect(h.db.snapshotOwners).toEqual([]);
    } finally {
      h.app.close();
      h.bus.close();
    }
  }, 15_000);

  test("a hashed bus notification wakes only its connected owner", async () => {
    const h = idleFixture(32);
    try {
      for (const socket of h.sockets) await h.app.open(socket);
      h.db.reset();
      h.db.observe = true;
      let finished!: (value: void) => void;
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const original = h.app.refresh.bind(h.app);
      h.app.refresh = async (uid) => {
        try {
          await original(uid);
        } finally {
          finished();
        }
      };
      const unsubscribe = await h.bus.subscribe((digest) =>
        h.app.onWake(digest),
      );
      const target = h.uids[17]!;
      await h.bus.publish(target);
      await done;
      unsubscribe();
      expect(h.db.snapshotOwners).toEqual([target]);
      expect(h.db.revisionBatches).toEqual([]);
      h.db.reset();
      h.app.onWake(hash("unknown-owner"));
      await Promise.resolve();
      expect(h.db.snapshotOwners).toEqual([]);
    } finally {
      h.app.close();
      h.bus.close();
    }
  });
});
