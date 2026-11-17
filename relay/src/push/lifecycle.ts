/** Only a client registration renews a destination; provider acceptance is not delivery. */
export const PUSH_REGISTRATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PUSH_FIELDS = ["push_token", "voip_token"] as const;
export type PushField = (typeof PUSH_FIELDS)[number];
export const registrationField = (field: PushField) =>
  field === "push_token" ? "push_registered_at" : "voip_registered_at";

export function freshPushRegistration(registeredAt: number, now: number): boolean {
  // API and worker clocks can differ slightly on separate hosts.
  return Number.isFinite(registeredAt) && registeredAt <= now + 300_000 && now - registeredAt < PUSH_REGISTRATION_TTL_MS;
}

/** An opaque app/device identity, used only to retire superseded pairings. */
export function validPushClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}
