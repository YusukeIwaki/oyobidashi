import { describe, expect, test } from "bun:test";
import { harness } from "./helpers.ts";
import { MemoryDatabase } from "./memory.ts";
import { hash } from "../src/service.ts";
import { JobWorker } from "../src/worker.ts";

describe("cloud identity and boundaries", () => {
  test("Firebase identity is required and caller-supplied UID cannot change ownership", async () => {
    const h = harness();
    expect(
      (await h.call("POST", "/v1/requests", null, { question: "q" })).status,
    ).toBe(401);
    const r = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "q",
      uid: "bob",
      user_id: "bob",
    });
    expect(r.status).toBe(201);
    expect(
      (await h.call("GET", `/v1/requests/${r.body.request.id}`, "agent-bob"))
        .status,
    ).toBe(404);
  });
  test("every request mutation and voice result is scoped to owner and role", async () => {
    const h = harness(),
      a = await h.setup(),
      b = await h.pair("bob"),
      t = await a.turn();
    for (const [method, suffix, body] of [
      ["GET", "", undefined],
      ["PATCH", "", { priority: "urgent" }],
      ["POST", "/cancel", undefined],
      ["POST", "/answer", { text: "yes" }],
      ["POST", "/call", { event: "hangup" }],
      ["GET", `/turns/${t.turnId}`, undefined],
    ] as const) {
      const token =
        suffix === "/cancel" || method === "PATCH"
          ? "agent-bob"
          : b.device_token;
      expect(
        (await h.call(method, `/v1/requests/${a.id}${suffix}`, token, body))
          .status,
      ).toBe(404);
    }
    expect(
      (await h.call("GET", "/v1/requests", b.device_token)).body.requests,
    ).toEqual([]);
    expect(
      (
        await h.call("POST", "/v1/requests", a.d.device_token, {
          question: "q",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.call("POST", `/v1/requests/${a.id}/answer`, "agent-alice", {
          text: "q",
        })
      ).status,
    ).toBe(403);
    expect(
      (await h.call("GET", "/v1/presence", b.device_token)).body.recent_events,
    ).toEqual([]);
  });
  test("pairing codes are single use, expire and cannot be replayed across replicas", async () => {
    const h = harness();
    const code = (await h.call("POST", "/v1/pairing-codes")).body.code;
    const body = { code, platform: "ios", device_name: "phone" };
    const paired = await Promise.all([
      h.call("POST", "/v1/pair", null, body),
      h.call("POST", "/v1/pair", null, body),
    ]);
    expect(paired.map((r) => r.status).sort()).toEqual([201, 401]);
    const expired = (await h.call("POST", "/v1/pairing-codes")).body.code;
    h.advance(600_001);
    expect(
      (await h.call("POST", "/v1/pair", null, { ...body, code: expired }))
        .status,
    ).toBe(401);
    const rows = [...(h.db as MemoryDatabase).records.values()];
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(rows.some((r) => r.id === hash(code))).toBe(true);
  });
  test("device revocation is enforced on all subsequent operations", async () => {
    const h = harness(),
      s = await h.setup();
    expect(
      (await h.call("DELETE", "/v1/devices/me", s.d.device_token)).status,
    ).toBe(204);
    expect(
      (await h.call("GET", `/v1/requests/${s.id}`, s.d.device_token)).status,
    ).toBe(401);
    const r = (await h.call("GET", `/v1/requests/${s.id}`)).body.request;
    expect(r.status).toBe("pending");
    expect(r.call.outcome).toBe("failed");
    expect(r.delivery_mode).toBe("text");
  });
  test("device availability and push tokens are isolated by UID", async () => {
    const h = harness(),
      a = await h.pair(),
      b = await h.pair("bob");
    await h.call("PUT", "/v1/presence", a.device_token, {
      availability: "busy",
    });
    await h.call("PUT", "/v1/devices/me", a.device_token, {
      push_token: "normal-a",
      voip_token: "voip-a",
    });
    await h.call("PUT", "/v1/devices/me", a.device_token, { voip_token: null });
    expect(
      (await h.call("GET", "/v1/presence", b.device_token)).body.devices[0]
        .availability,
    ).toBe("available");
    const stored = await h.db.findDevice(hash(a.device_token));
    expect(stored!.device.push_token).toBe("normal-a");
    expect(stored!.device.voip_token).toBeNull();
  });
});

describe("durable nonblocking turn contract", () => {
  test("declining a call prevents immediate repeated rings for five minutes", async () => {
    const h = harness();
    const phone = await h.pair("alice");
    const ask = () => h.call("POST", "/v1/requests", "agent-alice", {
      question: "確認してください", priority: "high", delivery_mode: "call",
    });
    const first = await ask();
    expect(first.body.request.delivery_mode).toBe("call");
    await h.call("POST", `/v1/requests/${first.body.request.id}/call`, phone.device_token, { event: "decline" });
    expect((await ask()).body.request.delivery_mode).toBe("text");
    h.advance(5 * 60_000 + 1);
    expect((await ask()).body.request.delivery_mode).toBe("call");
  });
  test("silent calls create no voice jobs, and different owners can call concurrently", async () => {
    const h = harness(),
      a = await h.setup(),
      b = await h.setup("bob");
    expect(
      (await h.call("GET", `/v1/requests/${a.id}`)).body.request.call.state,
    ).toBe("active");
    expect(
      (await h.call("GET", `/v1/requests/${b.id}`, "agent-bob")).body.request
        .call.state,
    ).toBe("active");
    expect(
      [...(h.db as MemoryDatabase).jobs.values()].filter(
        (j) => j.kind === "turn",
      ),
    ).toHaveLength(0);
    const other = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "second",
      priority: "urgent",
      delivery_mode: "call",
    });
    expect(other.body.request.delivery_mode).toBe("text");
  });
  test("a turn returns 202 before any provider runs and queues exactly one durable job", async () => {
    const h = harness(),
      s = await h.setup();
    const t = await s.turn();
    expect(t.status).toBe(202);
    expect(t.body.turn.state).toBe("queued");
    const jobs = [...(h.db as MemoryDatabase).jobs.values()].filter(
      (j) => j.kind === "turn",
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.turnId).toBe(t.turnId);
    expect(t.body.call.transcript).toHaveLength(1);
  });
  test("lost POST response is recoverable by turn lookup and same-ID replay", async () => {
    const h = harness(),
      s = await h.setup(),
      id = crypto.randomUUID();
    await s.turn("はい", id);
    const retry = await s.turn("はい", id);
    expect(retry.status).toBe(202);
    expect(
      (
        await h.call(
          "GET",
          `/v1/requests/${s.id}/turns/${id}`,
          s.d.device_token,
        )
      ).body.turn.id,
    ).toBe(id);
    expect(
      [...(h.db as MemoryDatabase).jobs.values()].filter(
        (j) => j.kind === "turn",
      ),
    ).toHaveLength(1);
    expect((await s.turn("違う内容", id)).body.error.code).toBe(
      "idempotency_conflict",
    );
    expect((await s.turn("別の発話")).body.error.code).toBe("turn_in_progress");
  });
  test("second device cannot claim or inspect the owner's in-progress turn", async () => {
    const h = harness(),
      s = await h.setup(),
      b = await h.pair(),
      t = await s.turn();
    expect(
      (
        await h.call("POST", `/v1/requests/${s.id}/call`, b.device_token, {
          event: "answer",
        })
      ).body.error.code,
    ).toBe("call_claimed");
    expect(
      (
        await h.call(
          "GET",
          `/v1/requests/${s.id}/turns/${t.turnId}`,
          b.device_token,
        )
      ).status,
    ).toBe(404);
  });
  for (const action of [
    "hangup",
    "decline",
    "failed",
    "cancel",
    "text",
  ] as const)
    test(`${action} invalidates queued turns but retains the appropriate question state`, async () => {
      const h = harness(),
        s = await h.setup(),
        t = await s.turn();
      if (action === "cancel")
        await h.call("POST", `/v1/requests/${s.id}/cancel`);
      else if (action === "text")
        await h.call("POST", `/v1/requests/${s.id}/answer`, s.d.device_token, {
          text: "text answer",
        });
      else
        await h.call("POST", `/v1/requests/${s.id}/call`, s.d.device_token, {
          event: action,
        });
      const stored = await h.turn(t.turnId);
      expect(stored!.state).toBe("cancelled");
      const r = (await h.call("GET", `/v1/requests/${s.id}`)).body.request;
      expect(r.status).toBe(
        action === "cancel"
          ? "cancelled"
          : action === "text"
            ? "answered"
            : "pending",
      );
      expect((await s.turn("はい", t.turnId)).body.turn.state).toBe(
        "cancelled",
      );
    });
  test("request expiry cancels pending jobs even with no connected gateways", async () => {
    const h = harness(),
      s = await h.setup(),
      t = await s.turn();
    h.advance(3600_001);
    await h.db.transaction("alice", (tx) => h.service.reconcile(tx));
    expect((await h.turn(t.turnId))!.state).toBe("cancelled");
    expect(
      (await h.call("GET", `/v1/requests/${s.id}`)).body.request.status,
    ).toBe("expired");
  });
  test("ring timeout and active silence timeout fall back to text without redial", async () => {
    const h = harness();
    await h.pair();
    const r = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "q",
      priority: "high",
      delivery_mode: "call",
    });
    h.advance(45_001);
    const missed = (await h.call("GET", `/v1/requests/${r.body.request.id}`))
      .body.request;
    expect(missed.call.outcome).toBe("missed");
    expect(missed.delivery_mode).toBe("text");
    const s = await h.setup();
    h.advance(600_001);
    expect(
      (await h.call("GET", `/v1/requests/${s.id}`)).body.request.call.outcome,
    ).toBe("failed");
  });
});

describe("commit boundaries and validation", () => {
  test("three impossible-length voice turns ban the account without banning another owner", async () => {
    const h = harness(), s = await h.setup();
    const worker = new JobWorker(h.service, {
      conversation: { turn: async () => ({ reply: "次へ", resolved: false, answer: null }) },
    });
    for (let i = 0; i < 2; i++) {
      expect((await s.turn("あ".repeat(2001))).status).toBe(202);
      expect(await worker.runOnce("turn")).toBe(true);
    }
    expect((await s.turn("あ".repeat(2001))).body.error.code).toBe("account_banned");
    expect(await h.db.isBanned("alice")).toBe(true);
    expect((await h.call("GET", "/v1/presence", "agent-alice")).status).toBe(403);
    expect((await h.call("POST", "/v1/requests", "agent-bob", { question: "other owner" })).status).toBe(201);
  });
  test("the rolling voice budget spans calls and devices and leaves text replies available", async () => {
    const h = harness();
    const hour = 60 * 60_000;
    const firstAt = (Math.floor(h.clock.now / hour) + 1) * hour - 120_000;
    h.advance(firstAt - h.clock.now);
    let providerCalls = 0;
    const worker = new JobWorker(h.service, {
      conversation: { turn: async () => {
        providerCalls++;
        return { reply: "次へ", resolved: false, answer: null };
      } },
    });
    const first = await h.setup();
    const accept = async (call: typeof first) => {
      const result = await call.turn();
      expect(result.status).toBe(202);
      expect((await call.turn("はい", result.turnId)).status).toBe(202);
      expect(await worker.runOnce("turn")).toBe(true);
      h.advance(15_000);
      return result.turnId;
    };
    for (let i = 0; i < 15; i++) await accept(first);
    await h.call("POST", `/v1/requests/${first.id}/call`, first.d.device_token, { event: "hangup" });
    const second = await h.setup();
    expect(second.d.device_token).not.toBe(first.d.device_token);
    for (let i = 0; i < 14; i++) await accept(second);
    const lastTurnId = await accept(second);
    expect((await second.turn("はい", lastTurnId)).status).toBe(200);
    const overBudget = await second.turn();
    expect(overBudget.status).toBe(409);
    expect(overBudget.body.error.code).toBe("call_ended");
    expect(await worker.runOnce("turn")).toBe(false);
    expect(providerCalls).toBe(30);
    expect(await h.db.isBanned("alice")).toBe(false);

    const ask = () => h.call("POST", "/v1/requests", "agent-alice", {
      question: "ご確認ください", priority: "high", delivery_mode: "call",
    });
    const blocked = await ask();
    expect(blocked.body.request.delivery_mode).toBe("text");
    expect(blocked.body.request.call).toBeNull();
    const updated = await h.call("PATCH", `/v1/requests/${blocked.body.request.id}`, "agent-alice", {
      priority: "urgent", delivery_mode: "call",
    });
    expect(updated.body.request.delivery_mode).toBe("text");
    const reply = await h.call("POST", `/v1/requests/${second.id}/answer`, second.d.device_token, {
      text: "確認しました", input_method: "text",
    });
    expect(reply.body.request).toMatchObject({ status: "answered", delivery_mode: "text" });
    const other = await h.setup("bob");
    expect((await other.turn()).status).toBe(202);
    expect(await worker.runOnce("turn")).toBe(true);

    h.advance(firstAt + hour - h.clock.now - 1);
    expect((await ask()).body.request.delivery_mode).toBe("text");
    h.advance(1);
    const recovered = await h.setup();
    expect((await recovered.turn()).status).toBe(202);
    expect(await worker.runOnce("turn")).toBe(true);
    expect((await recovered.turn()).body.error.code).toBe("call_ended");
  });
  test("machine-like distinct turn IDs during one pending model call trigger a durable ban", async () => {
    const h = harness(), s = await h.setup();
    const accepted = await s.turn("はい");
    expect(accepted.status).toBe(202);
    expect((await s.turn("はい", accepted.turnId)).status).toBe(202);
    for (let i = 0; i < 28; i++)
      expect((await s.turn("次", crypto.randomUUID())).body.error.code).toBe("turn_in_progress");
    expect((await s.turn("次")).body.error.code).toBe("account_banned");
    expect((await h.db.transaction("alice", (tx) => tx.get("ban", "current")))?.reason).toBe("voice_hammer");
  });
  test("voice hammer detection spans a minute boundary", async () => {
    const h = harness();
    h.advance((Math.floor(h.clock.now / 60_000) + 2) * 60_000 - h.clock.now - 1000);
    const s = await h.setup();
    expect((await s.turn("はい")).status).toBe(202);
    for (let i = 0; i < 18; i++) expect((await s.turn("次")).status).toBe(409);
    h.advance(2000);
    for (let i = 0; i < 10; i++) expect((await s.turn("次")).status).toBe(409);
    expect((await s.turn("次")).body.error.code).toBe("account_banned");
  });
  test("notification bursts are bounded independently of question creation", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++)
      expect((await h.call("POST", "/v1/requests", "agent-alice", { kind: "notification", question: `notice ${i}` })).status).toBe(201);
    const next = await h.call("POST", "/v1/requests", "agent-alice", { kind: "notification", question: "again" });
    expect(next.status).toBe(429);
    expect((await h.call("POST", "/v1/requests", "agent-alice", { question: "real question" })).status).toBe(201);
  });
  test("a new request prunes the oldest completed record at the storage limit", async () => {
    const h = harness();
    const first = await h.call("POST", "/v1/requests", "agent-alice", { kind: "notification", question: "first" });
    const base = first.body.request;
    await h.db.transaction("alice", async (tx) => {
      for (let i = 0; i < 999; i++) {
        const id = `seed-${i.toString().padStart(4, "0")}`;
        await tx.put("request", id, {
          ...base, id, created_at: new Date(h.clock.now - (1000 - i) * 1000).toISOString(),
        });
      }
    });
    const created = await h.call("POST", "/v1/requests", "agent-alice", { question: "new" });
    expect(created.status).toBe(201);
    expect(await h.db.transaction("alice", (tx) => tx.list("request", {}, 1001))).toHaveLength(1000);
    expect((await h.call("GET", "/v1/requests/seed-0000")).status).toBe(404);
    expect((await h.call("GET", `/v1/requests/${first.body.request.id}`)).status).toBe(200);
  });
  test("question creation and its push jobs roll back together", async () => {
    const db = new MemoryDatabase(),
      h = harness(db);
    await h.pair();
    const before = db.records.size;
    let entered = false;
    await expect(
      db.transaction("alice", async (tx) => {
        await h.service.create(tx, { question: "q" }, null);
        entered = true;
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow();
    expect(entered).toBe(true);
    expect(db.records.size).toBe(before);
    expect(db.jobs.size).toBe(0);
  });
  test("same idempotency key creates one question even with concurrent callers", async () => {
    const h = harness(),
      headers = { "Idempotency-Key": crypto.randomUUID() };
    const responses = await Promise.all([
      h.call("POST", "/v1/requests", "agent-alice", { question: "q" }, headers),
      h.call("POST", "/v1/requests", "agent-alice", { question: "q" }, headers),
    ]);
    expect(responses[0]!.body.request.id).toBe(responses[1]!.body.request.id);
    expect(
      (
        await h.call(
          "POST",
          "/v1/requests",
          "agent-alice",
          { question: "different" },
          headers,
        )
      ).status,
    ).toBe(409);
  });
  test("a lost text answer can be retried without discarding the answer", async () => {
    const h = harness(),
      s = await h.setup(),
      path = `/v1/requests/${s.id}/answer`;
    const a = await h.call("POST", path, s.d.device_token, { text: "yes" });
    const b = await h.call("POST", path, s.d.device_token, { text: "yes" });
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(
      (await h.call("POST", path, s.d.device_token, { text: "different" }))
        .status,
    ).toBe(409);
  });
  for (const body of [
    { question: "" },
    { question: "q", choices: [""] },
    { question: "q", expires_in_seconds: 0 },
    { question: "q", priority: "critical" },
    { question: "q", delivery_mode: "phone" },
    { question: "q", agent: [] },
    { question: "q", context: 5 },
    [],
    "bad JSON",
  ])
    test(`invalid create input ${JSON.stringify(body)} returns a contract error`, async () => {
      const r = await harness().call(
        "POST",
        "/v1/requests",
        "agent-alice",
        body,
      );
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_request");
    });
  test("database outage becomes a generic retryable 503 without private details", async () => {
    const db = new MemoryDatabase(),
      h = harness(db);
    db.fail = true;
    const r = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "q",
    });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("private details");
    expect((await h.call("GET", "/healthz", null)).status).toBe(200);
    expect((await h.call("GET", "/readyz", null)).status).toBe(503);
  });
  test("oversized and streaming oversized bodies return 413 before mutation", async () => {
    const h = harness();
    expect(
      (
        await h.call("POST", "/v1/requests", "agent-alice", {
          question: "x".repeat(65537),
        })
      ).status,
    ).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(65537));
        c.close();
      },
    });
    const res = await h.app.fetch(
      new Request("http://localhost/v1/requests", {
        method: "POST",
        headers: { authorization: "Bearer agent-alice" },
        body: stream,
      }),
    );
    expect(res!.status).toBe(413);
  });
});
