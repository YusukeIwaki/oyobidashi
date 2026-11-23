import { createHash, createPrivateKey, createPublicKey, verify, type KeyObject } from "node:crypto";
import { SignJWT, type JWK } from "jose";
import { unavailable } from "./errors.ts";

const KMS = "https://cloudkms.googleapis.com/v1/";
const GOOGLE_IDENTITY = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const GOOGLE_OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const versionResource = /^projects\/[A-Za-z0-9_-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/[1-9]\d*$/;

export interface ClaudeSigner {
  publicKeys(): Promise<{ keys: JWK[] }>;
  sign(subject: string, audience: string): Promise<string>;
}

function googleKms(send: typeof fetch, now: () => number, serviceAccountJson?: string) {
  const serviceAccount = serviceAccountJson === undefined ? undefined : parseServiceAccount(serviceAccountJson);
  let token: { value: string; expires: number } | undefined;
  let refreshing: Promise<string> | undefined;
  async function request(url: string, options: RequestInit) {
    const response = await send(url, { ...options, redirect: "error", signal: AbortSignal.timeout(6000) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  async function accessToken() {
    let response: Record<string, unknown>;
    if (serviceAccount) {
      const iat = Math.floor(now() / 1000);
      const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/cloudkms" })
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: serviceAccount.keyId })
        .setIssuer(serviceAccount.email).setAudience(GOOGLE_OAUTH_TOKEN)
        .setIssuedAt(iat).setExpirationTime(iat + 300).sign(serviceAccount.key);
      response = await request(GOOGLE_OAUTH_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      });
    } else {
      response = await request(GOOGLE_IDENTITY, { headers: { "Metadata-Flavor": "Google" } });
    }
    if (typeof response.access_token !== "string" || !response.access_token ||
        typeof response.expires_in !== "number" || response.expires_in <= 0) throw unavailable();
    token = { value: response.access_token, expires: now() + response.expires_in * 1000 };
    return token.value;
  }

  return async (path: string, body?: object) => {
    const access = token && token.expires > now() + 30_000 ? token.value :
      await (refreshing ??= accessToken().finally(() => { refreshing = undefined; }));
    return request(KMS + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${access}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  };
}

function parseServiceAccount(raw: string) {
  try {
    const { type, client_email, private_key, private_key_id } = JSON.parse(raw);
    if (type !== "service_account" || typeof client_email !== "string" ||
        !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(client_email) ||
        typeof private_key_id !== "string" || !/^[a-f0-9]{40}$/.test(private_key_id) ||
        typeof private_key !== "string") throw new Error();
    const key = createPrivateKey(private_key);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
    return { email: client_email, keyId: private_key_id, key };
  } catch {
    throw new Error("Invalid CLAUDE_BILLING_GOOGLE_SERVICE_ACCOUNT");
  }
}

/** The Claude signing private key stays in Cloud KMS. */
export function claudeKmsSigner({
  version, issuer, send = fetch, now = Date.now, serviceAccountJson,
}: {
  version: string; issuer: string; send?: typeof fetch; now?: () => number; serviceAccountJson?: string;
}): ClaudeSigner {
  if (!versionResource.test(version)) throw new Error("Invalid CLAUDE_BILLING_KMS_KEY_VERSION");
  const kms = googleKms(send, now, serviceAccountJson);
  let publicKey: Promise<{ key: KeyObject; jwk: JWK & { kid: string } }> | undefined;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

  async function fetchPublicKey() {
    const data = await kms(version + "/publicKey");
    if (data.name !== version || typeof data.pem !== "string" ||
        typeof data.algorithm !== "string" || !/^RSA_SIGN_PKCS1_(2048|3072|4096)_SHA256$/.test(data.algorithm))
      throw new Error("Cloud KMS key version must use RSA PKCS1 SHA256 signing");
    const key = createPublicKey(data.pem);
    const jwk = key.export({ format: "jwk" });
    if (jwk.kty !== "RSA" || !jwk.n) throw unavailable();
    const kid = createHash("sha256").update(jwk.n).digest("base64url");
    return { key, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
  }

  const signingKey = () => publicKey ??= fetchPublicKey().catch(error => { publicKey = undefined; throw error; });
  return {
    async publicKeys() { return { keys: [(await signingKey()).jwk] }; },
    async sign(subject, audience) {
      const { key, jwk } = await signingKey();
      const iat = Math.floor(now() / 1000);
      const payload = `${encode({ alg: "RS256", typ: "JWT", kid: jwk.kid })}.${encode({
        iss: issuer, sub: subject, aud: audience, iat, exp: iat + 180, jti: crypto.randomUUID(),
      })}`;
      const digest = createHash("sha256").update(payload).digest("base64");
      const answer = await kms(version + ":asymmetricSign", { digest: { sha256: digest } });
      if (answer.name !== version || typeof answer.signature !== "string") throw unavailable();
      const signature = Buffer.from(answer.signature, "base64");
      if (!verify("RSA-SHA256", Buffer.from(payload), key, signature)) throw unavailable();
      return `${payload}.${signature.toString("base64url")}`;
    },
  };
}


export interface ClaudeTokenCipher {
  encrypt(value: string, binding: string): Promise<string>;
  decrypt(ciphertext: string, binding: string): Promise<string>;
}
const keyResource = /^projects\/[A-Za-z0-9_-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/;

export function claudeKmsTokenCipher(key: string, send: typeof fetch = fetch, serviceAccountJson?: string): ClaudeTokenCipher {
  if (!keyResource.test(key)) throw new Error("Invalid CLAUDE_BILLING_KMS_TOKEN_KEY");
  const kms = googleKms(send, Date.now, serviceAccountJson);
  const base64 = (value: string) => Buffer.from(value).toString("base64");
  return {
    async encrypt(value, binding) {
      const response = await kms(key + ":encrypt", {
        plaintext: base64(value), additionalAuthenticatedData: base64(binding),
      });
      if (typeof response.ciphertext !== "string" || !response.ciphertext ||
          typeof response.name !== "string" || !response.name.startsWith(key + "/cryptoKeyVersions/")) throw unavailable();
      return response.ciphertext;
    },
    async decrypt(ciphertext, binding) {
      const response = await kms(key + ":decrypt", { ciphertext, additionalAuthenticatedData: base64(binding) });
      if (typeof response.plaintext !== "string" || !response.plaintext) throw unavailable();
      return Buffer.from(response.plaintext, "base64").toString("utf8");
    },
  };
}
