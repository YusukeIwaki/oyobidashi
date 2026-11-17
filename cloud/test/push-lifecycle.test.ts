import { describe, expect, test } from "bun:test";
import { harness } from "./helpers.ts";
import { JobWorker } from "../src/worker.ts";
import { PUSH_REGISTRATION_TTL_MS as ttl } from "../../relay/src/push/lifecycle.ts";

const clientId = "synthetic-stable-client-identity-00001";
const day = 86400_000;

describe("cloud push lifecycle", () => {
  test("re-pairing at the device limit retires the old phone even before FCM/APNs supplies its new token", async () => {
    const h = harness();
    const old = await h.pair();
    await h.call("PUT", "/v1/devices/me", old.device_token, { push_client_id: clientId, push_token: "old" });
    for (let n = 1; n < 32; n++) {
      if (n % 10 === 0) h.advance(61_000);
      await h.pair();
    }
    h.advance(61_000);
    const code = await h.call("POST", "/v1/pairing-codes");
    const fresh = await h.call("POST", "/v1/pair", null, { code: code.body.code, platform: "ios", device_name: "reinstalled", push_client_id: clientId });
    expect(fresh.status).toBe(201);
    expect((await h.call("GET", "/v1/requests", old.device_token)).status).toBe(401);
    expect((await h.db.transaction("alice", tx => tx.list("device"))).length).toBe(32);
    const extraCode = await h.call("POST", "/v1/pairing-codes");
    expect((await h.call("POST", "/v1/pair", null, { code: extraCode.body.code, platform: "ios", device_name: "different phone" })).status).toBe(429);
    expect((await h.call("PUT", "/v1/devices/me", fresh.body.device_token, { push_client_id: clientId + "2" })).status).toBe(400);
    expect((await h.call("PUT", "/v1/devices/me", fresh.body.device_token, { push_client_id: "invalid" })).status).toBe(400);
  });

  test("new tokens on the same phone revoke the old account, including queued and future pushes", async () => {
    const h = harness(), sent: string[] = [];
    const pair = async (uid: string, token: string) => {
      const code = await h.call("POST", "/v1/pairing-codes", `agent-${uid}`);
      const d = await h.call("POST", "/v1/pair", null, { code: code.body.code, device_name: "phone", platform: "ios", push_client_id: clientId, push_token: token });
      expect(d.status).toBe(201);
      return d.body;
    };
    const old = await pair("alice", "old");
    await h.call("PUT", "/v1/devices/me", old.device_token, { voip_token: "old-voip" });
    await h.call("POST", "/v1/requests", "agent-alice", { question: "queued" });
    await pair("bob", "new");
    expect((await h.call("PUT", "/v1/devices/me", old.device_token, { push_token: "old" })).status).toBe(401);
    await h.call("POST", "/v1/requests", "agent-alice", { question: "future" });
    await h.call("POST", "/v1/requests", "agent-bob", { question: "new" });
    const worker = new JobWorker(h.service, { push: { ios: { send: async t => { sent.push(t.token); return { ok: true }; } } } });
    while (await worker.runOnce("push")) {}
    expect(sent).toEqual(["new"]);
  });

  test("legacy endpoints expire despite accepted sends and app traffic, and re-registering restores delivery", async () => {
    const h = harness(), sent: string[] = [], d = await h.pair();
    const worker = new JobWorker(h.service, { push: { ios: { send: async t => { sent.push(t.token); return { ok: true }; } } } });
    await h.call("PUT", "/v1/devices/me", d.device_token, { push_token: "normal", voip_token: "voip" });
    h.advance(ttl - day);
    await h.call("POST", "/v1/requests", "agent-alice", { question: "accepted" });
    while (await worker.runOnce("push")) {}
    expect(sent).toEqual(["normal"]);
    h.advance(day);
    await h.call("GET", "/v1/requests", d.device_token);
    await h.call("POST", "/v1/requests", "agent-alice", { question: "expired" });
    while (await worker.runOnce("push")) {}
    expect(sent).toEqual(["normal"]);
    const expired = await h.db.transaction("alice", tx => tx.get("device", d.device.id));
    expect(expired).toMatchObject({ push_token: null, voip_token: null });
    await h.call("PUT", "/v1/devices/me", d.device_token, { push_token: "normal" });
    await h.call("POST", "/v1/requests", "agent-alice", { question: "restored" });
    while (await worker.runOnce("push")) {}
    expect(sent).toEqual(["normal", "normal"]);
  });

  test("fresh ordinary registration does not extend the VoIP deadline", async () => {
    const h = harness(), d = await h.pair();
    await h.call("PUT", "/v1/devices/me", d.device_token, { push_token: "normal", voip_token: "voip" });
    h.advance(ttl - day);
    await h.call("PUT", "/v1/devices/me", d.device_token, { push_token: "normal" });
    h.advance(day);
    await h.call("POST", "/v1/requests", "agent-alice", { question: "prune" });
    expect(await h.db.transaction("alice", tx => tx.get("device", d.device.id))).toMatchObject({ push_token: "normal", voip_token: null });
  });

  test("the worker rejects a registration that expired after its job was queued", async () => {
    const h = harness(), d = await h.pair();
    await h.call("PUT", "/v1/devices/me", d.device_token, { push_token: "old" });
    h.advance(ttl - 1000);
    await h.call("POST", "/v1/requests", "agent-alice", { question: "queued" });
    h.advance(1000);
    let sends = 0;
    const worker = new JobWorker(h.service, { push: { ios: { send: async () => { sends++; return { ok: true }; } } } });
    while (await worker.runOnce("push")) {}
    expect(sends).toBe(0);
  });
});
