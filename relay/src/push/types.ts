import type { PushEnvironment, RequestObject } from "../types.ts";

export interface PushTarget {
  token: string;
  type?: "alert" | "update" | "voip";
  environment: PushEnvironment | null;
}

export type PushResult =
  | { ok: true }
  /** `unregistered: true` means the token is dead and must be forgotten. */
  | { ok: false; unregistered: boolean; reason: string };

export interface PushProvider {
  send(target: PushTarget, request: RequestObject): Promise<PushResult>;
}

/** Providers keyed by device platform. A missing key means push is disabled for that platform. */
export interface PushProviders {
  ios?: PushProvider;
  android?: PushProvider;
}

const BODY_MAX_CHARS = 1000;

export function notificationText(request: RequestObject): { title: string; body: string } {
  const name = request.agent?.name;
  const suffix = request.kind === "notification" ? "からのお知らせ" : "からの質問";
  const title = name ? `${name} ${suffix}` : `エージェント${suffix}`;
  let body = request.question;
  if (body.length > BODY_MAX_CHARS) {
    // Cut by code point so a surrogate pair is never split.
    const chars = Array.from(body);
    if (chars.length > BODY_MAX_CHARS) body = chars.slice(0, BODY_MAX_CHARS).join("");
  }
  return { title, body };
}

export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("-----"))
    .join("")
    .replace(/\s+/g, "");
  if (b64.length === 0) throw new Error("PEM has no body");
  const buf = Buffer.from(b64, "base64");
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

export const b64url = (data: string | Uint8Array | ArrayBuffer): string =>
  (typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data as ArrayBuffer)).toString("base64url");

/** Bound the UTF-8 payload, including multi-byte Japanese/emoji, below provider limits. */
export function pushPreview(value: string, maxBytes: number): string {
  if(Buffer.byteLength(value,"utf8")<=maxBytes) return value;
  let result=""; let bytes=0;
  for(const ch of value) { const next=Buffer.byteLength(ch,"utf8"); if(bytes+next>maxBytes-3) break; result+=ch;bytes+=next; }
  return result+"…";
}
