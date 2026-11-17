import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, fstatSync, fsyncSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { abortError, systemClock, type Clock } from "./clock.ts";
import type { FetchLike } from "./relay-client.ts";

/** All public auth errors deliberately omit provider bodies, URLs and credentials. */
export class CloudAuthError extends Error {
  constructor(readonly code: "cloud_auth_invalid" | "cloud_auth_required" | "cloud_auth_unavailable", message?: string) {
    super(message ?? (code === "cloud_auth_unavailable"
      ? "Cloud sign-in is temporarily unavailable. Retry later; existing credentials were preserved."
      : "Cloud sign-in is required. Run the cloud login command in your terminal."));
    this.name = "CloudAuthError";
  }
  get transient(): boolean { return this.code === "cloud_auth_unavailable"; }
}

export interface CloudCredentials {
  version: 1;
  baseUrl: string;
  apiKey: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number;
  projectId?: string;
}

/** Reject embedded credentials, redirect-like query parameters, fragments and insecure remote HTTP. */
export function cloudBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CloudAuthError("cloud_auth_invalid", "Cloud URL must be an HTTPS origin."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new CloudAuthError("cloud_auth_invalid", "Cloud URL must be an HTTPS origin (HTTP is allowed only on loopback).");
  }
  return url.origin;
}

function secretString(v: unknown): v is string { return typeof v === "string" && v.length > 0 && v.length <= 32_768 && !/[\r\n\s]/.test(v); }

/** An identity-change guard, never token verification. The cloud still verifies
 * signatures/issuer/audience. Both inputs originate from protected credentials
 * or the TLS-authenticated Firebase exchange. */
function credentialSubject(token:string):string|undefined {
  try { const value=JSON.parse(Buffer.from(token.split(".")[1]??"","base64url").toString("utf8")) as {sub?:unknown};return typeof value.sub==="string"&&value.sub.length>0&&value.sub.length<=128?value.sub:undefined; }
  catch { return undefined; }
}

// Firebase's refresh response calls its numeric project number `project_id`.
// The ID token audience carries the configured project ID instead. This is an
// identity guard on the TLS-authenticated exchange; the server verifies the JWT.
function credentialAudience(token: string): string | undefined {
  try { const value=JSON.parse(Buffer.from(token.split(".")[1]??"","base64url").toString("utf8")) as {aud?:unknown}; return typeof value.aud === "string" ? value.aud : undefined; }
  catch { return undefined; }
}

export function parseCloudCredentials(value: unknown): CloudCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CloudAuthError("cloud_auth_invalid");
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.baseUrl !== "string" || !secretString(v.apiKey) || !secretString(v.idToken) || !secretString(v.refreshToken)
    || typeof v.expiresAt !== "number" || !Number.isSafeInteger(v.expiresAt) || v.expiresAt < 0
    || (v.projectId !== undefined && (typeof v.projectId !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(v.projectId)))) {
    throw new CloudAuthError("cloud_auth_invalid");
  }
  return {version: 1, baseUrl: cloudBaseUrl(v.baseUrl), apiKey: v.apiKey, idToken: v.idToken, refreshToken: v.refreshToken,
    expiresAt: v.expiresAt, ...(typeof v.projectId === "string" ? {projectId: v.projectId} : {})};
}

/** Refuse a shared-readable or symlink credential file rather than silently expose refresh tokens. */
export function readCloudCredentials(path: string): CloudCredentials {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new CloudAuthError("cloud_auth_invalid");
    return parseCloudCredentials(JSON.parse(readFileSync(fd, "utf8")));
  } catch (e) {
    if (e instanceof CloudAuthError) throw e;
    throw new CloudAuthError("cloud_auth_invalid", "Cloud credentials cannot be read. Run the cloud login command in your terminal.");
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Atomic replace preserves unrelated local config; a failed write never truncates existing credentials. */
export function saveCloudCredentials(path: string, value: CloudCredentials): void {
  const credentials = parseCloudCredentials(value);
  const parent = dirname(path);
  let fd: number | undefined;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    if (!existsSync(parent)) mkdirSync(parent, {recursive: true, mode: 0o700});
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new CloudAuthError("cloud_auth_invalid");
    }
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, `${JSON.stringify(credentials)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    // Persist the directory entry on supported filesystems. No payload is ever logged.
    const directory = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (e) {
    if (e instanceof CloudAuthError) throw e;
    throw new CloudAuthError("cloud_auth_invalid", "Could not safely save cloud credentials. Check directory permissions.");
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* removed after rename, or never created */ }
  }
}

export interface AuthDeps {
  fetch?: FetchLike;
  clock?: Clock;
  timeoutMs?: number;
}

/** Bounded even when an injected/failed transport ignores AbortSignal. Redirects are forbidden. */
async function authExchange(url: string, init: RequestInit, deps: AuthDeps): Promise<Record<string, unknown>> {
  const clock = deps.clock ?? systemClock;
  const controller = new AbortController();
  const timeoutCancel = new AbortController();
  const timeout = clock.sleep(deps.timeoutMs ?? 10_000, timeoutCancel.signal).then(() => {
    controller.abort(); throw new CloudAuthError("cloud_auth_unavailable");
  }, () => new Promise<never>(() => {}));
  const exchange = (async () => {
    let response: Response;
    try { response = await (deps.fetch ?? fetch)(url, {...init, redirect: "error", signal: controller.signal}); }
    catch { throw new CloudAuthError("cloud_auth_unavailable"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CloudAuthError(response.status >= 500 || response.status === 429 ? "cloud_auth_unavailable" : "cloud_auth_required");
    }
    // Bound the body independently of declared Content-Length, which is untrusted.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const {done, value} = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 128 * 1024) { await reader.cancel().catch(() => {}); throw new CloudAuthError("cloud_auth_invalid"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new CloudAuthError("cloud_auth_invalid"); }
  })();
  exchange.catch(() => {});
  try { return await Promise.race([exchange, timeout]); }
  catch (error) { throw error instanceof CloudAuthError ? error : new CloudAuthError("cloud_auth_unavailable"); }
  finally { timeoutCancel.abort(); controller.abort(); }
}

function lifetime(raw: unknown): number {
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 86400) throw new CloudAuthError("cloud_auth_invalid");
  return n * 1000;
}

export async function signInCloud(input: {baseUrl: string; apiKey: string; email: string; password: string; projectId?: string}, deps: AuthDeps = {}): Promise<CloudCredentials> {
  const baseUrl = cloudBaseUrl(input.baseUrl);
  if (!secretString(input.apiKey) || !input.email.trim() || !input.password) throw new CloudAuthError("cloud_auth_invalid");
  const body = await authExchange(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(input.apiKey)}`, {
    method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({email: input.email.trim(), password: input.password, returnSecureToken: true}),
  }, deps);
  if (!secretString(body.idToken) || !secretString(body.refreshToken)) throw new CloudAuthError("cloud_auth_invalid");
  return parseCloudCredentials({version:1, baseUrl, apiKey:input.apiKey, idToken:body.idToken, refreshToken:body.refreshToken,
    expiresAt:(deps.clock ?? systemClock).now() + lifetime(body.expiresIn), ...(input.projectId ? {projectId:input.projectId} : {})});
}

/** Creates a Firebase anonymous identity without requesting or storing PII. */
export async function signInAnonymous(input: {baseUrl: string; apiKey: string; projectId?: string}, deps: AuthDeps = {}): Promise<CloudCredentials> {
  const baseUrl = cloudBaseUrl(input.baseUrl);
  if (!secretString(input.apiKey) || (input.projectId !== undefined && !/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.projectId))) throw new CloudAuthError("cloud_auth_invalid");
  const body = await authExchange(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(input.apiKey)}`, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({returnSecureToken: true}),
  }, deps);
  if (!secretString(body.idToken) || !secretString(body.refreshToken)) throw new CloudAuthError("cloud_auth_invalid");
  return parseCloudCredentials({version:1, baseUrl, apiKey:input.apiKey, idToken:body.idToken, refreshToken:body.refreshToken,
    expiresAt:(deps.clock ?? systemClock).now() + lifetime(body.expiresIn), ...(input.projectId ? {projectId:input.projectId} : {})});
}

/** Returns only account ownership and linked-provider IDs, never email/profile data. */
export async function inspectCloudAccount(credentials: CloudCredentials, deps: AuthDeps = {}): Promise<{uid:string; providers:string[]; anonymous:boolean}> {
  const stored = parseCloudCredentials(credentials);
  const body = await authExchange(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(stored.apiKey)}`, {
    method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({idToken: stored.idToken}),
  }, deps);
  if (!Array.isArray(body.users) || body.users.length !== 1) throw new CloudAuthError("cloud_auth_invalid");
  const user = body.users[0] as unknown;
  if (!user || typeof user !== "object" || Array.isArray(user)) throw new CloudAuthError("cloud_auth_invalid");
  const account = user as Record<string, unknown>;
  if (typeof account.localId !== "string" || !account.localId.trim() || account.localId.length > 128 || /[\u0000-\u001f\u007f]/.test(account.localId)) throw new CloudAuthError("cloud_auth_invalid");
  const subject = credentialSubject(stored.idToken);
  // This is an identity-change guard on already protected credentials, not JWT
  // verification. Firebase verifies the ID token on the authenticated lookup.
  if (stored.idToken.includes(".")) {
    try {
      const payload: unknown = JSON.parse(Buffer.from(stored.idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || (Object.hasOwn(payload, "sub") && subject === undefined)) throw new CloudAuthError("cloud_auth_invalid");
    } catch { throw new CloudAuthError("cloud_auth_invalid"); }
  }
  if (subject !== undefined && subject !== account.localId) throw new CloudAuthError("cloud_auth_invalid");
  // Firebase may omit empty repeated fields for an anonymous account. A present
  // null/non-array field or malformed member is never silently treated as empty.
  const info = account.providerUserInfo === undefined ? [] : account.providerUserInfo;
  if (!Array.isArray(info)) throw new CloudAuthError("cloud_auth_invalid");
  const providerIds = new Set<string>();
  for (const item of info) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new CloudAuthError("cloud_auth_invalid");
    const providerId = (item as Record<string, unknown>).providerId;
    if (typeof providerId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(providerId)) throw new CloudAuthError("cloud_auth_invalid");
    providerIds.add(providerId);
  }
  const providers = [...providerIds];
  return {uid:account.localId, providers, anonymous:providers.length === 0};
}

/** One shared refresh per credential file per MCP server; caller cancellation only cancels that caller's wait. */
export class CloudTokenProvider {
  readonly baseUrl: string;
  private credentials: CloudCredentials;
  private inflight: Promise<string> | undefined;
  private readonly accountSubject:string|undefined;
  private readonly clock: Clock;
  constructor(readonly path: string, private readonly deps: AuthDeps = {}) {
    this.credentials = readCloudCredentials(path);
    this.accountSubject=credentialSubject(this.credentials.idToken);
    this.baseUrl = this.credentials.baseUrl;
    this.clock = deps.clock ?? systemClock;
  }

  async getToken(forceRefresh = false, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw abortError();
    if (!forceRefresh && this.clock.now() < this.credentials.expiresAt - 60_000) return this.credentials.idToken;
    if (!this.inflight) {
      this.inflight = this.refresh(forceRefresh);
      void this.inflight.finally(() => {this.inflight = undefined;}).catch(() => {});
    }
    return waitWithSignal(this.inflight, signal);
  }

  private async refresh(forced=false): Promise<string> {
    // A second MCP process may have already rotated the saved refresh token.
    const disk = readCloudCredentials(this.path);
    if (disk.baseUrl !== this.baseUrl || disk.apiKey !== this.credentials.apiKey) throw new CloudAuthError("cloud_auth_invalid");
    if(this.accountSubject ? credentialSubject(disk.idToken)!==this.accountSubject : disk.idToken!==this.credentials.idToken&&disk.refreshToken!==this.credentials.refreshToken)throw new CloudAuthError("cloud_auth_required");
    const changed=disk.idToken!==this.credentials.idToken;
    this.credentials = disk;
    if(changed&&!forced&&this.clock.now()<disk.expiresAt-60_000)return disk.idToken;
    const body = await authExchange(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(disk.apiKey)}`, {
      method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"refresh_token", refresh_token:disk.refreshToken}).toString(),
    }, this.deps);
    if (!secretString(body.id_token) || !secretString(body.refresh_token)) throw new CloudAuthError("cloud_auth_invalid");
    if (disk.projectId && credentialAudience(body.id_token) !== disk.projectId) throw new CloudAuthError("cloud_auth_invalid");
    if(this.accountSubject&&credentialSubject(body.id_token)!==this.accountSubject)throw new CloudAuthError("cloud_auth_required");
    const next = parseCloudCredentials({...disk, idToken:body.id_token, refreshToken:body.refresh_token,
      expiresAt:this.clock.now()+lifetime(body.expires_in)});
    // A login in another terminal must not be overwritten by an older in-flight
    // refresh. Retry after reconnecting instead of silently switching identities.
    const current = readCloudCredentials(this.path);
    if (current.idToken !== disk.idToken || current.refreshToken !== disk.refreshToken || current.baseUrl !== disk.baseUrl || current.apiKey !== disk.apiKey) {
      if(this.accountSubject&&credentialSubject(current.idToken)===this.accountSubject&&current.baseUrl===disk.baseUrl&&current.apiKey===disk.apiKey&&this.clock.now()<current.expiresAt-60_000){this.credentials=current;return current.idToken;}
      throw new CloudAuthError("cloud_auth_required");
    }
    saveCloudCredentials(this.path, next);
    this.credentials = next;
    return next.idToken;
  }
}

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {onAbort = () => reject(abortError()); signal.addEventListener("abort", onAbort, {once:true});});
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort!); }
}
