import http2 from "node:http2";
import type { RequestObject } from "../types.ts";
import { b64url, notificationText, pushPreview, pemToDer, type PushProvider, type PushResult, type PushTarget } from "./types.ts";

export interface ApnsTransportRequest {
  /** e.g. https://api.push.apple.com */
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
export interface ApnsTransportResponse {
  status: number;
  body: string;
}
export type ApnsTransport = (req: ApnsTransportRequest) => Promise<ApnsTransportResponse>;

export interface ApnsOptions {
  /** Contents of the AuthKey_XXXX.p8 file (PKCS#8 PEM, P-256). */
  keyPem: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  transport: ApnsTransport;
  now?: () => number;
}

export const APNS_PRODUCTION_ORIGIN = "https://api.push.apple.com";
export const APNS_SANDBOX_ORIGIN = "https://api.sandbox.push.apple.com";
/** APNs rejects provider tokens older than 1h and refreshes more often than every 20min. */
export const APNS_JWT_TTL_MS = 50 * 60 * 1000;

export function buildApnsPayload(request: RequestObject): Record<string, unknown> {
  const text = notificationText(request);
  const title=pushPreview(text.title,180);
  const actionChoices=request.delivery_mode === "actions" ? (request.choices ?? []).slice(0,3).map(x=>pushPreview(x,180)) : [];
  const body=pushPreview(text.body,1400)+(actionChoices.length ? "\n"+actionChoices.map((x,i)=>`${i+1}: ${x}`).join(" / ") : "");
  const isNotification = request.kind === "notification";
  const category = isNotification ? "OYOBIDASHI_NOTIFICATION"
    : request.items || request.requires_item_answers ? "OYOBIDASHI_ITEM_QUESTION"
    : request.delivery_mode === "actions" ? `OYOBIDASHI_ACTIONS_${actionChoices.length}` : "OYOBIDASHI_QUESTION";
  return {
    aps: {
      alert: { title, body },
      ...(request.priority === "low" ? {} : {sound:"default"}),
      "mutable-content":1,
      "interruption-level": request.priority === "low" ? "passive" : request.priority === "normal" ? "active" : request.priority ? "time-sensitive" : isNotification ? "active" : "time-sensitive",
      category,
      "thread-id": "oyobidashi",
    },
    request_id: request.id,
    ...(request.recipient_device_id ? {recipient_device_id:request.recipient_device_id} : {}),
    ...(request.preview_url&&request.preview_token?{preview_url:request.preview_url,preview_token:request.preview_token}:{}),
    kind: request.kind,
    ...(request.priority ? {priority:request.priority,delivery_mode:request.delivery_mode,status:request.status,choices:actionChoices} : {}),
  };
}

export interface ApnsProvider extends PushProvider {
  /** Imports the key; rejects if the .p8 is unusable. */
  ready(): Promise<void>;
}

export function createApnsProvider(opts: ApnsOptions): ApnsProvider {
  const now = opts.now ?? Date.now;
  let keyPromise: Promise<CryptoKey> | null = null;
  let cached: { jwt: string; issuedAt: number } | null = null;
  let signing: Promise<string> | null = null;

  const key = () =>
    (keyPromise ??= crypto.subtle.importKey(
      "pkcs8",
      pemToDer(opts.keyPem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    ));

  async function providerToken(): Promise<string> {
    const t = now();
    if (cached && t - cached.issuedAt < APNS_JWT_TTL_MS && t >= cached.issuedAt) return cached.jwt;
    if (signing) return signing;
    signing = (async () => {
      const header = b64url(JSON.stringify({ alg: "ES256", kid: opts.keyId }));
      const claims = b64url(JSON.stringify({ iss: opts.teamId, iat: Math.floor(t / 1000) }));
      const input = `${header}.${claims}`;
      // WebCrypto ECDSA yields the raw r||s form, which is exactly what JWS ES256 wants.
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await key(), Buffer.from(input));
      const jwt = `${input}.${b64url(sig)}`;
      cached = { jwt, issuedAt: t };
      return jwt;
    })();
    try {
      return await signing;
    } finally {
      signing = null;
    }
  }

  async function attempt(target: PushTarget, request: RequestObject): Promise<ApnsTransportResponse> {
    const jwt = await providerToken();
    const voip = target.type === "voip";
    const update = target.type === "update";
    const recipient={...(request.recipient_device_id?{recipient_device_id:request.recipient_device_id}:{}),...(request.preview_url&&request.preview_token?{preview_url:request.preview_url,preview_token:request.preview_token}:{})};
    const payload = voip ? {
      aps: { "content-available": 1 },
      request_id: request.id,
      call_id: request.call?.id,
      question: pushPreview(request.question,1400),
      ...(request.subject ? { subject: request.subject } : {}),
      ...(request.agent?.name ? { agent_name: pushPreview(request.agent.name,180) } : {}),
      ...recipient,
    }
      : update ? { aps: { "content-available": 1 }, request_id: request.id, kind:request.kind,status:request.status,...recipient }
      : buildApnsPayload(request);
    return opts.transport({
      origin: target.environment === "development" ? APNS_SANDBOX_ORIGIN : APNS_PRODUCTION_ORIGIN,
      path: `/3/device/${encodeURIComponent(target.token)}`,
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-push-type": voip ? "voip" : update ? "background" : "alert",
        "apns-topic": voip ? `${opts.bundleId}.voip` : opts.bundleId,
        "apns-priority": update ? "5" : "10",
        "apns-collapse-id": request.id,
        // Do not deliver a question after it can no longer be answered.
        "apns-expiration": voip ? "0" : String(Math.floor(Date.parse(request.expires_at) / 1000)),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  const reasonOf = (body: string): string => {
    try {
      const parsed = JSON.parse(body) as { reason?: unknown };
      return typeof parsed.reason === "string" ? parsed.reason : "";
    } catch {
      return "";
    }
  };

  return {
    async ready() {
      await key();
    },
    async send(target, request): Promise<PushResult> {
      let res = await attempt(target, request);
      if (res.status === 403 && reasonOf(res.body) === "ExpiredProviderToken") {
        cached = null;
        res = await attempt(target, request);
      }
      if (res.status === 200) return { ok: true };
      const reason = reasonOf(res.body);
      const unregistered = res.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
      return { ok: false, unregistered, reason: `apns ${res.status}${reason ? ` ${reason}` : ""}` };
    },
  };
}

/** Real transport: one long-lived HTTP/2 session per origin, re-created when it dies. */
export function createHttp2ApnsTransport(timeoutMs = 10_000): ApnsTransport & { close(): void } {
  const sessions = new Map<string, http2.ClientHttp2Session>();

  function session(origin: string): http2.ClientHttp2Session {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = http2.connect(origin);
    const drop = () => {
      if (sessions.get(origin) === s) sessions.delete(origin);
    };
    s.on("error", drop);
    s.on("close", drop);
    s.on("goaway", drop);
    s.unref?.();
    sessions.set(origin, s);
    return s;
  }

  const transport = (req: ApnsTransportRequest) =>
    new Promise<ApnsTransportResponse>((resolve, reject) => {
      let s: http2.ClientHttp2Session;
      try {
        s = session(req.origin);
      } catch (e) {
        reject(e as Error);
        return;
      }
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.off("error", fail);
        reject(e);
      };
      s.once("error", fail);
      const stream = s.request({ ":method": "POST", ":path": req.path, ...req.headers });
      const timer = setTimeout(() => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        fail(new Error("apns request timed out"));
      }, timeoutMs);
      let status = 0;
      const chunks: Buffer[] = [];
      stream.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.off("error", fail);
        resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
      });
      stream.on("error", fail);
      stream.end(req.body);
    });

  return Object.assign(transport, {
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  });
}
