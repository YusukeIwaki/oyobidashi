import { describe, expect, test } from "bun:test";
import { AGENT_TOKEN, ISO_MS, expectSameShape, fixture, makeHarness } from "./helpers.ts";

describe("GET /healthz", () => {
  test("needs no auth", async () => {
    const h = makeHarness();
    const res = await h.call("GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ ok: true, version: "0.2.0", voice_privacy: { id: "v1:claude-code", provider: "claude-code" } });
  });
});

describe("POST /v1/requests", () => {
  test("creates a pending question matching the fixture shape", async () => {
    const h = makeHarness();
    const res = await h.agent("POST", "/v1/requests", {
      kind: "question",
      question: "本番DBのマイグレーションを実行してよいですか?",
      context: "users テーブルに列を追加します",
      choices: ["はい", "いいえ"],
      urgency: "normal",
      expires_in_seconds: 3600,
      agent: { name: "claude-code", cwd: "/path/to/project" },
    });
    expect(res.status).toBe(201);
    const expected = fixture("create_request_response.json");
    expectSameShape(res.body, expected);
    expectSameShape(res.body.request, fixture("request_pending.json"));
    // Everything except the generated id and the delivery counters is identical to the fixture.
    expect({ ...res.body.request, id: expected.request.id }).toEqual(expected.request);
    expect(res.body.request.id).toMatch(/^req_[0-9A-Z]{26}$/);
    expect(res.body.delivery).toEqual({ paired_devices: 0, websocket_delivered: 0, push_attempted: 0 });
  });

  test("applies defaults for a minimal body", async () => {
    const h = makeHarness();
    const res = await h.agent("POST", "/v1/requests", { question: "次はどのタスクをやりますか?" });
    expect(res.status).toBe(201);
    const r = res.body.request;
    expect(r).toMatchObject({
      kind: "question",
      context: null,
      choices: null,
      urgency: "normal",
      status: "pending",
      answer: null,
      agent: null,
    });
    for (const k of ["created_at", "updated_at", "expires_at"]) expect(r[k]).toMatch(ISO_MS);
    expect(Date.parse(r.expires_at) - Date.parse(r.created_at)).toBe(3600_000);
    expect(r.updated_at).toBe(r.created_at);
    expect(Object.keys(r).sort()).toEqual(Object.keys(fixture("request_minimal_voice_answered.json")).sort());
  });

  test("treats null like a missing field and ignores unknown fields", async () => {
    const h = makeHarness();
    const res = await h.agent("POST", "/v1/requests", {
      kind: null,
      question: "q",
      context: null,
      choices: null,
      urgency: null,
      expires_in_seconds: null,
      agent: null,
      some_future_field: { nested: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ kind: "question", urgency: "normal", context: null, agent: null });
    expect("some_future_field" in res.body.request).toBe(false);
  });

  test("notification is created as notified, matching the fixture shape", async () => {
    const h = makeHarness();
    const res = await h.agent("POST", "/v1/requests", {
      kind: "notification",
      question: "ビルドが完了しました",
      agent: { name: "codex" },
    });
    expect(res.status).toBe(201);
    const expected = fixture("request_notification.json");
    expectSameShape(res.body.request, expected);
    expect(res.body.request).toMatchObject({
      kind: "notification",
      status: "notified",
      answer: null,
      agent: { name: "codex", cwd: null },
    });
  });

  test("high urgency and custom expiry are stored", async () => {
    const h = makeHarness();
    const r = await h.ask({ urgency: "high", expires_in_seconds: 10 });
    expect(r.urgency).toBe("high");
    expect(Date.parse(r.expires_at) - Date.parse(r.created_at)).toBe(10_000);
    const max = await h.ask({ expires_in_seconds: 86400 });
    expect(Date.parse(max.expires_at) - Date.parse(max.created_at)).toBe(86400_000);
  });

  test("boundary lengths are accepted", async () => {
    const h = makeHarness();
    const res = await h.agent("POST", "/v1/requests", {
      question: "あ".repeat(4000),
      context: "c".repeat(8000),
      choices: Array.from({ length: 8 }, () => "x".repeat(200)),
      agent: { name: "n".repeat(100), cwd: "/".repeat(1000) },
    });
    expect(res.status).toBe(201);
    // Limits count characters, not UTF-16 units: 4000 astral characters are 8000 units.
    const emoji = await h.agent("POST", "/v1/requests", { question: "😀".repeat(4000) });
    expect(emoji.status).toBe(201);
  });

  const invalidBodies: [string, unknown][] = [
    ["missing question", {}],
    ["null question", { question: null }],
    ["empty question", { question: "" }],
    ["non-string question", { question: 42 }],
    ["question too long", { question: "a".repeat(4001) }],
    ["astral question too long", { question: "😀".repeat(4001) }],
    ["context too long", { question: "q", context: "a".repeat(8001) }],
    ["context wrong type", { question: "q", context: 1 }],
    ["too many choices", { question: "q", choices: Array.from({ length: 9 }, (_, i) => `c${i}`) }],
    ["choices not an array", { question: "q", choices: "yes" }],
    ["empty choice", { question: "q", choices: ["ok", ""] }],
    ["choice too long", { question: "q", choices: ["a".repeat(201)] }],
    ["non-string choice", { question: "q", choices: [1] }],
    ["bad kind", { question: "q", kind: "alert" }],
    ["bad urgency", { question: "q", urgency: "critical" }],
    ["expires too small", { question: "q", expires_in_seconds: 9 }],
    ["expires too large", { question: "q", expires_in_seconds: 86401 }],
    ["expires not an integer", { question: "q", expires_in_seconds: 60.5 }],
    ["expires as string", { question: "q", expires_in_seconds: "60" }],
    ["agent not an object", { question: "q", agent: "claude" }],
    ["agent as array", { question: "q", agent: [] }],
    ["agent.name too long", { question: "q", agent: { name: "n".repeat(101) } }],
    ["agent.cwd too long", { question: "q", agent: { cwd: "/".repeat(1001) } }],
    ["agent.name wrong type", { question: "q", agent: { name: 1 } }],
  ];
  for (const [name, body] of invalidBodies) {
    test(`400 invalid_request: ${name}`, async () => {
      const h = makeHarness();
      const res = await h.agent("POST", "/v1/requests", body);
      expect(res.status).toBe(400);
      expectSameShape(res.body, fixture("error_unauthorized.json"));
      expect(res.body.error.code).toBe("invalid_request");
      expect(h.store.listRequests(null, 10)).toHaveLength(0);
    });
  }

  const malformed: [string, string][] = [
    ["malformed JSON", "{ not json"],
    ["empty body", ""],
    ["JSON array", "[]"],
    ["JSON string", '"hello"'],
    ["JSON null", "null"],
  ];
  for (const [name, rawBody] of malformed) {
    test(`400 invalid_request: ${name}`, async () => {
      const h = makeHarness();
      const res = await h.json("POST", "/v1/requests", { token: AGENT_TOKEN, rawBody });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    });
  }

  test("413 when the body exceeds 64KB (streamed, no content-length)", async () => {
    const h = makeHarness();
    const rawBody = JSON.stringify({ question: "q", context: "a".repeat(64 * 1024) });
    const res = await h.json("POST", "/v1/requests", { token: AGENT_TOKEN, rawBody });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: { code: "payload_too_large", message: expect.any(String) } });
  });

  test("413 when content-length declares more than 64KB", async () => {
    const h = makeHarness();
    const res = await h.json("POST", "/v1/requests", {
      token: AGENT_TOKEN,
      rawBody: "{}",
      headers: { "content-length": String(64 * 1024 + 1) },
    });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });

  test("a body of exactly 64KB is not rejected for its size", async () => {
    const h = makeHarness();
    const padding = 64 * 1024 - JSON.stringify({ question: "q", pad: "" }).length;
    const rawBody = JSON.stringify({ question: "q", pad: "a".repeat(padding) });
    expect(Buffer.byteLength(rawBody)).toBe(64 * 1024);
    const res = await h.json("POST", "/v1/requests", { token: AGENT_TOKEN, rawBody });
    expect(res.status).toBe(201);
  });

  test("delivery counts paired devices", async () => {
    const h = makeHarness();
    await h.pair();
    await h.pair({ platform: "android", device_name: "Pixel" });
    const res = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(res.body.delivery).toEqual({ paired_devices: 2, websocket_delivered: 0, push_attempted: 0 });
  });
});

describe("GET /v1/requests/{id}", () => {
  test("returns the request to the agent and to a device", async () => {
    const h = makeHarness();
    const r = await h.ask();
    const { token } = await h.pair();
    for (const t of [AGENT_TOKEN, token]) {
      const res = await h.json("GET", `/v1/requests/${r.id}`, { token: t });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(["request"]);
      expectSameShape(res.body.request, fixture("request_pending.json"));
      expect(res.body.request).toEqual(r);
    }
  });

  test("404 for an unknown id", async () => {
    const h = makeHarness();
    const res = await h.agent("GET", "/v1/requests/req_nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  for (const wait of ["-1", "301", "abc", "1.5", "", "1e2"]) {
    test(`400 for wait=${JSON.stringify(wait)}`, async () => {
      const h = makeHarness();
      const r = await h.ask();
      const res = await h.agent("GET", `/v1/requests/${r.id}?wait=${wait}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    });
  }

  test("a device's wait parameter is ignored entirely", async () => {
    const h = makeHarness();
    const r = await h.ask();
    const { token } = await h.pair();
    for (const wait of ["300", "garbage"]) {
      const res = await h.json("GET", `/v1/requests/${r.id}?wait=${wait}`, { token });
      expect(res.status).toBe(200);
      expect(res.body.request.status).toBe("pending");
    }
    expect(h.app.waiterCount()).toBe(0);
  });
});

describe("GET /v1/requests", () => {
  test("lists newest first, filters by status and honours limit", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await h.ask({ question: `q${i}` })).id);
      h.clock.advance(1000);
    }
    await h.agent("POST", `/v1/requests/${ids[1]}/cancel`);
    const note = (await h.agent("POST", "/v1/requests", { kind: "notification", question: "done" })).body.request;

    const all = await h.json("GET", "/v1/requests", { token });
    expect(all.status).toBe(200);
    expect(Object.keys(all.body)).toEqual(["requests"]);
    expect(all.body.requests.map((r: any) => r.id)).toEqual([note.id, ...ids.slice().reverse()]);
    for (const r of all.body.requests) {
      expect(Object.keys(r).sort()).toEqual(Object.keys(fixture("request_pending.json")).sort());
    }

    const pending = await h.json("GET", "/v1/requests?status=pending", { token });
    expect(pending.body.requests.map((r: any) => r.id)).toEqual([ids[4], ids[3], ids[2], ids[0]]);
    expectSameShape(pending.body.requests, [fixture("request_pending.json")]);

    const cancelled = await h.json("GET", "/v1/requests?status=cancelled", { token });
    expect(cancelled.body.requests.map((r: any) => r.id)).toEqual([ids[1]]);
    const notified = await h.json("GET", "/v1/requests?status=notified", { token });
    expect(notified.body.requests.map((r: any) => r.id)).toEqual([note.id]);

    const limited = await h.json("GET", "/v1/requests?status=pending&limit=2", { token });
    expect(limited.body.requests.map((r: any) => r.id)).toEqual([ids[4], ids[3]]);
  });

  test("requests created in the same millisecond keep creation order (newest first)", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const a = await h.ask({ question: "a" });
    const b = await h.ask({ question: "b" });
    const res = await h.json("GET", "/v1/requests", { token });
    expect(res.body.requests.map((r: any) => r.id)).toEqual([b.id, a.id]);
  });

  test("default limit is 50, maximum 200", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    for (let i = 0; i < 60; i++) await h.ask({ question: `q${i}` });
    expect((await h.json("GET", "/v1/requests", { token })).body.requests).toHaveLength(50);
    expect((await h.json("GET", "/v1/requests?limit=200", { token })).body.requests).toHaveLength(60);
    expect((await h.json("GET", "/v1/requests?limit=1", { token })).body.requests).toHaveLength(1);
  });

  test("empty list", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    expect((await h.json("GET", "/v1/requests", { token })).body).toEqual({ requests: [] });
  });

  for (const query of ["limit=0", "limit=201", "limit=abc", "limit=-1", "limit=1.5", "limit=", "status=done", "status="]) {
    test(`400 for ?${query}`, async () => {
      const h = makeHarness();
      const { token } = await h.pair();
      const res = await h.json("GET", `/v1/requests?${query}`, { token });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
    });
  }
});

describe("POST /v1/requests/{id}/answer", () => {
  test("choice answer matches the fixture", async () => {
    const h = makeHarness();
    const { token, device } = await h.pair();
    const r = await h.ask();
    h.clock.advance(60_000);
    const res = await h.json("POST", `/v1/requests/${r.id}/answer`, { token, body: fixture("answer_request.json") });
    expect(res.status).toBe(200);
    const expected = fixture("request_answered.json");
    expectSameShape(res.body.request, expected);
    expect(res.body.request).toEqual({
      ...expected,
      id: r.id,
      answer: { ...expected.answer, device_id: device.id },
    });
    // and it is what the agent now reads
    expect((await h.agent("GET", `/v1/requests/${r.id}`)).body.request).toEqual(res.body.request);
  });

  test("voice answer on a minimal request matches the fixture", async () => {
    const h = makeHarness();
    const { token, device } = await h.pair();
    const r = await h.ask({ context: null, choices: null, agent: null, urgency: "high", question: "次はどのタスクをやりますか?" });
    h.clock.advance(30_250);
    const res = await h.json("POST", `/v1/requests/${r.id}/answer`, {
      token,
      body: { text: "ログイン画面のバグ修正を先にやって", input_method: "voice" },
    });
    expect(res.status).toBe(200);
    const expected = fixture("request_minimal_voice_answered.json");
    expectSameShape(res.body.request, expected);
    expect(res.body.request.answer).toEqual({
      text: "ログイン画面のバグ修正を先にやって",
      choice_index: null,
      input_method: "voice",
      device_id: device.id,
      answered_at: res.body.request.updated_at,
    });
    expect(Date.parse(res.body.request.updated_at) - Date.parse(res.body.request.created_at)).toBe(30_250);
  });

  test("input_method defaults to text, or choice when choice_index is given", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const a = await h.ask();
    const b = await h.ask();
    const text = await h.json("POST", `/v1/requests/${a.id}/answer`, { token, body: { text: "free text" } });
    expect(text.body.request.answer).toMatchObject({ input_method: "text", choice_index: null });
    const choice = await h.json("POST", `/v1/requests/${b.id}/answer`, { token, body: { text: "いいえ", choice_index: 1 } });
    expect(choice.body.request.answer).toMatchObject({ input_method: "choice", choice_index: 1 });
  });

  test("choice_index is stored only for a choice answer", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const r = await h.ask();
    const res = await h.json("POST", `/v1/requests/${r.id}/answer`, {
      token,
      body: { text: "はい、でも夜にやって", choice_index: 0, input_method: "text" },
    });
    expect(res.status).toBe(200);
    expect(res.body.request.answer).toMatchObject({ input_method: "text", choice_index: null });
  });

  test("text of 10000 characters is accepted", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const r = await h.ask();
    const res = await h.json("POST", `/v1/requests/${r.id}/answer`, { token, body: { text: "あ".repeat(10000) } });
    expect(res.status).toBe(200);
  });

  const invalidAnswers: [string, unknown][] = [
    ["missing text", { input_method: "text" }],
    ["null text", { text: null }],
    ["empty text", { text: "" }],
    ["non-string text", { text: 1 }],
    ["text too long", { text: "a".repeat(10001) }],
    ["bad input_method", { text: "x", input_method: "telepathy" }],
    ["choice_index out of range (high)", { text: "x", choice_index: 2, input_method: "choice" }],
    ["choice_index out of range (negative)", { text: "x", choice_index: -1, input_method: "choice" }],
    ["choice_index not an integer", { text: "x", choice_index: 0.5, input_method: "choice" }],
    ["choice_index as string", { text: "x", choice_index: "0", input_method: "choice" }],
    ["choice without choice_index", { text: "x", input_method: "choice" }],
    ["out-of-range choice_index with text input", { text: "x", choice_index: 5, input_method: "text" }],
  ];
  for (const [name, body] of invalidAnswers) {
    test(`400 invalid_request: ${name}`, async () => {
      const h = makeHarness();
      const { token } = await h.pair();
      const r = await h.ask();
      const res = await h.json("POST", `/v1/requests/${r.id}/answer`, { token, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      // a rejected answer leaves the request answerable
      expect((await h.agent("GET", `/v1/requests/${r.id}`)).body.request.status).toBe("pending");
    });
  }

  test("400 for choice_index on a request without choices", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const r = await h.ask({ choices: null });
    const res = await h.json("POST", `/v1/requests/${r.id}/answer`, { token, body: { text: "x", choice_index: 0 } });
    expect(res.status).toBe(400);
  });

  test("400 for malformed JSON and 413 for an oversized body", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const r = await h.ask();
    expect((await h.json("POST", `/v1/requests/${r.id}/answer`, { token, rawBody: "{" })).status).toBe(400);
    const big = JSON.stringify({ text: "a".repeat(70_000) });
    const res = await h.json("POST", `/v1/requests/${r.id}/answer`, { token, rawBody: big });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });

  test("404 for an unknown id", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const res = await h.json("POST", "/v1/requests/req_nope/answer", { token, body: { text: "x" } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("POST /v1/requests/{id}/cancel", () => {
  test("cancels a pending request", async () => {
    const h = makeHarness();
    const r = await h.ask();
    h.clock.advance(120_000);
    const res = await h.agent("POST", `/v1/requests/${r.id}/cancel`);
    expect(res.status).toBe(200);
    const expected = fixture("event_request_updated.json").request;
    expectSameShape(res.body.request, expected);
    expect(res.body.request).toEqual({ ...expected, id: r.id });
  });

  test("404 for an unknown id", async () => {
    const h = makeHarness();
    const res = await h.agent("POST", "/v1/requests/req_nope/cancel");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("state machine", () => {
  async function setup(state: "answered" | "cancelled" | "expired" | "notified") {
    const h = makeHarness();
    const { token } = await h.pair();
    let r: any;
    if (state === "notified") {
      r = (await h.agent("POST", "/v1/requests", { kind: "notification", question: "done" })).body.request;
    } else {
      r = await h.ask({ expires_in_seconds: 60 });
      if (state === "answered") await h.json("POST", `/v1/requests/${r.id}/answer`, { token, body: { text: "ok" } });
      if (state === "cancelled") await h.agent("POST", `/v1/requests/${r.id}/cancel`);
      if (state === "expired") h.clock.advance(60_000);
    }
    return { h, token, id: r.id as string };
  }

  for (const state of ["answered", "cancelled", "expired", "notified"] as const) {
    test(`answer on ${state} → 409 already_resolved`, async () => {
      const { h, token, id } = await setup(state);
      const res = await h.json("POST", `/v1/requests/${id}/answer`, { token, body: { text: "late" } });
      expect(res.status).toBe(409);
      expectSameShape(res.body, fixture("error_already_resolved.json"));
      expect(res.body).toEqual({ error: { code: "already_resolved", message: `request is already ${state}` } });
      expect((await h.agent("GET", `/v1/requests/${id}`)).body.request.status).toBe(state);
    });

    test(`cancel on ${state} → 409 already_resolved`, async () => {
      const { h, id } = await setup(state);
      const res = await h.agent("POST", `/v1/requests/${id}/cancel`);
      if (state === "notified") {
        expect(res.status).toBe(200);
        expect(res.body.request.status).toBe("cancelled");
      } else {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("already_resolved");
        expect((await h.agent("GET", `/v1/requests/${id}`)).body.request.status).toBe(state);
      }
    });
  }

  test("the 409 body for an answered request equals the fixture exactly", async () => {
    const { h, token, id } = await setup("answered");
    const res = await h.json("POST", `/v1/requests/${id}/answer`, { token, body: { text: "late" } });
    expect(res.body).toEqual(fixture("error_already_resolved.json"));
  });

  test("the first answer is kept when a second one is rejected", async () => {
    const { h, token, id } = await setup("answered");
    await h.json("POST", `/v1/requests/${id}/answer`, { token, body: { text: "second" } });
    expect((await h.agent("GET", `/v1/requests/${id}`)).body.request.answer.text).toBe("ok");
  });

  test("two devices answering concurrently: exactly one wins", async () => {
    const h = makeHarness();
    const a = await h.pair();
    const b = await h.pair({ device_name: "Pixel", platform: "android" });
    for (let round = 0; round < 20; round++) {
      const r = await h.ask();
      const results = await Promise.all([
        h.json("POST", `/v1/requests/${r.id}/answer`, { token: a.token, body: { text: "from a" } }),
        h.json("POST", `/v1/requests/${r.id}/answer`, { token: b.token, body: { text: "from b" } }),
        h.json("POST", `/v1/requests/${r.id}/answer`, { token: a.token, body: { text: "from a again" } }),
      ]);
      const statuses = results.map((x) => x.status).sort();
      expect(statuses).toEqual([200, 409, 409]);
      const winner = results.find((x) => x.status === 200)!;
      const stored = (await h.agent("GET", `/v1/requests/${r.id}`)).body.request;
      expect(stored.answer).toEqual(winner.body.request.answer);
      for (const loser of results.filter((x) => x.status === 409)) {
        expect(loser.body.error.code).toBe("already_resolved");
      }
    }
  });

  test("concurrent answer and cancel: exactly one wins", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const r = await h.ask();
    const [answer, cancel] = await Promise.all([
      h.json("POST", `/v1/requests/${r.id}/answer`, { token, body: { text: "yes" } }),
      h.agent("POST", `/v1/requests/${r.id}/cancel`),
    ]);
    expect([answer.status, cancel.status].sort()).toEqual([200, 409]);
  });

  test("the store refuses a second answer and an answer after expiry (atomic UPDATE)", async () => {
    const h = makeHarness();
    const r = await h.ask({ expires_in_seconds: 10 });
    const answer = { text: "x", choice_index: null, input_method: "text" as const, device_id: "dev_1" };
    expect(h.store.answerRequest(r.id, answer, h.clock.now())).not.toBeNull();
    expect(h.store.answerRequest(r.id, answer, h.clock.now())).toBeNull();
    expect(h.store.cancelRequest(r.id, h.clock.now())).toBeNull();
    const late = await h.ask({ expires_in_seconds: 10 });
    // even if nobody ran the expiry sweep, an overdue request cannot be answered or cancelled
    expect(h.store.answerRequest(late.id, answer, h.clock.now() + 10_000)).toBeNull();
    expect(h.store.cancelRequest(late.id, h.clock.now() + 10_000)).toBeNull();
  });
});

describe("expiry", () => {
  test("a pending request expires lazily when read", async () => {
    const h = makeHarness();
    const r = await h.ask({ expires_in_seconds: 10 });
    h.clock.advance(9_999);
    expect((await h.agent("GET", `/v1/requests/${r.id}`)).body.request.status).toBe("pending");
    h.clock.advance(1);
    const res = await h.agent("GET", `/v1/requests/${r.id}`);
    expect(res.body.request.status).toBe("expired");
    expect(res.body.request.answer).toBeNull();
    expect(Date.parse(res.body.request.updated_at)).toBe(h.clock.now());
    expectSameShape(res.body.request, fixture("event_request_updated.json").request);
  });

  test("the list endpoint also applies expiry", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const r = await h.ask({ expires_in_seconds: 10 });
    const keep = await h.ask({ expires_in_seconds: 100 });
    h.clock.advance(10_000);
    const pending = await h.json("GET", "/v1/requests?status=pending", { token });
    expect(pending.body.requests.map((x: any) => x.id)).toEqual([keep.id]);
    const expired = await h.json("GET", "/v1/requests?status=expired", { token });
    expect(expired.body.requests.map((x: any) => x.id)).toEqual([r.id]);
  });

  test("the periodic sweep expires requests nobody reads", async () => {
    const h = makeHarness();
    const r = await h.ask({ expires_in_seconds: 10 });
    h.clock.advance(60_000);
    h.app.sweep();
    expect(h.store.getRequest(r.id)!.status).toBe("expired");
  });

  test("notifications and resolved requests never expire", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const note = (await h.agent("POST", "/v1/requests", { kind: "notification", question: "n", expires_in_seconds: 10 })).body.request;
    const answered = await h.ask({ expires_in_seconds: 10 });
    await h.json("POST", `/v1/requests/${answered.id}/answer`, { token, body: { text: "ok" } });
    h.clock.advance(3600_000);
    h.app.sweep();
    expect(h.store.getRequest(note.id)!.status).toBe("notified");
    expect(h.store.getRequest(answered.id)!.status).toBe("answered");
  });
});

describe("routing and errors", () => {
  const unknown: [string, string][] = [
    ["GET", "/"],
    ["GET", "/v1"],
    ["GET", "/v1/nope"],
    ["GET", "/v2/requests"],
    ["POST", "/healthz"],
    ["DELETE", "/v1/requests"],
    ["PUT", "/v1/requests/req_1"],
    ["GET", "/v1/requests/req_1/answer"],
    ["POST", "/v1/requests/req_1/unknown"],
    ["POST", "/v1/requests/req_1/answer/extra"],
    ["GET", "/v1/requests/"],
    ["GET", "/v1/pair"],
    ["GET", "/v1/devices/me"],
    ["POST", "/v1/events"],
  ];
  for (const [method, path] of unknown) {
    test(`${method} ${path} → 404 not_found`, async () => {
      const h = makeHarness();
      const res = await h.json(method, path, { token: AGENT_TOKEN });
      expect(res.status).toBe(404);
      expectSameShape(res.body, fixture("error_unauthorized.json"));
      expect(res.body.error.code).toBe("not_found");
    });
  }

  test("an unexpected failure becomes 500 internal without leaking details", async () => {
    const h = makeHarness();
    h.store.close(); // every query now throws
    const res = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal", message: "internal server error" } });
    expect(h.warnings.join("\n")).toContain("internal error");
  });

  test("every error response is JSON with the contract's content type", async () => {
    const h = makeHarness();
    const res = await h.call("GET", "/v1/requests/req_x");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });
});
