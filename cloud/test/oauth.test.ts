import { describe, expect, test } from "bun:test";
import { generateKeyPair, SignJWT } from "jose";
import { CloudApp } from "../src/app.ts";
import { OFFICIAL_CLOUD_ORIGIN } from "../src/config.ts";
import { unauthorized } from "../src/errors.ts";
import { MCP_REVIEW_HEADER } from "../src/oauth-browser-flow.ts";
import { loadMcpReviewAuth, type McpReviewAuth } from "../src/oauth-review.ts";
import {
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  sameRedirect,
  validRedirectUri,
} from "../src/oauth.ts";
import { harness } from "./helpers.ts";
import { MemoryOAuthStore } from "./oauth-memory.ts";

const ORIGIN = "http://localhost";
const REDIRECT = "http://127.0.0.1:43110/callback";
const accountAuth = {
  publicConfig: {
    firebase: { apiKey: "synthetic", projectId: "synthetic-project", authDomain: "synthetic-project.firebaseapp.com" },
    providers: ["google" as const],
    canLinkExisting: false,
  },
  issueLinkToken: async () => "unused",
};
const challengeOf = (verifier: string) =>
  new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

function remote(origin = ORIGIN, review?: McpReviewAuth) {
  const h = harness(),
    store = new MemoryOAuthStore();
  const verifier = {
    verify: async (token: string) => (await verifier.identify(token)).uid,
    async identify(token: string) {
      if (token.startsWith("agent-")) return { uid: token.slice(6), provider: "google.com" };
      if (token.startsWith("anon-")) return { uid: token.slice(5), provider: "anonymous" };
      if (token.startsWith("custom-")) return { uid: token.slice(7), provider: "custom" };
      throw unauthorized();
    },
  };
  const app = new CloudApp(h.service, verifier, 10_000, accountAuth, undefined, {
    store,
    script: async () => "/* bundle */",
    ...(review ? { review } : {}),
  });
  const send = async (method: string, path: string, init: { token?: string; json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) => {
    const response = (await app.fetch(
      new Request(`${origin}${path}`, {
        method,
        redirect: "manual",
        headers: {
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...init.headers,
        },
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
        ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
      }),
    ))!;
    const text = await response.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: response.status, headers: response.headers, body };
  };
  const register = async (extra: Record<string, unknown> = {}) =>
    (await send("POST", "/oauth/register", { json: { client_name: "Claude Code", redirect_uris: [REDIRECT], ...extra } })).body;
  const approve = async (clientId: string, verifier = "v".repeat(43), user = "agent-alice", extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const response = await send("POST", "/oauth/authorize", {
      token: user,
      headers: { origin, ...headers },
      json: {
        decision: "approve", client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
        code_challenge: challengeOf(verifier), code_challenge_method: "S256", state: "xyz", ...extra,
      },
    });
    const target = response.status === 200 ? new URL(response.body.redirect_to) : null;
    return { response, code: target?.searchParams.get("code") ?? "", target };
  };
  const exchange = (clientId: string, code: string, verifier = "v".repeat(43), extra: Record<string, string> = {}) =>
    send("POST", "/oauth/token", { form: { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, ...extra } });
  const connect = async (user = "agent-alice") => {
    const client = await register();
    const { code } = await approve(client.client_id, undefined, user);
    const tokens = (await exchange(client.client_id, code)).body;
    return { client, tokens };
  };
  const rpc = async (token: string | undefined, message: unknown) => {
    const response = await send("POST", "/v1/mcp", {
      ...(token ? { token } : {}),
      json: message,
      headers: { accept: "application/json, text/event-stream" },
    });
    const data = typeof response.body === "string" ? /^data: (.*)$/m.exec(response.body)?.[1] : undefined;
    return { ...response, message: data ? JSON.parse(data) : undefined };
  };
  const tool = async (token: string, name: string, args: Record<string, unknown>) =>
    (await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).message.result;
  return { h, store, app, send, register, approve, exchange, connect, rpc, tool };
}

describe("dedicated MCP review authentication", () => {
  test("only the exact project, password provider and review UID can use the dedicated flow", async () => {
    const projectId = "mcp-review-test", prodProject = "synthetic-project", uid = "reviewer";
    const config = { projectId, uid, apiKey: "synthetic_review_key_1234" };
    expect(() => loadMcpReviewAuth(JSON.stringify({ ...config, projectId: prodProject }), prodProject)).toThrow();
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const review = loadMcpReviewAuth(JSON.stringify(config), prodProject, async () => publicKey)!;
    const idToken = (project: string, subject: string, provider: string) =>
      new SignJWT({ auth_time: Math.floor(Date.now() / 1000) - 1, firebase: { sign_in_provider: provider } })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt().setExpirationTime("1h").setSubject(subject)
        .setIssuer(`https://securetoken.google.com/${project}`).setAudience(project).sign(privateKey);
    const token = await idToken(projectId, uid, "password");
    const r = remote(OFFICIAL_CLOUD_ORIGIN, review);
    const headers = { [MCP_REVIEW_HEADER]: "1", origin: OFFICIAL_CLOUD_ORIGIN };
    const browser = { token, headers };
    const client = await r.register();

    expect((await r.send("GET", "/oauth/review")).body).toContain('data-review-only="1"');
    expect((await r.send("GET", "/pair")).body).not.toContain("data-review-project");
    for (const [issuer, subject, provider] of [
      [prodProject, uid, "password"], [projectId, "other", "password"], [projectId, uid, "custom"],
    ] as const) {
      const access = await r.send("GET", "/v1/presence", { token: await idToken(issuer, subject, provider), headers });
      expect([401, 403]).toContain(access.status);
    }
    expect((await r.send("GET", "/v1/presence", { token })).status).toBe(401);
    expect((await r.send("GET", "/v1/presence", browser)).status).toBe(200);
    expect((await r.send("GET", "/v1/input-restriction", browser)).status).toBe(200);
    expect((await r.send("POST", "/v1/pairing-codes", { ...browser, json: {} })).status).toBe(201);
    expect((await r.send("POST", "/v1/pairing-codes", {
      token, headers: { ...headers, origin: "https://other.example" }, json: {},
    })).status).toBe(403);
    expect((await r.send("POST", "/v1/requests", { ...browser, json: { question: "test" } })).status).toBe(401);
    expect((await r.send("POST", "/v1/auth/link-token", { ...browser, json: {} })).status).toBe(401);
    const alternate = await r.app.fetch(new Request("https://other.example/oauth/review"));
    expect(alternate?.status).toBe(404);

    expect((await r.approve(client.client_id, undefined, token)).response.status).toBe(401);
    const approved = await r.approve(client.client_id, undefined, token, {}, headers);
    expect(approved.response.status).toBe(200);
    const { body: tokens } = await r.exchange(client.client_id, approved.code);
    const listing = await r.rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listing.message.result.tools).toHaveLength(6);
    const reviewResult = await r.tool(tokens.access_token, "ask_human", { question: "review sample", wait_seconds: 0 });
    expect(await r.h.service.run(r.h.principal(review.ownerUid), tx => tx.get("request", reviewResult.structuredContent.request_id))).not.toBeNull();
    expect(await r.h.service.run(r.h.principal(uid), tx => tx.get("request", reviewResult.structuredContent.request_id))).toBeNull();

    const regular = await r.connect();
    const withoutReview = new CloudApp(r.h.service, r.app.verifier, 10_000, accountAuth, undefined, { store: r.store });
    const list = (token: string) => withoutReview.fetch(new Request(`${OFFICIAL_CLOUD_ORIGIN}/v1/mcp`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect((await list(tokens.access_token))?.status).toBe(401);
    expect((await list(regular.tokens.access_token))?.status).toBe(200);
  });
});

describe("OAuth discovery and client registration", () => {
  test("the OpenAI domain challenge serves only the configured value on the official host", async () => {
    const h = harness();
    const path = "/.well-known/openai-apps-challenge";
    const official = `http://api.oyobidashi.me${path}`;
    const app = new CloudApp(h.service, h.app.verifier, 10_000, accountAuth, undefined, {
      store: new MemoryOAuthStore(),
      openAiAppsChallenge: "synthetic-challenge",
    });
    const challenge = (await app.fetch(new Request(official)))!;
    expect(challenge.status).toBe(200);
    expect(challenge.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(challenge.headers.get("cache-control")).toBe("no-store");
    expect(await challenge.text()).toBe("synthetic-challenge");
    expect((await app.fetch(new Request(official, { method: "HEAD" })))!.status).toBe(200);
    expect((await app.fetch(new Request(official, { method: "POST" })))!.status).toBe(404);
    expect((await app.fetch(new Request(`${ORIGIN}${path}`)))!.status).toBe(404);
    expect((await h.app.fetch(new Request(official)))!.status).toBe(404);
  });

  test("an unauthenticated MCP request is told where to authorize", async () => {
    const r = remote();
    const response = await r.rpc(undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer realm="oyobidashi", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/v1/mcp", scope="oyobidashi"`,
    );
    const resource = await r.send("GET", "/.well-known/oauth-protected-resource/v1/mcp");
    expect(resource.body).toMatchObject({ resource: `${ORIGIN}/v1/mcp`, authorization_servers: [ORIGIN] });
    const server = await r.send("GET", "/.well-known/oauth-authorization-server");
    expect(server.body).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect(server.headers.get("access-control-allow-origin")).toBe("*");
  });
  test("a non-loopback host is always advertised as HTTPS and the canonical origin wins", async () => {
    const h = harness();
    const app = new CloudApp(h.service, h.app.verifier, 10_000, accountAuth, undefined, {
      store: new MemoryOAuthStore(),
      publicUrl: "https://api.example.test",
    });
    const metadata = async (host: string) =>
      (await (await app.fetch(new Request(`http://${host}/.well-known/oauth-authorization-server`)))!.json()) as { issuer: string };
    expect((await metadata("api.example.test")).issuer).toBe("https://api.example.test");
    expect((await metadata("other.example.test")).issuer).toBe("https://other.example.test");
  });
  test("the endpoint stays absent when browser sign-in is not configured", async () => {
    const h = harness();
    const app = new CloudApp(h.service, h.app.verifier, 10_000, undefined, undefined, { store: new MemoryOAuthStore() });
    for (const path of ["/v1/mcp", "/.well-known/oauth-authorization-server", "/oauth/register"])
      expect((await app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST" })))!.status).toBe(401);
  });
  test("registration accepts public clients and rejects unsafe redirect targets", async () => {
    const r = remote();
    const client = await r.register({ token_endpoint_auth_method: "client_secret_post" });
    expect(client.client_id).toMatch(/^kmc_[A-Za-z0-9_-]{43}$/);
    expect(client).toMatchObject({ client_name: "Claude Code", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(client.client_secret).toBeUndefined();
    for (const bad of ["http://example.test/cb", "javascript:alert(1)", "https://example.test/cb#fragment", "data:text/html,x", "https://user:pw@example.test/cb", "not a url"]) {
      const response = await r.send("POST", "/oauth/register", { json: { redirect_uris: [bad] } });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("invalid_redirect_uri");
    }
    expect((await r.send("POST", "/oauth/register", { json: { redirect_uris: [] } })).status).toBe(400);
    const named = await r.register({ client_name: "  Evil\u0000\n<b>App</b>  " });
    expect(named.client_name).toBe("Evil <b>App</b>");
  });
  test("redirect URI rules", () => {
    expect(validRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBeTruthy();
    expect(validRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBeTruthy();
    expect(validRedirectUri("http://localhost:3000/cb")).toBeTruthy();
    expect(validRedirectUri("http://192.168.0.2/cb")).toBeNull();
    expect(validRedirectUri("oyobidashi://pair?url=https%3A%2F%2Fapi.example&code=secret")).toBeNull();
    expect(validRedirectUri("intent://x#Intent;end")).toBeNull();
    expect(sameRedirect("http://127.0.0.1/callback", "http://127.0.0.1:51234/callback")).toBe(true);
    expect(sameRedirect("http://127.0.0.1/callback", "http://localhost:51234/callback")).toBe(false);
    expect(sameRedirect("http://127.0.0.1/callback", "http://127.0.0.1:51234/other")).toBe(false);
    expect(sameRedirect("https://a.example/cb", "https://a.example:444/cb")).toBe(false);
  });
  test("registration is throttled without leaking store failures", async () => {
    const r = remote();
    const now = r.h.clock.now;
    for (let i = 0; i < 30; i++)
      await r.store.insert({ kind: "client", id: `c${i}`, uid: null, grant: null, doc: { name: null, redirect_uris: [REDIRECT], registration_hosts: ["http://127.0.0.1"] }, created: now, expires: now + 1000, used: null });
    const limited = await r.send("POST", "/oauth/register", { json: { redirect_uris: [REDIRECT] } });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("slow_down");
    expect((await r.send("POST", "/oauth/register", { json: { redirect_uris: ["https://other.example/callback"] } })).status).toBe(201);
    r.store.fail = true;
    const failed = await r.send("POST", "/oauth/register", { json: { redirect_uris: [REDIRECT] } });
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain("private details");
  });
});

describe("authorization", () => {
  test("the consent page shows the registered client and never reflects markup", async () => {
    const r = remote();
    const client = await r.register({ client_name: '"><script>alert(1)</script>' });
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challengeOf("v".repeat(43)), code_challenge_method: "S256", state: "s" });
    const pageResponse = await r.send("GET", `/oauth/authorize?${query}`);
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.body).toContain('data-mode="authorize"');
    expect(pageResponse.body).not.toContain("<script>alert");
    expect(pageResponse.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect(pageResponse.headers.get("x-frame-options")).toBe("DENY");
  });
  test("an unknown client or foreign redirect is refused on our page, never redirected", async () => {
    const r = remote();
    const client = await r.register();
    const base = { response_type: "code", code_challenge: challengeOf("v".repeat(43)), code_challenge_method: "S256" };
    const unknown = await r.send("GET", `/oauth/authorize?${new URLSearchParams({ ...base, client_id: "kmc_unknown", redirect_uri: REDIRECT })}`);
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();
    const foreign = await r.send("GET", `/oauth/authorize?${new URLSearchParams({ ...base, client_id: client.client_id, redirect_uri: "https://attacker.example/cb" })}`);
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("location")).toBeNull();
    const posted = await r.approve(client.client_id, undefined, "agent-alice", { redirect_uri: "https://attacker.example/cb" });
    expect(posted.response.status).toBe(400);
  });
  test("invalid authorization links never redirect before consent", async () => {
    const r = remote();
    const client = await r.register();
    const noPkce = await r.send("GET", `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, state: "keep" })}`);
    expect(noPkce.status).toBe(400);
    expect(noPkce.headers.get("location")).toBeNull();
    const noResponseType = await r.send("GET", `/oauth/authorize?client_id=${client.client_id}`);
    expect(noResponseType.status).toBe(400);
    expect(noResponseType.headers.get("location")).toBeNull();
    const plain = await r.approve(client.client_id, undefined, "agent-alice", { code_challenge_method: "plain" });
    expect(new URL(plain.response.body.redirect_to).searchParams.get("error")).toBe("invalid_request");
    const wrongResource = await r.approve(client.client_id, undefined, "agent-alice", { resource: "https://other.example/v1/mcp" });
    expect(new URL(wrongResource.response.body.redirect_to).searchParams.get("error")).toBe("invalid_target");
  });
  test("approval needs a verified, recoverable sign-in from our own page", async () => {
    const r = remote();
    const client = await r.register();
    const body = { decision: "approve", client_id: client.client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: challengeOf("v".repeat(43)), code_challenge_method: "S256" };
    expect((await r.send("POST", "/oauth/authorize", { json: body, headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await r.send("POST", "/oauth/authorize", { token: "forged", json: body, headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await r.send("POST", "/oauth/authorize", { token: "anon-alice", json: body, headers: { origin: ORIGIN } })).status).toBe(403);
    expect((await r.send("POST", "/oauth/authorize", { token: "custom-alice", json: body, headers: { origin: ORIGIN } })).status).toBe(403);
    expect((await r.send("POST", "/oauth/authorize", { token: "agent-alice", json: body, headers: { origin: "https://attacker.example" } })).status).toBe(403);
    expect((await r.send("POST", "/oauth/authorize", { token: "agent-alice", json: body })).status).toBe(403);
    expect([...r.store.rows.values()].some((row) => row.kind === "code")).toBe(false);
    const denied = await r.send("POST", "/oauth/authorize", { json: { ...body, decision: "deny", state: "s" }, headers: { origin: ORIGIN } });
    expect(Object.fromEntries(new URL(denied.body.redirect_to).searchParams)).toMatchObject({ error: "access_denied", state: "s" });
  });
  test("a loopback client may return on any port", async () => {
    const r = remote();
    const client = await r.register({ redirect_uris: ["http://localhost/callback"] });
    const approved = await r.approve(client.client_id, undefined, "agent-alice", { redirect_uri: "http://localhost:50999/callback" });
    expect(approved.target!.host).toBe("localhost:50999");
    expect(approved.target!.searchParams.get("state")).toBe("xyz");
    expect(approved.target!.searchParams.get("iss")).toBe(ORIGIN);
    const tokens = await r.exchange(client.client_id, approved.code, undefined, { redirect_uri: "http://localhost:50999/callback" });
    expect(tokens.status).toBe(200);
  });
  test("approvals are rate limited per user", async () => {
    const r = remote();
    const client = await r.register();
    for (let i = 0; i < 20; i++) expect((await r.approve(client.client_id)).response.status).toBe(200);
    expect((await r.approve(client.client_id)).response.status).toBe(429);
    expect((await r.approve(client.client_id, undefined, "agent-bob")).response.status).toBe(200);
  });
});

describe("tokens", () => {
  test("a code is exchanged once, with the matching verifier, client and redirect", async () => {
    const r = remote();
    const client = await r.register(),
      other = await r.register();
    const wrongVerifier = await r.approve(client.client_id);
    expect((await r.exchange(client.client_id, wrongVerifier.code, "w".repeat(43))).body.error).toBe("invalid_grant");
    const wrongClient = await r.approve(client.client_id);
    expect((await r.exchange(other.client_id, wrongClient.code)).body.error).toBe("invalid_grant");
    const wrongRedirect = await r.approve(client.client_id);
    expect((await r.exchange(client.client_id, wrongRedirect.code, undefined, { redirect_uri: "http://127.0.0.1:1/other" })).body.error).toBe("invalid_grant");
    const expired = await r.approve(client.client_id);
    r.h.advance(300_001);
    expect((await r.exchange(client.client_id, expired.code)).body.error).toBe("invalid_grant");

    const { code } = await r.approve(client.client_id);
    const first = await r.exchange(client.client_id, code);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "oyobidashi" });
    expect(first.body.access_token).toMatch(/^kma_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...r.store.rows.values()])).not.toContain(first.body.access_token.slice(4));
    expect(JSON.stringify([...r.store.rows.values()])).not.toContain(first.body.refresh_token.slice(4));
    // Replaying the code withdraws the tokens it produced.
    expect((await r.exchange(client.client_id, code)).body.error).toBe("invalid_grant");
    expect((await r.rpc(first.body.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  });
  test("refresh rotates once and any replay revokes its token family", async () => {
    const r = remote();
    const { client, tokens } = await r.connect();
    const refresh = (token: string, clientId = client.client_id) =>
      r.send("POST", "/oauth/token", { form: { grant_type: "refresh_token", client_id: clientId, refresh_token: token } });
    const second = await refresh(tokens.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await refresh(tokens.refresh_token)).body.error).toBe("invalid_grant");
    expect((await refresh(second.body.refresh_token)).body.error).toBe("invalid_grant");
    expect((await r.rpc(second.body.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await refresh("kmr_unknown")).body.error).toBe("invalid_grant");
  });
  test("the owner can inspect and revoke only their own MCP approvals", async () => {
    const r = remote();
    const alice = await r.connect("agent-alice");
    const bob = await r.connect("agent-bob");
    const list = (token: string) => r.send("GET", "/oauth/grants", { token });
    const a = await list("agent-alice");
    const b = await list("agent-bob");
    expect(a.body.grants).toHaveLength(1);
    expect(a.body.grants[0]).toMatchObject({ name: "Claude Code", redirect_uri: REDIRECT });
    expect(b.body.grants).toHaveLength(1);
    expect(a.body.grants[0].id).not.toBe(b.body.grants[0].id);
    expect((await r.send("DELETE", `/oauth/grants/${b.body.grants[0].id}`, { token: "agent-alice", headers: { origin: ORIGIN } })).status).toBe(204);
    expect((await list("agent-bob")).body.grants).toHaveLength(1);
    expect((await r.send("DELETE", `/oauth/grants/${a.body.grants[0].id}`, { token: "agent-alice" })).status).toBe(403);
    expect((await r.send("DELETE", `/oauth/grants/${a.body.grants[0].id}`, { token: "agent-alice", headers: { origin: ORIGIN } })).status).toBe(204);
    expect((await list("agent-alice")).body.grants).toHaveLength(0);
    expect((await r.rpc(alice.tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await r.rpc(bob.tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    expect((await r.send("GET", "/oauth/connections")).body).toContain('data-mode="connections"');
  });
  test("removing the final phone revokes the owner's MCP approval", async () => {
    const r = remote();
    const { tokens } = await r.connect();
    const first = await r.h.pair("alice");
    const second = await r.h.pair("alice");
    const listed = () => r.rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await listed()).status).toBe(200);
    expect((await r.send("DELETE", "/v1/devices/me", { token: first.device_token })).status).toBe(204);
    expect((await listed()).status).toBe(200);
    expect((await r.send("DELETE", "/v1/devices/me", { token: second.device_token })).status).toBe(204);
    expect((await listed()).status).toBe(401);
  });
  test("access tokens expire, refresh tokens idle out and revocation ends the approval", async () => {
    const r = remote();
    const { client, tokens } = await r.connect();
    const list = (token: string) => r.rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await list(tokens.access_token)).status).toBe(200);
    r.h.advance(ACCESS_TTL_MS + 1);
    const expired = await list(tokens.access_token);
    expect(expired.status).toBe(401);
    expect(expired.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const renewed = (await r.send("POST", "/oauth/token", { form: { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token } })).body;
    expect((await list(renewed.access_token)).status).toBe(200);
    expect((await r.send("POST", "/oauth/revoke", { form: { token: renewed.refresh_token } })).status).toBe(200);
    expect((await list(renewed.access_token)).status).toBe(401);
    expect((await r.send("POST", "/oauth/revoke", { form: { token: "kmr_unknown" } })).status).toBe(200);

    const idle = await r.connect();
    r.h.advance(REFRESH_TTL_MS + 1);
    expect((await r.send("POST", "/oauth/token", { form: { grant_type: "refresh_token", client_id: idle.client.client_id, refresh_token: idle.tokens.refresh_token } })).body.error).toMatch(/invalid_/);
  });
  test("only the newest approvals of a user are kept", async () => {
    const r = remote();
    const client = await r.register();
    const issued: string[] = [];
    for (let i = 0; i < 31; i++) {
      r.h.advance(61_000);
      const { code } = await r.approve(client.client_id);
      issued.push((await r.exchange(client.client_id, code)).body.access_token);
    }
    const list = (token: string) => r.rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((await list(issued[0]!)).status).toBe(401);
    expect((await list(issued[30]!)).status).toBe(200);
  });
  test("unsupported grants and malformed bodies get RFC 6749 errors", async () => {
    const r = remote();
    const client = await r.register();
    expect((await r.send("POST", "/oauth/token", { form: { grant_type: "password", client_id: client.client_id } })).body.error).toBe("unsupported_grant_type");
    expect((await r.send("POST", "/oauth/token", { form: { grant_type: "authorization_code" } })).body.error).toBe("invalid_client");
    expect((await r.send("POST", "/oauth/token", { form: { grant_type: "authorization_code", client_id: client.client_id, code: "x" } })).body.error).toBe("invalid_request");
  });
});

describe("hosted MCP endpoint", () => {
  test("tools run as the approving user and reach only their phone", async () => {
    const r = remote();
    const { tokens } = await r.connect();
    const init = await r.rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
    expect(init.message.result.serverInfo.name).toBe("oyobidashi");
    expect(init.message.result.capabilities.resources.subscribe).toBeUndefined();
    const tools = await r.rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(tools.message.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["ask_human", "cancel_request", "get_human_status", "notify_human", "update_request", "wait_for_answer"]);
    for (const tool of tools.message.result.tools) {
      const readOnly = ["get_human_status", "wait_for_answer"].includes(tool.name);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false,
      });
    }

    const unpaired = await r.tool(tokens.access_token, "notify_human", { message: "ビルドが終わりました" });
    expect(unpaired.structuredContent.status).toBe("notified");
    expect(unpaired.structuredContent.warning).toContain(`${ORIGIN}/pair`);

    const device = await r.h.pair("alice");
    const asked = await r.tool(tokens.access_token, "ask_human", { question: "デプロイしますか？", choices: ["はい", "いいえ"], wait_seconds: 0 });
    expect(asked.structuredContent.status).toBe("pending");
    const id = asked.structuredContent.request_id as string;
    const stored = await r.h.service.run(r.h.principal("alice"), (tx) => r.h.service.request(tx, id));
    expect(stored.agent).toEqual({ name: "Claude Code", cwd: null });
    expect((await r.h.service.run(r.h.principal("bob"), (tx) => tx.get("request", id)))).toBeNull();

    const waiting = r.tool(tokens.access_token, "wait_for_answer", { request_id: id, wait_seconds: 20 });
    await Bun.sleep(50);
    const answered = await r.send("POST", `/v1/requests/${id}/answer`, { token: device.device_token, json: { text: "はい", choice_index: 0, input_method: "choice" } });
    expect(answered.status).toBe(200);
    const result = await waiting;
    expect(result.structuredContent).toMatchObject({ status: "answered", answer: "はい", choice_index: 0 });
    expect((await r.tool(tokens.access_token, "get_human_status", {})).structuredContent.devices).toHaveLength(1);

    const bob = await r.connect("agent-bob");
    const foreign = await r.tool(bob.tokens.access_token, "wait_for_answer", { request_id: id, wait_seconds: 0 });
    expect(foreign.isError).toBe(true);
    expect(foreign.structuredContent.error_code).toBe("not_found");
  });
  test("OAuth tokens open nothing but the MCP endpoint, and other credentials do not open it", async () => {
    const r = remote();
    const { tokens } = await r.connect();
    for (const [method, path] of [["POST", "/v1/pairing-codes"], ["POST", "/v1/auth/link-token"], ["POST", "/v1/requests"], ["GET", "/v1/presence"]] as const)
      expect((await r.send(method, path, { token: tokens.access_token, json: {} })).status).toBe(401);
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await r.rpc("agent-alice", list)).status).toBe(401);
    expect((await r.rpc(tokens.refresh_token, list)).status).toBe(401);
    const device = await r.h.pair("alice");
    expect((await r.rpc(device.device_token, list)).status).toBe(401);
  });
  test("the endpoint is stateless: no session streams, preflight for browser clients", async () => {
    const r = remote();
    const { tokens } = await r.connect();
    const get = await r.send("GET", "/v1/mcp", { token: tokens.access_token, headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toContain("POST");
    expect((await r.send("DELETE", "/v1/mcp", { token: tokens.access_token })).status).toBe(405);
    const options = await r.send("OPTIONS", "/v1/mcp", { headers: { origin: "https://inspector.example", "access-control-request-method": "POST" } });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-headers")).toContain("authorization");
    const notification = await r.rpc(tokens.access_token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);
  });
});
