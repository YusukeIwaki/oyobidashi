import { expect, test } from "bun:test";
import { generateKeyPairSync, privateEncrypt } from "node:crypto";
import { decodeJwt, importJWK, jwtVerify } from "jose";
import postgres from "postgres";
import { CloudApp } from "../src/app.ts";
import { ClaudeBilling } from "../src/claude-billing.ts";
import { CLAUDE_CALLBACK, CLAUDE_ISSUER, ClaudePlatform, ClaudeRefreshDeferred } from "../src/claude-platform.ts";
import { claudeKmsSigner, claudeKmsTokenCipher } from "../src/claude-kms.ts";
import { ClaudeTokenWorker, sealClaudeTokens } from "../src/claude-tokens.ts";
import { OFFICIAL_CLOUD_ORIGIN } from "../src/config.ts";
import { apiConversation, CLAUDE_BILLING_BETA } from "../src/provider.ts";
import { PostgresDatabase } from "../src/postgres.ts";
import { JobWorker } from "../src/worker.ts";
import { harness } from "./helpers.ts";

const orgPath = "/oauth/claude/organization";
const billingPath = "/oauth/claude/billing";
const choice = { question: "Keep or remove the sample API?", priority: "high", delivery_mode: "call" };
const disclosed = { "x-oyobidashi-voice-provider": "anthropic-linked" };
const linked = { profileId: "uprof_alice", connectionId: "ocon_alice" };

// KMS double hands out opaque ciphertext and enforces exactly the same AAD checks.
function fakeCipher() {
  const values = new Map<string, {value: string; binding: string}>();
  return {
    async encrypt(value: string, binding: string) {
      const key = crypto.randomUUID();
      values.set(key, {value, binding});
      return key;
    },
    async decrypt(key: string, binding: string) {
      const entry = values.get(key);
      if (entry?.binding !== binding) throw new Error("binding mismatch");
      return entry.value;
    },
  };
}
const credentials = (connectionId: string, now: number, generation = 1) => ({
  connectionId, access: `access-${connectionId}-${generation}`, refresh: `refresh-${connectionId}-${generation}`,
  accessExpires: now + 120_000, refreshExpires: now + 3600_000,
});

function setup(db?: Parameters<typeof harness>[0]) {
  const h = harness(db);
  h.service.claudeBillingEnabled = true;
  h.service.freeInputRestricted = true;
  h.service.voiceProvider = "meta";
  const exchanges: {code: string; verifier: string}[] = [];
  const revoked: string[] = [];
  const created: string[] = [];
  const cipher = fakeCipher();
  const verifier = {
    ...h.app.verifier,
    async identify(token: string) {
      const uid = await h.app.verifier.verify(token);
      return {
        uid, provider: uid === "guest" ? "anonymous" : "google.com",
        ...(uid !== "unverified" ? { verifiedEmail: `${uid}@example.test` } : {}),
      };
    },
  };
  const billing = new ClaudeBilling(h.service, verifier, {
    async createProfile(ref) { created.push(ref); return created.length === 1 ? linked.profileId : `uprof_${created.length}`; },
    async authorize(profileId, state) { return `https://auth.claude.com/oauth/authorize?state=${state}&profile=${profileId}`; },
    async exchange(code, verifier) {
      exchanges.push({code, verifier});
      return credentials(code === "sample-code" ? linked.connectionId : `ocon_${code}`, h.clock.now);
    },
    async revoke(id) { revoked.push(id); },
    async connectionStatus() { return "linked"; },
  }, cipher);
  const app = new CloudApp(h.service, verifier, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, billing);
  function browser(path: string, options: RequestInit = {}, token = "agent-alice", origin = OFFICIAL_CLOUD_ORIGIN) {
    return app.fetch(new Request(`${origin}${path}`, {
      ...options,
      headers: {
        ...(token ? {authorization: `Bearer ${token}`} : {}),
        origin: OFFICIAL_CLOUD_ORIGIN,
        ...options.headers,
      },
    })) as Promise<Response>;
  }
  const post = (path: string, body: object, user = "alice") =>
    browser(path, { method: "POST", body: JSON.stringify(body) }, `agent-${user}`);
  const organization = async (uid = "alice", name = "A社") => {
    expect((await post(orgPath, {name}, uid)).status).toBe(201);
    return (await h.db.transaction(uid, tx => tx.claudeAccess()))!.organizationId;
  };
  const seedBilling = async (uid = "alice", name = "A社", payer = linked) => {
    const id = await organization(uid, name);
    const sealed = await sealClaudeTokens(cipher, id, credentials(payer.connectionId, h.clock.now));
    await h.db.transaction(id, async tx => {
      await tx.put("claude_billing", "current", payer);
      await tx.putClaudeTokens(sealed);
    });
    return id;
  };
  return { ...h, browser, post, organization, seedBilling, exchanges, revoked, created, cipher };
}

test("links the Firebase owner through a one-time, browser-bound callback", async () => {
  const h = setup();
  const start = { method: "POST", body: JSON.stringify({accept: true}) };
  expect((await h.browser(billingPath, start, "agent-guest")).status).toBe(401);
  expect((await h.browser(billingPath, start, "agent-alice", "https://self-hosted.example")).status).toBe(404);
  expect((await h.browser(billingPath, { ...start, headers: {origin: "https://other.example"} })).status).toBe(401);
  const orgId = await h.organization();
  expect((await h.browser(billingPath, { method: "POST", body: JSON.stringify({accept: false}) })).status).toBe(400);
  expect(h.created).toHaveLength(0);
  const response = await h.browser(billingPath, start);
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; SameSite=Lax");
  const {redirect_to} = await response.json() as {redirect_to: string};
  const state = new URL(redirect_to).searchParams.get("state");
  const callback = `/oauth/claude/callback?state=${state}&code=sample-code`;
  expect((await h.browser(callback, {}, "")).headers.get("location")).toBe("/oauth/connections?claude=failed");
  expect(h.exchanges).toHaveLength(0);
  const valid = { headers: {cookie: cookie.split(";")[0]!} };
  expect((await h.browser(callback, valid, "")).headers.get("location")).toBe("/oauth/connections?claude=linked");
  expect((await h.browser(callback, valid, "")).headers.get("location")).toBe("/oauth/connections?claude=failed");
  expect(h.exchanges).toHaveLength(1);
  const stored = await h.db.transaction(orgId, tx => tx.getClaudeTokens());
  expect(stored?.connectionId).toBe("ocon_alice");
  expect(JSON.stringify(stored)).not.toContain("refresh-ocon_alice");
  expect(h.exchanges[0]?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await (await h.browser(billingPath)).json()).toEqual({status: "linked", organization: {name: "A社", role: "admin"}, members: []});
  expect(await (await h.browser(billingPath, {}, "agent-bob")).json()).toEqual({status: "unlinked", organization: null, members: []});
  expect(await h.db.transaction("alice", tx => h.service.hasPlus(tx))).toBe(false);
  expect((await h.call("GET", "/v1/input-restriction")).body.restricted).toBe(false);
  expect((await h.call("GET", "/v1/input-restriction", "agent-bob")).body.restricted).toBe(true);
  expect((await h.browser(billingPath, {method: "DELETE"})).status).toBe(204);
  expect(h.revoked).toEqual(["ocon_alice"]);
  expect(await h.db.transaction(orgId, tx => tx.getClaudeTokens())).toBeNull();
  expect((await h.call("POST", "/v1/requests", "agent-alice", choice)).body.request.delivery_mode).toBe("text");
  expect((await h.browser(billingPath, start)).status).toBe(200);
  expect(h.created).toHaveLength(1);
});

test("bills only the linked profile and uses a text fallback on a billing refusal", async () => {
  const h = setup();
  const d = await h.pair("alice", "android");
  const orgId = await h.seedBilling();
  const device = d.device_token;
  const oldClient = await h.call("POST", "/v1/requests", "agent-alice", choice);
  expect(oldClient.body.request.call.voice_provider).toBe("anthropic-linked");
  const oldPath = `/v1/requests/${oldClient.body.request.id}/call`;
  expect((await h.call("POST", oldPath, device, {event: "answer"})).status).toBe(409);
  let calls = 0, hostedCalls = 0;
  const tokenWorker = new ClaudeTokenWorker(h.db, h.cipher, {
    async refresh() { throw new Error("valid stored access token should be reused"); },
  }, () => h.clock.now);
  const worker = new JobWorker(h.service, {
    conversation: {turn: async () => { hostedCalls++; throw new Error("unexpected"); }},
    freeConversation: {turn: async () => { hostedCalls++; throw new Error("unexpected"); }},
    linkedConversation: ref => apiConversation({
      model: "claude-test",
      linkedBilling: {profileId: ref.profileId, accessToken: signal => tokenWorker.access(ref, signal)},
      fetch: (async (input, init) => {
        expect(input).toBe("https://api.anthropic.com/v1/messages");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer access-ocon_alice-1");
        expect(headers.get("anthropic-user-profile-id")).toBe("uprof_alice");
        expect(headers.get("anthropic-beta")).toBe(CLAUDE_BILLING_BETA);
        expect(headers.has("x-api-key")).toBe(false);
        const body = JSON.parse(init?.body as string);
        expect(body.billing_policy).toEqual({type: "billing_policy", bill_to: "user_profile"});
        expect(body.messages[0].content).toContain("Use the short report");
        return ++calls === 1
          ? Response.json({stop_reason: "end_turn", content: [{type: "text", text: '{"reply":"Thanks","answer":"short","resolved":true}'}]})
          : Response.json({error: {type: "billing_error"}}, {status: 402});
      }) as typeof fetch,
    }),
  });
  for (const result of ["answered", "pending"]) {
    const generated = await h.call("POST", "/v1/requests", "agent-alice", choice);
    const path = `/v1/requests/${generated.body.request.id}`;
    expect((await h.call("POST", `${path}/call`, device, {event:"answer"}, disclosed)).status).toBe(200);
    const turnId = crypto.randomUUID();
    expect((await h.call("POST", `${path}/call`, device, {event:"turn", text:"Use the short report", turn_id:turnId, async:true}, disclosed)).status).toBe(202);
    expect(await worker.runOnce("turn")).toBe(true);
    const request = (await h.call("GET", path, device)).body.request;
    expect(request.status).toBe(result);
    if (result === "pending") {
      expect(request.delivery_mode).toBe("text");
      expect(request.call.outcome).toBe("failed");
      await h.db.transaction(orgId, tx => tx.remove("claude_billing", "current"));
      const updated = await h.call("PATCH", path, "agent-alice", {priority: "high", delivery_mode: "call"});
      expect(updated.body.request.delivery_mode).toBe("text");
    }
  }
  expect(calls).toBe(2);
  expect(hostedCalls).toBe(0);
  expect(await worker.runOnce("turn")).toBe(false);
});

test("a pending linked text question cannot be escalated through the hosted model after unlinking", async () => {
  const h = setup();
  await h.pair();
  await h.seedBilling();
  const result = await h.call("POST", "/v1/requests", "agent-alice", { ...choice, delivery_mode: "text" });
  const path = `/v1/requests/${result.body.request.id}`;
  expect(result.body.request.call).toBeNull();
  expect((await h.browser(billingPath, {method: "DELETE"})).status).toBe(204);
  // Simulate leaving the organization and then accepting the standard route.
  const org = (await h.db.transaction("alice", tx => tx.claudeAccess()))!;
  await h.db.transaction(org.organizationId, tx => tx.remove("claude_member", "alice"));
  const policy = (await h.call("GET", "/v1/input-restriction")).body;
  expect((await h.call("POST", "/v1/input-restriction", "agent-alice", {accept: true, version: policy.version})).status).toBe(200);
  expect((await h.call("PATCH", path, "agent-alice", {priority: "high", delivery_mode: "call"})).body.request.delivery_mode).toBe("text");
  expect((await h.call("POST", "/v1/requests", "agent-alice", choice)).body.request.delivery_mode).toBe("call");
});

async function accessRef(h: ReturnType<typeof setup>, uid = "alice") {
  const access = (await h.db.transaction(uid, tx => tx.claudeAccess()))!;
  return {
    organizationId: access.organizationId, uid, grantId: access.member.grantId,
    profileId: access.billing!.profileId, connectionId: access.billing!.connectionId,
  };
}

async function verifyRefreshLock(db?: Parameters<typeof harness>[0], other?: Parameters<typeof harness>[0]) {
  const h = setup(db);
  const org = await h.seedBilling();
  const ref = await accessRef(h);
  const invite = await (await h.post(`${orgPath}/invite`, {email: "x@example.test"})).json() as {invitation: string};
  expect((await h.post(`${orgPath}/accept`, {...invite, accept:true}, "x")).status).toBe(200);
  const otherMember = await accessRef(h, "x");
  const previous = (await h.db.transaction(org, tx => tx.getClaudeTokens()))!;
  h.advance(110_000);
  let calls = 0;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const remote = {
    async refresh(connection: string, input: string) {
      calls++;
      expect(connection).toBe("ocon_alice");
      expect(input).toBe("refresh-ocon_alice-1");
      entered.resolve();
      await release.promise;
      return credentials(connection, h.clock.now, 2);
    },
  };
  const first = new ClaudeTokenWorker(h.db, h.cipher, remote, () => h.clock.now);
  const second = new ClaudeTokenWorker(other ?? h.db, h.cipher, remote, () => h.clock.now);
  const a = first.access(ref);
  await entered.promise;
  const b = second.access(otherMember);
  try {
    await Bun.sleep(35);
    expect(calls).toBe(1);
    const inProgress = await h.db.transaction(org, tx => tx.getClaudeTokens());
    expect(inProgress?.refreshId).toBeTruthy();
    expect(inProgress?.ciphertext).toBe(previous.ciphertext);
  } finally {
    release.resolve();
  }
  expect(await Promise.all([a, b])).toEqual(["access-ocon_alice-2", "access-ocon_alice-2"]);
  const after = await h.db.transaction(org, tx => tx.getClaudeTokens());
  expect(after?.refreshId).toBeNull();
  expect(after?.ciphertext).not.toBe(previous.ciphertext);
  expect(calls).toBe(1);
}
test("two worker replicas share a durable refresh lock and reuse the persisted rotation", async () => {
  await verifyRefreshLock();
});
test("an ambiguous refresh stays on hold across restarts and requires relinking", async () => {
  const h = setup();
  const org = await h.seedBilling();
  const ref = await accessRef(h);
  h.advance(110_000);
  let calls = 0;
  const remote = { async refresh() { calls++; throw new DOMException("timeout", "TimeoutError"); } };
  const first = new ClaudeTokenWorker(h.db, h.cipher, remote, () => h.clock.now);
  await expect(first.access(ref)).rejects.toThrow();
  const crashed = await h.db.transaction(org, tx => tx.getClaudeTokens());
  expect(crashed?.refreshId).toBeTruthy();
  h.advance(46_000);
  const restarted = new ClaudeTokenWorker(h.db, h.cipher, remote, () => h.clock.now);
  await expect(restarted.access(ref)).rejects.toThrow();
  expect(calls).toBe(1);
  expect((await (await h.browser(billingPath)).json() as {status: string}).status).toBe("relink_required");
});
test("unlinking an organization during refresh cannot restore its token row", async () => {
  const h = setup();
  const org = await h.seedBilling();
  const ref = await accessRef(h);
  h.advance(110_000);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const worker = new ClaudeTokenWorker(h.db, h.cipher, {
    async refresh(connection) {
      entered.resolve();
      await release.promise;
      return credentials(connection, h.clock.now, 2);
    },
  }, () => h.clock.now);
  const activity = worker.access(ref);
  await entered.promise;
  try {
    expect((await h.browser(billingPath, {method: "DELETE"})).status).toBe(204);
  } finally {
    release.resolve();
  }
  await expect(activity).rejects.toThrow();
  expect(await h.db.transaction(org, tx => tx.getClaudeTokens())).toBeNull();
});

test("a confirmed rate limit defers renewal and leaves the token safe to use later", async () => {
  const h = setup();
  const org = await h.seedBilling();
  const ref = await accessRef(h);
  h.advance(110_000);
  let calls = 0;
  const worker = new ClaudeTokenWorker(h.db, h.cipher, {
    async refresh(connection: string) {
      if (++calls === 1) throw new ClaudeRefreshDeferred(h.clock.now + 5_000);
      return credentials(connection, h.clock.now, 2);
    },
  }, () => h.clock.now);
  await expect(worker.access(ref)).rejects.toThrow();
  expect((await h.db.transaction(org, tx => tx.getClaudeTokens()))?.refreshId).toBeNull();
  await expect(worker.access(ref)).rejects.toThrow();
  expect(calls).toBe(1);
  h.advance(5_000);
  expect(await worker.access(ref)).toBe("access-ocon_alice-2");
});
test("copying ciphertext to another organization cannot give it billable credentials", async () => {
  const h = setup();
  const a = await h.seedBilling();
  const b = await h.seedBilling("d", "B社", { profileId: "uprof_b", connectionId: "ocon_b" });
  const alice = (await h.db.transaction(a, tx => tx.getClaudeTokens()))!;
  await h.db.transaction(b, tx => tx.putClaudeTokens({...alice, connectionId: "ocon_b"}));
  const worker = new ClaudeTokenWorker(h.db, h.cipher, {
    async refresh() { throw new Error("unexpected refresh"); },
  }, () => h.clock.now);
  await expect(worker.access(await accessRef(h, "d"))).rejects.toThrow();
  expect(await worker.access(await accessRef(h))).toBe("access-ocon_alice-1");
});
test("token storage sends authenticated ciphertext operations to a separate Cloud KMS key", async () => {
  const key = "projects/sample/locations/global/keyRings/oyobidashi/cryptoKeys/claude-tokens";
  const seen: string[] = [];
  const cipher = claudeKmsTokenCipher(key, (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal")
      return Response.json({access_token: "ephemeral-google-token", expires_in: 600});
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer ephemeral-google-token");
    expect(init?.redirect).toBe("error");
    const payload = JSON.parse(String(init?.body));
    expect(Buffer.from(payload.additionalAuthenticatedData, "base64").toString()).toBe("organization-A/connection-A");
    seen.push(url.pathname);
    if (url.pathname.endsWith(":encrypt")) {
      expect(Buffer.from(payload.plaintext, "base64").toString()).toBe("demo-secret");
      return Response.json({ciphertext: "opaque", name: key + "/cryptoKeyVersions/1"});
    }
    expect(payload.ciphertext).toBe("opaque");
    return Response.json({plaintext: Buffer.from("demo-secret").toString("base64")});
  }) as typeof fetch);
  expect(await cipher.encrypt("demo-secret", "organization-A/connection-A")).toBe("opaque");
  expect(await cipher.decrypt("opaque", "organization-A/connection-A")).toBe("demo-secret");
  expect(seen).toEqual([`/v1/${key}:encrypt`, `/v1/${key}:decrypt`]);
});

async function verifyOrganizationBilling(database?: Parameters<typeof harness>[0]) {
  const h = setup(database);
  const a = await h.seedBilling("alice", "A社", {profileId: "uprof_a", connectionId: "ocon_a"});
  const b = await h.seedBilling("d", "B社", {profileId: "uprof_b", connectionId: "ocon_b"});
  expect(a).not.toBe(b);
  const x = await h.pair("x");
  const y = await h.pair("y");
  const codeA = await (await h.post(`${orgPath}/invite`, {email: "X@example.test"})).json() as {invitation: string};
  const codeB = await (await h.post(`${orgPath}/invite`, {email: "y@example.test"}, "d")).json() as {invitation: string};
  expect((await h.post(`${orgPath}/accept`, {...codeA, accept:true}, "unverified")).status).toBe(403);
  expect((await h.post(`${orgPath}/accept`, {...codeB, accept:true}, "x")).status).toBe(403);
  expect((await h.post(`${orgPath}/accept`, {...codeA, accept:true}, "y")).status).toBe(403);
  expect((await h.post(`${orgPath}/accept`, {...codeA, accept:true}, "x")).status).toBe(200);
  expect((await h.post(`${orgPath}/accept`, {...codeB, accept:true}, "y")).status).toBe(200);
  expect((await h.post(`${orgPath}/accept`, {...codeA, accept:true}, "x")).status).toBe(409);
  expect((await h.post(billingPath, {accept: true}, "x")).status).toBe(403);
  expect((await h.post(`${orgPath}/invite`, {email: "intruder@example.test"}, "x")).status).toBe(403);
  expect((await h.browser(billingPath, {method: "DELETE"}, "agent-x")).status).toBe(403);
  expect((await h.browser(`${orgPath}/member`, {method: "DELETE", body: JSON.stringify({uid: "x"})}, "agent-d")).status).toBe(403);
  expect(await h.db.transaction("x", tx => h.service.hasPlus(tx))).toBe(false);
  expect((await h.call("GET", "/v1/input-restriction", "agent-x")).body.restricted).toBe(false);
  const xStatus = await (await h.browser(billingPath, {}, "agent-x")).json();
  expect(xStatus).toEqual({status: "linked", organization: {name: "A社", role: "member"}, members: []});

  const recipients: [string, string][] = [];
  const worker = new JobWorker(h.service, {
    linkedConversation: ref => ({turn: async () => {
      recipients.push([ref.uid, ref.profileId]);
      return {reply: "Thanks", answer: "short", resolved: true};
    }}),
  });
  async function queue(uid: string, token: string) {
    const result = await h.call("POST", "/v1/requests", `agent-${uid}`, choice);
    expect(result.body.request.call.voice_provider).toBe("anthropic-linked");
    const path = `/v1/requests/${result.body.request.id}`;
    expect((await h.call("POST", `${path}/call`, token, {event: "answer"}, disclosed)).status).toBe(200);
    expect((await h.call("POST", `${path}/call`, token, {
      event: "turn", async: true, text: "short", turn_id: crypto.randomUUID(),
    }, disclosed)).status).toBe(202);
    return path;
  }
  const oldA = await queue("x", x.device_token);
  await worker.runOnce("turn");
  await queue("y", y.device_token);
  await worker.runOnce("turn");
  expect(recipients).toEqual([["x", "uprof_a"], ["y", "uprof_b"]]);
  expect((await h.call("GET", oldA, x.device_token)).body.request.status).toBe("answered");

  const revokedA = await queue("x", x.device_token);
  expect((await h.browser(`${orgPath}/member`, {method: "DELETE", body: JSON.stringify({uid: "x"})})).status).toBe(204);
  h.advance(61_000);
  const newInvite = await (await h.post(`${orgPath}/invite`, {email: "x@example.test"}, "d")).json() as {invitation: string};
  expect((await h.post(`${orgPath}/accept`, {...newInvite, accept:true}, "x")).status).toBe(200);
  await worker.runOnce("turn");
  expect(recipients).toEqual([["x", "uprof_a"], ["y", "uprof_b"]]);
  const oldRequest = await h.call("GET", revokedA, x.device_token);
  expect(oldRequest.body.request.delivery_mode).toBe("text");
  const oldUpdate = await h.call("PATCH", revokedA, "agent-x", {priority:"high", delivery_mode:"call"});
  expect(oldUpdate.body.request.delivery_mode).toBe("text");
  await queue("x", x.device_token);
  await worker.runOnce("turn");
  expect(recipients[2]).toEqual(["x", "uprof_b"]);

  const inviteForZ = async (administrator: string) => (await h.post(`${orgPath}/invite`, {email: "z@example.test"}, administrator)).json() as Promise<{invitation: string}>;
  const invitations = await Promise.all([inviteForZ("alice"), inviteForZ("d")]);
  const simultaneous = await Promise.all(invitations.map(invite => h.post(`${orgPath}/accept`, {...invite, accept:true}, "z")));
  expect(simultaneous.map(response => response.status).sort()).toEqual([200, 409]);
  expect(await h.db.transaction("z", async tx => (await tx.claudeAccess())?.billing?.profileId)).toMatch(/^uprof_[ab]$/);

  expect((await h.browser(billingPath, {method: "DELETE"})).status).toBe(204);
  expect(h.revoked).toEqual(["ocon_a"]);
  expect((await h.browser(billingPath, {}, "agent-x")).status).toBe(200);
  expect(await h.db.transaction("x", async tx => (await tx.claudeAccess())?.billing?.profileId)).toBe("uprof_b");
}

test("invited Firebase users stay isolated between organizations and cannot bill after removal", async () => {
  await verifyOrganizationBilling();
});

test.skipIf(!process.env.CLOUD_TEST_DATABASE_URL)("organization scope and invites are isolated in PostgreSQL", async () => {
  const schema = `claude_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = process.env.CLOUD_TEST_DATABASE_URL!;
  const admin = postgres(url, {max: 1, onnotice: () => {}});
  const db = new PostgresDatabase(url, 4, schema);
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    await db.migrate();
    await verifyOrganizationBilling(db);
  } finally {
    await db.close();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test.skipIf(!process.env.CLOUD_TEST_DATABASE_URL)("PostgreSQL serializes token refresh across separate connection pools", async () => {
  const url = process.env.CLOUD_TEST_DATABASE_URL!;
  const schema = `claude_tokens_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(url, {max: 1, onnotice: () => {}});
  const db = new PostgresDatabase(url, 2, schema);
  const second = new PostgresDatabase(url, 2, schema);
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    await db.migrate();
    await verifyRefreshLock(db, second);
  } finally {
    await Promise.all([db.close(), second.close()]);
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});

test("uses signed and audience-scoped workload assertions for the real platform wire format", async () => {
  const {privateKey, publicKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
  const version = "projects/sample/locations/global/keyRings/oyobidashi/cryptoKeys/claude/cryptoKeyVersions/1";
  let metadataRequests = 0;
  const signer = claudeKmsSigner({
    version, issuer: CLAUDE_ISSUER,
    send: (async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      if (url.hostname === "metadata.google.internal") {
        expect(headers.get("metadata-flavor")).toBe("Google");
        metadataRequests++;
        return Response.json({access_token: "ephemeral-google-token", expires_in: 600});
      }
      expect(url.hostname).toBe("cloudkms.googleapis.com");
      expect(headers.get("authorization")).toBe("Bearer ephemeral-google-token");
      if (url.pathname.endsWith("/publicKey")) return Response.json({
        name: version, pem: publicKey.export({type: "spki", format: "pem"}),
        algorithm: "RSA_SIGN_PKCS1_2048_SHA256",
      });
      expect(url.pathname).toBe(`/v1/${version}:asymmetricSign`);
      const digest = Buffer.from(JSON.parse(String(init?.body)).digest.sha256, "base64");
      const digestInfo = Buffer.concat([Buffer.from("3031300d060960864801650304020105000420", "hex"), digest]);
      return Response.json({name: version, signature: privateEncrypt(privateKey, digestInfo).toString("base64")});
    }) as typeof fetch,
  });
  const key = (await signer.publicKeys()).keys[0]!;
  expect(key.d).toBeUndefined();
  const paths: string[] = [];
  const platform = new ClaudePlatform({
    clientId: "oauth_sample", clientAudience: "client", operatorAudience: "operator",
    organizationId: "example", federationRuleId: "fdrl_example", serviceAccountId: "svac_example",
    workspaceId: "wrkspc_example", model: "claude-test",
  }, signer, (async (input, init) => {
    const url = new URL(String(input));
    const props = JSON.parse(String(init?.body));
    paths.push(url.pathname);
    expect(init?.redirect).toBe("error");
    if (props.assertion || props.client_assertion) {
      const assertion = props.assertion ?? props.client_assertion;
      const claims = decodeJwt(assertion);
      const audience = url.hostname === "auth.claude.com" ? "client" : "operator";
      await jwtVerify(assertion, await importJWK(key), {audience, issuer: CLAUDE_ISSUER});
      expect(claims.sub).toBe(`oyobidashi:claude:${audience}`);
    }
    if (url.pathname === "/v1/user_profiles") return Response.json({id: "uprof_demo"});
    if (url.pathname.endsWith("/par")) {
      expect(props.redirect_uri).toBe(CLAUDE_CALLBACK);
      expect(props.user_profile_id).toBe("uprof_demo");
      expect(props.scope).toBe("billing:attribution offline_access");
      expect(props.code_challenge_method).toBe("S256");
      return Response.json({request_uri: "urn:sample:par"}, {status:201});
    }
    if (url.hostname === "auth.claude.com") {
      if (props.grant_type === "authorization_code") expect(props.code_verifier).toBe("private-verifier");
      else {
        expect(props.grant_type).toBe("refresh_token");
        expect(props.refresh_token).toBe("refresh-original");
        expect(props.scope).toBeUndefined();
      }
      return Response.json({
        connection_id: "ocon_demo", access_token: "access-rotated", refresh_token: "refresh-rotated",
        expires_in: 600, refresh_token_expires_in: 3600,
      });
    }
    return Response.json({access_token: "operator-token", expires_in: 600});
  }) as typeof fetch);
  const profile = await platform.createProfile("opaque-reference");
  const url = new URL(await platform.authorize(profile, "state", "private-verifier"));
  expect(url.hostname).toBe("auth.claude.com");
  expect([...url.searchParams.keys()]).toEqual(["client_id", "request_uri"]);
  expect((await platform.exchange("sample-code", "private-verifier")).connectionId).toBe("ocon_demo");
  expect((await platform.refresh("ocon_demo", "refresh-original")).refresh).toBe("refresh-rotated");
  expect(paths).toEqual(["/v1/oauth/token", "/v1/user_profiles", "/v1/oauth/par", "/v1/oauth/token", "/v1/oauth/token"]);
  expect(metadataRequests).toBe(1);
});
