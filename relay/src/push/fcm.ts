import type { RequestObject } from "../types.ts";
import { b64url, notificationText, pushPreview, pemToDer, type PushProvider, type PushResult } from "./types.ts";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FcmOptions {
  serviceAccount?: ServiceAccount;
  projectId?: string;
  tokenProvider?: () => Promise<string>;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_MS = 60_000;

export function parseServiceAccount(json: string): ServiceAccount {
  const raw = JSON.parse(json) as Record<string, unknown>;
  for (const k of ["client_email", "private_key", "project_id"]) {
    if (typeof raw[k] !== "string" || raw[k] === "") throw new Error(`service account JSON is missing "${k}"`);
  }
  return {
    client_email: raw.client_email as string,
    private_key: raw.private_key as string,
    project_id: raw.project_id as string,
    token_uri: typeof raw.token_uri === "string" && raw.token_uri ? raw.token_uri : undefined,
  };
}

/** data-only message: every value is a string, the app builds the notification itself. */
export function buildFcmData(request: RequestObject): Record<string, string> {
  const { title, body } = notificationText(request);
  return {
    request_id: request.id,
    ...(request.recipient_device_id ? {recipient_device_id:request.recipient_device_id} : {}),
    ...(request.preview_url&&request.preview_token?{preview_url:request.preview_url,preview_token:request.preview_token}:{}),
    kind: request.kind,
    title:pushPreview(title,180),
    body:pushPreview(body,1400),
    urgency: request.urgency,
    ...(request.priority ? { priority: request.priority, delivery_mode: request.delivery_mode ?? "text", status: request.status, ...(request.call?.state === "ringing" ? {call_id:request.call.id} : {}), call: JSON.stringify(request.call ? {...request.call,transcript:[]} : null) } : {}),
    choices: JSON.stringify((request.choices ?? []).slice(0,3).map(x=>pushPreview(x,180))),
  };
}

export function buildFcmMessage(token: string, request: RequestObject): Record<string, unknown> {
  return { message: { token, data: buildFcmData(request), android: { priority: request.priority === "low" ? "normal" : "high", ...(request.priority ? { ttl: `${Math.max(0,Math.min(86400,Math.floor((Date.parse(request.expires_at)-Date.now())/1000)))}s`, collapse_key: request.id } : {}) } } };
}

export interface FcmProvider extends PushProvider {
  /** Imports the key; rejects if the service account is unusable. */
  ready(): Promise<void>;
}

export function createFcmProvider(opts: FcmOptions): FcmProvider {
  const now = opts.now ?? Date.now;
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sa = opts.serviceAccount;
  const tokenUri = sa?.token_uri ?? GOOGLE_TOKEN_URI;
  let keyPromise: Promise<CryptoKey> | null = null;
  let cached: { token: string; expiresAt: number } | null = null;
  let fetching: Promise<string> | null = null;

  const key = () =>
    (keyPromise ??= crypto.subtle.importKey(
      "pkcs8",
      pemToDer(sa!.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    ));

  async function accessToken(): Promise<string> {
    if (opts.tokenProvider) return opts.tokenProvider();
    const t = now();
    if (cached && t < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
    if (fetching) return fetching;
    fetching = (async () => {
      const iat = Math.floor(t / 1000);
      const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const claims = b64url(
        JSON.stringify({ iss: sa!.client_email, scope: FCM_SCOPE, aud: tokenUri, iat, exp: iat + 3600 }),
      );
      const input = `${header}.${claims}`;
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await key(), Buffer.from(input));
      const res = await doFetch(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${input}.${b64url(sig)}`,
        }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`fcm oauth token request failed: ${res.status}`);
      const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof json.access_token !== "string") throw new Error("fcm oauth response has no access_token");
      const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
      cached = { token: json.access_token, expiresAt: t + expiresIn * 1000 };
      return json.access_token;
    })();
    try {
      return await fetching;
    } finally {
      fetching = null;
    }
  }

  async function attempt(token: string, request: RequestObject): Promise<Response> {
    const access = await accessToken();
    return doFetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(opts.projectId ?? sa!.project_id)}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json; charset=utf-8", ...(opts.projectId ? {"x-goog-user-project":opts.projectId} : {}) },
      body: JSON.stringify(buildFcmMessage(token, request)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async ready() {
      if (!opts.tokenProvider) await key();
    },
    async send(target, request): Promise<PushResult> {
      let res = await attempt(target.token, request);
      if (res.status === 401) {
        cached = null;
        res = await attempt(target.token, request);
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: true };
      }
      const text = await res.text().catch(() => "");
      let status = "";
      let errorCode = "";
      try {
        const err = (JSON.parse(text) as { error?: { status?: unknown; details?: unknown } }).error;
        if (typeof err?.status === "string") status = err.status;
        if (Array.isArray(err?.details)) {
          for (const d of err.details as { errorCode?: unknown }[]) {
            if (typeof d?.errorCode === "string") errorCode = d.errorCode;
          }
        }
      } catch {
        // non-JSON error body
      }
      const unregistered = res.status === 404 || status === "UNREGISTERED" || errorCode === "UNREGISTERED";
      return { ok: false, unregistered, reason: `fcm ${res.status} ${errorCode || status}`.trim() };
    },
  };
}

/** Uses an already signed-in Google Cloud CLI; no new service-account private key is needed. */
export function gcloudTokenProvider(): () => Promise<string> {
  let token: {value:string;expires:number}|null=null;
  let pending:Promise<string>|null=null;
  return async () => {
    if (token && token.expires>Date.now()) return token.value;
    if (pending) return pending;
    pending=(async()=>{
      const process=Bun.spawn(["gcloud","auth","print-access-token","--quiet"],{stdout:"pipe",stderr:"ignore"});
      const timer=setTimeout(()=>process.kill(),10_000);
      try {
        const [output,code]=await Promise.all([new Response(process.stdout).text(),process.exited]);
        if(code!==0 || !output.trim() || output.length>16384) throw new Error("Google Cloud CLI authentication failed; run gcloud auth login");
        token={value:output.trim(),expires:Date.now()+40*60_000};
        return token.value;
      } finally { clearTimeout(timer); }
    })();
    try {return await pending;} finally {pending=null;}
  };
}
