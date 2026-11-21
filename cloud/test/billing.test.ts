import { afterAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { CloudApp } from "../src/app.ts";
import { Billing, loadBillingConfig, loadPlusGrantUids, type BillingConfig } from "../src/billing/service.ts";
import { GooglePlay } from "../src/billing/google.ts";
import { verifyAppleJws } from "../src/billing/apple.ts";
import { OFFICIAL_CLOUD_ORIGIN } from "../src/config.ts";
import { unauthorized } from "../src/errors.ts";
import { INPUT_RESTRICTION_VERSION } from "../src/input-restriction.ts";
import { JobWorker } from "../src/worker.ts";
import { fakeAppAttest, fakeAppStore } from "./billing-fixtures.ts";
import { harness } from "./helpers.ts";
import postgres from "postgres";
import { PostgresDatabase } from "../src/postgres.ts";
import type { Database } from "../src/types.ts";

const BUNDLE = "com.example.app",
  APP_ID = `TEAM123456.${BUNDLE}`,
  PRODUCT = "voice.monthly";
const store = fakeAppStore(),
  attest = fakeAppAttest(APP_ID);
const url = process.env.CLOUD_TEST_DATABASE_URL;
afterAll(() => attest.dispose());

function setup(config: Partial<BillingConfig> = {}, database?: Database) {
  const h = harness(database);
  h.service.voiceTrainingPolicy = { free: true, plus: false };
  h.service.freeInputRestricted = true;
  const billing = new Billing(h.service, {
    apple: {
      bundleId: BUNDLE,
      appId: APP_ID,
      productIds: [PRODUCT],
      environments: ["Production"],
      attestEnvironments: ["production"],
      storeRoot: store.rootPem,
      attestRoot: attest.rootPem,
    },
    ...config,
  });
  const app = new CloudApp(
    h.service,
    {
      async verify(token: string) {
        if (!token.startsWith("agent-")) throw unauthorized();
        return token.slice(6);
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    billing,
  );
  const call = async (
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = (await app.fetch(
      new Request(`${OFFICIAL_CLOUD_ORIGIN}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ))!;
    return {
      status: response.status,
      body: response.status === 204 ? null : ((await response.json()) as any),
    };
  };
  const challenge = async (token: string) =>
    (await call("POST", "/v1/billing/challenge", token, {})).body.challenge as string;
  /** Pairs a phone and attests its App Attest key. */
  const phone = async (uid: string) => {
    const paired = await h.pair(uid),
      token = paired.device_token,
      key = attest.device();
    const c = await challenge(token);
    const attested = await call("POST", "/v1/billing/apple/attest", token, {
      key_id: key.keyId,
      attestation: key.attestation(c),
      challenge: c,
    });
    expect(attested.status).toBe(204);
    const sync = async (transactions: string[]) => {
      const payload = JSON.stringify({ challenge: await challenge(token), transactions });
      return call("POST", "/v1/billing/apple", token, {
        key_id: key.keyId,
        assertion: key.assertion(payload),
        payload,
      });
    };
    return { token, key, sync, uid };
  };
  const transaction = (fields: Record<string, unknown> = {}) =>
    store.sign({
      bundleId: BUNDLE,
      productId: PRODUCT,
      environment: "Production",
      originalTransactionId: "1000",
      expiresDate: h.clock.now + 30 * 86400_000,
      signedDate: h.clock.now,
      inAppOwnershipType: "PURCHASED",
      ...fields,
    });
  const training = async (uid: string) =>
    (await call("GET", "/v1/presence", `agent-${uid}`)).body.input_restricted === true;
  /** FREE owners of the hosted service accept the input restriction before any call. */
  const acceptInputRestriction = (uid: string) =>
    h.db.transaction(uid, (tx) => h.service.acceptInputRestriction(tx, INPUT_RESTRICTION_VERSION));
  return { h, app, call, challenge, phone, transaction, training, billing, acceptInputRestriction };
}

describe("subscription billing", () => {
  test("a deployment without stores reports billing as disabled", async () => {
    const h = harness(),
      d = await h.pair();
    expect((await h.call("GET", "/v1/billing", d.device_token)).body).toEqual({ enabled: false });
    expect((await h.call("POST", "/v1/billing/challenge", d.device_token, {})).status).toBe(404);
    expect((await h.call("POST", "/v1/billing/webhooks/apple", null, {})).status).toBe(404);
    expect(loadBillingConfig({})).toEqual({});
    // Without a restricted free model, agents see no notice.
    expect((await h.call("GET", "/v1/presence")).body.input_restricted).toBeUndefined();
  });

  test("an attested device activates the owner's subscription", async () => {
    const s = setup(),
      p = await s.phone("alice");
    expect((await s.call("GET", "/v1/billing", p.token)).body).toEqual({
      enabled: true,
      active: false,
      expires_at: null,
      active_stores: [],
      purchase_account_id: expect.any(String),
      voice_training: { free: true, plus: false },
      apple: { product_ids: [PRODUCT] },
    });
    expect(await s.training("alice")).toBe(true);
    const created = await s.call("POST", "/v1/requests", "agent-alice", { question: "q" });
    expect(created.body.delivery.input_restricted).toBe(true);

    const synced = await p.sync([await s.transaction()]);
    expect(synced.status).toBe(200);
    expect(synced.body.active).toBe(true);
    expect(Date.parse(synced.body.expires_at)).toBe(s.h.clock.now + 30 * 86400_000);
    expect(await s.training("alice")).toBe(false);
    expect(
      (await s.call("POST", "/v1/requests", "agent-alice", { question: "q2" })).body.delivery
        .input_restricted,
    ).toBeUndefined();
    // The subscription simply runs out; no device has to report that.
    s.h.advance(31 * 86400_000);
    expect((await s.call("GET", "/v1/billing", p.token)).body.active).toBe(false);
    expect(await s.training("alice")).toBe(true);
  });

  test("agents and MCP callers cannot use billing routes", async () => {
    const s = setup();
    await s.h.pair("alice");
    expect((await s.call("GET", "/v1/billing", "agent-alice")).status).toBe(403);
    expect((await s.call("POST", "/v1/billing/challenge", "agent-alice", {})).status).toBe(403);
    expect((await s.call("POST", "/v1/billing/challenge", null, {})).status).toBe(401);
  });

  test("billing stays disabled on the legacy hostname even on the official deployment", async () => {
    const s = setup();
    const d = await s.h.pair();
    const request = (path: string, method: string) =>
      s.app.fetch(new Request(`https://oyobidashi.up.railway.app${path}`, {
        method,
        headers: { authorization: `Bearer ${d.device_token}` },
        ...(method === "POST" ? { body: "{}" } : {}),
      }));
    expect(await (await request("/v1/billing", "GET"))?.json()).toEqual({ enabled: false });
    expect((await request("/v1/billing/challenge", "POST"))?.status).toBe(404);
    expect((await request("/v1/billing/webhooks/apple", "POST"))?.status).toBe(404);
  });

  test("a sync needs a fresh challenge, the attested key and a valid assertion", async () => {
    const s = setup(),
      p = await s.phone("alice"),
      jws = await s.transaction();
    const send = (payload: string, extra: Record<string, unknown> = {}) =>
      s.call("POST", "/v1/billing/apple", p.token, {
        key_id: p.key.keyId,
        assertion: p.key.assertion(payload),
        payload,
        ...extra,
      });
    const body = async () =>
      JSON.stringify({ challenge: await s.challenge(p.token), transactions: [jws] });

    // Unknown challenge, and a challenge issued to another device.
    expect((await send(JSON.stringify({ challenge: "nope", transactions: [jws] }))).status).toBe(409);
    const other = await s.phone("bob");
    const foreign = JSON.stringify({ challenge: await s.challenge(other.token), transactions: [jws] });
    expect((await send(foreign)).body.error.code).toBe("challenge_expired");

    // A different key than the attested one must attest first.
    const stranger = attest.device(),
      p1 = await body();
    const wrongKey = await s.call("POST", "/v1/billing/apple", p.token, {
      key_id: stranger.keyId,
      assertion: stranger.assertion(p1),
      payload: p1,
    });
    expect(wrongKey.status).toBe(409);
    expect(wrongKey.body.error.code).toBe("attestation_required");

    // The assertion must cover exactly the payload that was sent.
    const p2 = await body();
    const tampered = await s.call("POST", "/v1/billing/apple", p.token, {
      key_id: p.key.keyId,
      assertion: p.key.assertion(p2),
      payload: p2.replace(jws, jws + " "),
    });
    expect(tampered.body.error.code).toBe("attestation_failed");

    // Wrong app and a replayed counter are rejected.
    const p3 = await body();
    expect(
      (await send(p3, { assertion: p.key.assertion(p3, { appId: "TEAM123456.other.app" }) })).body
        .error.code,
    ).toBe("attestation_failed");
    const p4 = await body();
    expect((await send(p4)).status).toBe(200);
    const p5 = await body();
    expect(
      (await send(p5, { assertion: p.key.assertion(p5, { counter: 1 }) })).body.error.code,
    ).toBe("attestation_failed");

    // A used challenge cannot be replayed even with a fresh assertion.
    expect((await send(p4)).body.error.code).toBe("challenge_expired");
    // An expired challenge is refused.
    const p6 = await body();
    s.h.advance(301_000);
    expect((await send(p6)).body.error.code).toBe("challenge_expired");
  });

  test("invalid billing syncs still exhaust the per-owner quota", async () => {
    const s = setup(), phone = await s.phone("alice");
    const payload = JSON.stringify({ challenge: "unknown-challenge", transactions: [] });
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++)
      statuses.push((await s.call("POST", "/v1/billing/apple", phone.token, {
        key_id: phone.key.keyId, assertion: phone.key.assertion(payload), payload,
      })).status);
    expect(statuses).toContain(409);
    expect(statuses.at(-1)).toBe(429);
  });

  test("attestation rejects other apps, environments, keys and challenges", async () => {
    const s = setup(),
      d = await s.h.pair("alice"),
      token = d.device_token;
    const attempt = async (make: (c: string) => Record<string, unknown>) => {
      const c = await s.challenge(token);
      return s.call("POST", "/v1/billing/apple/attest", token, make(c));
    };
    const key = attest.device();
    expect(
      (await attempt((c) => ({ key_id: key.keyId, attestation: key.attestation(c, "TEAM123456.evil"), challenge: c }))).body.error.code,
    ).toBe("attestation_failed");
    const dev = attest.device("development");
    expect(
      (await attempt((c) => ({ key_id: dev.keyId, attestation: dev.attestation(c), challenge: c }))).body.error.code,
    ).toBe("attestation_failed");
    const other = attest.device();
    expect(
      (await attempt((c) => ({ key_id: other.keyId, attestation: key.attestation(c), challenge: c }))).body.error.code,
    ).toBe("attestation_failed");
    // Attested for a different challenge than the one presented.
    const stale = key.attestation("some-other-challenge");
    expect(
      (await attempt((c) => ({ key_id: key.keyId, attestation: stale, challenge: c }))).body.error.code,
    ).toBe("attestation_failed");
    expect(
      (await attempt((c) => ({ key_id: key.keyId, attestation: Buffer.from("junk").toString("base64"), challenge: c }))).body.error.code,
    ).toBe("attestation_failed");
    expect(
      (await attempt((c) => ({ key_id: key.keyId, attestation: key.attestation(c), challenge: c }))).status,
    ).toBe(204);
  });

  test("transactions for other apps, products, environments or signers are ignored", async () => {
    const s = setup(),
      p = await s.phone("alice");
    const foreignStore = fakeAppStore();
    const ignored = [
      await s.transaction({ bundleId: "com.other.app" }),
      await s.transaction({ productId: "other.product" }),
      await s.transaction({ environment: "Sandbox" }),
      await s.transaction({ environment: "Xcode" }),
      await s.transaction({ originalTransactionId: "../x" }),
      await foreignStore.sign({
        bundleId: BUNDLE,
        productId: PRODUCT,
        environment: "Production",
        originalTransactionId: "1",
        expiresDate: s.h.clock.now + 1e9,
      }),
      "not-a-jws",
      // Same header and payload, signature bytes altered.
      (await s.transaction()).replace(/(.)(.{20})$/, (_, c, rest) => (c === "A" ? "B" : "A") + rest),
    ];
    const r = await p.sync(ignored);
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(false);
    await expect(verifyAppleJws(await s.transaction(), s.h.clock.now)).rejects.toThrow();
  });

  test("an existing purchase remains with its registered owner when restored", async () => {
    const s = setup(),
      alice = await s.phone("alice"),
      bob = await s.phone("bob"),
      jws = await s.transaction();
    expect((await alice.sync([jws])).body.active).toBe(true);
    expect((await bob.sync([jws])).body.active).toBe(false);
    const replacement = await s.phone("alice");
    expect((await replacement.sync([jws])).body.active).toBe(true);
    expect((await alice.sync([])).body.active).toBe(true);
  });

  test("a StoreKit purchase with an account token first activates only for that account", async () => {
    const s = setup(), alice = await s.phone("alice"), bob = await s.phone("bob");
    const status = async (token: string) => (await s.call("GET", "/v1/billing", token)).body;
    const accountId: string = (await status(alice.token)).purchase_account_id;
    expect(accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await status(bob.token)).purchase_account_id).not.toBe(accountId);
    const replacement = await s.phone("alice");
    expect((await status(replacement.token)).purchase_account_id).toBe(accountId);
    const jws = await s.transaction({ appAccountToken: accountId.toUpperCase() });
    expect((await bob.sync([jws])).body.active).toBe(false);
    expect((await replacement.sync([jws])).body.active).toBe(true);
  });

  test("a refunded transaction cannot be replayed by its owner or another account", async () => {
    const s = setup(), alice = await s.phone("alice"), bob = await s.phone("bob");
    const old = await s.transaction();
    expect((await alice.sync([old])).body.active).toBe(true);
    const revoked = await s.transaction({ revocationDate: s.h.clock.now + 1, signedDate: s.h.clock.now + 1 });
    expect((await alice.sync([revoked, old])).body.active).toBe(false);
    expect((await alice.sync([old])).body.active).toBe(false);
    expect((await bob.sync([old])).body.active).toBe(false);
  });

  test("a stale transaction or notification cannot shorten a renewal", async () => {
    const s = setup(), phone = await s.phone("alice");
    const old = await s.transaction({ expiresDate: s.h.clock.now + 86400_000 });
    const later = await s.transaction({ expiresDate: s.h.clock.now + 31 * 86400_000, signedDate: s.h.clock.now + 1 });
    await phone.sync([old]);
    await phone.sync([later]);
    const expected = new Date(s.h.clock.now + 31 * 86400_000).toISOString();
    expect((await phone.sync([old])).body.expires_at).toBe(expected);
    await s.call("POST", "/v1/billing/webhooks/apple", null, {
      signedPayload: await store.sign({ notificationType: "DID_RENEW", data: {
        bundleId: BUNDLE, signedTransactionInfo: old,
      } }),
    });
    expect((await s.call("GET", "/v1/billing", phone.token)).body.expires_at).toBe(expected);
  });

  test("a family or assigned seat stays with its registered owner", async () => {
    const s = setup(), alice = await s.phone("alice"), bob = await s.phone("bob");
    for (const ownership of ["FAMILY_SHARED", "ASSIGNED"]) {
      const shared = await s.transaction({ originalTransactionId: ownership === "ASSIGNED" ? "5000" : "6000",
        appTransactionId: "7000", inAppOwnershipType: ownership });
      expect((await alice.sync([shared])).body.active).toBe(true);
      expect((await bob.sync([shared])).body.active).toBe(false);
      expect((await s.call("GET", "/v1/billing", alice.token)).body.active).toBe(true);
    }
    const missingOwnership = await s.transaction({ inAppOwnershipType: undefined });
    expect((await bob.sync([missingOwnership])).body.active).toBe(false);
  });

  test("organization-assigned and family-shared seats need no purchase on the device", async () => {
    const s = setup(),
      alice = await s.phone("alice"),
      bob = await s.phone("bob");
    // No appAccountToken, no purchase on the device: only the ownership type differs.
    const seat = (account: string, fields: Record<string, unknown> = {}) =>
      s.transaction({ originalTransactionId: "2000", appTransactionId: account, inAppOwnershipType: "ASSIGNED", ...fields });
    expect((await alice.sync([await seat("3001")])).body.active).toBe(true);
    expect((await bob.sync([await seat("3002")])).body.active).toBe(true);
    expect((await s.call("GET", "/v1/billing", alice.token)).body.active).toBe(true);
    // The organization takes Bob's seat back; Alice keeps hers.
    const revoked = await seat("3002", { revocationDate: s.h.clock.now, revocationType: "ASSIGNMENT_REVOKE" });
    expect((await bob.sync([revoked])).body.active).toBe(false);
    expect((await s.call("GET", "/v1/billing", alice.token)).body.active).toBe(true);
    const family = await s.transaction({ originalTransactionId: "3000", appTransactionId: "4001", inAppOwnershipType: "FAMILY_SHARED" });
    expect((await bob.sync([family])).body.active).toBe(true);
  });

  test("App Store notifications renew, expire and refund without a device", async () => {
    const s = setup(),
      p = await s.phone("alice");
    await p.sync([await s.transaction({ expiresDate: s.h.clock.now + 86400_000 })]);
    const notify = async (fields: Record<string, unknown>, renewal?: Record<string, unknown>) =>
      s.call("POST", "/v1/billing/webhooks/apple", null, {
        signedPayload: await store.sign({
          notificationType: "DID_RENEW",
          data: {
            bundleId: BUNDLE,
            environment: "Production",
            signedTransactionInfo: await s.transaction(fields),
            ...(renewal ? { signedRenewalInfo: await store.sign(renewal) } : {}),
          },
        }),
      });
    const renewed = s.h.clock.now + 31 * 86400_000;
    // Billing retry with a grace period keeps access until the grace period ends.
    const grace = s.h.clock.now + 5 * 86400_000;
    await notify({ expiresDate: s.h.clock.now - 1 }, { originalTransactionId: "1000", autoRenewProductId: PRODUCT, environment: "Production", gracePeriodExpiresDate: grace });
    expect(Date.parse((await s.call("GET", "/v1/billing", p.token)).body.expires_at)).toBe(grace);
    expect((await notify({ expiresDate: renewed })).status).toBe(204);
    expect(Date.parse((await s.call("GET", "/v1/billing", p.token)).body.expires_at)).toBe(renewed);
    await notify({ expiresDate: renewed, revocationDate: s.h.clock.now });
    expect((await s.call("GET", "/v1/billing", p.token)).body.active).toBe(false);
    // A later notification for a subscription nobody holds is acknowledged and ignored.
    expect((await notify({ originalTransactionId: "9999" })).status).toBe(204);
    expect((await s.call("GET", "/v1/billing", p.token)).body.active).toBe(false);
    // Unsigned or foreign notifications are refused.
    expect((await s.call("POST", "/v1/billing/webhooks/apple", null, { signedPayload: "x.y.z" })).status).toBe(401);
    expect(
      (await s.call("POST", "/v1/billing/webhooks/apple", null, {
        signedPayload: await fakeAppStore().sign({ data: {} }),
      })).status,
    ).toBe(401);
  });

  test("a grace period signed for another subscription does not revive an expired one", async () => {
    const s = setup(),
      p = await s.phone("alice");
    await p.sync([await s.transaction({ expiresDate: s.h.clock.now + 1 })]);
    s.h.advance(2);
    expect((await s.call("GET", "/v1/billing", p.token)).body.active).toBe(false);
    const grace = s.h.clock.now + 5 * 86400_000;
    const notice = async (renewal: Record<string, unknown>) =>
      s.call("POST", "/v1/billing/webhooks/apple", null, {
        signedPayload: await store.sign({
          notificationType: "DID_FAIL_TO_RENEW",
          data: {
            bundleId: BUNDLE,
            environment: "Production",
            signedTransactionInfo: await s.transaction({ expiresDate: s.h.clock.now - 1, signedDate: s.h.clock.now + 1 }),
            signedRenewalInfo: await store.sign(renewal),
          },
        }),
      });
    // Another subscription's grace, another product's grace and another
    // environment's grace all leave the expired subscription expired.
    for (const renewal of [
      { originalTransactionId: "9999", autoRenewProductId: PRODUCT, environment: "Production", gracePeriodExpiresDate: grace },
      { originalTransactionId: "1000", autoRenewProductId: "other.product", environment: "Production", gracePeriodExpiresDate: grace },
      { originalTransactionId: "1000", autoRenewProductId: PRODUCT, environment: "Sandbox", gracePeriodExpiresDate: grace },
    ]) {
      expect((await notice(renewal)).status).toBe(204);
      expect((await s.call("GET", "/v1/billing", p.token)).body.active).toBe(false);
    }
    // The matching renewal info still extends its own subscription.
    expect((await notice({ originalTransactionId: "1000", autoRenewProductId: PRODUCT, environment: "Production", gracePeriodExpiresDate: grace })).status).toBe(204);
    expect(Date.parse((await s.call("GET", "/v1/billing", p.token)).body.expires_at)).toBe(grace);
  });

  test("a real-sized notification with renewal info is accepted; a device transaction stays bounded", async () => {
    const s = setup(), p = await s.phone("alice");
    expect((await p.sync([await s.transaction()])).body.active).toBe(true);
    // Apple's x5c is a 1076 B leaf, the 794 B WWDR G6 and the 583 B Root G3:
    // a protected header of about 4,400 characters on each of the three JWS.
    const header = Math.ceil((JSON.stringify({ alg: "ES256", x5c: [1076, 794, 583].map((n) => "A".repeat(Math.ceil(n / 3) * 4)) }).length * 4) / 3);
    /** Signs with the small test chain, padded to the length Apple's chain would give. */
    const sized = async (payload: Record<string, unknown>) => {
      const target = header + 1 + Math.ceil((JSON.stringify(payload).length * 4) / 3) + 1 + 86;
      const bare = await store.sign(payload);
      return store.sign({ ...payload, pad: "x".repeat(Math.max(0, Math.floor(((target - bare.length) * 3) / 4))) });
    };
    const base = {
      bundleId: BUNDLE, productId: PRODUCT, environment: "Production", originalTransactionId: "1000",
      expiresDate: s.h.clock.now + 30 * 86400_000, signedDate: s.h.clock.now + 1, inAppOwnershipType: "PURCHASED",
    };
    const refunded = await sized({ ...base, revocationDate: s.h.clock.now + 1 });
    const renewal = await sized({ originalTransactionId: "1000", autoRenewProductId: PRODUCT, autoRenewStatus: 0, environment: "Production" });
    const notice = await sized({
      notificationType: "REFUND",
      data: { bundleId: BUNDLE, environment: "Production", signedTransactionInfo: refunded, signedRenewalInfo: renewal },
    });
    expect(notice.length).toBeGreaterThan(16_384);
    expect((await s.call("POST", "/v1/billing/webhooks/apple", null, { signedPayload: notice })).status).toBe(204);
    expect((await s.call("GET", "/v1/billing", p.token)).body.active).toBe(false);
    // The wider limit is for notifications only.
    const bob = await s.phone("bob");
    const huge = await store.sign({ ...base, originalTransactionId: "3000", pad: "x".repeat(16_000) });
    expect((await bob.sync([huge])).body.active).toBe(false);
  });

  test("the worker gives subscribers the standard model and everyone else the free one", async () => {
    const s = setup();
    const used: string[] = [];
    const provider = (name: string) => ({
      turn: async () => {
        used.push(name);
        return { reply: "ok", resolved: false, answer: null };
      },
    });
    const worker = new JobWorker(s.h.service, {
      conversation: provider("standard"),
      freeConversation: provider("free"),
    });
    await s.acceptInputRestriction("alice");
    const voice = await s.h.setup("alice");
    await voice.turn("one");
    await worker.runOnce("turn");
    // Subscribe with a second, attested phone of the same account.
    const p = await s.phone("alice");
    expect((await p.sync([await s.transaction()])).body.active).toBe(true);
    await voice.turn("two");
    await worker.runOnce("turn");
    s.h.advance(31 * 86400_000);
    expect(used).toEqual(["free", "standard"]);

    // A deployment with one model never looks at subscriptions or restricts input.
    s.h.service.freeInputRestricted = false;
    const single = new JobWorker(s.h.service, { conversation: provider("only") });
    const bob = await s.h.setup("bob");
    await bob.turn("x");
    await single.runOnce("turn");
    expect(used.at(-1)).toBe("only");
  });

  test("a failing free model is never replaced by the standard one", async () => {
    const s = setup();
    let standard = 0;
    const worker = new JobWorker(s.h.service, {
      conversation: { turn: async () => (standard++, { reply: "ok", resolved: false, answer: null }) },
      freeConversation: { turn: async () => { throw new Error("down"); } },
    });
    await s.acceptInputRestriction("alice");
    const voice = await s.h.setup("alice"),
      t = await voice.turn("one");
    await worker.runOnce("turn");
    expect(standard).toBe(0);
    expect((await s.h.turn(t.turnId))!.state).toBe("failed");
  });
});

describe("Google Play billing", () => {
  const PACKAGE = "com.example.android",
    pubsub = { audience: "https://example/webhook", serviceAccount: "push@example.iam.gserviceaccount.com" },
    hashOf = (text: string) => createHash("sha256").update(text).digest("base64url");
  function google(overrides: { verdict?: Record<string, any>; purchases?: Record<string, any> } = {}, database?: Database) {
    const calls: string[] = [];
    let now = Date.now();
    const state = { requestHash: "", purchases: overrides.purchases ?? {} as Record<string, any> };
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method} ${u.replace(/^https:\/\/[^/]+/, "")}`);
      if (u === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" }] });
      if (u.includes("oauth2")) return Response.json({ access_token: "t", expires_in: 3600 });
      if (u.includes(":decodeIntegrityToken"))
        return Response.json({
          tokenPayloadExternal: {
            requestDetails: { requestPackageName: PACKAGE, requestHash: state.requestHash, timestampMillis: String(now) },
            appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: PACKAGE },
            deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
            ...overrides.verdict,
          },
        });
      if (u.includes(":acknowledge")) return Response.json({});
      const token = decodeURIComponent(u.split("/tokens/")[1]!);
      const purchase = state.purchases[token];
      return purchase ? Response.json(purchase) : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const play = new GooglePlay({
      packageName: PACKAGE,
      serviceAccount: {
        project_id: "p",
        client_email: "billing@example.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      },
      pubsub,
      fetch: send,
      now: () => now,
    });
    const s = setup({ google: { productIds: ["voice_monthly"], play } }, database);
    now = s.h.clock.now;
    const sync = async (token: string, purchases: unknown[], hash?: string) => {
      const payload = JSON.stringify({ challenge: await s.challenge(token), purchases });
      state.requestHash = hash ?? hashOf(payload);
      return s.call("POST", "/v1/billing/google", token, { integrity_token: "it", payload });
    };
    const notify = async (event: Record<string, unknown>) => {
      const token = await new SignJWT({ email: pubsub.serviceAccount, email_verified: true })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer("https://accounts.google.com")
        .setAudience(pubsub.audience)
        .setExpirationTime("5m")
        .sign(privateKey);
      const data = Buffer.from(JSON.stringify({ packageName: PACKAGE, ...event })).toString("base64");
      return s.call("POST", "/v1/billing/webhooks/google", token, { message: { data } });
    };
    return { s, calls, state, sync, notify };
  }
  const active = (now: number, extra: Record<string, unknown> = {}) => ({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    lineItems: [{ productId: "voice_monthly", expiryTime: new Date(now + 30 * 86400_000).toISOString() }],
    ...extra,
  });

  test("a genuine Play install activates and acknowledges a purchase", async () => {
    const g = google(),
      d = await g.s.h.pair("alice", "android");
    g.state.purchases.tok = active(g.s.h.clock.now);
    const r = await g.sync(d.device_token, [{ product_id: "voice_monthly", purchase_token: "tok" }]);
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(true);
    expect(r.body.active_stores).toEqual(["google"]);
    expect(r.body.google).toEqual({ product_ids: ["voice_monthly"] });
    expect(g.calls.some((c) => c.includes("/purchases/subscriptions/voice_monthly/tokens/tok:acknowledge"))).toBe(true);
    // The raw purchase token is not stored.
    expect(JSON.stringify([...(g.s.h.db as any).records.values()])).not.toContain("tok\"");
    const bob = await g.s.h.pair("bob", "android");
    expect((await g.sync(bob.device_token, [{ purchase_token: "tok" }])).body.active).toBe(false);
    expect((await g.s.call("GET", "/v1/billing", d.device_token)).body.active).toBe(true);
  });

  test("both platforms see the same owner's active subscription stores", async () => {
    const g = google();
    const ios = await g.s.phone("alice");
    const android = await g.s.h.pair("alice", "android");
    const other = await g.s.h.pair("bob", "android");
    const shortExpiry = g.s.h.clock.now + 86400_000;
    await ios.sync([await g.s.transaction({ expiresDate: shortExpiry })]);
    const status = async (token: string) => (await g.s.call("GET", "/v1/billing", token)).body;
    expect((await status(android.device_token)).active_stores).toEqual(["apple"]);
    expect((await status(other.device_token)).active_stores).toEqual([]);

    g.state.purchases.tok = active(g.s.h.clock.now);
    await g.sync(android.device_token, [{ product_id: "voice_monthly", purchase_token: "tok" }]);
    expect((await status(ios.token)).active_stores).toEqual(["apple", "google"]);
    g.s.h.advance(2 * 86400_000);
    const remaining = await status(ios.token);
    expect(remaining.active).toBe(true);
    expect(remaining.active_stores).toEqual(["google"]);
  });

  test.skipIf(!url)("concurrent App Store and Google Play syncs retain both subscriptions on PostgreSQL", async () => {
    const admin = postgres(url!, { max: 1, onnotice: () => {} });
    const schema = `oyobidashi_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const db = new PostgresDatabase(url!, 2, schema);
    try {
      await db.migrate();
      const g = google({}, db);
      const ios = await g.s.phone("alice");
      const android = await g.s.h.pair("alice", "android");
      const day = 86400_000;
      const now = g.s.h.clock.now;
      const apple = await g.s.transaction({ expiresDate: now + day });
      g.state.purchases.tok = active(now);

      const [appleSync, googleSync] = await Promise.all([
        ios.sync([apple]),
        g.sync(android.device_token, [{ product_id: "voice_monthly", purchase_token: "tok" }]),
      ]);
      expect(appleSync.status).toBe(200);
      expect(googleSync.status).toBe(200);

      const status = async (token: string) => (await g.s.call("GET", "/v1/billing", token)).body;
      const expiry = new Date(now + 30 * day).toISOString();
      for (const token of [ios.token, android.device_token]) {
        expect(await status(token)).toMatchObject({ active: true, active_stores: ["apple", "google"], expires_at: expiry });
      }
      g.s.h.advance(2 * day);
      expect(await status(ios.token)).toMatchObject({ active: true, active_stores: ["google"], expires_at: expiry });
      g.s.h.advance(29 * day);
      expect(await status(android.device_token)).toMatchObject({ active: false, active_stores: [], expires_at: null });
    } finally {
      await db.close();
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  test("Play verifies the account ID before registering or acknowledging a purchase", async () => {
    const g = google(), alice = await g.s.h.pair("alice", "android"), bob = await g.s.h.pair("bob", "android");
    const status = (await g.s.call("GET", "/v1/billing", alice.device_token)).body;
    g.state.purchases.bound = active(g.s.h.clock.now, {
      externalAccountIdentifiers: { obfuscatedExternalAccountId: status.purchase_account_id },
    });
    const purchases = [{ purchase_token: "bound" }];
    expect((await g.sync(bob.device_token, purchases)).body.active).toBe(false);
    expect(g.calls.some((c) => c.includes(":acknowledge"))).toBe(false);
    expect((await g.sync(alice.device_token, purchases)).body.active).toBe(true);
    expect(g.calls.some((c) => c.includes(":acknowledge"))).toBe(true);
  });

  test("a linked Play purchase can replace its predecessor only for the same owner", async () => {
    const g = google(), alice = await g.s.h.pair("alice", "android"), bob = await g.s.h.pair("bob", "android");
    const current = g.s.h.clock.now;
    g.state.purchases.old = active(current);
    g.state.purchases.new = active(current + 86400_000, { linkedPurchaseToken: "old" });
    expect((await g.sync(alice.device_token, [{ purchase_token: "old" }])).body.active).toBe(true);
    expect((await g.sync(bob.device_token, [{ purchase_token: "new" }])).body.active).toBe(false);
    expect(g.calls.some((c) => c.includes("/tokens/new:acknowledge"))).toBe(false);
    expect((await g.sync(alice.device_token, [{ purchase_token: "new" }])).body.expires_at).toBe(
      g.state.purchases.new.lineItems[0].expiryTime,
    );
    g.state.purchases.new = active(current, { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" });
    expect((await g.sync(alice.device_token, [{ purchase_token: "new" }])).body.active).toBe(false);
    expect((await g.sync(alice.device_token, [{ purchase_token: "old" }])).body.active).toBe(false);
    g.state.purchases.new = active(current);
    expect((await g.sync(bob.device_token, [{ purchase_token: "new" }])).body.active).toBe(false);
    expect((await g.sync(alice.device_token, [{ purchase_token: "new" }])).body.active).toBe(true);
  });

  test("a Play resubscription from the store uses the previous purchase owner after expiry", async () => {
    const g = google(), alice = await g.s.h.pair("alice", "android"), bob = await g.s.h.pair("bob", "android");
    const current = g.s.h.clock.now;
    g.state.purchases.old = active(current);
    await g.sync(alice.device_token, [{ purchase_token: "old" }]);
    g.state.purchases.old = active(current, { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" });
    expect((await g.sync(alice.device_token, [{ purchase_token: "old" }])).body.active).toBe(false);
    g.state.purchases.new = active(current, {
      outOfAppPurchaseContext: { expiredPurchaseToken: "old" },
    });
    expect((await g.sync(bob.device_token, [{ purchase_token: "new" }])).body.active).toBe(false);
    expect((await g.sync(alice.device_token, [{ purchase_token: "new" }])).body.active).toBe(true);
  });

  test("integrity verdicts gate the sync", async () => {
    for (const verdict of [
      { appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION", packageName: PACKAGE } },
      { deviceIntegrity: { deviceRecognitionVerdict: [] } },
      { deviceIntegrity: {} },
      { requestDetails: { requestPackageName: "other", requestHash: "", timestampMillis: "0" } },
    ]) {
      const g = google({ verdict }),
        d = await g.s.h.pair("alice", "android");
      g.state.purchases.tok = active(g.s.h.clock.now);
      const r = await g.sync(d.device_token, [{ product_id: "voice_monthly", purchase_token: "tok" }]);
      expect(r.body.error?.code).toBe("attestation_failed");
      expect(g.calls.some((c) => c.includes("/purchases/"))).toBe(false);
    }
    // The token must be bound to this exact payload.
    const g = google(),
      d = await g.s.h.pair("alice", "android");
    const r = await g.sync(d.device_token, [], "another-hash");
    expect(r.body.error.code).toBe("attestation_failed");
  });

  test("expired, unknown and foreign purchases grant nothing", async () => {
    const g = google(),
      d = await g.s.h.pair("alice", "android"),
      now = g.s.h.clock.now;
    g.state.purchases.expired = active(now, { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" });
    g.state.purchases.other = active(now, {
      lineItems: [{ productId: "something_else", expiryTime: new Date(now + 1e9).toISOString() }],
    });
    const r = await g.sync(d.device_token, [
      { product_id: "voice_monthly", purchase_token: "expired" },
      { product_id: "voice_monthly", purchase_token: "other" },
      { product_id: "voice_monthly", purchase_token: "missing" },
      { product_id: "voice_monthly" },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(false);
    expect(g.calls.some((c) => c.includes(":acknowledge"))).toBe(false);
  });

  test("a Play test purchase grants nothing and is not acknowledged", async () => {
    const g = google(),
      d = await g.s.h.pair("alice", "android");
    g.state.purchases.testtok = active(g.s.h.clock.now, { testPurchase: {} });
    const r = await g.sync(d.device_token, [{ product_id: "voice_monthly", purchase_token: "testtok" }]);
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(false);
    expect(g.calls.some((c) => c.includes(":acknowledge"))).toBe(false);
  });

  test("voided Play subscriptions retain access until expiry or lose it immediately after revocation", async () => {
    const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : undefined;
    const schema = `oyobidashi_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = url ? new PostgresDatabase(url, 2, schema) : undefined;
    try {
      if (admin && db) {
        await admin.unsafe(`CREATE SCHEMA ${schema}`);
        await db.migrate();
      }
      const g = google({}, db);
      const { device_token } = await g.s.h.pair("alice", "android");
      const activeStatus = async () => (await g.s.call("GET", "/v1/billing", device_token)).body;
      const notifyVoided = (purchaseToken: string) => g.notify({
        voidedPurchaseNotification: { purchaseToken, orderId: "test-order", productType: 1, refundType: 1 },
      });

      const now = g.s.h.clock.now;
      const expiryTime = new Date(now + 60_000).toISOString();
      g.state.purchases.refund = active(now, {
        lineItems: [{ productId: "voice_monthly", expiryTime }],
      });
      expect((await g.sync(device_token, [{ purchase_token: "refund" }])).body.active).toBe(true);
      g.state.purchases.refund.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
      g.calls.length = 0;
      expect((await notifyVoided("refund")).status).toBe(204);
      expect(g.calls).toContain(`GET /androidpublisher/v3/applications/${PACKAGE}/purchases/subscriptionsv2/tokens/refund`);
      expect(await activeStatus()).toMatchObject({ active: true, expires_at: expiryTime });
      g.s.h.advance(59_999);
      expect((await activeStatus()).active).toBe(true);
      g.s.h.advance(1);
      expect((await activeStatus()).active).toBe(false);

      g.state.purchases.revoked = active(g.s.h.clock.now);
      expect((await g.sync(device_token, [{ purchase_token: "revoked" }])).body.active).toBe(true);
      // Play can report an ended state while the previous period was still on record.
      g.state.purchases.revoked.subscriptionState = "SUBSCRIPTION_STATE_EXPIRED";
      g.state.purchases.revoked.acknowledgementState = "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";
      g.calls.length = 0;
      expect((await notifyVoided("revoked")).status).toBe(204);
      expect(g.calls).toContain(`GET /androidpublisher/v3/applications/${PACKAGE}/purchases/subscriptionsv2/tokens/revoked`);
      expect(await activeStatus()).toMatchObject({ active: false, active_stores: [], expires_at: null });
    } finally {
      await db?.close();
      if (admin) {
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    }
  });

  test("voided one-time products do not trigger a subscription lookup", async () => {
    const g = google();
    const r = await g.notify({
      voidedPurchaseNotification: { purchaseToken: "item", orderId: "test-order", productType: 2, refundType: 1 },
    });
    expect(r.status).toBe(204);
    expect(g.calls.some((c) => c.includes("/purchases/"))).toBe(false);
  });

  test("Pub/Sub pushes without Google's signature are refused", async () => {
    const g = google();
    const r = await g.s.call("POST", "/v1/billing/webhooks/google", null, { message: { data: "" } }, {
      authorization: "Bearer not-a-jwt",
    });
    expect(r.status).toBe(401);
  });
});

describe.skipIf(!url)("subscription billing on real PostgreSQL", () => {
  test("a linked Play token atomically replaces access for its recorded owner, even with a one-connection pool", async () => {
    const admin = postgres(url!, { max: 1, onnotice: () => {} });
    const schema = `oyobidashi_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const db = new PostgresDatabase(url!, 1, schema);
    try {
      await db.migrate();
      const value = { store: "google" as const, product_id: "voice_monthly", expires: Date.now() + 86400_000, shared: false };
      const now = Date.now();
      await db.applyGoogleBilling("google:old", "alice", { value }, now);
      const successor = { value, linkedSource: "google:old" };
      const outcomes = await Promise.all([
        db.applyGoogleBilling("google:old", "alice", { value }, now),
        db.applyGoogleBilling("google:new", "bob", successor, now),
        db.applyGoogleBilling("google:new", null, successor, now),
      ]);
      expect(outcomes).toEqual([true, false, true]);
      expect(await db.applyGoogleBilling("google:old", "alice", { value }, now)).toBe(false);
      expect(await db.billingHolders("google:new")).toEqual(["alice"]);
      const alice = await db.transaction("alice", (tx) => tx.get("entitlement", "current"));
      const bob = await db.transaction("bob", (tx) => tx.get("entitlement", "current"));
      expect(alice?.sources).toEqual({ "google:new": value });
      expect(bob).toBeNull();
    } finally {
      await db.close();
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  test("claims, shared seats and store notifications persist across owners", async () => {
    const admin = postgres(url!, { max: 1, onnotice: () => {} });
    const schema = `oyobidashi_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    // A single-connection pool catches nested checkout deadlocks in billing.
    const db = new PostgresDatabase(url!, 1, schema);
    try {
      await db.migrate();
      await db.migrate();
      const s = setup({}, db),
        alice = await s.phone("alice"),
        bob = await s.phone("bob");
      const purchased = await s.transaction();
      expect((await alice.sync([purchased])).body.active).toBe(true);
      // Concurrent restores of one purchase leave exactly one holder.
      await Promise.all([alice.sync([purchased]), bob.sync([purchased])]);
      const holders = await db.billingHolders("apple:Production:1000");
      expect(holders).toEqual(["alice"]);
      const states = await Promise.all(
        [alice, bob].map(async (p) => (await s.call("GET", "/v1/billing", p.token)).body.active),
      );
      expect(states.filter(Boolean).length).toBe(1);
      expect(states[holders[0] === "alice" ? 0 : 1]).toBe(true);

      const seatAlice = await s.transaction({ originalTransactionId: "2000", appTransactionId: "3001", inAppOwnershipType: "ASSIGNED" });
      const seatBob = await s.transaction({ originalTransactionId: "2000", appTransactionId: "3002", inAppOwnershipType: "ASSIGNED" });
      await alice.sync([seatAlice]);
      await bob.sync([seatBob]);
      expect(await db.billingHolders("apple:Production:2000:account:3001")).toEqual(["alice"]);
      expect(await db.billingHolders("apple:Production:2000:account:3002")).toEqual(["bob"]);
      // Refunding Bob's seat removes access but preserves its ownership.
      const refund = await s.call("POST", "/v1/billing/webhooks/apple", null, {
        signedPayload: await store.sign({
          notificationType: "REFUND",
          data: {
            bundleId: BUNDLE,
            signedTransactionInfo: await s.transaction({
              originalTransactionId: "2000",
              appTransactionId: "3002",
              inAppOwnershipType: "ASSIGNED",
              revocationDate: s.h.clock.now,
            }),
          },
        }),
      });
      expect(refund.status).toBe(204);
      expect(await db.billingHolders("apple:Production:2000:account:3002")).toEqual(["bob"]);
      expect((await s.call("GET", "/v1/billing", bob.token)).body.active).toBe(false);
      const worker = new JobWorker(s.h.service, {
        conversation: { turn: async () => ({ reply: "standard", resolved: false, answer: null }) },
        freeConversation: { turn: async () => ({ reply: "free", resolved: false, answer: null }) },
      });
      const voice = await s.h.setup(holders[0]!),
        t = await voice.turn("one");
      await worker.runOnce("turn");
      expect((await s.h.turn(t.turnId, holders[0]!))!.reply).toBe("standard");
    } finally {
      await db.close();
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});

test("an operator grant gives PLUS without a purchase, only to listed accounts", async () => {
  expect(() => loadPlusGrantUids({ PLUS_GRANT_UIDS: "alice, not a uid" })).toThrow();
  expect(loadPlusGrantUids({}).size).toBe(0);
  const { h, billing } = setup();
  const status = (uid: string) => h.db.transaction(uid, tx => billing.status(tx));
  const hasPlus = (uid: string) => h.db.transaction(uid, tx => h.service.hasPlus(tx));
  expect(await hasPlus("alice")).toBe(false);
  h.service.plusGrantUids = loadPlusGrantUids({ PLUS_GRANT_UIDS: " alice ,carol" });
  expect(await hasPlus("alice")).toBe(true);
  expect(await hasPlus("bob")).toBe(false);
  expect(await status("alice")).toMatchObject({ active: true, expires_at: null, active_stores: [] });
  expect(await status("bob")).toMatchObject({ active: false, expires_at: null });
  h.service.plusGrantUids = new Set();
  expect(await hasPlus("alice")).toBe(false);
  expect(await status("alice")).toMatchObject({ active: false });
});
