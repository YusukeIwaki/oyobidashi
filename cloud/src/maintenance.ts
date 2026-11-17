import type { CloudService } from "./service.ts";

/** Bounded batches prevent one busy tenant or a synchronized expiry burst from
 * delaying everyone else's missed-call/text fallback. No timer per call. */
export class Maintenance {
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(private service: CloudService) {}
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async sweep() {
    for (let batch = 0; batch < 5 && !this.stopped; batch++) {
      const owners = await this.service.db.dueOwners(this.service.now(), 100);
      let next = 0;
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(4, owners.length) }, async () => {
          while (next < owners.length && !this.stopped) {
            const uid = owners[next++]!;
            await this.service.db.transaction(uid, (tx) =>
              this.service.reconcile(tx),
            );
            void this.service.wake(uid);
          }
        }),
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (owners.length < 100) break;
    }
  }
  async stop() {
    this.stopped = true;
    await this.running?.catch(() => {});
  }
}
