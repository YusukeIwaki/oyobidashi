import { afterAll, expect, test } from "bun:test";
import { CloudApp } from "../src/app.ts";
import { purchaseAccountId } from "../src/billing/account.ts";
import { Billing, loadAppleSandboxReviewUids } from "../src/billing/service.ts";
import { OFFICIAL_CLOUD_ORIGIN } from "../src/config.ts";
import { unauthorized } from "../src/errors.ts";
import { fakeAppAttest, fakeAppStore } from "./billing-fixtures.ts";
import { harness } from "./helpers.ts";

const bundleId = "com.example.app";
const appId = `TEAM123456.${bundleId}`;
const productId = "voice.monthly";
const attest = fakeAppAttest(appId);
const store = fakeAppStore();
afterAll(() => attest.dispose());

test("production purchases and review purchases use separate Apple environments", async () => {
  const h = harness();
  h.service.appleSandboxReviewUids = loadAppleSandboxReviewUids({
    APPLE_IAP_SANDBOX_REVIEW_UIDS: "review",
  });
  h.service.voiceTrainingPolicy = { free: true, plus: false };
  const billing = new Billing(h.service, {
    apple: {
      bundleId, appId, productIds: [productId], environments: ["Production"],
      attestEnvironments: ["production"], storeRoot: store.rootPem, attestRoot: attest.rootPem,
    },
  });
  const app = new CloudApp(h.service, { async verify() { throw unauthorized(); } },
    undefined, undefined, undefined, undefined, billing);
  const post = (path: string, body: unknown, token?: string) =>
    app.fetch(new Request(`${OFFICIAL_CLOUD_ORIGIN}/v1/billing/${path}`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    }));
  const phone = async (uid: string) => {
    const { device_token } = await h.pair(uid);
    const key = attest.device();
    const challenge = async () => {
      const response = await post("challenge", {}, device_token);
      const body = await response!.json() as { challenge: string };
      return body.challenge;
    };
    const c = await challenge();
    expect((await post("apple/attest", {
      key_id: key.keyId, challenge: c, attestation: key.attestation(c),
    }, device_token))?.status).toBe(204);
    return async (transaction: string) => {
      const payload = JSON.stringify({ challenge: await challenge(), transactions: [transaction] });
      const response = await post("apple", {
        key_id: key.keyId, payload, assertion: key.assertion(payload),
      }, device_token);
      expect(response?.status).toBe(200);
      return (await response!.json() as { active: boolean }).active;
    };
  };
  const purchase = (uid: string, environment: "Production" | "Sandbox") => ({
    bundleId, productId, environment, inAppOwnershipType: "PURCHASED",
    originalTransactionId: "1000", signedDate: h.clock.now,
    expiresDate: h.clock.now + 86_400_000, appAccountToken: purchaseAccountId(uid),
  });
  const active = async (uid: string) => {
    const status = await h.db.transaction(uid, tx => billing.status(tx));
    return "active" in status && status.active;
  };
  const training = (uid: string) => h.db.transaction(uid, tx => h.service.voiceTraining(tx));

  const syncReview = await phone("review");
  const syncPublic = await phone("public");
  const sandbox = purchase("review", "Sandbox");
  expect(await syncPublic(await store.sign(purchase("public", "Sandbox")))).toBe(false);
  expect(await syncReview(await store.sign(sandbox))).toBe(true);
  expect(await syncPublic(await store.sign(purchase("public", "Production")))).toBe(true);
  expect(await training("review")).toBe(false);

  h.service.appleSandboxReviewUids = new Set();
  expect(await active("review")).toBe(false);
  expect(await training("review")).toBe(true);
  expect(await active("public")).toBe(true);
  h.service.appleSandboxReviewUids = new Set(["review"]);

  h.advance(1_000);
  const refund = { signedPayload: await store.sign({
    notificationType: "REFUND",
    data: {
      bundleId, environment: "Sandbox",
      signedTransactionInfo: await store.sign({
        ...sandbox, signedDate: h.clock.now, revocationDate: h.clock.now,
      }),
    },
  }) };
  expect((await post("webhooks/apple/production", refund))?.status).toBe(204);
  expect((await post("webhooks/apple", refund))?.status).toBe(204);
  expect(await active("review")).toBe(true);
  expect((await post("webhooks/apple/sandbox", refund))?.status).toBe(204);
  expect(await active("review")).toBe(false);
  expect(await active("public")).toBe(true);
});
