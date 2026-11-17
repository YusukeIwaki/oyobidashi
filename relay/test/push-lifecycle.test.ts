import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { makeHarness } from "./helpers.ts";
import { PUSH_REGISTRATION_TTL_MS as ttl, freshPushRegistration } from "../src/push/lifecycle.ts";
import type { Platform } from "../src/types.ts";
import type { PushTarget } from "../src/push/types.ts";

const clientId = "synthetic-stable-client-identity-00001";
const day = 86400_000;

describe("push registration lifecycle", () => {
  test("expiry allows bounded API/worker clock skew without accepting invalid timestamps", () => {
    expect(freshPushRegistration(1010, 1000)).toBe(true);
    expect(freshPushRegistration(1000, 1000 + ttl - 1)).toBe(true);
    expect(freshPushRegistration(1000, 1000 + ttl)).toBe(false);
    expect(freshPushRegistration(Infinity, 1000)).toBe(false);
    expect(freshPushRegistration(NaN, 1000)).toBe(false);
    expect(freshPushRegistration(301001, 1000)).toBe(false);
  });
  test("legacy migration preserves historical freshness across server restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "oyobidashi-push-lifecycle-"));
    const path = join(directory, "relay.sqlite");
    try {
      const db = new Database(path);
      db.exec("CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT,platform TEXT,token_hash TEXT UNIQUE,push_token TEXT,push_environment TEXT,created_at INTEGER); INSERT INTO devices VALUES('old','phone','ios','hash','legacy','production',1000)");
      db.close();
      let store = new Store(path);
      expect(store.getDevice("old")!.push_registered_at).toBe(1000);
      store.close();
      store = new Store(path);
      store.prunePushRegistrations(1000 + ttl);
      expect(store.getDevice("old")!.push_token).toBeNull();
      store.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  for (const platform of ["ios", "android"] as Platform[]) {
    test(`${platform}: reinstall with different tokens revokes old pairing and queued credentials`, async () => {
      const sent: string[] = [];
      const h = makeHarness({ push: { [platform]: { send: async (t: PushTarget) => { sent.push(t.token); return { ok: true }; } } } });
      const old = await h.pair({ platform, push_token: "old", push_client_id: clientId });
      if (platform === "ios") await h.json("PUT", "/v1/devices/me", { token: old.token, body: { voip_token: "old-voip" } });
      await h.pair({ platform, push_token: "new", push_client_id: clientId });
      expect(h.store.getDevice(old.device.id)).toBeNull();
      expect((await h.json("PUT", "/v1/devices/me", { token: old.token, body: { push_token: "old" } })).status).toBe(401);
      await h.agent("POST", "/v1/requests", { question: "q" });
      await h.app.idle();
      expect(sent).toEqual(["new"]);
    });
  }

  test("provider success never renews an abandoned registration; authenticated re-registration restores it", async () => {
    const sent: string[] = [];
    const h = makeHarness({ push: { ios: { send: async t => { sent.push(t.token); return { ok: true }; } } } });
    const d = await h.pair({ push_token: "legacy-without-client-id" });
    h.clock.advance(ttl - day);
    await h.agent("POST", "/v1/requests", { question: "q" });
    await h.app.idle();
    expect(sent).toHaveLength(1);
    h.clock.advance(day);
    // No sweep: the send path itself must enforce expiry.
    await h.agent("POST", "/v1/requests", { question: "expired" });
    await h.app.idle();
    expect(sent).toHaveLength(1);
    expect(h.store.getDevice(d.device.id)!.push_token).toBeNull();
    expect((await h.json("PUT", "/v1/devices/me", { token: d.token, body: { push_token: "legacy-without-client-id" } })).status).toBe(200);
    await h.agent("POST", "/v1/requests", { question: "restored" });
    await h.app.idle();
    expect(sent).toHaveLength(2);
  });

  test("renewing ordinary push or using the app does not renew an abandoned VoIP endpoint", async () => {
    const h = makeHarness();
    const d = await h.pair({ push_token: "normal" });
    await h.json("PUT", "/v1/devices/me", { token: d.token, body: { voip_token: "voip" } });
    h.clock.advance(ttl - day);
    await h.json("PUT", "/v1/devices/me", { token: d.token, body: { push_token: "normal" } });
    h.clock.advance(day);
    await h.json("GET", "/v1/requests", { token: d.token });
    h.app.sweep();
    expect(h.store.getDevice(d.device.id)).toMatchObject({ push_token: "normal", voip_token: null });
  });

  test("a pairing cannot change its bound client identity or displace another physical device", async () => {
    const h = makeHarness();
    const d = await h.pair({ push_client_id: clientId });
    const other = await h.pair({ push_client_id: clientId + "2" });
    expect((await h.json("PUT", "/v1/devices/me", { token: d.token, body: { push_client_id: clientId + "2" } })).status).toBe(400);
    expect(h.store.getDevice(other.device.id)).not.toBeNull();
    expect((await h.json("PUT", "/v1/devices/me", { token: d.token, body: { push_client_id: "short" } })).status).toBe(400);
  });
});
