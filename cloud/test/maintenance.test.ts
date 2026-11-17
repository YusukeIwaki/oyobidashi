import { describe, expect, test } from "bun:test";
import { Maintenance } from "../src/maintenance.ts";
import { harness } from "./helpers.ts";
import { MemoryDatabase } from "./memory.ts";
import type { Transaction } from "../src/types.ts";

describe("bounded shared maintenance", () => {
  test("a synchronized missed-call burst spanning multiple batches falls back without one timer per user", async () => {
    const h = harness();
    for (let i = 0; i < 250; i++)
      await h.service.run(h.principal(`owner${i}`), (tx) =>
        h.service.create(
          tx,
          { question: "q", priority: "urgent", delivery_mode: "call" },
          null,
        ),
      );
    h.advance(45_001);
    const db = h.db as MemoryDatabase,
      original = db.transaction.bind(db);
    let active = 0,
      peak = 0;
    db.transaction = async <T>(
      uid: string,
      fn: (tx: Transaction) => Promise<T>,
    ) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        return await original(uid, fn);
      } finally {
        active--;
      }
    };
    const maintenance = new Maintenance(h.service);
    await maintenance.tick();
    await maintenance.stop();
    const requests = [...db.records.values()]
      .filter((r) => r.kind === "request")
      .map(
        (r) =>
          r.doc as {
            status: string;
            delivery_mode: string;
            call: { outcome: string };
          },
      );
    expect(requests).toHaveLength(250);
    expect(
      requests.every(
        (r) =>
          r.status === "pending" &&
          r.delivery_mode === "text" &&
          r.call.outcome === "missed",
      ),
    ).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
  test("overlapping ticks share work; failure is retryable and does not strand the scheduler", async () => {
    const h = harness(),
      db = h.db as MemoryDatabase,
      maintenance = new Maintenance(h.service);
    db.fail = true;
    const a = maintenance.tick(),
      b = maintenance.tick();
    expect(a).toBe(b);
    await expect(a).rejects.toThrow();
    db.fail = false;
    await maintenance.tick();
    await maintenance.stop();
    await maintenance.tick();
  });
  test("stop awaits an in-flight batch and never starts expired-call processing afterwards", async () => {
    const h = harness();
    let release!: (owners: string[]) => void,
      entered = false;
    h.db.dueOwners = async () => {
      entered = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    let transactions = 0;
    h.db.transaction = async () => {
      transactions++;
      throw new Error("must not start after shutdown");
    };
    const maintenance = new Maintenance(h.service),
      tick = maintenance.tick();
    expect(entered).toBe(true);
    let stopped = false;
    const stop = maintenance.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(["alice"]);
    await tick;
    await stop;
    expect(transactions).toBe(0);
  });
});
