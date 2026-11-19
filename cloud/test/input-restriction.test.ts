import { describe, expect, test } from "bun:test";
import { CloudApp } from "../src/app.ts";
import { unauthorized } from "../src/errors.ts";
import { INPUT_RESTRICTION_VERSION, needsInputConsent, parseInputRestriction } from "../src/input-restriction.ts";
import { canPostponeInputConsent, stepAfterSignIn } from "../src/oauth-browser-flow.ts";
import { JobWorker } from "../src/worker.ts";
import { INPUT_RESTRICTION_PROMPT } from "../../mcp/src/server.ts";
import { PRIVACY_NOTICE } from "../../mcp/src/results.ts";
import { harness } from "./helpers.ts";
import { MemoryOAuthStore } from "./oauth-memory.ts";

// The FREE plan input restriction, phase by phase:
//   0. who is restricted            (deployment x plan)
//   1. linking an agent             (the owner accepts it once, in the browser)
//   2. what the agent is told       (MCP instructions, tool descriptions, results)
//   3. during a call                (nothing is asked; unaccepted owners get text)
//   4. plan changes                 (the restriction follows the plan immediately)
//
// "hosted" is the official service whose FREE model accepts no personal or
// confidential input. "self-hosted" is every other deployment.

const ORIGIN = "http://localhost";
const REDIRECT = "http://127.0.0.1:43110/callback";
const challengeOf = (verifier: string) => new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

function deployment(kind: "hosted" | "self-hosted") {
  const h = harness();
  h.service.freeInputRestricted = kind === "hosted";
  const verifier = {
    verify: async (token: string) => (await verifier.identify(token)).uid,
    async identify(token: string) {
      if (token.startsWith("agent-")) return { uid: token.slice(6), provider: "google.com" };
      throw unauthorized();
    },
  };
  const app = new CloudApp(h.service, verifier, 10_000, {
    publicConfig: {
      firebase: { apiKey: "synthetic", projectId: "synthetic-project", authDomain: "synthetic-project.firebaseapp.com" },
      providers: ["google" as const],
      canLinkExisting: false,
    },
    issueLinkToken: async () => "unused",
  }, undefined, { store: new MemoryOAuthStore(), script: async () => "/* bundle */" });
  const send = async (method: string, path: string, init: { token?: string; json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) => {
    const response = (await app.fetch(new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...init.headers,
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
    })))!;
    const text = await response.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch {}
    return { status: response.status, body };
  };
  /** Subscribes or unsubscribes an owner without going through a store. */
  const plan = (uid: string, plus: boolean) => h.db.transaction(uid, (tx) =>
    tx.put("entitlement", "current", {
      sources: plus ? { "google:test": { store: "google", product_id: "plus", expires: h.clock.now + 30 * 86400_000, shared: false } } : {},
    }));
  const status = async (uid: string) => (await send("GET", "/v1/input-restriction", { token: `agent-${uid}` })).body;
  const accept = (uid: string, version: unknown = INPUT_RESTRICTION_VERSION) =>
    send("POST", "/v1/input-restriction", { token: `agent-${uid}`, json: { accept: true, version } });
  const register = async () =>
    (await send("POST", "/oauth/register", { json: { client_name: "Claude Code", redirect_uris: [REDIRECT] } })).body.client_id as string;
  /** The human's decision on the consent page. */
  const approve = (uid: string, client: string, verifier = "v".repeat(43)) =>
    send("POST", "/oauth/authorize", {
      token: `agent-${uid}`,
      headers: { origin: ORIGIN },
      json: { decision: "approve", client_id: client, redirect_uri: REDIRECT, response_type: "code", code_challenge: challengeOf(verifier), code_challenge_method: "S256" },
    });
  /** Links an MCP client for `uid` and returns its access token. */
  const link = async (uid: string) => {
    const client = await register();
    const approved = await approve(uid, client);
    if (approved.status !== 200) throw new Error(`approval refused: ${approved.body.error?.code}`);
    const code = new URL(approved.body.redirect_to).searchParams.get("code")!;
    const tokens = await send("POST", "/oauth/token", { form: { grant_type: "authorization_code", client_id: client, code, code_verifier: "v".repeat(43), redirect_uri: REDIRECT } });
    return tokens.body.access_token as string;
  };
  const rpc = async (token: string, method: string, params: unknown = {}) => {
    const response = await send("POST", "/v1/mcp", {
      token, json: { jsonrpc: "2.0", id: 1, method, params },
      headers: { accept: "application/json, text/event-stream" },
    });
    const data = typeof response.body === "string" ? /^data: (.*)$/m.exec(response.body)?.[1] : undefined;
    return (data ? JSON.parse(data) : response.body).result;
  };
  const instructions = async (token: string) =>
    (await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).instructions as string;
  const descriptions = async (token: string) =>
    Object.fromEntries(((await rpc(token, "tools/list")).tools as { name: string; description: string }[]).map((t) => [t.name, t.description]));
  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) =>
    (await rpc(token, "tools/call", { name, arguments: args })).structuredContent as Record<string, any>;
  /** Asks for a call and returns how the request is actually delivered. */
  const askCall = async (uid: string) =>
    (await send("POST", "/v1/requests", { token: `agent-${uid}`, json: { question: "進めますか？", priority: "high", delivery_mode: "call" } })).body;
  return { h, send, plan, status, accept, register, approve, link, instructions, descriptions, tool, askCall };
}

/** The test phones have no push provider, so an unrelated delivery warning may be present. */
const consentWarned = (result: Record<string, any>) => String(result.warning ?? "").includes("FREE plan input restriction");

describe("phase 0: who is restricted", () => {
  test("hosted FREE is restricted; hosted PLUS and every self-hosted owner are not", async () => {
    const hosted = deployment("hosted"), own = deployment("self-hosted");
    await hosted.plan("plus", true);
    await own.plan("plus", true);
    const cases = [
      [hosted, "free", true],
      [hosted, "plus", false],
      [own, "free", false],
      [own, "plus", false],
    ] as const;
    for (const [d, uid, restricted] of cases)
      expect(await d.status(uid)).toEqual({ restricted, accepted: false, version: INPUT_RESTRICTION_VERSION });
  });

  test("only a restricted owner without an acceptance needs the consent step", () => {
    const state = (restricted: boolean, accepted: boolean) => ({ restricted, accepted, version: INPUT_RESTRICTION_VERSION });
    expect(needsInputConsent(state(true, false))).toBe(true);
    expect(needsInputConsent(state(true, true))).toBe(false);
    expect(needsInputConsent(state(false, false))).toBe(false);
    expect(() => parseInputRestriction({ restricted: "yes" })).toThrow();
    expect(() => parseInputRestriction(null)).toThrow();
  });
});

describe("phase 1: linking an agent", () => {
  test("a hosted FREE owner cannot link an agent before accepting", async () => {
    const d = deployment("hosted");
    const refused = await d.approve("alice", await d.register());
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("input_consent_required");
  });

  test("accepting on the page records it once and lets the link complete", async () => {
    const d = deployment("hosted");
    const accepted = await d.accept("alice");
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ restricted: true, accepted: true, version: INPUT_RESTRICTION_VERSION });
    const first = await d.h.db.transaction("alice", (tx) => tx.get("input_consent", "current"));
    d.h.advance(60_000);
    expect((await d.accept("alice")).status).toBe(200);
    expect(await d.h.db.transaction("alice", (tx) => tx.get("input_consent", "current"))).toEqual(first);
    expect(await d.link("alice")).toMatch(/^kma_/);
    // Another agent linked later does not ask again.
    expect(await d.link("alice")).toMatch(/^kma_/);
  });

  test("the owner can replace acceptance of an older version", async () => {
    const d = deployment("hosted");
    await d.h.db.transaction("alice", (tx) =>
      tx.put("input_consent", "current", { version: INPUT_RESTRICTION_VERSION - 1, at: d.h.clock.now }));
    expect((await d.status("alice")).accepted).toBe(false);
    expect((await d.accept("alice")).body.accepted).toBe(true);
    expect((await d.status("alice")).accepted).toBe(true);
  });

  test("declining still returns to the client without an acceptance", async () => {
    const d = deployment("hosted");
    const denied = await d.send("POST", "/oauth/authorize", {
      headers: { origin: ORIGIN },
      json: { decision: "deny", client_id: await d.register(), redirect_uri: REDIRECT, response_type: "code", code_challenge: challengeOf("v".repeat(43)), code_challenge_method: "S256" },
    });
    expect(new URL(denied.body.redirect_to).searchParams.get("error")).toBe("access_denied");
    expect((await d.status("alice")).accepted).toBe(false);
  });

  test("PLUS and self-hosted owners link without any consent step", async () => {
    const hosted = deployment("hosted");
    await hosted.plan("plus", true);
    expect(await hosted.link("plus")).toMatch(/^kma_/);
    expect(await deployment("self-hosted").link("alice")).toMatch(/^kma_/);
  });

  test("the acceptance must be explicit, current and the owner's own", async () => {
    const d = deployment("hosted");
    expect((await d.send("POST", "/v1/input-restriction", { token: "agent-alice", json: {} })).status).toBe(400);
    expect((await d.send("POST", "/v1/input-restriction", { token: "agent-alice", json: { accept: "true", version: INPUT_RESTRICTION_VERSION } })).status).toBe(400);
    const stale = await d.accept("alice", INPUT_RESTRICTION_VERSION + 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("input_restriction_changed");
    expect((await d.status("alice")).accepted).toBe(false);
    expect((await d.send("GET", "/v1/input-restriction")).status).toBe(401);
    // A paired phone is not where the owner accepts.
    const phone = await d.h.pair("alice");
    expect((await d.send("GET", "/v1/input-restriction", { token: phone.device_token })).status).toBe(403);
    expect((await d.send("POST", "/v1/input-restriction", { token: phone.device_token, json: { accept: true, version: INPUT_RESTRICTION_VERSION } })).status).toBe(403);
    expect((await d.status("alice")).accepted).toBe(false);
  });

  test("one owner's acceptance never covers another owner", async () => {
    const d = deployment("hosted");
    await d.accept("alice");
    expect((await d.status("bob")).accepted).toBe(false);
    expect((await d.approve("bob", await d.register())).status).toBe(409);
  });

  test("the page asks first, and only the owners it applies to", () => {
    const state = (restricted: boolean, accepted: boolean) => ({ restricted, accepted, version: INPUT_RESTRICTION_VERSION });
    for (const mode of ["authorize", "pair", "connections"] as const)
      expect(stepAfterSignIn(mode, state(true, false), 1)).toBe("input_restriction");
    expect(stepAfterSignIn("authorize", state(true, true), 1)).toBe("approval");
    expect(stepAfterSignIn("authorize", state(true, true), 0)).toBe("pairing");
    expect(stepAfterSignIn("authorize", state(false, false), 1)).toBe("approval");
    expect(stepAfterSignIn("authorize", state(false, false), 0)).toBe("pairing");
    expect(stepAfterSignIn("pair", state(false, false), 3)).toBe("pairing");
    expect(stepAfterSignIn("connections", state(false, false), 0)).toBe("connections");
    // Linking an agent cannot skip the step; looking at the account can.
    expect(canPostponeInputConsent("authorize")).toBe(false);
    expect(canPostponeInputConsent("pair")).toBe(true);
    expect(canPostponeInputConsent("connections")).toBe(true);
  });
});

describe("phase 2: what the agent is told", () => {
  test("a hosted FREE owner's MCP server carries the restriction in its own prompt", async () => {
    const d = deployment("hosted");
    await d.accept("alice");
    const token = await d.link("alice");
    expect(await d.instructions(token)).toContain(INPUT_RESTRICTION_PROMPT);
    const tools = await d.descriptions(token);
    expect(tools.ask_human).toContain(INPUT_RESTRICTION_PROMPT);
    expect(tools.notify_human).toContain(INPUT_RESTRICTION_PROMPT);
    await d.h.pair("alice");
    for (const result of [
      await d.tool(token, "ask_human", { question: "進めますか？", wait_seconds: 0 }),
      await d.tool(token, "notify_human", { message: "完了しました" }),
      await d.tool(token, "get_human_status"),
    ]) {
      expect(result.privacy_notice).toBe(PRIVACY_NOTICE);
      expect(consentWarned(result)).toBe(false);
    }
  });

  test("PLUS and self-hosted owners get no restriction anywhere", async () => {
    const hosted = deployment("hosted"), own = deployment("self-hosted");
    await hosted.plan("plus", true);
    for (const [d, uid] of [[hosted, "plus"], [own, "alice"]] as const) {
      const token = await d.link(uid);
      await d.h.pair(uid);
      expect(await d.instructions(token)).not.toContain("INPUT RESTRICTION");
      expect(JSON.stringify(await d.descriptions(token))).not.toContain("INPUT RESTRICTION");
      for (const result of [
        await d.tool(token, "ask_human", { question: "進めますか？", wait_seconds: 0 }),
        await d.tool(token, "notify_human", { message: "完了しました" }),
        await d.tool(token, "get_human_status"),
      ]) {
        expect("privacy_notice" in result).toBe(false);
        expect(consentWarned(result)).toBe(false);
      }
    }
  });

  test("the plain API reports the restriction to agents and never to phones", async () => {
    const d = deployment("hosted");
    const phone = await d.h.pair("alice");
    const agent = (await d.send("GET", "/v1/presence", { token: "agent-alice" })).body;
    expect(agent).toMatchObject({ input_restricted: true, input_consent_required: true });
    const device = (await d.send("GET", "/v1/presence", { token: phone.device_token })).body;
    expect("input_restricted" in device || "input_consent_required" in device).toBe(false);
    await d.accept("alice");
    const created = (await d.send("POST", "/v1/requests", { token: "agent-alice", json: { question: "q" } })).body;
    expect(created.delivery.input_restricted).toBe(true);
    expect("input_consent_required" in created.delivery).toBe(false);
  });
});

describe("phase 3: during a call", () => {
  /** A worker that records which model, if any, received each turn. */
  const worker = (d: ReturnType<typeof deployment>) => {
    const sent: string[] = [];
    const model = (name: string) => ({ turn: async () => {
      sent.push(name);
      return { reply: "続けます", resolved: false, answer: null };
    } });
    // Only the hosted service has a separate FREE model.
    return { sent, worker: new JobWorker(d.h.service, {
      conversation: model("standard"),
      ...(d.h.service.freeInputRestricted ? { freeConversation: model("free") } : {}),
    }) };
  };
  const speak = (d: ReturnType<typeof deployment>, id: string, device: string) =>
    d.send("POST", `/v1/requests/${id}/call`, { token: device, json: { event: "turn", turn_id: crypto.randomUUID(), text: "はい", async: true } });

  test("an accepted FREE owner answers and talks at once; the call asks nothing", async () => {
    const d = deployment("hosted"), w = worker(d);
    await d.accept("alice");
    const phone = await d.h.pair("alice");
    const { request } = await d.askCall("alice");
    expect(request.delivery_mode).toBe("call");
    const answered = await d.send("POST", `/v1/requests/${request.id}/call`, { token: phone.device_token, json: { event: "answer" } });
    expect(answered.status).toBe(200);
    // The first thing spoken is the question itself.
    expect(answered.body.reply).toBe("進めますか？");
    // A turn carries no consent field of any kind.
    expect((await speak(d, request.id, phone.device_token)).status).toBe(202);
    expect(await w.worker.runOnce("turn")).toBe(true);
    expect(w.sent).toEqual(["free"]);
  });

  test("PLUS and self-hosted owners talk without any acceptance", async () => {
    const hosted = deployment("hosted"), own = deployment("self-hosted");
    await hosted.plan("plus", true);
    for (const [d, uid] of [[hosted, "plus"], [own, "alice"]] as const) {
      const w = worker(d), phone = await d.h.pair(uid);
      const { request, delivery } = await d.askCall(uid);
      expect(request.delivery_mode).toBe("call");
      expect("input_consent_required" in delivery).toBe(false);
      expect((await d.send("POST", `/v1/requests/${request.id}/call`, { token: phone.device_token, json: { event: "answer" } })).status).toBe(200);
      expect((await speak(d, request.id, phone.device_token)).status).toBe(202);
      expect(await w.worker.runOnce("turn")).toBe(true);
      expect(w.sent).toEqual(["standard"]);
    }
  });

  test("without an acceptance no call is placed: the question arrives as text and the agent is told why", async () => {
    const d = deployment("hosted");
    await d.h.pair("alice");
    const { request, delivery } = await d.askCall("alice");
    expect(request.delivery_mode).toBe("text");
    expect(request.call).toBeNull();
    expect(delivery).toMatchObject({ input_restricted: true, input_consent_required: true });
    // Escalating later does not place one either.
    const updated = await d.send("PATCH", `/v1/requests/${request.id}`, { token: "agent-alice", json: { priority: "urgent", delivery_mode: "call" } });
    expect(updated.body.request.delivery_mode).toBe("text");
    // Accepting makes the same request callable.
    await d.accept("alice");
    const retried = await d.send("PATCH", `/v1/requests/${request.id}`, { token: "agent-alice", json: { priority: "urgent", delivery_mode: "call" } });
    expect(retried.body.request.delivery_mode).toBe("call");
  });

  test("the hosted MCP result tells the agent how the owner can accept", async () => {
    const d = deployment("hosted");
    await d.accept("alice");
    const token = await d.link("alice");
    await d.h.pair("alice");
    await d.h.db.transaction("alice", (tx) => tx.remove("input_consent", "current"));
    const asked = await d.tool(token, "ask_human", { question: "進めますか？", priority: "high", delivery_mode: "call", wait_seconds: 0 });
    expect(asked.delivery_mode).toBe("text");
    expect(consentWarned(asked)).toBe(true);
    expect(asked.warning).toContain(`${ORIGIN}/oauth/connections`);
    expect(asked.privacy_notice).toBe(PRIVACY_NOTICE);
    expect((await d.tool(token, "get_human_status")).warning).toContain(`${ORIGIN}/oauth/connections`);
  });
});

describe("phase 4: plan changes", () => {
  test("a subscription that lapses mid-call never sends an unaccepted owner's words to the FREE model", async () => {
    const d = deployment("hosted");
    const sent: string[] = [];
    const model = (name: string) => ({ turn: async () => {
      sent.push(name);
      return { reply: "続けます", resolved: false, answer: null };
    } });
    const worker = new JobWorker(d.h.service, { conversation: model("standard"), freeConversation: model("free") });
    await d.plan("alice", true);
    const phone = await d.h.pair("alice");
    const { request } = await d.askCall("alice");
    const call = (body: unknown) => d.send("POST", `/v1/requests/${request.id}/call`, { token: phone.device_token, json: body });
    expect((await call({ event: "answer" })).status).toBe(200);
    const turn = () => call({ event: "turn", turn_id: crypto.randomUUID(), text: "はい", async: true });

    // Subscribed: the standard model answers.
    expect((await turn()).status).toBe(202);
    expect(await worker.runOnce("turn")).toBe(true);
    expect(sent).toEqual(["standard"]);

    // Queued while subscribed, executed after the lapse: the worker ends the call instead.
    const queued = await turn();
    expect(queued.status).toBe(202);
    await d.plan("alice", false);
    expect(await worker.runOnce("turn")).toBe(true);
    expect(sent).toEqual(["standard"]);
    expect((await d.h.turn(queued.body.turn.id))?.state).toBe("cancelled");
    const ended = (await d.send("GET", `/v1/requests/${request.id}`, { token: "agent-alice" })).body.request;
    // The question stays answerable, as text.
    expect(ended).toMatchObject({ status: "pending", delivery_mode: "text", call: { state: "ended", outcome: "failed" } });
    expect((await turn()).body.error.code).toBe("call_ended");
    expect(await worker.runOnce("turn")).toBe(false);

    // Once the owner accepts, the next call runs on the FREE model.
    await d.accept("alice");
    const next = (await d.askCall("alice")).request;
    expect(next.delivery_mode).toBe("call");
    const again = (body: unknown) => d.send("POST", `/v1/requests/${next.id}/call`, { token: phone.device_token, json: body });
    expect((await again({ event: "answer" })).status).toBe(200);
    expect((await again({ event: "turn", turn_id: crypto.randomUUID(), text: "はい", async: true })).status).toBe(202);
    expect(await worker.runOnce("turn")).toBe(true);
    expect(sent).toEqual(["standard", "free"]);
  });

  test("a call that is ringing or active when the plan lapses ends with a message the phone can show", async () => {
    for (const event of ["answer", "turn"] as const) {
      const d = deployment("hosted");
      await d.plan("alice", true);
      const phone = await d.h.pair("alice");
      const { request } = await d.askCall("alice");
      const call = (body: unknown) => d.send("POST", `/v1/requests/${request.id}/call`, { token: phone.device_token, json: body });
      if (event === "turn") expect((await call({ event: "answer" })).status).toBe(200);
      await d.plan("alice", false);
      const refused = await call(event === "answer" ? { event } : { event, turn_id: crypto.randomUUID(), text: "はい", async: true });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("call_ended");
      expect(refused.body.error.message).toContain("文字で返信できます");
      const after = (await d.send("GET", `/v1/requests/${request.id}`, { token: phone.device_token })).body.request;
      expect(after).toMatchObject({ status: "pending", delivery_mode: "text", call: { state: "ended" } });
      // The text answer still reaches the agent.
      expect((await d.send("POST", `/v1/requests/${request.id}/answer`, { token: phone.device_token, json: { text: "進めてください", input_method: "text" } })).status).toBe(200);
    }
  });

  test("the agent's prompt follows the plan from the next request on", async () => {
    const d = deployment("hosted");
    await d.accept("alice");
    const token = await d.link("alice");
    await d.h.pair("alice");
    expect(await d.instructions(token)).toContain(INPUT_RESTRICTION_PROMPT);
    await d.plan("alice", true);
    expect(await d.instructions(token)).not.toContain("INPUT RESTRICTION");
    expect("privacy_notice" in await d.tool(token, "get_human_status")).toBe(false);
    await d.plan("alice", false);
    expect(await d.instructions(token)).toContain(INPUT_RESTRICTION_PROMPT);
    // The earlier acceptance still stands after returning to FREE.
    const status = await d.tool(token, "get_human_status");
    expect(status.privacy_notice).toBe(PRIVACY_NOTICE);
    expect(consentWarned(status)).toBe(false);
  });

  test("an agent linked while subscribed keeps working over text after the lapse", async () => {
    const d = deployment("hosted");
    await d.plan("alice", true);
    const token = await d.link("alice");
    await d.h.pair("alice");
    await d.plan("alice", false);
    const asked = await d.tool(token, "ask_human", { question: "進めますか？", wait_seconds: 0 });
    expect(asked.status).toBe("pending");
    expect(asked.privacy_notice).toBe(PRIVACY_NOTICE);
    expect(asked.warning).toContain("FREE plan input restriction");
  });

  test("deleting the account erases the acceptance with everything else", async () => {
    const d = deployment("hosted");
    await d.accept("alice");
    await d.h.db.transaction("alice", (tx) => tx.eraseAccount());
    expect(await d.h.db.transaction("alice", (tx) => tx.get("input_consent", "current"))).toBeNull();
  });
});
