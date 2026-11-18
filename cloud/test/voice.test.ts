import { afterAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { CloudApp } from "../src/app.ts";
import { VoiceSecurity, loadVoiceConfig } from "../src/voice.ts";
import { OFFICIAL_CLOUD_ORIGIN, requiresVoiceProof } from "../src/config.ts";
import { JobWorker } from "../src/worker.ts";
import { fakeAppAttest } from "./billing-fixtures.ts";
import { harness } from "./helpers.ts";
import type { GooglePlay } from "../src/billing/google.ts";

const APP_ID = "TEAM123456.com.example.app";
const attest = fakeAppAttest(APP_ID);
afterAll(() => attest.dispose());
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("base64url");

function setup() {
  const h = harness();
  h.service.voiceProofRequired = true;
  const seen: string[] = [];
  const play = {
    async verifyIntegrity(_token: string, requestHash: string) { seen.push(requestHash); },
  } as unknown as GooglePlay;
  const voice = new VoiceSecurity(h.service, {
    apple: { appId: APP_ID, environments: ["production"], root: attest.rootPem },
    android: { play },
  });
  const app = new CloudApp(h.service, h.app.verifier, undefined, undefined, undefined, undefined, undefined, voice);
  const call = async (method: string, path: string, token: string | null, body?: unknown, voiceToken?: string) => {
    const response = (await app.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(voiceToken ? { "x-oyobidashi-voice-token": voiceToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })))!;
    return { status: response.status, body: response.status === 204 ? null : await response.json() as any };
  };
  const challenge = async (token: string, purpose: string) =>
    (await call("POST", "/v1/voice/challenge", token, { purpose })).body.challenge as string;
  return { h, voice, call, challenge, seen };
}

describe("cloud voice proof", () => {
  test("self-hosted cloud voice works with the paired device token alone", async () => {
    const h = harness();
    h.service.voiceProofRequired = requiresVoiceProof({}, "https://cloud.example");
    const d = await h.pair("alice", "android");
    expect((await h.call("GET", "/v1/voice", d.device_token)).status).toBe(404);
    const result = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "q", priority: "high", delivery_mode: "call",
    });
    const path = `/v1/requests/${result.body.request.id}/call`;
    expect((await h.call("POST", path, null, { event: "answer" })).status).toBe(401);
    expect((await h.call("POST", path, d.device_token, { event: "answer" })).status).toBe(200);
    const turnId = crypto.randomUUID();
    const turn = await h.call("POST", path, d.device_token, { event: "turn", text: "yes", turn_id: turnId, async: true });
    expect(turn.status).toBe(202);
    const worker = new JobWorker(h.service, {
      conversation: { turn: async () => ({ reply: "ok", resolved: true, answer: "yes" }) },
    });
    expect(await worker.runOnce("turn")).toBe(true);
    const completed = await h.call("GET", `/v1/requests/${result.body.request.id}/turns/${turnId}`, d.device_token);
    expect(completed.body.request.status).toBe("answered");
    expect(requiresVoiceProof({ VOICE_REQUIRE_DEVICE_PROOF: "0" }, OFFICIAL_CLOUD_ORIGIN)).toBe(true);
    expect(requiresVoiceProof({ VOICE_REQUIRE_DEVICE_PROOF: "1" }, "https://cloud.example")).toBe(true);
  });

  test("empty Compose overrides preserve the App Attest fallback", () => {
    const compose = {
      VOICE_APPLE_TEAM_ID: "",
      VOICE_APPLE_BUNDLE_ID: "",
      VOICE_APP_ATTEST_ENVIRONMENTS: "",
      APPLE_TEAM_ID: "TEAM123456",
      APPLE_IAP_BUNDLE_ID: "com.example.app",
    };
    expect(loadVoiceConfig(compose).apple).toEqual({ appId: APP_ID, environments: ["production"] });
    expect(loadVoiceConfig({ ...compose, APPLE_APP_ATTEST_ENVIRONMENTS: "development" }).apple?.environments)
      .toEqual(["development"]);
  });

  test("a scripted phone cannot answer or enqueue model work before App Attest", async () => {
    const s = setup(), d = await s.h.pair();
    const request = await s.h.call("POST", "/v1/requests", "agent-alice", { question: "q", priority: "high", delivery_mode: "call" });
    const path = `/v1/requests/${request.body.request.id}/call`;
    expect((await s.call("POST", path, d.device_token, { event: "answer" })).body.error.code).toBe("voice_proof_required");
    expect((await s.call("POST", path, d.device_token, { event: "turn", text: "yes", turn_id: crypto.randomUUID(), async: true })).status).toBe(403);
    expect((await s.call("GET", "/v1/voice", d.device_token)).body.supported).toBe(true);
  });

  test("an attested iPhone receives a ten-minute voice token and renews with a local assertion", async () => {
    const s = setup(), d = await s.h.pair(), key = attest.device();
    const enroll = await s.challenge(d.device_token, "apple_enroll");
    const message = VoiceSecurity.enrollmentMessage("alice", d.device.id, enroll);
    expect((await s.call("POST", "/v1/voice/apple/attest", d.device_token, {
      challenge: enroll, key_id: key.keyId, attestation: key.attestation(message),
    })).status).toBe(204);
    const issue = async () => {
      const challenge = await s.challenge(d.device_token, "token");
      return s.call("POST", "/v1/voice/token", d.device_token, {
        challenge, key_id: key.keyId, signature: key.assertion(VoiceSecurity.tokenMessage("alice", d.device.id, challenge)),
      });
    };
    const first = await issue();
    expect(first.status).toBe(200);
    expect(first.body.expires_in).toBe(600);
    const request = await s.h.call("POST", "/v1/requests", "agent-alice", { question: "q", priority: "high", delivery_mode: "call" });
    const path = `/v1/requests/${request.body.request.id}/call`;
    expect((await s.call("POST", path, d.device_token, { event: "answer" }, first.body.access_token)).status).toBe(200);
    const turn = await s.call("POST", path, d.device_token, { event: "turn", text: "はい", turn_id: crypto.randomUUID(), async: true }, first.body.access_token);
    expect(turn.status).toBe(202);
    const worker = new JobWorker(s.h.service, { conversation: { turn: async () => ({ reply: "はい", resolved: false, answer: null }) } });
    expect(await worker.runOnce("turn")).toBe(true);
    expect((await s.call("POST", path, d.device_token, { event: "hangup" })).status).toBe(200);
    s.h.advance(600_001);
    const later = await s.h.call("POST", "/v1/requests", "agent-alice", { question: "再確認", priority: "high", delivery_mode: "call" });
    const laterPath = `/v1/requests/${later.body.request.id}/call`;
    expect((await s.call("POST", laterPath, d.device_token, { event: "answer" }, first.body.access_token)).body.error.code).toBe("voice_proof_required");
    const renewed = await issue();
    expect(renewed.status).toBe(200);
    expect(renewed.body.access_token).not.toBe(first.body.access_token);
    expect((await s.call("POST", laterPath, d.device_token, { event: "answer" }, renewed.body.access_token)).status).toBe(200);
    expect((await s.call("POST", laterPath, d.device_token, { event: "turn", text: "次", turn_id: crypto.randomUUID(), async: true }, renewed.body.access_token)).status).toBe(202);
    expect((await s.call("DELETE", "/v1/devices/me", d.device_token)).status).toBe(204);
    expect((await s.call("GET", "/v1/voice", d.device_token)).status).toBe(401);
  });

  test("Android Play Integrity binds a Keystore key, while short renewals avoid Google", async () => {
    const s = setup(), d = await s.h.pair("alice", "android");
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const der = pair.publicKey.export({ format: "der", type: "spki" });
    const keyId = sha(der);
    const enrollment = await s.challenge(d.device_token, "android_enroll");
    const message = VoiceSecurity.enrollmentMessage("alice", d.device.id, enrollment, keyId);
    expect((await s.call("POST", "/v1/voice/android/enroll", d.device_token, {
      challenge: enrollment, public_key: der.toString("base64"), integrity_token: "synthetic",
    })).status).toBe(204);
    expect(s.seen).toEqual([sha(message)]);
    const issue = async () => {
      const challenge = await s.challenge(d.device_token, "token");
      const message = VoiceSecurity.tokenMessage("alice", d.device.id, challenge);
      return s.call("POST", "/v1/voice/token", d.device_token, {
        challenge, key_id: keyId, signature: sign("sha256", Buffer.from(message), pair.privateKey).toString("base64"),
      });
    };
    expect((await issue()).status).toBe(200);
    expect((await issue()).status).toBe(200);
    expect(s.seen).toHaveLength(1);
    s.h.advance(6 * 3600_000);
    expect((await issue()).body.error.code).toBe("integrity_required");
  });
});
