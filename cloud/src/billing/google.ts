import { createRemoteJWKSet, customFetch, importPKCS8, jwtVerify, SignJWT } from "jose";
import type { ServiceAccount } from "../../../relay/src/push/fcm.ts";
import { VerificationError } from "./apple.ts";

type Send = typeof fetch;
const SCOPES =
  "https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playintegrity";
const PRODUCT_TYPE_SUBSCRIPTION = 1;

export interface GooglePurchase {
  /** Expiry of the entitlement in milliseconds; 0 when the purchase grants nothing. */
  expires: number;
  productId: string;
  acknowledged: boolean;
  accountId?: string;
  linkedPurchaseToken?: string;
}

/** Thin, bounded client for the Play Integrity and Play Developer APIs. */
export class GooglePlay {
  private token: { value: string; expires: number } | null = null;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  constructor(
    readonly options: {
      packageName: string;
      serviceAccount: ServiceAccount;
      /** Pub/Sub push authentication; the webhook is disabled when absent. */
      pubsub?: { audience: string; serviceAccount: string };
      fetch?: Send;
      now?: () => number;
    },
  ) {
    this.jwks = createRemoteJWKSet(
      new URL("https://www.googleapis.com/oauth2/v3/certs"),
      options.fetch ? { [customFetch]: options.fetch } : undefined,
    );
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private async accessToken() {
    if (this.token && this.token.expires > this.now() + 60_000)
      return this.token.value;
    const sa = this.options.serviceAccount;
    const uri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPES })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.client_email)
      .setAudience(uri)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 3600)
      .sign(await importPKCS8(sa.private_key, "RS256"));
    const body = await this.json(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (typeof body.access_token !== "string") throw new VerificationError();
    this.token = {
      value: body.access_token,
      expires: this.now() + (Number(body.expires_in) || 3600) * 1000,
    };
    return this.token.value;
  }
  private async json(url: string, init: RequestInit) {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("store unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // 4xx is a verdict about the input; anything else is worth a retry.
      if (response.status >= 400 && response.status < 500 && response.status !== 429)
        throw new VerificationError();
      throw new Error("store unavailable");
    }
    const text = await response.text();
    if (text.length > 256 * 1024) throw new VerificationError();
    try {
      return (text ? JSON.parse(text) : {}) as Record<string, any>;
    } catch {
      throw new VerificationError();
    }
  }
  private async api(url: string, body?: unknown) {
    return this.json(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Requires a genuine Play-installed app on a genuine device, bound to `requestHash`. */
  async verifyIntegrity(integrityToken: string, requestHash: string) {
    const pkg = this.options.packageName;
    const decoded = await this.api(
      `https://playintegrity.googleapis.com/v1/${encodeURIComponent(pkg)}:decodeIntegrityToken`,
      { integrity_token: integrityToken },
    );
    const p = decoded.tokenPayloadExternal ?? {};
    const age = this.now() - Number(p.requestDetails?.timestampMillis);
    if (
      p.requestDetails?.requestPackageName !== pkg ||
      p.requestDetails?.requestHash !== requestHash ||
      !(age > -60_000 && age < 300_000) ||
      p.appIntegrity?.appRecognitionVerdict !== "PLAY_RECOGNIZED" ||
      p.appIntegrity?.packageName !== pkg ||
      !Array.isArray(p.deviceIntegrity?.deviceRecognitionVerdict) ||
      !p.deviceIntegrity.deviceRecognitionVerdict.includes("MEETS_DEVICE_INTEGRITY")
    )
      throw new VerificationError();
  }

  /** Reads the authoritative state of a subscription purchase token. */
  async purchase(purchaseToken: string): Promise<GooglePurchase> {
    const pkg = encodeURIComponent(this.options.packageName);
    const s = await this.api(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
    );
    const item = Array.isArray(s.lineItems) ? s.lineItems[0] : undefined;
    const productId = typeof item?.productId === "string" ? item.productId : "";
    const expiry = Date.parse(item?.expiryTime ?? "");
    const previous = s.outOfAppPurchaseContext;
    const accountId = s.externalAccountIdentifiers?.obfuscatedExternalAccountId
      ?? previous?.expiredExternalAccountIdentifiers?.obfuscatedExternalAccountId;
    const linkedToken = s.linkedPurchaseToken ?? previous?.expiredPurchaseToken;
    // ACTIVE and IN_GRACE_PERIOD keep access; CANCELED keeps it until the paid period ends.
    // A license-tester (test) purchase is never paid access, however Google
    // otherwise describes it; it must not be acknowledged as a real purchase.
    const entitled = s.testPurchase == null && [
      "SUBSCRIPTION_STATE_ACTIVE",
      "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
      "SUBSCRIPTION_STATE_CANCELED",
    ].includes(s.subscriptionState);
    return {
      productId,
      expires: entitled && Number.isFinite(expiry) ? expiry : 0,
      acknowledged: s.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      ...(accountId != null ? { accountId: typeof accountId === "string" ? accountId : "" } : {}),
      ...(typeof linkedToken === "string" && linkedToken.length <= 2000
        ? { linkedPurchaseToken: linkedToken } : {}),
    };
  }

  /** Unacknowledged purchases are refunded by Google after three days. */
  async acknowledge(productId: string, purchaseToken: string) {
    const pkg = encodeURIComponent(this.options.packageName);
    await this.api(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${pkg}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
      {},
    );
  }

  /** Authenticates a Pub/Sub push and returns the purchase token it refers to, if any. */
  async notification(authorization: string | null, body: Record<string, unknown>) {
    const config = this.options.pubsub;
    if (!config) throw new VerificationError();
    try {
      const { payload } = await jwtVerify(
        (authorization ?? "").replace(/^Bearer /i, ""),
        this.jwks,
        {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: config.audience,
        },
      );
      if (payload.email !== config.serviceAccount || payload.email_verified !== true)
        throw new VerificationError();
    } catch {
      throw new VerificationError();
    }
    const data = (body.message as { data?: unknown } | undefined)?.data;
    if (typeof data !== "string") return null;
    try {
      const event = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
      const voided = event?.voidedPurchaseNotification;
      const token = event?.subscriptionNotification?.purchaseToken
        ?? (voided?.productType === PRODUCT_TYPE_SUBSCRIPTION ? voided.purchaseToken : undefined);
      return event?.packageName === this.options.packageName && typeof token === "string"
        ? token
        : null;
    } catch {
      return null;
    }
  }
}
