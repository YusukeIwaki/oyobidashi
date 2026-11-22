import { authPageHeaders } from "./account-auth.ts";
import { CloudError, conflict, invalid, json, missing, readBody, unauthorized } from "./errors.ts";
import { OFFICIAL_CLOUD_ORIGIN } from "./config.ts";
import { MCP_REVIEW_HEADER } from "./oauth-browser-flow.ts";
import { MCP_REVIEW_OWNER_PREFIX, type McpReviewAuth } from "./oauth-review.ts";
import { hash, type CloudService } from "./service.ts";
import type { IdentityVerifier } from "./types.ts";

// OAuth 2.1 authorization server for the hosted MCP endpoint. Firebase proves who
// the human is in the browser; this module issues its own opaque tokens bound to
// that UID. Tokens are valid for /v1/mcp only and are stored hashed.

export const MCP_PATH = "/v1/mcp";
export const OAUTH_SCOPE = "oyobidashi";
export const ACCESS_TTL_MS = 3600_000;
export const REFRESH_TTL_MS = 180 * 86400_000;
export const CODE_TTL_MS = 300_000;
export const CLIENT_TTL_MS = 400 * 86400_000;
const USED_REFRESH_RETENTION_MS = 7 * 86400_000;
const USED_CODE_RETENTION_MS = 600_000;
const MAX_GRANTS_PER_USER = 30;
const MAX_REGISTRATIONS_PER_DESTINATION_HOUR = 30;

export type OAuthKind = "client" | "code" | "access" | "refresh";
export interface OAuthRow {
  kind: OAuthKind;
  /** client_id for clients; SHA-256 of the secret for everything else. */
  id: string;
  uid: string | null;
  grant: string | null;
  doc: { client?: string; name?: string | null; redirect_uris?: string[]; redirect_uri?: string; challenge?: string; registration_hosts?: string[] };
  created: number;
  expires: number;
  used: number | null;
}
export interface OAuthStore {
  insert(row: OAuthRow): Promise<void>;
  get(kind: OAuthKind, id: string): Promise<OAuthRow | null>;
  /** Atomically marks an unused row used, keeping it at most `retainMs` longer. Null if missing or already used. */
  consume(kind: OAuthKind, id: string, now: number, retainMs: number): Promise<OAuthRow | null>;
  extend(kind: OAuthKind, id: string, expires: number): Promise<void>;
  /** Removes the code and every token issued under one user approval. */
  revokeGrant(grant: string): Promise<void>;
  /** Keeps a user's `keep` most recent approvals and revokes the rest. */
  trimGrants(uid: string, keep: number): Promise<void>;
  listGrants(uid: string): Promise<OAuthRow[]>;
  revokeOwnedGrant(uid: string, grant: string): Promise<void>;
  revokeOwner(uid: string): Promise<void>;
  countSince(kind: OAuthKind, since: number): Promise<number>;
  countRegistrations(host: string, since: number): Promise<number>;
  cleanup(now: number): Promise<void>;
}

export interface OAuthDeps {
  store: OAuthStore;
  service: CloudService;
  verifier: IdentityVerifier;
  /** Minified browser bundle for the consent and pairing pages. */
  script?: () => Promise<string>;
  /** Canonical HTTPS origin; other hostnames reaching this service keep their own origin. */
  publicUrl?: string;
  review?: McpReviewAuth;
}
export interface AccessGrant {
  uid: string;
  client: string;
  name: string | null;
}

const secret = (prefix: string) =>
  prefix + crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "ftp:", "ws:", "wss:", "mailto:", "tel:", "sms:", "intent:", "view-source:", "filesystem:", "oyobidashi:"]);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
};
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Adds the headers a browser-based MCP client needs. No cookies are ever used, so any origin may read. */
export function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
  return response;
}
export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
      "access-control-max-age": "600",
    },
  });
}

/** The origin a client used to reach us. TLS ends at the platform proxy, so non-loopback hosts are always HTTPS. */
export function requestOrigin(req: Request, publicUrl?: string): string {
  const u = new URL(req.url);
  if (publicUrl && new URL(publicUrl).host === u.host) return publicUrl;
  return `${LOOPBACK.includes(u.hostname) ? u.protocol : "https:"}//${u.host}`;
}

/** Accepts HTTPS, HTTP on loopback and app-specific schemes; returns the normalized URI or null. */
export function validRedirectUri(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > 2000 || /[\s<>"\\]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hash || raw.includes("#") || u.username || u.password) return null;
  if (u.protocol === "https:") return u.hostname ? raw : null;
  if (u.protocol === "http:") return LOOPBACK.includes(u.hostname) ? raw : null;
  if (!/^[a-z][a-z0-9+.-]{1,63}:$/.test(u.protocol) || BLOCKED_SCHEMES.has(u.protocol)) return null;
  return raw;
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 section 7.3). */
export function sameRedirect(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered),
      b = new URL(requested);
    return a.protocol === "http:" && b.protocol === "http:" && LOOPBACK.includes(a.hostname) &&
      a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && !b.hash && !b.username && !b.password;
  } catch {
    return false;
  }
}

function redirectLabel(uri: string): string {
  const u = new URL(uri);
  if (u.protocol === "http:") return "このパソコン (localhost)";
  if (u.protocol === "https:") return u.hostname;
  return `${u.protocol}//${u.host}`.slice(0, 80);
}

const PAGE_STYLE = `body{font:16px/1.65 system-ui,sans-serif;background:#faf6eb;color:#29251f;margin:0;padding:32px 18px}main{max-width:480px;margin:9vh auto;background:#fffef9;border:1px solid #e6dfd1;border-radius:20px;padding:28px}h1{font-size:24px;line-height:1.4}button{display:block;width:100%;padding:14px;margin:12px 0;border-radius:12px;border:1px solid #d6cdbb;background:#fff;color:#29251f;font:inherit;cursor:pointer}button.quiet{border-color:transparent;background:none;color:#625b50;text-decoration:underline}button:disabled{opacity:.55;cursor:wait}p{color:#625b50}dl{margin:16px 0;padding:14px 16px;background:#f6f0e2;border-radius:12px}dt{font-size:13px;color:#746b5b}dd{margin:0 0 8px;overflow-wrap:anywhere}dd:last-child{margin-bottom:0}#qr{margin:18px auto;max-width:260px;padding:12px;background:#fff;border-radius:12px}#qr svg{display:block;width:100%;height:auto}#status{min-height:2em;white-space:pre-wrap}footer{font-size:13px;margin-top:28px;color:#746b5b}`;

function page(title: string, attributes: Record<string, string>, body: string, script: boolean): string {
  const data = Object.entries(attributes).map(([k, v]) => ` data-${k}="${escapeHtml(v)}"`).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>お呼び出し — ${escapeHtml(title)}</title><style>${PAGE_STYLE}#providers label{display:block;margin:12px 0}#providers input{display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:10px;border:1px solid #d6cdbb;border-radius:8px;font:inherit}</style>${script ? '<script type="module" src="/oauth.js"></script>' : ""}</head><body><main${data}>${body}</main></body></html>`;
}
const INTERACTIVE_BODY = `<h1 id="heading"></h1><p id="explanation">準備しています…</p><dl id="details" hidden></dl><div id="providers"></div><div id="pairing" hidden><div id="qr"></div><p id="pairing-hint"></p></div><div id="actions"></div><p id="status" role="status" aria-live="polite"></p><footer>ご自身で始めた操作のときだけ進めてください。心当たりがなければ、この画面を閉じてください。<br><a href="/oauth/connections">接続済みアプリを確認・取り消す</a></footer>`;

export function oauthPageHeaders(type: string): Record<string, string> {
  const headers = authPageHeaders(type);
  // The result is delivered by a top-level navigation, never by a form.
  headers["content-security-policy"] = headers["content-security-policy"]!.replace(/form-action [^;]+/, "form-action 'none'");
  headers["referrer-policy"] = "no-referrer";
  return headers;
}
const html = (status: number, body: string) =>
  new Response(body, { status, headers: oauthPageHeaders("text/html; charset=utf-8") });
const errorPage = (status: number, message: string) =>
  html(status, page("接続できません", {}, `<h1>接続できません</h1><p>${escapeHtml(message)}</p><footer>元のアプリに戻って、もう一度接続をやり直してください。</footer>`, false));

/** RFC 6749 section 5.2 error body. */
const oauthError = (status: number, error: string, description: string) =>
  withCors(json(status, { error, error_description: description }));

type Params = Record<string, string | undefined>;
type Checked =
  | { kind: "ok"; client: OAuthRow; redirect: string; challenge: string; state?: string }
  | { kind: "page"; message: string }
  | { kind: "redirect"; redirect: string; error: string; description: string; state?: string };

export class OAuthServer {
  private registering = 0;
  constructor(private readonly deps: OAuthDeps) {}
  async revokeOwner(uid: string) {
    await this.deps.store.revokeOwner(uid);
  }
  private get now() {
    return this.deps.service.now();
  }
  origin(req: Request) {
    return requestOrigin(req, this.deps.publicUrl);
  }

  /** 401 that tells an MCP client where to start the authorization flow. */
  challenge(req: Request, rejected: boolean): Response {
    const metadata = `${this.origin(req)}/.well-known/oauth-protected-resource${MCP_PATH}`;
    return withCors(
      new Response(
        JSON.stringify({ error: { code: "unauthorized", message: "sign in to oyobidashi to use this MCP server" } }),
        {
          status: 401,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "www-authenticate": `Bearer realm="oyobidashi", ${rejected ? 'error="invalid_token", ' : ""}resource_metadata="${metadata}", scope="${OAUTH_SCOPE}"`,
          },
        },
      ),
    );
  }

  /** Resolves an access token to its owner. `rejected` distinguishes a bad token from a missing one. */
  async access(req: Request): Promise<AccessGrant | { rejected: boolean }> {
    const header = (req.headers.get("authorization") ?? "").trim();
    if (!header) return { rejected: false };
    const token = /^Bearer +(kma_[A-Za-z0-9_-]{43})$/i.exec(header)?.[1];
    if (!token) return { rejected: true };
    const row = await this.deps.store.get("access", hash(token));
    if (!row || !row.uid || row.expires <= this.now || !row.doc.client || !this.ownerEnabled(req, row.uid))
      return { rejected: true };
    return { uid: row.uid, client: row.doc.client, name: row.doc.name ?? null };
  }

  /** Handles the authorization-server routes; undefined means the path is not ours. */
  async handle(req: Request, url: URL): Promise<Response | undefined> {
    const path = url.pathname,
      method = req.method;
    const discovery = path.startsWith("/.well-known/oauth-");
    const api = ["/oauth/register", "/oauth/token", "/oauth/revoke"].includes(path);
    if ((discovery || api) && method === "OPTIONS") return preflight();
    if (method === "GET") {
      if (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${MCP_PATH}`)
        return withCors(json(200, this.resourceMetadata(req)));
      if (path === "/.well-known/oauth-authorization-server" || path === `/.well-known/oauth-authorization-server${MCP_PATH}`)
        return withCors(json(200, this.serverMetadata(req)));
      if (path === "/oauth/authorize") return this.authorizePage(req, url);
      if (path === "/oauth/connections")
        return html(200, page("接続済みアプリ", { mode: "connections", ...this.reviewAttributes(req) }, INTERACTIVE_BODY, true));
      if (path === "/oauth/grants") return this.grants(req);
      if (path === "/pair")
        return html(200, page("スマホをペアリング", { mode: "pair" }, INTERACTIVE_BODY, true));
      if (path === "/oauth/review") {
        if (!this.reviewOnHost(req)) throw missing();
        return html(200, page("審査用スマホをペアリング", {
          mode: "pair", "review-only": "1", ...this.reviewAttributes(req),
        }, INTERACTIVE_BODY, true));
      }
      if (path === "/oauth.js") {
        if (!this.deps.script) return errorPage(503, "しばらくしてから、もう一度お試しください。");
        return new Response(await this.deps.script(), { headers: oauthPageHeaders("text/javascript; charset=utf-8") });
      }
    }
    if (method === "POST") {
      if (path === "/oauth/authorize") return this.decide(req);
      if (api)
        try {
          if (path === "/oauth/register") return await this.register(req);
          if (path === "/oauth/token") return await this.token(req);
          return await this.revoke(req);
        } catch (e) {
          if (e instanceof CloudError && e.status < 500)
            return oauthError(e.status, e.status === 429 ? "slow_down" : "invalid_request", e.message);
          return oauthError(503, "temporarily_unavailable", "please retry shortly");
        }
    }
    if (method === "DELETE" && /^\/oauth\/grants\/[0-9a-f-]{36}$/.test(path))
      return this.removeGrant(req, path.slice("/oauth/grants/".length));
    return undefined;
  }

  private reviewOnHost(req: Request) {
    return this.origin(req) === OFFICIAL_CLOUD_ORIGIN ? this.deps.review : undefined;
  }

  private reviewAttributes(req: Request): Record<string, string> {
    const review = this.reviewOnHost(req);
    return review ? { "review-project": review.projectId, "review-api-key": review.apiKey } : {};
  }

  private ownerEnabled(req: Request, uid: string): boolean {
    return !uid.startsWith(MCP_REVIEW_OWNER_PREFIX) || this.reviewOnHost(req)?.ownerUid === uid;
  }

  private async reviewUid(req: Request): Promise<string> {
    const review = this.reviewOnHost(req);
    const token = /^Bearer +(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim())?.[1];
    if (!review || !token) throw unauthorized();
    await review.verify(token);
    if (await this.deps.service.db.isBanned(review.ownerUid))
      throw new CloudError(403, "account_banned", "this account is disabled");
    return review.ownerUid;
  }

  /** Review Firebase credentials can only prepare pairing and input consent here. */
  async reviewSetupUid(req: Request, path: string): Promise<string | undefined> {
    if (req.headers.get(MCP_REVIEW_HEADER) !== "1") return;
    const method = req.method;
    if ((path === "/v1/presence" && method === "GET") ||
        (path === "/v1/pairing-codes" && method === "POST") ||
        (path === "/v1/input-restriction" && (method === "GET" || method === "POST"))) {
      if (method === "POST" && req.headers.get("origin") !== this.origin(req))
        throw new CloudError(403, "forbidden", "this endpoint is only available to the review page");
      return this.reviewUid(req);
    }
  }

  private async human(req: Request) {
    if (req.headers.get(MCP_REVIEW_HEADER) === "1") return this.reviewUid(req);
    const token = /^Bearer +(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim())?.[1];
    if (!token) throw unauthorized();
    const identity = this.deps.verifier.identify
      ? await this.deps.verifier.identify(token)
      : { uid: await this.deps.verifier.verify(token), provider: null };
    if (!["google.com", "apple.com", "github.com"].includes(identity.provider ?? ""))
      throw new CloudError(403, "forbidden", "sign in with Google, Apple or GitHub");
    await this.deps.service.db.transaction(identity.uid, (tx) => this.deps.service.ensureAccount(tx));
    if (await this.deps.service.db.isBanned(identity.uid))
      throw new CloudError(403, "account_banned", "this account is disabled");
    return identity.uid;
  }

  private async grants(req: Request) {
    const uid = await this.human(req);
    const rows = await this.deps.store.listGrants(uid);
    return json(200, { grants: rows.filter((r) => r.expires > this.now).map((r) => ({
      id: r.grant,
      name: r.doc.name ?? null,
      redirect_uri: r.doc.redirect_uri ?? null,
      last_used_at: new Date(r.created).toISOString(),
    })) });
  }

  private async removeGrant(req: Request, grant: string) {
    if (req.headers.get("origin") !== this.origin(req))
      throw new CloudError(403, "forbidden", "this endpoint is only available to the account page");
    const uid = await this.human(req);
    await this.deps.store.revokeOwnedGrant(uid, grant);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  private resourceMetadata(req: Request) {
    const origin = this.origin(req);
    return {
      resource: `${origin}${MCP_PATH}`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: [OAUTH_SCOPE],
      resource_name: "お呼び出し",
    };
  }
  private serverMetadata(req: Request) {
    const origin = this.origin(req);
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [OAUTH_SCOPE],
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ---- Dynamic client registration (RFC 7591), public clients only ----
  private async register(req: Request): Promise<Response> {
    if (this.registering >= 16) return oauthError(429, "slow_down", "registration is busy; retry shortly");
    this.registering++;
    try {
      const body = await readBody(req);
      const uris = body.redirect_uris;
      if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10)
        return oauthError(400, "invalid_redirect_uri", "redirect_uris must list 1-10 URIs");
      const redirects: string[] = [];
      for (const raw of uris) {
        const uri = validRedirectUri(raw);
        if (!uri)
          return oauthError(400, "invalid_redirect_uri", "each redirect URI must be HTTPS, HTTP on loopback, or an app-specific scheme, without a fragment");
        redirects.push(uri);
      }
      let name: string | null = null;
      if (body.client_name !== undefined && body.client_name !== null) {
        if (typeof body.client_name !== "string")
          return oauthError(400, "invalid_client_metadata", "client_name must be a string");
        // Shown on the consent page and on the phone: one short printable line.
        name = Array.from(body.client_name.replace(/[\p{C}\s]+/gu, " ").trim()).slice(0, 80).join("") || null;
      }
      const now = this.now;
      const hosts = [...new Set(redirects.map((uri) => {
        const url = new URL(uri);
        return `${url.protocol}//${url.hostname}`;
      }))];
      for (const host of hosts)
        if ((await this.deps.store.countRegistrations(host, now - 3600_000)) >= MAX_REGISTRATIONS_PER_DESTINATION_HOUR)
          return oauthError(429, "slow_down", "too many registrations for this destination; retry later");
      const id = secret("kmc_");
      await this.deps.store.insert({
        kind: "client", id, uid: null, grant: null,
        doc: { name, redirect_uris: redirects, registration_hosts: hosts },
        created: now, expires: now + CLIENT_TTL_MS, used: null,
      });
      return withCors(json(201, {
        client_id: id,
        client_id_issued_at: Math.floor(now / 1000),
        redirect_uris: redirects,
        ...(name ? { client_name: name } : {}),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: OAUTH_SCOPE,
      }));
    } finally {
      this.registering--;
    }
  }

  // ---- Authorization endpoint ----
  private async check(req: Request, p: Params): Promise<Checked> {
    const id = p.client_id;
    const client = id && id.length <= 200 ? await this.deps.store.get("client", id) : null;
    if (!client || client.expires <= this.now)
      return { kind: "page", message: "このアプリの登録が見つからないか、有効期限が切れています。" };
    const registered = client.doc.redirect_uris ?? [];
    let redirect: string | undefined;
    if (p.redirect_uri === undefined) redirect = registered.length === 1 ? registered[0] : undefined;
    else if (validRedirectUri(p.redirect_uri) && registered.some((r) => sameRedirect(r, p.redirect_uri!)))
      redirect = p.redirect_uri;
    if (!redirect) return { kind: "page", message: "戻り先のアドレスが、このアプリの登録内容と一致しません。" };
    const state = p.state;
    if (state !== undefined && state.length > 2000)
      return { kind: "redirect", redirect, error: "invalid_request", description: "state is too long" };
    const fail = (error: string, description: string): Checked => ({
      kind: "redirect", redirect: redirect!, error, description, ...(state !== undefined ? { state } : {}),
    });
    if (p.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge ?? ""))
      return fail("invalid_request", "PKCE with code_challenge_method S256 is required");
    if (p.resource !== undefined && !this.ownResource(req, p.resource))
      return fail("invalid_target", "resource must be this MCP server");
    return { kind: "ok", client, redirect, challenge: p.code_challenge!, ...(state !== undefined ? { state } : {}) };
  }
  private ownResource(req: Request, resource: string): boolean {
    try {
      const u = new URL(resource);
      return u.origin === this.origin(req) && [MCP_PATH, `${MCP_PATH}/`, "/"].includes(u.pathname) && !u.search && !u.hash;
    } catch {
      return false;
    }
  }
  private result(req: Request, redirect: string, fields: Record<string, string | undefined>): string {
    const u = new URL(redirect);
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set("iss", this.origin(req));
    return u.href;
  }
  private async authorizePage(req: Request, url: URL): Promise<Response> {
    const checked = await this.check(req, Object.fromEntries(url.searchParams));
    if (checked.kind === "page") return errorPage(400, checked.message);
    // A GET is never allowed to navigate to a client-controlled URI before the
    // human has signed in and made an explicit decision on our own page.
    if (checked.kind === "redirect") return errorPage(400, checked.description);
    return html(200, page("接続の許可", {
      mode: "authorize",
      client: checked.client.doc.name ?? "",
      redirect: redirectLabel(checked.redirect),
      ...this.reviewAttributes(req),
    }, INTERACTIVE_BODY, true));
  }

  /** The consent page reports the human's decision; approval needs their fresh Firebase sign-in. */
  private async decide(req: Request): Promise<Response> {
    // Only our own page may call this. Nothing here relies on cookies; this is defence in depth.
    if (req.headers.get("origin") !== this.origin(req))
      throw new CloudError(403, "forbidden", "this endpoint is only available to the consent page");
    const body = await readBody(req);
    const p: Params = {};
    for (const key of ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource"]) {
      const v = body[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" || v.length > 4000) throw invalid(`${key} is invalid`);
      p[key] = v;
    }
    const checked = await this.check(req, p);
    if (checked.kind === "page") throw invalid(checked.message);
    if (checked.kind === "redirect")
      return json(200, { redirect_to: this.result(req, checked.redirect, { error: checked.error, error_description: checked.description, state: checked.state }) });
    if (body.decision === "deny")
      return json(200, { redirect_to: this.result(req, checked.redirect, { error: "access_denied", error_description: "the user declined", state: checked.state }) });
    if (body.decision !== "approve") throw invalid("decision is invalid");

    const uid = await this.human(req);
    await this.deps.service.db.transaction(uid, async (tx) => {
      await this.deps.service.oauthAttempt(tx);
      // A FREE owner links an agent only after accepting the input restriction on this page.
      if (await this.deps.service.inputConsentMissing(tx))
        throw conflict("input_consent_required", "accept the FREE plan input restriction before connecting");
    });
    const code = secret("kmo_"),
      now = this.now;
    await this.deps.store.insert({
      kind: "code", id: hash(code), uid, grant: crypto.randomUUID(),
      doc: { client: checked.client.id, name: checked.client.doc.name ?? null, redirect_uri: checked.redirect, challenge: checked.challenge },
      created: now, expires: now + CODE_TTL_MS, used: null,
    });
    return json(200, { redirect_to: this.result(req, checked.redirect, { code, state: checked.state }) });
  }

  // ---- Token endpoint ----
  private async form(req: Request): Promise<Params> {
    if (Number(req.headers.get("content-length")) > 65536)
      throw new CloudError(413, "payload_too_large", "body exceeds 64KB");
    const text = await req.text();
    if (text.length > 65536) throw new CloudError(413, "payload_too_large", "body exceeds 64KB");
    const out: Params = {};
    if ((req.headers.get("content-type") ?? "").includes("json")) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw invalid("body must be form-encoded");
      }
      if (value && typeof value === "object" && !Array.isArray(value))
        for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
    } else for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    // Public clients have no secret, but some send their ID as HTTP Basic credentials.
    const basic = /^Basic +([A-Za-z0-9+/=]+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    if (basic && !out.client_id)
      try {
        out.client_id = decodeURIComponent(atob(basic).split(":")[0] ?? "");
      } catch {
        /* treated as a missing client_id below */
      }
    return out;
  }
  private async issue(uid: string, grant: string, client: string, name: string | null, redirectUri: string | null): Promise<Response> {
    const access = secret("kma_"),
      refresh = secret("kmr_"),
      now = this.now;
    const row = { uid, grant, doc: { client, name, redirect_uri: redirectUri ?? undefined }, created: now, used: null };
    await this.deps.store.insert({ ...row, kind: "access", id: hash(access), expires: now + ACCESS_TTL_MS });
    await this.deps.store.insert({ ...row, kind: "refresh", id: hash(refresh), expires: now + REFRESH_TTL_MS });
    await this.deps.store.extend("client", client, now + CLIENT_TTL_MS);
    const response = withCors(json(200, {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh,
      scope: OAUTH_SCOPE,
    }));
    response.headers.set("pragma", "no-cache");
    return response;
  }
  private async token(req: Request): Promise<Response> {
    const p = await this.form(req),
      store = this.deps.store,
      now = this.now;
    const grantError = (description: string) => oauthError(400, "invalid_grant", description);
    if (!p.client_id) return oauthError(400, "invalid_client", "client_id is required");
    if (p.resource !== undefined && !this.ownResource(req, p.resource))
      return oauthError(400, "invalid_target", "resource must be this MCP server");
    if (p.grant_type === "authorization_code") {
      if (!p.code || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier ?? ""))
        return oauthError(400, "invalid_request", "code and code_verifier are required");
      const id = hash(p.code),
        row = await store.consume("code", id, now, USED_CODE_RETENTION_MS);
      if (!row) {
        // A second redemption means the code leaked: withdraw what the first one obtained.
        const replayed = await store.get("code", id);
        if (replayed?.grant) await store.revokeGrant(replayed.grant);
        return grantError("authorization code is invalid or was already used");
      }
      const challenge = new Bun.CryptoHasher("sha256").update(p.code_verifier!).digest("base64url");
      if (
        row.expires <= now || !row.uid || !this.ownerEnabled(req, row.uid) || !row.grant || row.doc.client !== p.client_id || row.doc.challenge !== challenge ||
        (p.redirect_uri !== undefined && p.redirect_uri !== row.doc.redirect_uri)
      )
        return grantError("authorization code does not match this request");
      const response = await this.issue(row.uid, row.grant, p.client_id, row.doc.name ?? null, row.doc.redirect_uri ?? null);
      await store.trimGrants(row.uid, MAX_GRANTS_PER_USER);
      return response;
    }
    if (p.grant_type === "refresh_token") {
      if (!p.refresh_token) return oauthError(400, "invalid_request", "refresh_token is required");
      const id = hash(p.refresh_token);
      let row = await store.consume("refresh", id, now, USED_REFRESH_RETENTION_MS);
      if (!row) {
        const used = await store.get("refresh", id);
        if (!used || used.used === null) return grantError("refresh token is invalid");
        // A retry cannot mint a second live token family. Without a durable
        // encrypted response cache, the only safe response is to revoke.
        if (used.grant) await store.revokeGrant(used.grant);
        return grantError("refresh token was already used");
      }
      if (row.expires <= now || !row.uid || !this.ownerEnabled(req, row.uid) || !row.grant || row.doc.client !== p.client_id)
        return grantError("refresh token does not match this request");
      const client = await store.get("client", p.client_id);
      if (!client || client.expires <= now) return oauthError(400, "invalid_client", "client registration expired");
      return this.issue(row.uid, row.grant, p.client_id, row.doc.name ?? null, row.doc.redirect_uri ?? null);
    }
    return oauthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  }

  /** RFC 7009: always 200, and either token of an approval withdraws all of it. */
  private async revoke(req: Request): Promise<Response> {
    const p = await this.form(req);
    if (p.token && p.token.length <= 200) {
      const id = hash(p.token);
      const row = (await this.deps.store.get("refresh", id)) ?? (await this.deps.store.get("access", id));
      if (row?.grant && (!p.client_id || row.doc.client === p.client_id)) await this.deps.store.revokeGrant(row.grant);
    }
    return withCors(json(200, {}));
  }
}
