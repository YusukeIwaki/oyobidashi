import { networkInterfaces } from "node:os";
import type { Store } from "./db.ts";
import { newPairingCode, sha256Hex } from "./ids.ts";
import { isLanIPv4 } from "./net.ts";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/** Issues a one-time code. Only its hash is stored. */
export function issuePairingCode(store: Store, now: number): { code: string; expiresAt: number } {
  const code = newPairingCode();
  const expiresAt = now + PAIRING_CODE_TTL_MS;
  store.purgePairingCodes(now);
  store.insertPairingCode(sha256Hex(code), now, expiresAt);
  return { code, expiresAt };
}

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`public URL must be http(s): ${url}`);
  }
  return trimmed;
}

export function buildPairingUri(publicUrl: string, code: string): string {
  return `oyobidashi://pair?url=${encodeURIComponent(normalizeBaseUrl(publicUrl))}&code=${encodeURIComponent(code)}`;
}

export type Interfaces = ReturnType<typeof networkInterfaces>;

/** Name of the interface that carries the default route (e.g. "en0"), or null when unknown. */
export function detectDefaultInterface(): string | null {
  try {
    const cmd = process.platform === "darwin" ? ["route", "-n", "get", "default"] : ["ip", "route", "show", "default"];
    const res = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", timeout: 2000 });
    if (res.exitCode !== 0) return null;
    const text = res.stdout.toString();
    const m = process.platform === "darwin" ? /interface:\s*(\S+)/.exec(text) : /\bdev\s+(\S+)/.exec(text);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * The Mac's private (RFC 1918) IPv4 address: the default-route interface's if it has one, otherwise the
 * first one on any other interface. Loopback, link-local, public and VPN-style (e.g. 100.64/10) are ignored.
 */
export function detectLanIPv4(interfaces: Interfaces, defaultInterface: string | null): string | null {
  const lanOf = (name: string): string | null => {
    for (const a of interfaces[name] ?? []) {
      if (a.family === "IPv4" && !a.internal && isLanIPv4(a.address)) return a.address;
    }
    return null;
  };
  if (defaultInterface) {
    const preferred = lanOf(defaultInterface);
    if (preferred) return preferred;
  }
  for (const name of Object.keys(interfaces)) {
    const found = lanOf(name);
    if (found) return found;
  }
  return null;
}

export type PublicUrlSource = "flag" | "serve" | "lan";

export interface ResolvePublicUrlOptions {
  /** `--public-url` of this command. */
  explicit?: string | null;
  /** `--public-url` given to the running `serve`. */
  fromServe?: string | null;
  port: number;
  interfaces?: Interfaces;
  defaultInterface?: () => string | null;
}

/** PROTOCOL.md section 7: --public-url, else http://<private IPv4 of the default-route interface>:<port>. */
export function resolvePublicUrl(opts: ResolvePublicUrlOptions): { url: string; source: PublicUrlSource } {
  if (opts.explicit) return { url: normalizeBaseUrl(opts.explicit), source: "flag" };
  if (opts.fromServe) return { url: normalizeBaseUrl(opts.fromServe), source: "serve" };
  const ip = detectLanIPv4(
    opts.interfaces ?? networkInterfaces(),
    (opts.defaultInterface ?? detectDefaultInterface)(),
  );
  if (!ip) {
    throw new Error(
      "LAN 内のプライベート IPv4 アドレスが見つかりません。--public-url http://<ホスト名>.local:<port> のように指定してください",
    );
  }
  return { url: `http://${ip}:${opts.port}`, source: "lan" };
}
