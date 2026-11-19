import { expect, test } from "bun:test";
import { generateKeyPair, decodeJwt } from "jose";
import type { AccountAuth } from "../src/account-auth.ts";
import { firebaseAccountDirectory, type AccountDirectory } from "../src/account-deletion.ts";
import { unavailable } from "../src/errors.ts";
import { JobWorker } from "../src/worker.ts";
import { harness } from "./helpers.ts";
import { MemoryDatabase } from "./memory.ts";

function accountAuth(directory: AccountDirectory): AccountAuth {
  return {
    publicConfig: { firebase: { apiKey: "public", projectId: "fixture", authDomain: "fixture.firebaseapp.com" }, providers: ["apple"], canLinkExisting: false },
    issueLinkToken: async () => { throw new Error("disabled"); },
    directory,
  };
}

test("Firebase directory uses the project account API and revokes Apple authorization", async () => {
  const { privateKey } = await generateKeyPair("RS256");
  const calls: string[] = [];
  const send = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.hostname === "oauth2.googleapis.com") {
      const assertion = (init!.body as URLSearchParams).get("assertion")!;
      expect(decodeJwt(assertion).scope).toBe("https://www.googleapis.com/auth/identitytoolkit");
      return Response.json({ access_token: "fixture-admin", expires_in: 3600 });
    }
    const body = JSON.parse(init!.body as string);
    if (url.pathname.endsWith("accounts:lookup")) {
      expect(new Headers(init!.headers).get("authorization")).toBe("Bearer fixture-admin");
      expect(body).toEqual({ localId: ["uid"] });
      return Response.json({ users: [{ localId: "uid", providerUserInfo: [{ providerId: "apple.com" }] }] });
    }
    if (url.pathname.endsWith("accounts:revokeToken")) {
      expect(body).toMatchObject({ providerId: "apple.com", tokenType: "ACCESS_TOKEN", idToken: "fixture-id" });
      return Response.json({});
    }
    expect(body).toEqual({ localId: "uid" });
    return Response.json({ error: { message: "USER_NOT_FOUND" } }, { status: 400 });
  }, { preconnect: () => {} });
  const directory = firebaseAccountDirectory("fixture-project", "public", "fixture@fixture.invalid", privateKey, Date.now, send);
  expect(await directory.hasApple("uid")).toBe(true);
  await directory.revokeApple("fixture-id", "fixture-apple");
  await directory.deleteUser("uid");
  expect(calls).toEqual(["/token", "/v1/projects/fixture-project/accounts:lookup", "/v2/accounts:revokeToken", "/v1/projects/fixture-project/accounts:delete"]);
});

test("confirmed deletion can retry after a directory failure and erases only its own data", async () => {
  const db = new MemoryDatabase();
  const deleted: string[] = [];
  let fail = true;
  const h = harness(db, { auth: accountAuth({
    hasApple: async () => false,
    revokeApple: async () => { throw new Error("unexpected Apple revocation"); },
    deleteUser: async uid => { if (fail) throw unavailable(); deleted.push(uid); },
  }) });
  const s = await h.setup();
  const other = await h.setup("bob");
  const queued = await s.turn();
  expect(queued.status).toBe(202);
  expect((await h.call("POST", "/v1/account/deletion", "agent-alice")).status).toBe(401);
  expect((await h.call("POST", "/v1/account/deletion", s.d.device_token)).status).toBe(503);
  expect((await h.call("GET", "/v1/requests", "agent-alice")).body.error.code).toBe("account_deleting");
  fail = false;
  expect((await h.call("POST", "/v1/account/deletion", s.d.device_token)).body.status).toBe("deleted");
  expect(deleted).toEqual(["alice"]);
  expect([...db.records.values()].some(record => record.uid === "alice")).toBe(false);
  expect([...db.jobs.values()].some(job => job.uid === "alice")).toBe(false);
  expect((await h.call("GET", "/v1/requests", s.d.device_token)).status).toBe(401);
  expect((await h.call("POST", "/v1/pairing-codes", "agent-alice")).status).toBe(401);
  expect((await h.call("GET", "/v1/requests", other.d.device_token)).status).toBe(200);
});

test("Apple deletion requires fresh Apple authorization for the paired UID before erasure", async () => {
  const events: string[] = [];
  const db = new MemoryDatabase();
  const now = Date.now();
  const h = harness(db, {
    auth: accountAuth({
      hasApple: async () => true,
      revokeApple: async () => { events.push("revocation"); },
      deleteUser: async () => { events.push("deletion"); },
    }),
    verifier: {
      verify: async token => token.replace(/^agent-/, ""),
      identify: async token => ({
        uid: token === "other" ? "bob" : "alice",
        provider: token === "google" ? "google.com" : "apple.com",
        authenticatedAt: token === "stale" ? now - 11 * 60_000 : now,
      }),
    },
  });
  const d = await h.pair();
  const start = await h.call("POST", "/v1/account/deletion", d.device_token);
  expect(start.body.status).toBe("reauthentication");
  const confirm = (identity_token: string) => h.call("POST", "/v1/account/deletion/apple", null, {
    ticket: start.body.ticket, identity_token, apple_token: "temporary",
  });
  for (const token of ["other", "stale", "google"]) expect((await confirm(token)).status).toBe(401);
  expect(events).toEqual([]);
  expect((await confirm("fresh")).status).toBe(204);
  expect(events).toEqual(["revocation", "deletion"]);
  expect((await confirm("fresh")).status).toBe(401);
});

test("iOS voice turns require the disclosed policy and workers reject stale configurations", async () => {
  const h = harness();
  const policy = { provider: "anthropic" as const, id: "v1:anthropic:false:false", training: { free: false, plus: false } };
  h.service.voicePrivacy = policy;
  let sends = 0;
  const worker = new JobWorker(h.service, { conversation: { turn: async () => {
    sends++;
    return { resolved: false, answer: null, reply: "続けます" };
  } } });
  const s = await h.setup();
  const turn = (consent: string) => h.call("POST", `/v1/requests/${s.id}/call`, s.d.device_token, {
    event: "turn", turn_id: crypto.randomUUID(), text: "はい", voice_consent: consent, async: true,
  });
  expect((await s.turn()).body.error.code).toBe("voice_consent_required");
  expect(await worker.runOnce("turn")).toBe(false);
  expect(sends).toBe(0);
  expect((await turn(policy.id)).status).toBe(202);
  h.service.voicePrivacy = { ...policy, provider: "meta", id: "v1:meta:false:false" };
  expect(await worker.runOnce("turn")).toBe(true);
  expect(sends).toBe(0);
  expect((await turn(h.service.voicePrivacy.id)).status).toBe(202);
  expect(await worker.runOnce("turn")).toBe(true);
  expect(sends).toBe(1);
});
