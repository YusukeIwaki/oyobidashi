import { createHash } from "node:crypto";
import { parseServiceAccount } from "../../../relay/src/push/fcm.ts";
import { CloudError, conflict, invalid, missing, string } from "../errors.ts";
import { hash, type CloudService, type Principal } from "../service.ts";
import {
  iso,
  newerAppleProof,
  type AppleBillingProof,
  type GoogleBillingProof,
  type Transaction,
} from "../types.ts";
import {
  VerificationError,
  verifyAppleJws,
  verifyAssertion,
  verifyAttestation,
} from "./apple.ts";
import { purchaseAccountId } from "./account.ts";
import { GooglePlay } from "./google.ts";

export interface BillingConfig {
  apple?: {
    bundleId: string;
    /** `<Team ID>.<Bundle ID>` */
    appId: string;
    productIds: string[];
    /** Accepted App Store environments, e.g. ["Production"]. */
    environments: string[];
    attestEnvironments: ("production" | "development")[];
    /** Test seams; production uses the pinned Apple roots. */
    storeRoot?: string;
    attestRoot?: string;
  };
  google?: { productIds: string[]; play: GooglePlay };
}

export function loadAppleSandboxReviewUids(env: Record<string, string | undefined>): ReadonlySet<string> {
  const uids = new Set(list(env.APPLE_IAP_SANDBOX_REVIEW_UIDS));
  if (uids.size > 32 || [...uids].some(uid => !/^[A-Za-z0-9_-]{1,128}$/.test(uid)))
    throw new Error("APPLE_IAP_SANDBOX_REVIEW_UIDS is invalid");
  return uids;
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/** Billing stays off unless a store is configured completely. */
export function loadBillingConfig(
  env: Record<string, string | undefined>,
  send?: typeof fetch,
): BillingConfig {
  const config: BillingConfig = {};
  const appleProducts = list(env.APPLE_IAP_PRODUCT_IDS);
  if (appleProducts.length) {
    const bundleId = env.APPLE_IAP_BUNDLE_ID?.trim(),
      teamId = env.APPLE_TEAM_ID?.trim();
    if (!bundleId || !teamId)
      throw new Error("APPLE_IAP_BUNDLE_ID and APPLE_TEAM_ID are required");
    const environments = list(env.APPLE_IAP_ENVIRONMENTS ?? "Production");
    if (!environments.every((e) => ["Production", "Sandbox"].includes(e)))
      throw new Error("APPLE_IAP_ENVIRONMENTS must list Production and/or Sandbox");
    const attest = list(env.APPLE_APP_ATTEST_ENVIRONMENTS ?? "production");
    if (!attest.every((e) => e === "production" || e === "development"))
      throw new Error("APPLE_APP_ATTEST_ENVIRONMENTS must list production and/or development");
    config.apple = {
      bundleId,
      appId: `${teamId}.${bundleId}`,
      productIds: appleProducts,
      environments,
      attestEnvironments: attest as ("production" | "development")[],
    };
  }
  const googleProducts = list(env.GOOGLE_PLAY_PRODUCT_IDS);
  if (googleProducts.length) {
    const packageName = env.GOOGLE_PLAY_PACKAGE_NAME?.trim(),
      account = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!packageName || !account)
      throw new Error(
        "GOOGLE_PLAY_PACKAGE_NAME and GOOGLE_PLAY_SERVICE_ACCOUNT_JSON are required",
      );
    let serviceAccount;
    try {
      serviceAccount = parseServiceAccount(account);
    } catch {
      throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is invalid");
    }
    const audience = env.GOOGLE_PLAY_PUBSUB_AUDIENCE?.trim(),
      pusher = env.GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT?.trim();
    if (!!audience !== !!pusher)
      throw new Error(
        "GOOGLE_PLAY_PUBSUB_AUDIENCE and GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT go together",
      );
    config.google = {
      productIds: googleProducts,
      play: new GooglePlay({
        packageName,
        serviceAccount,
        ...(audience && pusher
          ? { pubsub: { audience, serviceAccount: pusher } }
          : {}),
        ...(send ? { fetch: send } : {}),
      }),
    };
  }
  return config;
}

const failed = () =>
  new CloudError(403, "attestation_failed", "この端末では購入を確認できませんでした。");
const b64 = (value: string | null) => {
  // Buffer accepts both alphabets; reject anything that is not base64 at all.
  if (!value || !/^[A-Za-z0-9+/_=-]+$/.test(value)) throw invalid("invalid encoding");
  return Buffer.from(value, "base64");
};
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest();

export class Billing {
  constructor(
    readonly service: CloudService,
    readonly config: BillingConfig,
  ) {}
  get enabled() {
    return !!(this.config.apple || this.config.google);
  }
  private now() {
    return this.service.now();
  }

  async status(tx: Transaction) {
    if (!this.enabled) return { enabled: false };
    const now = this.now();
    const activeSources = await this.service.activeEntitlementSources(tx, now);
    const expires = Math.max(0, ...activeSources.map((source) => source.expires));
    return {
      enabled: true,
      voice_training: this.service.voiceTrainingPolicy,
      purchase_account_id: purchaseAccountId(tx.uid),
      active: activeSources.length !== 0,
      expires_at: expires > now ? iso(expires) : null,
      active_stores: [...new Set(activeSources.map((source) => source.store))].sort(),
      ...(this.config.apple
        ? { apple: { product_ids: this.config.apple.productIds } }
        : {}),
      ...(this.config.google
        ? { google: { product_ids: this.config.google.productIds } }
        : {}),
    };
  }

  async challenge(tx: Transaction, deviceId: string) {
    await this.service.billingAttempt(tx);
    const challenge = crypto
      .getRandomValues(new Uint8Array(32))
      .toBase64({ alphabet: "base64url", omitPadding: true });
    const expires = this.now() + 300_000;
    await tx.put("challenge", hash(challenge), { deviceId, expires }, expires);
    return { challenge, expires_at: iso(expires) };
  }
  private async consume(tx: Transaction, deviceId: string, challenge: unknown) {
    if (typeof challenge !== "string" || challenge.length > 100) throw invalid("invalid challenge");
    const id = hash(challenge),
      found = await tx.get("challenge", id);
    if (!found || found.deviceId !== deviceId || found.expires <= this.now())
      throw new CloudError(409, "challenge_expired", "もう一度お試しください。");
    await tx.remove("challenge", id);
  }
  private payload(body: Record<string, unknown>, key: string) {
    const text = string(body, "payload", 60_000, true)!;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw invalid("payload must be JSON");
    }
    const items = (value as Record<string, unknown> | null)?.[key];
    if (!value || typeof value !== "object" || !Array.isArray(items) || items.length > 20)
      throw invalid(`payload.${key} must list at most 20 items`);
    return {
      text,
      challenge: (value as Record<string, unknown>).challenge,
      items: items as unknown[],
    };
  }
  /** Runs `fn` as the device; returned errors preserve consumed challenges. */
  private async guarded(
    p: Principal,
    fn: (tx: Transaction) => Promise<CloudError | void>,
  ) {
    const error = await this.service.run(p, fn);
    if (error) throw error;
  }

  async attestApple(p: Extract<Principal, { role: "device" }>, body: Record<string, unknown>) {
    await this.service.run(p, (tx) => this.service.billingAttempt(tx));
    const apple = this.config.apple;
    if (!apple) throw missing();
    const keyId = b64(string(body, "key_id", 200, true)),
      attestation = b64(string(body, "attestation", 30_000, true)),
      challenge = string(body, "challenge", 100, true)!;
    await this.guarded(p, async (tx) => {
      await this.consume(tx, p.deviceId, challenge);
      try {
        const key = verifyAttestation(attestation, keyId, sha256(challenge), {
          appId: apple.appId,
          environments: apple.attestEnvironments,
          now: this.now(),
          ...(apple.attestRoot ? { rootPem: apple.attestRoot } : {}),
        });
        await tx.put("attest", p.deviceId, {
          key_id: keyId.toString("base64"),
          public_key: key.publicKeyPem,
          counter: 0,
        });
      } catch (e) {
        if (e instanceof VerificationError) return failed();
        throw e;
      }
    });
  }

  async syncApple(p: Extract<Principal, { role: "device" }>, body: Record<string, unknown>) {
    await this.service.run(p, (tx) => this.service.billingAttempt(tx));
    const apple = this.config.apple;
    if (!apple) throw missing();
    const keyId = b64(string(body, "key_id", 200, true)).toString("base64"),
      assertion = b64(string(body, "assertion", 4000, true)),
      payload = this.payload(body, "transactions");
    await this.guarded(p, async (tx) => {
      await this.consume(tx, p.deviceId, payload.challenge);
      const key = await tx.get("attest", p.deviceId);
      if (!key || key.key_id !== keyId)
        return conflict("attestation_required", "端末の確認が必要です。");
      try {
        key.counter = verifyAssertion(
          assertion,
          sha256(payload.text),
          key.public_key,
          apple.appId,
          key.counter,
        );
      } catch (e) {
        if (e instanceof VerificationError) return failed();
        throw e;
      }
      await tx.put("attest", p.deviceId, key);
    });
    const updates = new Map<string, AppleBillingProof>();
    for (const jws of payload.items) {
      let transaction: Record<string, unknown>;
      try {
        transaction = await verifyAppleJws(jws as string, this.now(), apple.storeRoot);
      } catch {
        continue;
      }
      if (!this.acceptsSandboxPurchase(transaction, p.uid)) continue;
      const update = this.appleTransaction(transaction);
      if (update && newerAppleProof(updates.get(update.source) ?? null, update.proof))
        updates.set(update.source, update.proof);
    }
    for (const [source, proof] of updates)
      await this.service.db.applyAppleBilling(source, p.uid, proof, this.now());
    return this.service.db.transaction(p.uid, (tx) => this.status(tx));
  }

  private acceptsSandboxPurchase(transaction: Record<string, unknown>, uid?: string) {
    const reviewUids = this.service.appleSandboxReviewUids;
    if (transaction.environment !== "Sandbox" || !reviewUids) return true;
    if (transaction.inAppOwnershipType !== "PURCHASED" || typeof transaction.appAccountToken !== "string")
      return false;
    const account = transaction.appAccountToken.toLowerCase();
    if (uid !== undefined) return reviewUids.has(uid) && account === purchaseAccountId(uid);
    return [...reviewUids].some(reviewer => account === purchaseAccountId(reviewer));
  }

  /** Accepts only verified, relevant StoreKit transactions. */
  private appleTransaction(t: Record<string, unknown>, graceUntil = 0): { source: string; proof: AppleBillingProof } | null {
    const apple = this.config.apple!;
    if (
      t.bundleId !== apple.bundleId ||
      typeof t.productId !== "string" ||
      !apple.productIds.includes(t.productId) ||
      typeof t.environment !== "string" ||
      (t.environment === "Sandbox" && this.service.appleSandboxReviewUids
        ? this.service.appleSandboxReviewUids.size === 0
        : !apple.environments.includes(t.environment)) ||
      typeof t.originalTransactionId !== "string" ||
      !/^[0-9]{1,40}$/.test(t.originalTransactionId) ||
      typeof t.expiresDate !== "number" || !Number.isFinite(t.expiresDate) ||
      typeof t.signedDate !== "number" || !Number.isFinite(t.signedDate) ||
      !["PURCHASED", "FAMILY_SHARED", "ASSIGNED"].includes(t.inAppOwnershipType as string)
    )
      return null;
    const revoked = t.revocationDate !== undefined && t.revocationDate !== null;
    const shared = t.inAppOwnershipType !== "PURCHASED";
    // Key a shared or assigned seat by the beneficiary, independently of the buyer.
    if (shared && (typeof t.appTransactionId !== "string" || !/^[0-9]{1,40}$/.test(t.appTransactionId)))
      return null;
    return {
      source: `apple:${t.environment}:${t.originalTransactionId}${shared ? `:account:${t.appTransactionId}` : ""}`,
      proof: {
        revoked,
        periodEnd: t.expiresDate,
        signedDate: t.signedDate,
        ...(!shared && t.appAccountToken != null
          ? { accountId: typeof t.appAccountToken === "string" ? t.appAccountToken.toLowerCase() : "" }
          : {}),
        value: {
          store: "apple",
          product_id: t.productId,
          expires: revoked ? 0 : Math.max(t.expiresDate, graceUntil),
          shared,
        },
      },
    };
  }

  async syncGoogle(p: Extract<Principal, { role: "device" }>, body: Record<string, unknown>) {
    await this.service.run(p, (tx) => this.service.billingAttempt(tx));
    const google = this.config.google;
    if (!google) throw missing();
    const token = string(body, "integrity_token", 20_000, true)!,
      payload = this.payload(body, "purchases");
    await this.guarded(p, (tx) => this.consume(tx, p.deviceId, payload.challenge));
    try {
      await google.play.verifyIntegrity(
        token,
        sha256(payload.text).toString("base64url"),
      );
      for (const item of payload.items) {
        const purchaseToken = (item as { purchase_token?: unknown } | null)?.purchase_token;
        if (typeof purchaseToken !== "string" || purchaseToken.length > 2000) continue;
        const purchase = await this.googlePurchase(purchaseToken);
        if (!purchase) continue;
        const { source, acknowledged, proof } = purchase;
        const active = await this.service.db.applyGoogleBilling(source, p.uid, proof, this.now());
        if (active && !acknowledged)
          await google.play.acknowledge(proof.value.product_id, purchaseToken);
      }
    } catch (e) {
      if (e instanceof VerificationError) throw failed();
      if (e instanceof CloudError) throw e;
      throw new CloudError(503, "temporarily_unavailable", "ストアに接続できません。もう一度お試しください。");
    }
    return this.service.db.transaction(p.uid, (tx) => this.status(tx));
  }
  private async googlePurchase(purchaseToken: string): Promise<{
    source: string;
    proof: GoogleBillingProof;
    acknowledged: boolean;
  } | null> {
    const google = this.config.google!;
    let purchase;
    try {
      purchase = await google.play.purchase(purchaseToken);
    } catch (e) {
      if (e instanceof VerificationError) return null;
      throw e;
    }
    if (!google.productIds.includes(purchase.productId)) return null;
    return {
      // The token is a bearer secret for the purchase; only its digest is stored.
      source: `google:${hash(purchaseToken)}`,
      acknowledged: purchase.acknowledged,
      proof: {
        accountId: purchase.accountId,
        ...(purchase.linkedPurchaseToken ? { linkedSource: `google:${hash(purchase.linkedPurchaseToken)}` } : {}),
        value: {
          store: "google",
          product_id: purchase.productId,
          expires: purchase.expires,
          shared: false,
        },
      },
    };
  }

  async appleWebhook(body: Record<string, unknown>, expectedEnvironment?: "Production" | "Sandbox") {
    const apple = this.config.apple;
    if (!apple) throw missing();
    let notice: Record<string, unknown>;
    try {
      // A notification nests a transaction and renewal info, each with its own
      // certificate chain, so it is far longer than one transaction (~19k chars).
      // The request body is already capped at 64KB.
      notice = await verifyAppleJws(body.signedPayload as string, this.now(), apple.storeRoot, 65_536);
    } catch {
      throw new CloudError(401, "unauthorized", "invalid notification");
    }
    const data = notice.data as Record<string, unknown> | undefined;
    if (!data || data.bundleId !== apple.bundleId || !data.signedTransactionInfo ||
        (expectedEnvironment && data.environment !== expectedEnvironment)) return;
    let transaction: Record<string, unknown>;
    try {
      transaction = await verifyAppleJws(data.signedTransactionInfo as string, this.now(), apple.storeRoot);
    } catch {
      return;
    }
    if ((expectedEnvironment && transaction.environment !== expectedEnvironment) ||
        (typeof data.environment === "string" && data.environment !== transaction.environment) ||
        !this.acceptsSandboxPurchase(transaction)) return;
    let grace = 0;
    if (data.signedRenewalInfo)
      try {
        const renewal = await verifyAppleJws(data.signedRenewalInfo as string, this.now(), apple.storeRoot);
        // Renewal info may only extend the subscription it belongs to. A grace
        // period signed for another transaction must never revive this one.
        if (
          renewal.originalTransactionId === transaction.originalTransactionId &&
          renewal.environment === transaction.environment &&
          renewal.autoRenewProductId === transaction.productId &&
          typeof renewal.gracePeriodExpiresDate === "number"
        )
          grace = renewal.gracePeriodExpiresDate;
      } catch {
        /* the transaction alone still decides */
      }
    const update = this.appleTransaction(transaction, grace);
    if (update) await this.service.db.applyAppleBilling(update.source, null, update.proof, this.now());
  }

  async googleWebhook(authorization: string | null, body: Record<string, unknown>) {
    const google = this.config.google;
    if (!google) throw missing();
    let token: string | null;
    try {
      token = await google.play.notification(authorization, body);
    } catch {
      throw new CloudError(401, "unauthorized", "invalid notification");
    }
    if (!token) return;
    let purchase;
    try {
      // The message is only a hint; Google's API is the source of truth.
      purchase = await this.googlePurchase(token);
    } catch {
      throw new CloudError(503, "temporarily_unavailable", "please retry");
    }
    if (purchase) await this.service.db.applyGoogleBilling(purchase.source, null, purchase.proof, this.now());
  }
}
