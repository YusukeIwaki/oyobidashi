import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID-like id: 10 chars of time + 16 chars of randomness (lexicographically time-sortable). */
export function ulid(nowMs: number): string {
  let time = "";
  let t = Math.floor(nowMs);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let random = "";
  for (let i = 0; i < 16; i++) random += CROCKFORD[rnd[i]! & 31];
  return time + random;
}

export const newRequestId = (nowMs: number) => `req_${ulid(nowMs)}`;
export const newDeviceId = (nowMs: number) => `dev_${ulid(nowMs)}`;
export const newAgentToken = () => `ka_${randomBytes(32).toString("base64url")}`;
export const newDeviceToken = () => `kd_${randomBytes(32).toString("base64url")}`;
/** 32 hex chars = 128 bits. */
export const newPairingCode = () => randomBytes(16).toString("hex");

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
