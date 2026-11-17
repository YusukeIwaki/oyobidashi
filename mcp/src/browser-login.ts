import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ACCOUNT_PROVIDERS,
  parseAuthHandoff,
  type AccountProvider,
} from "../../relay/src/auth-handoff.ts";
import {
  CloudAuthError,
  cloudBaseUrl,
  inspectCloudAccount,
  parseCloudCredentials,
  type AuthDeps,
  type CloudCredentials,
} from "./cloud-auth.ts";

interface AccountIdentity {
  uid: string;
  providers: string[];
  anonymous: boolean;
}
export interface BrowserLoginOptions {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  mode: "signin" | "link";
  provider?: AccountProvider;
  expectedUid?: string;
  customToken?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  inspect?: (credentials: CloudCredentials) => Promise<AccountIdentity>;
  authDeps?: AuthDeps;
}
export interface BrowserLoginSession {
  url: string;
  result: Promise<CloudCredentials>;
  stop(): Promise<void>;
}

const successPage =
  "<!doctype html><html lang=ja><meta charset=utf-8><title>お呼び出し</title><p>認証が完了しました。このタブを閉じてターミナルへ戻ってください。</p></html>";
const failurePage =
  "<!doctype html><html lang=ja><meta charset=utf-8><title>お呼び出し</title><p>認証を完了できませんでした。ターミナルで再試行してください。元の接続情報は保持しています。</p></html>";
const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

/** A one-use local callback. Host, public origin, state and UID are all checked. */
export function startBrowserLogin(
  options: BrowserLoginOptions,
): BrowserLoginSession {
  const baseUrl = cloudBaseUrl(options.baseUrl),
    state = randomBytes(32).toString("base64url");
  if (!options.apiKey) throw new CloudAuthError("cloud_auth_invalid");
  const initial = parseAuthHandoff({
    version: 1, mode: options.mode, callbackUrl: "http://127.0.0.1:1/callback", state,
    ...(options.provider ? {provider: options.provider} : {}),
    ...(options.mode === "link" ? {uid: options.expectedUid, customToken: options.customToken} : {}),
  });
  let resolveResult!: (credentials: CloudCredentials) => void;
  let rejectResult!: (error: CloudAuthError) => void;
  let settled = false,
    busy = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<CloudCredentials>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => {});
  let cancelVerification!: (error: CloudAuthError) => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancelVerification = reject;
  });
  void cancelled.catch(() => {});
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    const error = new CloudAuthError("cloud_auth_required", message);
    cancelVerification(error);
    rejectResult(error);
  };
  const onAbort = () => {
    fail("Cloud login cancelled. Existing credentials were preserved.");
    void server.stop(true);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 5,
    maxRequestBodySize: 64 * 1024,
    error: () =>
      new Response(failurePage, { status: 400, headers: pageHeaders }),
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.headers.get("host") !== `127.0.0.1:${server.port}` ||
        url.pathname !== "/callback" ||
        url.search ||
        request.method !== "POST"
      )
        return new Response(null, { status: 404 });
      if (request.headers.get("origin") !== baseUrl)
        return new Response(null, { status: 403 });
      if (settled || busy) return new Response(null, { status: 409 });
      if (
        !request.headers
          .get("content-type")
          ?.startsWith("application/x-www-form-urlencoded")
      )
        return new Response(null, { status: 415 });
      let params: URLSearchParams;
      try {
        const text = await request.text();
        if (Buffer.byteLength(text) > 64 * 1024)
          return new Response(null, { status: 413 });
        params = new URLSearchParams(text);
      } catch {
        return new Response(null, { status: 413 });
      }
      const incoming = params.get("state") ?? "";
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(incoming) ||
        !timingSafeEqual(Buffer.from(incoming), Buffer.from(state))
      )
        return new Response(null, { status: 403 });
      // A second request may have arrived while the first body was still reading.
      if (settled || busy) return new Response(null, { status: 409 });
      busy = true;
      try {
        if (
          [...params.keys()].some(
            (k) =>
              !["state", "id_token", "refresh_token", "expires_at"].includes(k),
          ) ||
          [...params.keys()].length !== 4
        )
          throw new CloudAuthError("cloud_auth_invalid");
        const expires = params.get("expires_at") ?? "",
          now = (options.now ?? Date.now)();
        if (
          !/^\d{1,16}$/.test(expires) ||
          Number(expires) <= now ||
          Number(expires) > now + 86400_000
        )
          throw new CloudAuthError("cloud_auth_invalid");
        const credentials = parseCloudCredentials({
          version: 1,
          baseUrl,
          apiKey: options.apiKey,
          idToken: params.get("id_token"),
          refreshToken: params.get("refresh_token"),
          expiresAt: Number(expires),
          ...(options.projectId ? { projectId: options.projectId } : {}),
        });
        if (options.projectId) {
          let claims: { aud?: unknown; iss?: unknown };
          try {
            claims = JSON.parse(
              Buffer.from(
                credentials.idToken.split(".")[1] ?? "",
                "base64url",
              ).toString("utf8"),
            );
          } catch {
            throw new CloudAuthError("cloud_auth_invalid");
          }
          if (
            claims.aud !== options.projectId ||
            claims.iss !== `https://securetoken.google.com/${options.projectId}`
          )
            throw new CloudAuthError("cloud_auth_invalid");
        }
        const identity = await Promise.race([
          (
            options.inspect ?? ((c) => inspectCloudAccount(c, options.authDeps))
          )(credentials),
          cancelled,
        ]);
        if (options.expectedUid && identity.uid !== options.expectedUid)
          throw new CloudAuthError("cloud_auth_invalid");
        const expected = options.provider
          ? [`${options.provider}.com`]
          : ACCOUNT_PROVIDERS.map((p) => `${p}.com`);
        if (
          identity.anonymous ||
          !identity.providers.some((p) => expected.includes(p))
        )
          throw new CloudAuthError("cloud_auth_invalid");
        if (settled)
          return new Response(failurePage, {
            status: 408,
            headers: pageHeaders,
          });
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        resolveResult(credentials);
        void server.stop(false);
        return new Response(successPage, { headers: pageHeaders });
      } catch {
        fail(
          "Cloud login could not be verified for this account. Existing credentials were preserved. Retry the login or recovery command.",
        );
        void server.stop(false);
        return new Response(failurePage, { status: 400, headers: pageHeaders });
      }
    },
  });
  const handoff = parseAuthHandoff({
    ...initial,
    callbackUrl: `http://127.0.0.1:${server.port}/callback`,
  });
  const fragment = Buffer.from(JSON.stringify(handoff)).toString("base64url");
  timeout = setTimeout(() => {
    fail("Cloud login timed out. Existing credentials were preserved.");
    void server.stop(true);
  }, options.timeoutMs ?? 600_000);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return {
    url: `${baseUrl}/auth#${fragment}`,
    result,
    async stop() {
      if (!settled) {
        fail("Cloud login cancelled. Existing credentials were preserved.");
        await server.stop(true);
        return;
      }
      let grace: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          server.stop(false),
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, 250);
          }),
        ]);
      } finally {
        clearTimeout(grace);
        await server.stop(true);
      }
    },
  };
}

/** Shared bounded transport for public configuration and the own-UID link token. */
export async function authServerJson(
  baseUrl: string,
  path: "/v1/auth/config" | "/v1/auth/link-token",
  token?: string,
  send: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const origin = cloudBaseUrl(baseUrl),
    controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = (async () => {
    let response: Response;
    try {
      response = await send(origin + path, {
        method: token ? "POST" : "GET",
        headers: token
          ? {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            }
          : {},
        ...(token ? { body: "{}" } : {}),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new CloudAuthError("cloud_auth_unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CloudAuthError(
        response.status === 401
          ? "cloud_auth_required"
          : "cloud_auth_unavailable",
      );
    }
    const reader = response.body?.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 64 * 1024) {
            await reader.cancel();
            throw new CloudAuthError("cloud_auth_invalid");
          }
          chunks.push(value);
        }
    } finally {
      reader?.releaseLock();
    }
    try {
      const parsed: unknown = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new CloudAuthError("cloud_auth_invalid");
    }
  })();
  void request.catch(() => {});
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CloudAuthError("cloud_auth_unavailable"));
        }, timeoutMs);
      }),
    ]);
  } catch (e) {
    throw e instanceof CloudAuthError
      ? e
      : new CloudAuthError("cloud_auth_unavailable");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
