import qrcode from "qrcode-generator";
import { needsInputConsent, type InputRestriction } from "./input-restriction.ts";

export type PageMode = "authorize" | "pair" | "connections";
export type PageStep = "input_restriction" | "pairing" | "approval" | "connections";

/**
 * The screen a signed-in human sees next. The FREE plan input restriction comes
 * first and only for an owner it applies to; everyone else goes straight on.
 */
export function stepAfterSignIn(mode: PageMode, restriction: InputRestriction, paired: number): PageStep {
  if (needsInputConsent(restriction)) return "input_restriction";
  if (mode === "connections") return "connections";
  return mode === "authorize" && paired > 0 ? "approval" : "pairing";
}

/** An agent cannot be linked without the acceptance; the other pages may postpone it. */
export function canPostponeInputConsent(mode: PageMode): boolean {
  return mode !== "authorize";
}

/** The request fields the consent page hands back to the server unchanged. */
export const AUTHORIZATION_FIELDS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource"] as const;

/** Copies only known authorization fields; the server validates every value again. */
export function authorizationParams(search: string): Record<string, string> {
  const query = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const key of AUTHORIZATION_FIELDS) {
    const value = query.get(key);
    if (value !== null && value.length <= 4000) out[key] = value;
  }
  return out;
}

/**
 * The same one-time URL the terminal pairing command prints; the app reads it from a QR code.
 * `state` is added only to the link that returns to the app that opened this page.
 */
export function pairingUrl(origin: string, code: string, state?: string | null): string {
  const url = new URL("oyobidashi://pair");
  url.searchParams.set("url", origin);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return url.href;
}

/**
 * Whether this page is open on the phone that is being paired: the app opened
 * it (`?from=app`), or a phone browser did. Such a phone cannot scan its own
 * screen, so the page does not lead with the QR code.
 */
export function isPhoneToPair(search: string, userAgent: string): boolean {
  return openedByApp(search) || /Android|iPhone|iPad|iPod/i.test(userAgent);
}

/** The app's own "connect" button opened this page, so a link can return to it. */
export function openedByApp(search: string): boolean {
  return new URLSearchParams(search).get("from") === "app";
}

/**
 * The one-time value the app put on this page's address. The app pairs from a
 * link only when the link returns the value it issued, so a link that somebody
 * else sent cannot pair the phone with their account. Apps older than this
 * check send none and accept any link.
 */
export function appPairingState(search: string): string | null {
  const state = new URLSearchParams(search).get("state");
  return state !== null && /^[A-Za-z0-9_-]{43}$/.test(state) ? state : null;
}

/** The hosted service: the only origin the app's own "connect" button opens. */
export function isHostedService(origin: string): boolean {
  return origin === "https://api.oyobidashi.me";
}

/** A QR code as one SVG path on a square grid, including the four-module quiet zone. */
export function qrPath(text: string): { size: number; path: string } {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const modules = qr.getModuleCount(),
    quiet = 4;
  let path = "";
  for (let row = 0; row < modules; row++)
    for (let column = 0; column < modules; column++)
      if (qr.isDark(row, column)) path += `M${column + quiet} ${row + quiet}h1v1h-1z`;
  return { size: modules + quiet * 2, path };
}

/** Reads the paired-device count from a presence response without trusting its shape. */
export function pairedDevices(presence: unknown): number {
  const devices = (presence as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) throw new Error("invalid presence response");
  return devices.length;
}
