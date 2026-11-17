import { PostgresDatabase } from "../../src/postgres.ts";
import { LocalWakeBus } from "../../src/bus.ts";
import { CloudService } from "../../src/service.ts";
import { JobWorker } from "../../src/worker.ts";

const db = new PostgresDatabase(
  process.env.CLOUD_TEST_DATABASE_URL!,
  2,
  process.env.CLOUD_TEST_SCHEMA!,
);
const worker = new JobWorker(new CloudService(db, new LocalWakeBus()), {
  leaseMs: 300,
  heartbeatMs: 50,
  conversation: {
    turn: async () => {
      console.log("provider-entered");
      return new Promise(() => {});
    },
  },
});
await worker.runOnce("turn");
await db.close();
