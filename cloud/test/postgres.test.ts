import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { PostgresDatabase } from "../src/postgres.ts";
import { harness } from "./helpers.ts";
import { JobWorker } from "../src/worker.ts";
import { CloudApp } from "../src/app.ts";
import { LocalWakeBus } from "../src/bus.ts";
import { CloudService } from "../src/service.ts";

const url = process.env.CLOUD_TEST_DATABASE_URL;
const suite = describe.skipIf(!url);
const resources: { db: PostgresDatabase; schema: string }[] = [];
const admin = url ? postgres(url, { max: 2, onnotice: () => {} }) : null;
async function setup(poolSize = 10) {
  const schema = `oyobidashi_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  const db = new PostgresDatabase(url!, poolSize, schema);
  resources.push({ db, schema });
  await db.migrate();
  return { h: harness(db), db, schema };
}
afterAll(async () => {
  for (const r of resources) {
    await r.db.close();
    await admin!.unsafe(`DROP SCHEMA ${r.schema} CASCADE`);
  }
  await admin?.end();
});

suite("real PostgreSQL concurrency and forced failure", () => {
  test("voice abuse ban commits and is enforced across API pools", async () => {
    const { h, schema } = await setup(1);
    const s = await h.setup();
    const worker = new JobWorker(h.service, { conversation: { turn: async () => ({ reply: "次", resolved: false, answer: null }) } });
    for (let i = 0; i < 2; i++) {
      expect((await s.turn("あ".repeat(2001))).status).toBe(202);
      expect(await worker.runOnce("turn")).toBe(true);
    }
    expect((await s.turn("あ".repeat(2001))).body.error.code).toBe("account_banned");
    const anotherPool = new PostgresDatabase(url!, 1, schema);
    try {
      expect(await anotherPool.isBanned("alice")).toBe(true);
      const other = harness(anotherPool);
      expect((await other.call("GET", "/v1/requests", "agent-alice")).body.error.code).toBe("account_banned");
    } finally { await anotherPool.close(); }
  });
  test("reinstallation rotates both tokens and fences an in-flight registration from the old account", async () => {
    const { h, db } = await setup();
    const clientId = "synthetic-device-stable-identity-0001";
    const a = await h.pair();
    await h.call("PUT", "/v1/devices/me", a.device_token, { push_client_id: clientId, push_token: "old-normal", voip_token: "old-voip" });
    const code = (await h.call("POST", "/v1/pairing-codes", "agent-bob")).body.code;
    await expect(db.transaction("alice", async tx => {
      const old = (await tx.get("device", a.device.id))!;
      const next = await h.call("POST", "/v1/pair", null, { code, platform: "ios", device_name: "reinstalled", push_client_id: clientId, push_token: "new-normal" });
      expect(next.status).toBe(201);
      await tx.claimPush(old);
    })).rejects.toThrow();
    expect((await h.call("GET", "/v1/requests", a.device_token)).status).toBe(401);
    expect(await db.transaction("alice", tx => tx.list("device"))).toEqual([]);
  });

  test("legacy timestamp migration is repeatable without renewing expired registrations", async () => {
    const { h, db } = await setup(), d = await h.pair();
    await db.sql.unsafe("UPDATE cloud_records SET doc=(doc - 'push_registered_at' - 'voip_registered_at') || jsonb_build_object('lastSeen',1234,'push_token','legacy') WHERE kind='device'");
    await db.migrate();
    await db.migrate();
    expect(await db.transaction("alice", tx => tx.get("device", d.device.id))).toMatchObject({ push_registered_at: 1234, voip_registered_at: 1234 });
    await h.call("POST", "/v1/requests", "agent-alice", { question: "expired" });
    expect((await db.transaction("alice", tx => tx.get("device", d.device.id)))!.push_token).toBeNull();
  });

  test("a displaced device cannot reclaim a shared endpoint through an already in-flight registration", async () => {
    const { h, db } = await setup(),
      a = await h.pair();
    await h.call("PUT", "/v1/devices/me", a.device_token, {
      push_token: "synthetic-shared-endpoint",
    });
    const code = (await h.call("POST", "/v1/pairing-codes", "agent-bob")).body
      .code;
    await expect(
      db.transaction("alice", async (tx) => {
        const old = (await tx.get("device", a.device.id))!;
        const moved = await h.call("POST", "/v1/pair", null, {
          code,
          platform: "ios",
          device_name: "new account",
          push_token: "synthetic-shared-endpoint",
        });
        expect(moved.status).toBe(201);
        await tx.claimPush(old);
      }),
    ).rejects.toThrow();
    expect(
      (
        await h.call("PUT", "/v1/devices/me", a.device_token, {
          push_token: "synthetic-shared-endpoint",
        })
      ).status,
    ).toBe(401);
  });
  test("independent API pools share owners, call slots and first-device claim atomically", async () => {
    const { h, db, schema } = await setup();
    const db2 = new PostgresDatabase(url!, 4, schema);
    const other = harness(db2);
    try {
      const a = await h.pair(),
        b = await other.pair();
      const created = await Promise.all([
        h.call("POST", "/v1/requests", "agent-alice", {
          question: "a",
          priority: "urgent",
          delivery_mode: "call",
        }),
        other.call("POST", "/v1/requests", "agent-alice", {
          question: "b",
          priority: "urgent",
          delivery_mode: "call",
        }),
      ]);
      expect(created.map((r) => r.body.request.delivery_mode).sort()).toEqual([
        "call",
        "text",
      ]);
      const id = created.find((r) => r.body.request.call)!.body.request.id;
      const claims = await Promise.all([
        h.call("POST", `/v1/requests/${id}/call`, a.device_token, {
          event: "answer",
        }),
        other.call("POST", `/v1/requests/${id}/call`, b.device_token, {
          event: "answer",
        }),
      ]);
      expect(claims.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        await db.transaction("bob", (tx) => tx.get("request", id)),
      ).toBeNull();
    } finally {
      await db2.close();
    }
  });
  test("job+turn rollback is atomic and multiple worker claims never duplicate a job", async () => {
    const { h, db } = await setup();
    await expect(
      db.transaction("alice", async (tx) => {
        await h.service.create(tx, { question: "q" }, null);
        throw new Error("injected process failure");
      }),
    ).rejects.toThrow();
    expect(await db.transaction("alice", (tx) => tx.list("request"))).toEqual(
      [],
    );
    for (let i = 0; i < 8; i++)
      await db.transaction(`owner${i}`, (tx) =>
        tx.enqueue({
          kind: "turn",
          requestId: "req",
          payload: { turnId: crypto.randomUUID() },
          deadline: Date.now() + 90_000,
        }),
      );
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => db.claim("turn", Date.now(), 1000)),
    );
    const ids = claims.filter(Boolean).map((j) => j!.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });
  test("a real SIGKILL during model execution is recovered by a replacement worker", async () => {
    const { h, db, schema } = await setup(),
      s = await h.setup(),
      t = await s.turn();
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        new URL("./fixtures/crashing-worker.ts", import.meta.url).pathname,
      ],
      {
        env: {
          ...process.env,
          CLOUD_TEST_DATABASE_URL: url!,
          CLOUD_TEST_SCHEMA: schema,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = child.stdout.getReader();
      const entered = await Promise.race([
        reader.read(),
        Bun.sleep(5000).then(() => {
          throw new Error("worker did not reach provider");
        }),
      ]);
      expect(new TextDecoder().decode(entered.value)).toContain(
        "provider-entered",
      );
      reader.releaseLock();
      expect((await h.turn(t.turnId))!.state).toBe("running");
      child.kill("SIGKILL");
      await child.exited;
      h.clock.now = Date.now() + 400;
      await new JobWorker(h.service, {
        conversation: {
          turn: async () => ({
            reply: "復旧しました",
            resolved: true,
            answer: "yes",
          }),
        },
      }).runOnce("turn");
      expect((await h.turn(t.turnId))!.state).toBe("completed");
      expect(
        (await h.call("GET", `/v1/requests/${s.id}`)).body.request.call
          .transcript,
      ).toHaveLength(3);
    } finally {
      child.kill();
      await child.exited;
    }
    expect(await db.claim("turn", h.clock.now, 1000)).toBeNull();
  }, 10_000);
  test("closing one gateway never ends a call and another gateway can recover the turn", async () => {
    const { h, db } = await setup(),
      s = await h.setup(),
      t = await s.turn();
    h.app.close();
    const replacement = new CloudApp(
      new CloudService(db, new LocalWakeBus(), () => h.clock.now),
      { verify: async () => "alice" },
    );
    const response = await replacement.fetch(
      new Request(`http://localhost/v1/requests/${s.id}/turns/${t.turnId}`, {
        headers: { authorization: `Bearer ${s.d.device_token}` },
      }),
    );
    expect(response!.status).toBe(200);
    expect(((await response!.json()) as any).turn.state).toBe("queued");
    await new JobWorker(h.service, {
      conversation: {
        turn: async () => ({
          reply: "続けましょう",
          resolved: false,
          answer: null,
        }),
      },
    }).runOnce("turn");
    expect((await h.turn(t.turnId))!.reply).toBe("続けましょう");
    replacement.close();
  });
  test("PostgreSQL rejects accidental second live calls even outside service checks", async () => {
    const { h, db } = await setup(),
      s = await h.setup();
    await expect(
      db.transaction("alice", async (tx) => {
        const r = (await tx.get("request", s.id))!;
        await tx.put("request", "other", { ...r, id: "other" });
      }),
    ).rejects.toThrow();
    expect(
      await db.transaction("alice", (tx) => tx.list("request")),
    ).toHaveLength(1);
  });
  test("a stale lease cannot overwrite the replacement result in real PostgreSQL", async () => {
    const { h } = await setup(),
      s = await h.setup(),
      t = await s.turn();
    let release!: (value: any) => void;
    let entered = false;
    const old = new JobWorker(h.service, {
      leaseMs: 100,
      heartbeatMs: 999_999,
      conversation: {
        turn: () => {
          entered = true;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    });
    const pending = old.runOnce("turn");
    const deadline = Date.now() + 2000;
    while (!entered) {
      if (Date.now() > deadline) throw new Error("worker not started");
      await Bun.sleep(1);
    }
    h.advance(101);
    await new JobWorker(h.service, {
      conversation: {
        turn: async () => ({ reply: "new", resolved: false, answer: null }),
      },
    }).runOnce("turn");
    release({ reply: "stale", resolved: false, answer: null });
    await pending;
    expect((await h.turn(t.turnId))!.reply).toBe("new");
  });
  test("terminating a database connection rolls back state and work together", async () => {
    const { db } = await setup();
    await expect(
      db.sql.begin(async (sql) => {
        await sql.unsafe(
          "INSERT INTO cloud_records(uid,kind,id,doc,touched_at) VALUES('alice','pairing','test-hash','{\"used\":false,\"expires\":1}'::jsonb,1)",
        );
        await sql.unsafe(
          "INSERT INTO cloud_jobs(id,uid,kind,request_id,payload,state,available_at,deadline) VALUES('test-job','alice','push','r','{}'::jsonb,'ready',0,9999999999999)",
        );
        // Obtain this transaction's exact PID; never select another application
        // connection by name or terminate a developer's unrelated session.
        const rows = await sql.unsafe("SELECT pg_backend_pid() AS pid");
        await admin!.unsafe("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
        await sql.unsafe("SELECT 1");
      }),
    ).rejects.toThrow();
    expect(
      await db.transaction("alice", (tx) => tx.get("pairing", "test-hash")),
    ).toBeNull();
    expect(await db.claim("push", Date.now(), 100)).toBeNull();
  });
});
