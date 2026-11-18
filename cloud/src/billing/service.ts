import { createHash } from "node:crypto";
import { parseServiceAccount } from "../../../relay/src/push/fcm.ts";
import { CloudError, conflict, invalid, missing, string } from "../errors.ts";
import { hash, type CloudService, type Principal } from "../service.ts";
import {
  entitled,
  iso,
  newerAppleProof,
  type EntitlementSource,
  type Transaction,
} from "../types.ts";
import {
  VerificationError,
  verifyAppleJws,
  verifyAssertion,
  verifyAttestation,
} from "./apple.ts";
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

interface Update {
  source: string;
  value: EntitlementSource;
  revoked: boolean;
  periodEnd?: number;
  signedDate?: number;
  linkedSource?: string;
}

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
    const e = await tx.get("entitlement", "current");
    const now = this.now();
    const expires = Math.max(
      0,
      ...Object.values(e?.sources ?? {}).map((s) => s.expires),
    );
    return {
      enabled: true,
      active: entitled(e, now),
      expires_at: expires > now ? iso(expires) : null,
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
    const updates = new Map<string, Update>();
    for (const jws of payload.items) {
      const u = await this.appleTransaction(jws);
      const previous = u && updates.get(u.source);
      if (u && (!previous || newerAppleProof(previous as Required<Update> & { periodEnd: number; signedDate: number }, u as Required<Update> & { periodEnd: number; signedDate: number })))
        updates.set(u.source, u);
    }
    for (const u of updates.values()) await this.hold(p.uid, u);
    return this.service.db.transaction(p.uid, (tx) => this.status(tx));
  }

  /** Verified, relevant StoreKit transaction, or null when it must be ignored. */
  private async appleTransaction(jws: unknown, graceUntil = 0): Promise<Update | null> {
    const apple = this.config.apple!;
    let t: Record<string, unknown>;
    try {
      t = await verifyAppleJws(jws as string, this.now(), apple.storeRoot);
    } catch {
      return null;
    }
    if (
      t.bundleId !== apple.bundleId ||
      typeof t.productId !== "string" ||
      !apple.productIds.includes(t.productId) ||
      typeof t.environment !== "string" ||
      !apple.environments.includes(t.environment) ||
      typeof t.originalTransactionId !== "string" ||
      !/^[0-9]{1,40}$/.test(t.originalTransactionId) ||
      typeof t.expiresDate !== "number" || !Number.isFinite(t.expiresDate) ||
      typeof t.signedDate !== "number" || !Number.isFinite(t.signedDate) ||
      !["PURCHASED", "FAMILY_SHARED", "ASSIGNED"].includes(t.inAppOwnershipType as string)
    )
      return null;
    const revoked = t.revocationDate !== undefined && t.revocationDate !== null;
    const shared = t.inAppOwnershipType !== "PURCHASED";
    // An assigned or family-shared transaction belongs to one Apple Account.
    // A copied JWS must move that seat, never fan it out to arbitrary UIDs.
    if (shared && (typeof t.appTransactionId !== "string" || !/^[0-9]{1,40}$/.test(t.appTransactionId)))
      return null;
    return {
      source: `apple:${t.environment}:${t.originalTransactionId}${shared ? `:account:${t.appTransactionId}` : ""}`,
      revoked,
      periodEnd: t.expiresDate,
      signedDate: t.signedDate,
      value: {
        store: "apple",
        product_id: t.productId,
        expires: revoked ? 0 : Math.max(t.expiresDate, graceUntil),
        // Family-shared and organization-assigned seats have no single purchaser.
        shared,
      },
    };
  }

  /** Gives `uid` the subscription, or takes it away when it is revoked or lapsed. */
  private async hold(uid: string, u: Update) {
    const db = this.service.db;
    if (u.value.store === "apple") {
      await db.applyAppleBilling(u.source, uid, {
        value: u.value, periodEnd: u.periodEnd!, signedDate: u.signedDate!, revoked: u.revoked,
      });
      return;
    }
    if (u.value.expires <= this.now()) {
      if (u.revoked) await db.billingRelease(u.source, uid);
      await this.write(uid, u, !u.revoked && await db.billingHeld(u.source, uid));
      return;
    }
    if (u.value.store === "google") {
      await db.applyGoogleBilling(u.source, uid, u.value, u.linkedSource);
      return;
    }
    if (u.linkedSource) {
      const oldHolders = await db.billingSupersede(u.linkedSource, u.source);
      for (const other of oldHolders)
        await this.write(other, { ...u, source: u.linkedSource }, false);
    }
    const displaced = await db.billingClaim(u.source, uid, !u.value.shared);
    if (displaced === null) return;
    await this.write(uid, u, true);
    for (const other of displaced) await this.write(other, u, false);
  }
  /**
   * Brings one owner's record in line with the claims table, which is the
   * source of truth. Concurrent restores of one purchase therefore converge on
   * the last claimant instead of removing it from everyone.
   */
  private async write(uid: string, u: Update, held: boolean) {
    await this.service.db.transaction(uid, async (tx) => {
      const e = (await tx.get("entitlement", "current")) ?? { sources: {} };
      if (!held && !e.sources[u.source]) return;
      if (held && !u.revoked) e.sources[u.source] = u.value;
      else delete e.sources[u.source];
      // Lapsed sources are kept briefly so a late renewal notice still finds its holder.
      for (const [k, s] of Object.entries(e.sources))
        if (s.expires < this.now() - 60 * 86400_000) delete e.sources[k];
      await tx.put("entitlement", "current", e);
    });
  }
  /** Store notifications carry no user; they refresh whoever holds the subscription. */
  private async refreshHolders(u: Update) {
    if (u.value.store === "apple") {
      await this.service.db.applyAppleBilling(u.source, null, {
        value: u.value, periodEnd: u.periodEnd!, signedDate: u.signedDate!, revoked: u.revoked,
      });
      return;
    }
    if (u.linkedSource && !u.revoked && u.value.expires > this.now()) {
      for (const uid of await this.service.db.billingHolders(u.linkedSource))
        await this.service.db.applyGoogleBilling(u.source, uid, u.value, u.linkedSource);
    }
    for (const uid of await this.service.db.billingHolders(u.source)) {
      if (u.revoked) await this.service.db.billingRelease(u.source, uid);
      await this.write(uid, u, !u.revoked);
    }
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
        const u = await this.googlePurchase(purchaseToken, true);
        if (u) await this.hold(p.uid, u);
      }
    } catch (e) {
      if (e instanceof VerificationError) throw failed();
      if (e instanceof CloudError) throw e;
      throw new CloudError(503, "temporarily_unavailable", "ストアに接続できません。もう一度お試しください。");
    }
    return this.service.db.transaction(p.uid, (tx) => this.status(tx));
  }
  private async googlePurchase(purchaseToken: string, acknowledge: boolean): Promise<Update | null> {
    const google = this.config.google!;
    let purchase;
    try {
      purchase = await google.play.purchase(purchaseToken);
    } catch (e) {
      if (e instanceof VerificationError) return null;
      throw e;
    }
    if (!google.productIds.includes(purchase.productId)) return null;
    if (acknowledge && purchase.expires > this.now() && !purchase.acknowledged)
      await google.play.acknowledge(purchase.productId, purchaseToken);
    return {
      // The token is a bearer secret for the purchase; only its digest is stored.
      source: `google:${hash(purchaseToken)}`,
      ...(purchase.linkedPurchaseToken ? { linkedSource: `google:${hash(purchase.linkedPurchaseToken)}` } : {}),
      revoked: purchase.expires === 0,
      value: {
        store: "google",
        product_id: purchase.productId,
        expires: purchase.expires,
        shared: false,
      },
    };
  }

  async appleWebhook(body: Record<string, unknown>) {
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
    if (!data || data.bundleId !== apple.bundleId || !data.signedTransactionInfo) return;
    let grace = 0;
    if (data.signedRenewalInfo)
      try {
        const renewal = await verifyAppleJws(data.signedRenewalInfo as string, this.now(), apple.storeRoot);
        if (typeof renewal.gracePeriodExpiresDate === "number") grace = renewal.gracePeriodExpiresDate;
      } catch {
        /* the transaction alone still decides */
      }
    const u = await this.appleTransaction(data.signedTransactionInfo, grace);
    if (u) await this.refreshHolders(u);
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
    let u: Update | null;
    try {
      // The message is only a hint; Google's API is the source of truth.
      u = await this.googlePurchase(token, false);
    } catch {
      throw new CloudError(503, "temporarily_unavailable", "please retry");
    }
    if (u) await this.refreshHolders(u);
  }
}
