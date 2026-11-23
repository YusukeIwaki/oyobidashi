import { claudeKmsSigner, claudeKmsTokenCipher, type ClaudeSigner } from "./claude-kms.ts";
import { OFFICIAL_CLOUD_ORIGIN } from "./config.ts";
import { unavailable } from "./errors.ts";

export const CLAUDE_ISSUER = `${OFFICIAL_CLOUD_ORIGIN}/claude-identity`;
export const CLAUDE_CALLBACK = `${OFFICIAL_CLOUD_ORIGIN}/oauth/claude/callback`;
const API = "https://api.anthropic.com";
const AUTH = "https://auth.claude.com";
const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const CLIENT_SUBJECT = "oyobidashi:claude:client";
const OPERATOR_SUBJECT = "oyobidashi:claude:operator";
const fields = [
  "clientId", "clientAudience", "operatorAudience", "organizationId",
  "federationRuleId", "serviceAccountId", "workspaceId", "model",
] as const;
type Settings = Record<(typeof fields)[number], string>;

export function loadClaudePlatform(env: Record<string, string | undefined>) {
  const raw = env.CLAUDE_BILLING_CONFIG;
  const version = env.CLAUDE_BILLING_KMS_KEY_VERSION;
  const tokenKey = env.CLAUDE_BILLING_KMS_TOKEN_KEY;
  const signer = version ? claudeKmsSigner({ version, issuer: CLAUDE_ISSUER }) : undefined;
  if (!raw) return { signer };
  const config = JSON.parse(raw) as Partial<Settings> | null;
  if (!signer || !tokenKey || !config || fields.some(key => typeof config[key] !== "string" || !config[key]?.trim()) ||
      config.clientAudience === config.operatorAudience)
    throw new Error("Invalid CLAUDE_BILLING_CONFIG or missing Claude billing KMS keys");
  return { signer, platform: new ClaudePlatform(config as Settings, signer), cipher: claudeKmsTokenCipher(tokenKey) };
}

export interface ClaudeConnectionTokens {
  connectionId: string;
  access: string;
  refresh: string;
  accessExpires: number;
  refreshExpires: number;
}

// Only raised when Anthropic (or a local preflight failure) establishes that
// the refresh token was not consumed. The caller can lift its durable hold.
export class ClaudeRefreshDeferred extends Error {
  constructor(readonly retryAfter: number) { super("Claude token refresh deferred"); }
}

export class ClaudePlatform {
  private operatorToken?: { value: string; expires: number };
  private pendingToken?: Promise<string>;

  constructor(
    private readonly settings: Settings,
    private readonly signer: ClaudeSigner,
    private readonly send: typeof fetch = fetch,
  ) {}

  get model() { return this.settings.model; }

  private async request(url: string, init: RequestInit) {
    const response = await this.send(url, {
      ...init, redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    return await response.json() as Record<string, unknown>;
  }

  private post(url: string, body: object, headers: Record<string, string> = {}) {
    return this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  private async operatorExchange() {
    const body = await this.post(`${API}/v1/oauth/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await this.signer.sign(OPERATOR_SUBJECT, this.settings.operatorAudience),
      federation_rule_id: this.settings.federationRuleId,
      organization_id: this.settings.organizationId,
      service_account_id: this.settings.serviceAccountId,
      workspace_id: this.settings.workspaceId,
    });
    if (typeof body.access_token !== "string" || !body.access_token ||
        typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0)
      throw unavailable();
    this.operatorToken = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async operatorAccess() {
    if (this.operatorToken && this.operatorToken.expires > Date.now() + 30_000)
      return this.operatorToken.value;
    return await (this.pendingToken ??= this.operatorExchange().finally(() => { this.pendingToken = undefined; }));
  }

  async createProfile(reference: string) {
    const body = await this.post(`${API}/v1/user_profiles`, {
      external_user_details: { reference_id: reference },
    }, {
      "authorization": `Bearer ${await this.operatorAccess()}`,
      "anthropic-version": "2026-10-21",
    });
    if (!profileId(body.id)) throw unavailable();
    return body.id;
  }

  private async clientAuth() {
    return {
      client_id: this.settings.clientId,
      client_assertion_type: JWT_BEARER,
      client_assertion: await this.signer.sign(CLIENT_SUBJECT, this.settings.clientAudience),
    };
  }

  private async oauth(path: "par" | "token" | "revoke", body: object) {
    return this.post(`${AUTH}/v1/oauth/${path}`, { ...body, ...await this.clientAuth() });
  }

  async authorize(profile: string, state: string, verifier: string) {
    const body = await this.oauth("par", {
      response_type: "code",
      redirect_uri: CLAUDE_CALLBACK,
      scope: "billing:attribution offline_access",
      connection_type: "organization_shared",
      connection_auth_target: "platform",
      user_profile_id: profile,
      state,
      code_challenge: new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    if (typeof body.request_uri !== "string" || !body.request_uri || body.request_uri.length > 2048)
      throw unavailable();
    const query = new URLSearchParams({ client_id: this.settings.clientId, request_uri: body.request_uri });
    return `${AUTH}/oauth/authorize?${query}`;
  }

  async exchange(code: string, verifier: string) {
    const issuedAt = Date.now();
    const body = await this.oauth("token", {
      grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK,
    });
    if (!connectionId(body.connection_id)) throw unavailable();
    try {
      return readTokens(body, body.connection_id, issuedAt);
    } catch (error) {
      await this.revoke(body.connection_id).catch(() => {});
      throw error;
    }
  }

  async refresh(connection: string, refreshToken: string) {
    const auth = await this.clientAuth().catch(() => { throw new ClaudeRefreshDeferred(Date.now() + 5_000); });
    const issuedAt = Date.now();
    const response = await this.send(`${AUTH}/v1/oauth/token`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, ...auth }),
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const retry = response.headers.get("retry-after");
    if (response.status === 429 || (response.status === 503 && retry !== null && body?.type === "error")) {
      const seconds = Number(retry);
      const time = Date.parse(retry ?? "");
      const delay = retry !== null && Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
        : Number.isFinite(time) ? Math.max(0, time - Date.now()) : 30_000;
      throw new ClaudeRefreshDeferred(Math.min(Number.MAX_SAFE_INTEGER, Date.now() + Math.max(1000, delay)));
    }
    if (response.status !== 200 || !body || (body.connection_id !== undefined && body.connection_id !== connection))
      throw unavailable();
    return readTokens(body, connection, issuedAt);
  }

  async connectionStatus(profile: string) {
    const url = `${API}/v1/user_profiles/${encodeURIComponent(profile)}?oauth_app_id=${encodeURIComponent(this.settings.clientId)}`;
    const body = await this.request(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${await this.operatorAccess()}`,
        "anthropic-version": "2026-10-21",
        "anthropic-beta": "user-profiles-search-2026-08-30",
      },
    });
    const type = (body.connection_status as { type?: unknown } | null)?.type;
    if (type === "connected") return "linked";
    if (type === "disconnected" || type === "not_connected") return "relink_required";
    return "unknown";
  }

  async revoke(connectionId: string) {
    await this.oauth("revoke", { connection_id: connectionId });
  }
}

function profileId(value: unknown): value is string {
  return typeof value === "string" && /^uprof_[A-Za-z0-9_-]{1,150}$/.test(value);
}


function connectionId(value: unknown): value is string {
  return typeof value === "string" && /^ocon_[A-Za-z0-9_-]{1,150}$/.test(value);
}
function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/\s/.test(value);
}
function expiry(value: unknown, issuedAt: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw unavailable();
  return issuedAt + value * 1000;
}
function readTokens(body: Record<string, unknown>, connection: string, issuedAt: number): ClaudeConnectionTokens {
  if (!token(body.access_token) || !token(body.refresh_token)) throw unavailable();
  return {
    connectionId: connection, access: body.access_token, refresh: body.refresh_token,
    accessExpires: expiry(body.expires_in, issuedAt, 3600),
    refreshExpires: expiry(body.refresh_token_expires_in, issuedAt, 366 * 86400),
  };
}
