import type {
  Call,
  DeviceObject,
  Presence,
  RequestObject,
} from "../../relay/src/types.ts";

export interface TurnView {
  id: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  reply: string | null;
  resolved: boolean;
  error: { code: string; message: string } | null;
  deadline?: number;
}
export interface CloudCall extends Call {
  turn?: TurnView;
  turn_count?: number;
}
export interface CloudRequest extends RequestObject {
  version: number;
  call: CloudCall | null;
}
export interface Device extends DeviceObject {
  push_client_id?: string | null;
  push_registered_at?: number | null;
  voip_registered_at?: number | null;
  tokenHash: string;
  push_token: string | null;
  voip_token: string | null;
  push_environment: "development" | "production" | null;
  lastSeen: number;
}
export interface Turn extends TurnView {
  requestId: string;
  callId: string;
  deviceId: string;
  text: string;
  deadline: number;
}
export interface Pairing {
  expires: number;
  used: boolean;
}
export interface Dedupe {
  fingerprint: string;
  requestId: string;
  expires: number;
}
export interface Feedback {
  request_id: string;
  device_id: string | null;
  event: string;
  at: string;
}
/** One store subscription or beneficiary seat held by this owner. */
export interface EntitlementSource {
  store: "apple" | "google";
  product_id: string;
  expires: number;
  shared: boolean;
}
export interface AppleBillingProof {
  value: EntitlementSource;
  accountId?: string;
  /** End of the signed transaction, even when a refund makes access end now. */
  periodEnd: number;
  signedDate: number;
  revoked: boolean;
}
export interface GoogleBillingProof {
  value: EntitlementSource;
  accountId?: string;
  linkedSource?: string;
}
export function newerAppleProof(previous: AppleBillingProof | null, next: AppleBillingProof): boolean {
  if (!previous) return true;
  if (next.signedDate < previous.signedDate) return false;
  if (next.revoked) return next.periodEnd >= previous.periodEnd;
  if (previous.revoked) return next.periodEnd > previous.periodEnd;
  // Grace can extend an older transaction, so compare its effective access
  // deadline rather than the transaction's original period end.
  if (next.value.expires < previous.value.expires) return false;
  return true;
}
export interface Entitlement {
  sources: Record<string, EntitlementSource>;
}
export const entitled = (e: Entitlement | null, now: number) =>
  !!e && Object.values(e.sources).some((s) => s.expires > now);
export interface Records {
  entitlement: Entitlement;
  /** App Attest key of one iOS device, keyed by device ID. */
  attest: { key_id: string; public_key: string; counter: number };
  /** Single-use billing challenge, keyed by its hash. */
  challenge: { deviceId: string; expires: number };
  request: CloudRequest;
  device: Device;
  turn: Turn;
  pairing: Pairing;
  presence: Presence;
  dedupe: Dedupe;
  feedback: Feedback;
  quota: { window: number; count: number };
  call_cooldown: { until: number };
  ban: { at: number; reason: "voice_velocity" | "voice_oversize" | "voice_hammer" };
  voice_turn_usage: { recent: { at: number; oversized: boolean }[] };
  voice_attempts: { recent: number[] };
  voice_challenge: { deviceId: string; purpose: "apple_enroll" | "android_enroll" | "token"; expires: number };
  voice_key: { platform: "ios" | "android"; keyId: string; publicKey: string; counter: number; integrityAt: number };
  voice_access: { tokenHash: string; keyId: string; expires: number };
  preview: {
    requestId: string;
    deviceId: string;
    field: "push_token" | "voip_token";
    expires: number;
  };
}
export type Kind = keyof Records;
export interface Job {
  id: string;
  uid: string;
  kind: "turn" | "push";
  requestId: string;
  payload: {
    turnId?: string;
    deviceId?: string;
    update?: boolean;
    version?: number;
    mode?: "call" | "text";
  };
  state: "ready" | "leased" | "done";
  available: number;
  deadline: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  attempts: number;
}
export type NewJob = Pick<
  Job,
  "kind" | "requestId" | "payload" | "deadline"
> & { id?: string; available?: number };
export interface Transaction {
  readonly uid: string;
  get<K extends Kind>(kind: K, id: string): Promise<Records[K] | null>;
  put<K extends Kind>(
    kind: K,
    id: string,
    doc: Records[K],
    due?: number | null,
  ): Promise<void>;
  remove(kind: Kind, id: string): Promise<void>;
  list<K extends Kind>(
    kind: K,
    filter?: { status?: string; requestId?: string },
    limit?: number,
  ): Promise<Records[K][]>;
  due(now: number): Promise<{ kind: Kind; id: string; doc: Records[Kind] }[]>;
  enqueue(job: NewJob): Promise<void>;
  job(id: string): Promise<Job | null>;
  saveJob(job: Job): Promise<void>;
  claimPush(
    device: Device,
    fields?: readonly ("push_token" | "voip_token")[],
  ): Promise<void>;
  ownsPush(
    device: Device,
    field: "push_token" | "voip_token",
  ): Promise<boolean>;
  releasePush(deviceId: string): Promise<void>;
  revision(): Promise<string>;
}
export interface Database {
  transaction<T>(uid: string, fn: (tx: Transaction) => Promise<T>): Promise<T>;
  findDevice(hash: string): Promise<{ uid: string; device: Device } | null>;
  findPairing(hash: string): Promise<string | null>;
  findPreview(hash: string): Promise<string | null>;
  isBanned(uid: string): Promise<boolean>;
  claim(kind: Job["kind"], now: number, leaseMs: number): Promise<Job | null>;
  dueOwners(now: number, limit?: number): Promise<string[]>;
  revisions(uids: string[]): Promise<Map<string, string>>;
  health(): Promise<void>;
  close(): Promise<void>;
  /** Recorded owners outlive active access, including after expiry and refunds. */
  billingHolders(source: string): Promise<string[]>;
  /** Applies a signed Apple update and its owner entitlement atomically. */
  applyAppleBilling(source: string, uid: string | null, proof: AppleBillingProof, now: number): Promise<void>;
  /** Updates one owner's Play access. True authorizes acknowledgement of the active purchase. */
  applyGoogleBilling(source: string, uid: string | null, proof: GoogleBillingProof, now: number): Promise<boolean>;
}
export interface WakeBus {
  publish(uid: string): Promise<void>;
  subscribe(listener: (uid: string) => void): Promise<() => void>;
  close(): void;
}
export interface IdentityVerifier {
  verify(token: string): Promise<string>;
  /** Also reports how the user signed in ("anonymous", "google.com", ...) when known. */
  identify?(token: string): Promise<{ uid: string; provider: string | null }>;
}
export const turnView = (t: Turn): TurnView => ({
  id: t.id,
  state: t.state,
  reply: t.reply,
  resolved: t.resolved,
  error: t.error,
  deadline: t.deadline,
});
export const iso = (ms: number) => new Date(ms).toISOString();
export const liveTurn = (t: TurnView | undefined | null) =>
  t?.state === "queued" || t?.state === "running";
export function pushEndpointKey(d: Device, field: "push_token" | "voip_token") {
  if (!d[field]) return null;
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([d.platform, d.push_environment, field, d[field]]))
    .digest("hex");
}
export function pushClientKey(d: Device) {
  return d.push_client_id ? `client:${new Bun.CryptoHasher("sha256").update(JSON.stringify([d.platform, d.push_client_id])).digest("hex")}` : null;
}
export const scopedJobId = (uid: string, id: string) =>
  `${new Bun.CryptoHasher("sha256").update(uid).digest("hex")}:${id}`;
