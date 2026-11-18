import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { CloudError, conflict, invalid, string } from "./errors.ts";
import { hash, type CloudService, type Principal } from "./service.ts";
import type { Transaction } from "./types.ts";
import { VerificationError, verifyAssertion, verifyAttestation } from "./billing/apple.ts";
import { GooglePlay } from "./billing/google.ts";
import { parseServiceAccount } from "../../relay/src/push/fcm.ts";

type DevicePrincipal = Extract<Principal, { role: "device" }>;
type Purpose = "apple_enroll" | "android_enroll" | "token";
const ACCESS_MS = 10 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
const ANDROID_PROOF_MS = 6 * 3600_000;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest();
const b64url = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const decoded = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length > max || !/^[A-Za-z0-9+/_=-]+$/.test(value)) throw invalid("invalid proof");
  const data = Buffer.from(value, "base64");
  if (!data.length || data.length > max) throw invalid("invalid proof");
  return data;
};
const proofFailed = () => new CloudError(403, "voice_proof_failed", "端末の確認に失敗しました。");

export interface VoiceConfig {
  apple?: {
    appId: string;
    environments: ("production" | "development")[];
    root?: string;
  };
  android?: { play: GooglePlay };
}

/** Store configuration is shared, but voice enrollment works without a purchase. */
export function loadVoiceConfig(env: Record<string, string | undefined>, send?: typeof fetch): VoiceConfig {
  const config: VoiceConfig = {};
  const team = env.VOICE_APPLE_TEAM_ID ?? env.APPLE_TEAM_ID;
  const bundle = env.VOICE_APPLE_BUNDLE_ID ?? env.APPLE_IAP_BUNDLE_ID;
  if (team && bundle) {
    const environments = (env.VOICE_APP_ATTEST_ENVIRONMENTS ?? env.APPLE_APP_ATTEST_ENVIRONMENTS ?? "production").split(",").map((item) => item.trim());
    if (!environments.length || environments.some((item) => item !== "production" && item !== "development"))
      throw new Error("VOICE_APP_ATTEST_ENVIRONMENTS is invalid");
    config.apple = { appId: `${team}.${bundle}`, environments: environments as ("production" | "development")[] };
  }
  const packageName = env.VOICE_ANDROID_PACKAGE_NAME ?? env.GOOGLE_PLAY_PACKAGE_NAME;
  const account = env.VOICE_GOOGLE_SERVICE_ACCOUNT_JSON ?? env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (packageName && account) {
    let serviceAccount;
    try { serviceAccount = parseServiceAccount(account); }
    catch { throw new Error("VOICE_GOOGLE_SERVICE_ACCOUNT_JSON is invalid"); }
    config.android = { play: new GooglePlay({ packageName, serviceAccount, ...(send ? { fetch: send } : {}) }) };
  }
  return config;
}

export class VoiceSecurity {
  constructor(readonly service: CloudService, readonly config: VoiceConfig) {}
  private now() { return this.service.now(); }
  private async device(tx: Transaction, p: DevicePrincipal) {
    const device = await tx.get("device", p.deviceId);
    if (!device || device.tokenHash !== p.tokenHash) throw proofFailed();
    return device;
  }
  private async consume(tx: Transaction, p: DevicePrincipal, challenge: string, purpose: Purpose) {
    const key = hash(challenge);
    const saved = await tx.get("voice_challenge", key);
    if (!saved || saved.deviceId !== p.deviceId || saved.purpose !== purpose || saved.expires <= this.now())
      throw conflict("challenge_expired", "端末の確認をやり直してください。");
    await tx.remove("voice_challenge", key);
  }
  async status(p: DevicePrincipal) {
    return this.service.run(p, async (tx) => {
      const d = await this.device(tx, p);
      const access = await tx.get("voice_access", p.deviceId);
      return {
        enabled: true,
        supported: d.platform === "ios" ? !!this.config.apple : !!this.config.android,
        platform: d.platform,
        uid: p.uid,
        device_id: p.deviceId,
        token_ttl_seconds: ACCESS_MS / 1000,
        ...(access && access.expires > this.now() ? { expires_at: new Date(access.expires).toISOString() } : {}),
      };
    });
  }
  async challenge(p: DevicePrincipal, purpose: Purpose) {
    await this.service.run(p, (tx) => this.service.voiceProofAttempt(tx));
    return this.service.run(p, async (tx) => {
      const device = await this.device(tx, p);
      if ((purpose === "apple_enroll" && (device.platform !== "ios" || !this.config.apple)) ||
          (purpose === "android_enroll" && (device.platform !== "android" || !this.config.android)))
        throw conflict("voice_unavailable", "この端末では音声の確認を利用できません。");
      const value = `vc_${b64url(randomBytes(32))}`;
      const expires = this.now() + CHALLENGE_MS;
      await tx.put("voice_challenge", hash(value), { deviceId: p.deviceId, purpose, expires }, expires);
      return { challenge: value, expires_at: new Date(expires).toISOString() };
    });
  }
  static enrollmentMessage(uid: string, deviceId: string, challenge: string, keyId?: string) {
    return `voice-enroll\n${uid}\n${deviceId}\n${challenge}${keyId ? `\n${keyId}` : ""}`;
  }
  static tokenMessage(uid: string, deviceId: string, challenge: string) {
    return `voice-token\n${uid}\n${deviceId}\n${challenge}`;
  }
  async enrollApple(p: DevicePrincipal, body: Record<string, unknown>) {
    await this.service.run(p, (tx) => this.service.voiceProofAttempt(tx));
    const config = this.config.apple;
    if (!config) throw conflict("voice_unavailable", "音声の確認を利用できません。");
    const challenge = string(body, "challenge", 100, true)!;
    const keyId = string(body, "key_id", 200, true)!;
    const attestation = decoded(body.attestation, 30_000);
    await this.service.run(p, async (tx) => {
      const device = await this.device(tx, p);
      if (device.platform !== "ios") throw proofFailed();
      await this.consume(tx, p, challenge, "apple_enroll");
      try {
        const key = verifyAttestation(attestation, Buffer.from(keyId, "base64"), digest(VoiceSecurity.enrollmentMessage(p.uid, p.deviceId, challenge)), {
          appId: config.appId, environments: config.environments, now: this.now(),
          ...(config.root ? { rootPem: config.root } : {}),
        });
        await tx.put("voice_key", p.deviceId, { platform: "ios", keyId, publicKey: key.publicKeyPem, counter: 0, integrityAt: this.now() });
        await tx.remove("voice_access", p.deviceId);
      } catch (error) {
        if (error instanceof VerificationError) throw proofFailed();
        throw error;
      }
    });
  }
  async enrollAndroid(p: DevicePrincipal, body: Record<string, unknown>) {
    await this.service.run(p, (tx) => this.service.voiceProofAttempt(tx));
    const play = this.config.android?.play;
    if (!play) throw conflict("voice_unavailable", "音声の確認を利用できません。");
    const challenge = string(body, "challenge", 100, true)!;
    const keyDer = decoded(body.public_key, 1000);
    const token = string(body, "integrity_token", 20_000, true)!;
    let key;
    try { key = createPublicKey({ key: keyDer, format: "der", type: "spki" }); }
    catch { throw proofFailed(); }
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw proofFailed();
    const keyId = b64url(digest(keyDer));
    const message = VoiceSecurity.enrollmentMessage(p.uid, p.deviceId, challenge, keyId);
    await this.service.run(p, (tx) => this.consume(tx, p, challenge, "android_enroll"));
    try { await play.verifyIntegrity(token, b64url(digest(message))); }
    catch (error) {
      if (error instanceof VerificationError) throw proofFailed();
      throw new CloudError(503, "temporarily_unavailable", "端末の確認を再試行してください。");
    }
    await this.service.run(p, async (tx) => {
      const device = await this.device(tx, p);
      if (device.platform !== "android") throw proofFailed();
      await tx.put("voice_key", p.deviceId, { platform: "android", keyId, publicKey: key.export({ format: "pem", type: "spki" }).toString(), counter: 0, integrityAt: this.now() });
      await tx.remove("voice_access", p.deviceId);
    });
  }
  async token(p: DevicePrincipal, body: Record<string, unknown>) {
    await this.service.run(p, (tx) => this.service.voiceProofAttempt(tx));
    const challenge = string(body, "challenge", 100, true)!;
    const signature = decoded(body.signature, 4000);
    const keyId = string(body, "key_id", 200, true)!;
    return this.service.run(p, async (tx) => {
      const device = await this.device(tx, p);
      await this.consume(tx, p, challenge, "token");
      const key = await tx.get("voice_key", p.deviceId);
      if (!key || key.keyId !== keyId || key.platform !== device.platform) throw conflict("attestation_required", "端末の登録が必要です。");
      if (key.platform === "android" && this.now() - key.integrityAt >= ANDROID_PROOF_MS)
        throw conflict("integrity_required", "端末の確認を更新してください。");
      const message = VoiceSecurity.tokenMessage(p.uid, p.deviceId, challenge);
      if (key.platform === "ios") {
        const config = this.config.apple;
        if (!config) throw proofFailed();
        try { key.counter = verifyAssertion(signature, digest(message), key.publicKey, config.appId, key.counter); }
        catch (error) { if (error instanceof VerificationError) throw proofFailed(); throw error; }
      } else if (!verifySignature("sha256", Buffer.from(message), key.publicKey, signature)) throw proofFailed();
      await tx.put("voice_key", p.deviceId, key);
      const value = `kv_${b64url(randomBytes(32))}`;
      const expires = this.now() + ACCESS_MS;
      await tx.put("voice_access", p.deviceId, { tokenHash: hash(value), keyId, expires }, expires);
      return { access_token: value, expires_at: new Date(expires).toISOString(), expires_in: ACCESS_MS / 1000 };
    });
  }
}
