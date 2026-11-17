import qrcode from "qrcode-generator";

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

/** The same one-time URL the terminal pairing command prints; the app reads it from a QR code. */
export function pairingUrl(origin: string, code: string): string {
  const url = new URL("oyobidashi://pair");
  url.searchParams.set("url", origin);
  url.searchParams.set("code", code);
  return url.href;
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
