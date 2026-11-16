import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/ids.ts";
import { PAIRING_CODE_TTL_MS, issuePairingCode } from "../src/pairing.ts";
import { AGENT_TOKEN, ISO_MS, expectSameShape, fixture, makeHarness } from "./helpers.ts";

const pairBody = (code: string, extra: Record<string, unknown> = {}) => ({
  ...fixture("pair_request.json"),
  code,
  ...extra,
});

describe("POST /v1/pair", () => {
  test("pairs with a valid code and returns the fixture shape", async () => {
    const h = makeHarness();
    const { code } = issuePairingCode(h.store, h.clock.now());
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect(code.length).toBe(fixture("pair_request.json").code.length);
    const res = await h.json("POST", "/v1/pair", { body: pairBody(code) });
    expect(res.status).toBe(201);
    expectSameShape(res.body, fixture("pair_response.json"));
    expect(res.body.device).toMatchObject({ name: "iPhone 16", platform: "ios" });
    expect(res.body.device.id).toMatch(/^dev_/);
    expect(res.body.device.created_at).toMatch(ISO_MS);
    expect(res.body.device_token).toMatch(/^kd_[A-Za-z0-9_-]{43}$/);

    const row = h.store.getDevice(res.body.device.id)!;
    expect(row.push_token).toBe(fixture("pair_request.json").push_token);
    expect(row.push_environment).toBe("development");
    // the token works, without a token header pairing needed no auth
    expect((await h.json("GET", "/v1/requests", { token: res.body.device_token })).status).toBe(200);
  });

  test("the device token and the pairing code are stored only as hashes", async () => {
    const h = makeHarness();
    const { code } = issuePairingCode(h.store, h.clock.now());
    const codes = h.store.db.query("SELECT * FROM pairing_codes").all();
    expect(JSON.stringify(codes)).not.toContain(code);
    expect(JSON.stringify(codes)).toContain(sha256Hex(code));
    const res = await h.json("POST", "/v1/pair", { body: pairBody(code) });
    const devices = h.store.db.query("SELECT * FROM devices").all();
    expect(JSON.stringify(devices)).not.toContain(res.body.device_token);
    expect(JSON.stringify(devices)).toContain(sha256Hex(res.body.device_token));
  });

  test("defaults: push_token optional, ios → production, android → no environment", async () => {
    const h = makeHarness();
    const ios = await h.pair();
    expect(h.store.getDevice(ios.device.id)).toMatchObject({ push_token: null, push_environment: "production" });
    const android = await h.pair({ platform: "android", device_name: "Pixel 9", push_token: "fcm-token", push_environment: "development" });
    expect(android.device).toMatchObject({ name: "Pixel 9", platform: "android" });
    expect(h.store.getDevice(android.device.id)).toMatchObject({ push_token: "fcm-token", push_environment: null });
    const nulls = await h.pair({ push_token: null, push_environment: null });
    expect(h.store.getDevice(nulls.device.id)).toMatchObject({ push_token: null, push_environment: "production" });
  });

  test("a code can be used only once", async () => {
    const h = makeHarness();
    const { code } = issuePairingCode(h.store, h.clock.now());
    expect((await h.json("POST", "/v1/pair", { body: pairBody(code) })).status).toBe(201);
    const again = await h.json("POST", "/v1/pair", { body: pairBody(code) });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe("pairing_code_invalid");
    expectSameShape(again.body, fixture("error_unauthorized.json"));
    expect(h.store.listDevices()).toHaveLength(1);
  });

  test("two simultaneous uses of one code: exactly one succeeds", async () => {
    const h = makeHarness();
    const { code } = issuePairingCode(h.store, h.clock.now());
    const results = await Promise.all([1, 2, 3].map(() => h.json("POST", "/v1/pair", { body: pairBody(code) })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 401, 401]);
    expect(h.store.listDevices()).toHaveLength(1);
  });

  test("a code is valid for 10 minutes", async () => {
    const h = makeHarness();
    const early = issuePairingCode(h.store, h.clock.now());
    expect(early.expiresAt - h.clock.now()).toBe(PAIRING_CODE_TTL_MS);
    expect(PAIRING_CODE_TTL_MS).toBe(600_000);
    h.clock.advance(599_999);
    expect((await h.json("POST", "/v1/pair", { body: pairBody(early.code) })).status).toBe(201);

    const late = issuePairingCode(h.store, h.clock.now());
    h.clock.advance(600_000);
    const res = await h.json("POST", "/v1/pair", { body: pairBody(late.code) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("pairing_code_invalid");
  });

  test("a wrong code is rejected", async () => {
    const h = makeHarness();
    issuePairingCode(h.store, h.clock.now());
    for (const code of ["0".repeat(32), "nope", fixture("pair_request.json").code]) {
      const res = await h.json("POST", "/v1/pair", { body: pairBody(code) });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("pairing_code_invalid");
    }
    expect(h.store.listDevices()).toHaveLength(0);
  });

  const invalid: [string, Record<string, unknown>][] = [
    ["missing code", { code: undefined }],
    ["empty code", { code: "" }],
    ["non-string code", { code: 123 }],
    ["missing device_name", { device_name: undefined }],
    ["empty device_name", { device_name: "" }],
    ["device_name too long", { device_name: "x".repeat(201) }],
    ["missing platform", { platform: undefined }],
    ["bad platform", { platform: "windows" }],
    ["bad push_environment", { push_environment: "staging" }],
    ["non-string push_token", { push_token: 123 }],
    ["push_token too long", { push_token: "x".repeat(4097) }],
  ];
  for (const [name, extra] of invalid) {
    test(`400 invalid_request: ${name} (and the code is not consumed)`, async () => {
      const h = makeHarness();
      const { code } = issuePairingCode(h.store, h.clock.now());
      const res = await h.json("POST", "/v1/pair", { body: pairBody(code, extra) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect(h.store.listDevices()).toHaveLength(0);
      // the code itself is still usable afterwards
      expect((await h.json("POST", "/v1/pair", { body: pairBody(code) })).status).toBe(201);
    });
  }

  test("400 for malformed JSON, 413 for an oversized body", async () => {
    const h = makeHarness();
    expect((await h.json("POST", "/v1/pair", { rawBody: "not json" })).status).toBe(400);
    expect((await h.json("POST", "/v1/pair", { rawBody: "" })).status).toBe(400);
    const res = await h.json("POST", "/v1/pair", { rawBody: JSON.stringify({ code: "x".repeat(70_000) }) });
    expect(res.status).toBe(413);
  });

  test("more than 10 failures per minute from one address → 429, per address, for one minute", async () => {
    const h = makeHarness();
    h.peer = "192.168.1.50";
    for (let i = 0; i < 10; i++) {
      const res = await h.json("POST", "/v1/pair", { body: pairBody(`wrong-${i}`) });
      expect(res.status).toBe(401);
      h.clock.advance(1000);
    }
    const blocked = await h.json("POST", "/v1/pair", { body: pairBody("wrong-again") });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
    expectSameShape(blocked.body, fixture("error_unauthorized.json"));

    // even a valid code is refused while limited, and it is not consumed
    const { code } = issuePairingCode(h.store, h.clock.now());
    expect((await h.json("POST", "/v1/pair", { body: pairBody(code) })).status).toBe(429);

    // another address is unaffected
    h.peer = "192.168.1.51";
    expect((await h.json("POST", "/v1/pair", { body: pairBody("wrong") })).status).toBe(401);

    // the window slides: 50s after the first failure +10s more → the oldest failure drops out
    h.peer = "192.168.1.50";
    h.clock.advance(49_999);
    expect((await h.json("POST", "/v1/pair", { body: pairBody("wrong") })).status).toBe(429);
    h.clock.advance(1);
    expect((await h.json("POST", "/v1/pair", { body: pairBody(code) })).status).toBe(201);
  });

  test("validation errors and successes do not count as failures", async () => {
    const h = makeHarness();
    for (let i = 0; i < 15; i++) {
      expect((await h.json("POST", "/v1/pair", { body: { code: "x" } })).status).toBe(400);
      await h.pair();
    }
    expect((await h.json("POST", "/v1/pair", { body: pairBody("wrong") })).status).toBe(401);
  });

  test("the sweep forgets old failures", async () => {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) await h.json("POST", "/v1/pair", { body: pairBody("wrong") });
    expect((await h.json("POST", "/v1/pair", { body: pairBody("wrong") })).status).toBe(429);
    h.clock.advance(60_000);
    h.app.sweep();
    expect((await h.json("POST", "/v1/pair", { body: pairBody("wrong") })).status).toBe(401);
  });

  test("re-pairing the same phone moves its push token to the new pairing", async () => {
    const h = makeHarness();
    const first = await h.pair({ push_token: "same-token" });
    const second = await h.pair({ push_token: "same-token" });
    expect(h.store.getDevice(first.device.id)!.push_token).toBeNull();
    expect(h.store.getDevice(second.device.id)!.push_token).toBe("same-token");
  });
});

describe("PUT /v1/devices/me", () => {
  test("updates only the given fields", async () => {
    const h = makeHarness();
    const { token, device } = await h.pair({ push_token: "old", push_environment: "production" });

    const a = await h.json("PUT", "/v1/devices/me", { token, body: { push_token: "new-token" } });
    expect(a.status).toBe(200);
    expect(Object.keys(a.body)).toEqual(["device"]);
    expectSameShape(a.body.device, fixture("pair_response.json").device);
    expect(a.body.device).toEqual(device);
    expect(h.store.getDevice(device.id)).toMatchObject({ name: "iPhone 16", push_token: "new-token", push_environment: "production" });

    const b = await h.json("PUT", "/v1/devices/me", { token, body: { push_environment: "development", device_name: "仕事用 iPhone" } });
    expect(b.body.device).toEqual({ ...device, name: "仕事用 iPhone" });
    expect(h.store.getDevice(device.id)).toMatchObject({ name: "仕事用 iPhone", push_token: "new-token", push_environment: "development" });

    const c = await h.json("PUT", "/v1/devices/me", { token, body: {} });
    expect(c.status).toBe(200);
    expect(h.store.getDevice(device.id)).toMatchObject({ name: "仕事用 iPhone", push_token: "new-token", push_environment: "development" });
  });

  test("push_token: null clears the token; null for other fields changes nothing", async () => {
    const h = makeHarness();
    const { token, device } = await h.pair({ push_token: "tok", push_environment: "development" });
    const res = await h.json("PUT", "/v1/devices/me", { token, body: { push_token: null, device_name: null, push_environment: null } });
    expect(res.status).toBe(200);
    expect(h.store.getDevice(device.id)).toMatchObject({ name: "iPhone 16", push_token: null, push_environment: "development" });
  });

  test("a push token set here is taken away from an older pairing of the same phone", async () => {
    const h = makeHarness();
    const old = await h.pair({ push_token: "tok" });
    const fresh = await h.pair();
    await h.json("PUT", "/v1/devices/me", { token: fresh.token, body: { push_token: "tok" } });
    expect(h.store.getDevice(old.device.id)!.push_token).toBeNull();
    expect(h.store.getDevice(fresh.device.id)!.push_token).toBe("tok");
  });

  const invalid: [string, unknown][] = [
    ["non-string push_token", { push_token: 1 }],
    ["bad push_environment", { push_environment: "staging" }],
    ["empty device_name", { device_name: "" }],
    ["non-string device_name", { device_name: 7 }],
    ["device_name too long", { device_name: "x".repeat(201) }],
  ];
  for (const [name, body] of invalid) {
    test(`400 invalid_request: ${name}`, async () => {
      const h = makeHarness();
      const { token, device } = await h.pair({ push_token: "tok" });
      const res = await h.json("PUT", "/v1/devices/me", { token, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect(h.store.getDevice(device.id)).toMatchObject({ name: "iPhone 16", push_token: "tok" });
    });
  }

  test("400 for malformed JSON / missing body", async () => {
    const h = makeHarness();
    const { token } = await h.pair();
    expect((await h.json("PUT", "/v1/devices/me", { token, rawBody: "[1]" })).status).toBe(400);
    expect((await h.json("PUT", "/v1/devices/me", { token })).status).toBe(400);
  });
});

describe("DELETE /v1/devices/me", () => {
  test("unpairs: 204 with no body, the token stops working, other devices are untouched", async () => {
    const h = makeHarness();
    const a = await h.pair();
    const b = await h.pair({ device_name: "Pixel", platform: "android" });
    const r = await h.ask();
    const res = await h.call("DELETE", "/v1/devices/me", { token: a.token });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    expect((await h.json("GET", "/v1/requests", { token: a.token })).status).toBe(401);
    expect((await h.json("POST", `/v1/requests/${r.id}/answer`, { token: a.token, body: { text: "x" } })).status).toBe(401);
    expect((await h.json("DELETE", "/v1/devices/me", { token: a.token })).status).toBe(401);
    expect(h.store.listDevices().map((d) => d.id)).toEqual([b.device.id]);
    expect((await h.json("POST", `/v1/requests/${r.id}/answer`, { token: b.token, body: { text: "x" } })).status).toBe(200);
    expect((await h.agent("POST", "/v1/requests", { question: "q" })).body.delivery.paired_devices).toBe(1);
  });

  test("an answer given before unpairing keeps its device_id", async () => {
    const h = makeHarness();
    const a = await h.pair();
    const r = await h.ask();
    await h.json("POST", `/v1/requests/${r.id}/answer`, { token: a.token, body: { text: "x" } });
    await h.call("DELETE", "/v1/devices/me", { token: a.token });
    const res = await h.json("GET", `/v1/requests/${r.id}`, { token: AGENT_TOKEN });
    expect(res.body.request.answer.device_id).toBe(a.device.id);
  });
});
