import { describe, expect, test } from "bun:test";
import { AGENT_TOKEN, makeHarness, until } from "./helpers.ts";

const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 10));
  return done;
};

describe("long-poll GET /v1/requests/{id}?wait=N", () => {
  test("returns immediately when already resolved", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const answered = await h.ask();
    await h.json("POST", `/v1/requests/${answered.id}/answer`, { token, body: { text: "ok" } });
    const cancelled = await h.ask();
    await h.agent("POST", `/v1/requests/${cancelled.id}/cancel`);
    const expired = await h.ask({ expires_in_seconds: 10 });
    const note = (await h.agent("POST", "/v1/requests", { kind: "notification", question: "n" })).body.request;
    h.clock.advance(10_000);
    for (const [id, status] of [
      [answered.id, "answered"],
      [cancelled.id, "cancelled"],
      [expired.id, "expired"],
      [note.id, "notified"],
    ]) {
      const res = await h.agent("GET", `/v1/requests/${id}?wait=300`);
      expect(res.status).toBe(200);
      expect(res.body.request.status).toBe(status);
    }
    expect(h.app.waiterCount()).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("wait=0 (and no wait) returns the pending request at once", async () => {
    const h = makeHarness();
    const r = await h.ask();
    expect((await h.agent("GET", `/v1/requests/${r.id}?wait=0`)).body.request.status).toBe("pending");
    expect((await h.agent("GET", `/v1/requests/${r.id}`)).body.request.status).toBe("pending");
    expect(h.app.waiterCount()).toBe(0);
  });

  test("404 for an unknown id even with wait", async () => {
    const h = makeHarness();
    expect((await h.agent("GET", "/v1/requests/req_nope?wait=30")).status).toBe(404);
    expect(h.app.waiterCount()).toBe(0);
  });

  test("wakes up the moment the request is answered", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const r = await h.ask();
    const poll = h.agent("GET", `/v1/requests/${r.id}?wait=300`);
    await until(() => h.app.waiterCount() === 1);
    expect(await settled(poll)).toBe(false);
    await h.json("POST", `/v1/requests/${r.id}/answer`, { token, body: { text: "はい", choice_index: 0 } });
    const res = await poll;
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("answered");
    expect(res.body.request.answer.text).toBe("はい");
    expect(h.app.waiterCount()).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("wakes up on cancel", async () => {
    const h = makeHarness();
    const r = await h.ask();
    const poll = h.agent("GET", `/v1/requests/${r.id}?wait=300`);
    await until(() => h.app.waiterCount() === 1);
    await h.agent("POST", `/v1/requests/${r.id}/cancel`);
    expect((await poll).body.request.status).toBe("cancelled");
    expect(h.app.waiterCount()).toBe(0);
  });

  test("wakes up exactly at expiry when that comes before the wait ends", async () => {
    const h = makeHarness();
    const r = await h.ask({ expires_in_seconds: 20 });
    const poll = h.agent("GET", `/v1/requests/${r.id}?wait=300`);
    await until(() => h.app.waiterCount() === 1);
    h.clock.advance(19_999);
    expect(await settled(poll)).toBe(false);
    h.clock.advance(1);
    const res = await poll;
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("expired");
    expect(h.app.waiterCount()).toBe(0);
  });

  test("wakes up when the periodic sweep expires the request", async () => {
    const h = makeHarness();
    const r = await h.ask({ expires_in_seconds: 20 });
    const poll = h.agent("GET", `/v1/requests/${r.id}?wait=300`);
    await until(() => h.app.waiterCount() === 1);
    h.clock.t += 25_000; // time passes without the long-poll's own timer firing
    h.app.sweep();
    expect((await poll).body.request.status).toBe("expired");
    expect(h.app.waiterCount()).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("returns 200 pending when the wait times out, not earlier", async () => {
    const h = makeHarness();
    const r = await h.ask();
    const poll = h.agent("GET", `/v1/requests/${r.id}?wait=5`);
    await until(() => h.app.waiterCount() === 1);
    h.clock.advance(4_999);
    expect(await settled(poll)).toBe(false);
    h.clock.advance(1);
    const res = await poll;
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("pending");
    expect(h.app.waiterCount()).toBe(0);
    // still answerable afterwards
    const { token } = await h.pair();
    expect((await h.json("POST", `/v1/requests/${r.id}/answer`, { token, body: { text: "ok" } })).status).toBe(200);
  });

  test("the maximum wait of 300 seconds is honoured", async () => {
    const h = makeHarness();
    const r = await h.ask();
    const poll = h.agent("GET", `/v1/requests/${r.id}?wait=300`);
    await until(() => h.app.waiterCount() === 1);
    h.clock.advance(299_999);
    expect(await settled(poll)).toBe(false);
    h.clock.advance(1);
    expect((await poll).body.request.status).toBe("pending");
  });

  test("several waiters on the same request all wake up; other requests keep waiting", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    const r = await h.ask();
    const other = await h.ask();
    const polls = [1, 2, 3].map(() => h.agent("GET", `/v1/requests/${r.id}?wait=300`));
    const otherPoll = h.agent("GET", `/v1/requests/${other.id}?wait=300`);
    await until(() => h.app.waiterCount() === 4);
    await h.json("POST", `/v1/requests/${r.id}/answer`, { token, body: { text: "ok" } });
    for (const res of await Promise.all(polls)) expect(res.body.request.status).toBe("answered");
    expect(h.app.waiterCount()).toBe(1);
    expect(await settled(otherPoll)).toBe(false);
    await h.agent("POST", `/v1/requests/${other.id}/cancel`);
    expect((await otherPoll).body.request.status).toBe("cancelled");
    expect(h.app.waiterCount()).toBe(0);
  });

  test("a client that disconnects does not leak its waiter or timer", async () => {
    const h = makeHarness();
    const r = await h.ask();
    const controllers = [new AbortController(), new AbortController()];
    const polls = controllers.map((c) =>
      h.call("GET", `/v1/requests/${r.id}?wait=300`, { token: AGENT_TOKEN, signal: c.signal }),
    );
    await until(() => h.app.waiterCount() === 2);
    expect(h.clock.pendingTimers).toBe(2);
    controllers[0]!.abort();
    await polls[0];
    expect(h.app.waiterCount()).toBe(1);
    expect(h.clock.pendingTimers).toBe(1);
    controllers[1]!.abort();
    await polls[1];
    expect(h.app.waiterCount()).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
    // answering later finds no stale waiter
    const { token } = await h.pair();
    expect((await h.json("POST", `/v1/requests/${r.id}/answer`, { token, body: { text: "ok" } })).status).toBe(200);
  });

  test("a request that is already aborted never registers a waiter", async () => {
    const h = makeHarness();
    const r = await h.ask();
    const c = new AbortController();
    c.abort();
    await h.call("GET", `/v1/requests/${r.id}?wait=300`, { token: AGENT_TOKEN, signal: c.signal }).catch(() => {});
    expect(h.app.waiterCount()).toBe(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("app.close() releases every waiter", async () => {
    const h = makeHarness();
    const r = await h.ask();
    const poll = h.agent("GET", `/v1/requests/${r.id}?wait=300`);
    await until(() => h.app.waiterCount() === 1);
    h.app.close();
    expect((await poll).body.request.status).toBe("pending");
    expect(h.app.waiterCount()).toBe(0);
  });
});
