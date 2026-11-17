import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APNS_JWT_TTL_MS,
  buildApnsPayload,
  createApnsProvider,
  createHttp2ApnsTransport,
  type ApnsTransportRequest,
  type ApnsTransportResponse,
} from "../src/push/apns.ts";
import { FCM_SCOPE, buildFcmData, buildFcmMessage, createFcmProvider, parseServiceAccount } from "../src/push/fcm.ts";
import { createPushFromConfig, notificationText, type PushProvider, type PushResult, type PushTarget } from "../src/push/index.ts";
import type { RequestObject } from "../src/types.ts";
import { fixture, makeHarness } from "./helpers.ts";

const question = () => fixture<RequestObject>("request_pending.json");
const notification = () => fixture<RequestObject>("request_notification.json");

const toPem = (label: string, der: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;

let ecPem: string;
let ecPublic: CryptoKey;
let rsaPem: string;
let rsaPublic: CryptoKey;
let dir: string;

beforeAll(async () => {
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  ecPem = toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", ec.privateKey));
  ecPublic = ec.publicKey;
  const rsa = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  rsaPem = toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", rsa.privateKey));
  rsaPublic = rsa.publicKey;
  dir = mkdtempSync(join(tmpdir(), "oyobidashi-push-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function decodeJwt(jwt: string) {
  const [h, c, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c!, "base64url").toString()),
    signingInput: Buffer.from(`${h}.${c}`),
    signature: Buffer.from(s!, "base64url"),
  };
}

describe("notification text", () => {
  test("titles with and without an agent name", () => {
    expect(notificationText(question()).title).toBe("claude-code からの質問");
    expect(notificationText(notification()).title).toBe("codex からのお知らせ");
    expect(notificationText({ ...question(), agent: null }).title).toBe("エージェントからの質問");
    expect(notificationText({ ...question(), agent: { name: null, cwd: "/x" } }).title).toBe("エージェントからの質問");
    expect(notificationText({ ...notification(), agent: null }).title).toBe("エージェントからのお知らせ");
  });

  test("body is the first 1000 characters of the question", () => {
    expect(notificationText({ ...question(), question: "あ".repeat(1000) }).body).toBe("あ".repeat(1000));
    expect(notificationText({ ...question(), question: "あ".repeat(1001) + "END" }).body).toBe("あ".repeat(1000));
    // counted in characters: surrogate pairs are neither split nor counted twice
    const emoji = notificationText({ ...question(), question: "😀".repeat(1500) }).body;
    expect(Array.from(emoji)).toHaveLength(1000);
    expect(emoji).toBe("😀".repeat(1000));
    expect(notificationText({ ...question(), question: "😀".repeat(600) }).body).toBe("😀".repeat(600));
  });
});

describe("APNs payload", () => {
  test("question payload equals the fixture", () => {
    expect(buildApnsPayload(question())).toEqual(fixture("apns_payload.json"));
  });

  test("high urgency keeps time-sensitive", () => {
    expect((buildApnsPayload({ ...question(), urgency: "high", priority: "high" }).aps as any)["interruption-level"]).toBe("time-sensitive");
  });

  test("notification payload", () => {
    expect(buildApnsPayload(notification())).toEqual({
      aps: {
        alert: { title: "codex からのお知らせ", body: "ビルドが完了しました" },
        sound: "default",
        "mutable-content":1,
        "interruption-level": "active",
        category: "OYOBIDASHI_NOTIFICATION",
        "thread-id": "oyobidashi",
      },
      request_id: "req_01JCNTF",
      kind: "notification",
      priority:"normal",delivery_mode:"text",status:"notified",choices:[],
    });
  });
});

describe("APNs provider", () => {
  function setup(respond: (req: ApnsTransportRequest, n: number) => ApnsTransportResponse | Promise<ApnsTransportResponse> = () => ({ status: 200, body: "" })) {
    const sent: ApnsTransportRequest[] = [];
    const time = { now: Date.parse("2026-11-15T14:00:00.000Z") };
    const provider = createApnsProvider({
      keyPem: ecPem,
      keyId: "KEYID12345",
      teamId: "TEAMID6789",
      bundleId: "me.oyobidashi.ios",
      now: () => time.now,
      transport: async (req) => {
        sent.push(req);
        return respond(req, sent.length);
      },
    });
    return { provider, sent, time };
  }
  const target: PushTarget = { token: "a1b2c3", environment: "production" };

  test("sends the fixture payload with the contract's headers", async () => {
    const { provider, sent } = setup();
    expect(await provider.send(target, question())).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.origin).toBe("https://api.push.apple.com");
    expect(req.path).toBe("/3/device/a1b2c3");
    expect(JSON.parse(req.body)).toEqual(fixture("apns_payload.json"));
    expect(req.headers).toMatchObject({
      "apns-push-type": "alert",
      "apns-topic": "me.oyobidashi.ios",
      "apns-priority": "10",
      "apns-collapse-id": "req_01JCXYZ",
      "apns-expiration": String(Date.parse("2026-11-15T15:00:00.000Z") / 1000),
    });
    expect(req.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test("development tokens go to the sandbox host; notifications use their own category", async () => {
    const { provider, sent } = setup();
    await provider.send({ token: "tok", environment: "development" }, notification());
    await provider.send({ token: "tok", environment: null }, notification());
    expect(sent[0]!.origin).toBe("https://api.sandbox.push.apple.com");
    expect(sent[1]!.origin).toBe("https://api.push.apple.com");
    const payload = JSON.parse(sent[0]!.body);
    expect(payload.aps.category).toBe("OYOBIDASHI_NOTIFICATION");
    expect(payload.aps["interruption-level"]).toBe("active");
    expect(payload.kind).toBe("notification");
    expect(sent[0]!.headers["apns-collapse-id"]).toBe("req_01JCNTF");
  });

  test("the provider token is an ES256 JWT whose signature verifies against the key", async () => {
    const { provider, sent, time } = setup();
    await provider.send(target, question());
    const jwt = decodeJwt(sent[0]!.headers.authorization!.slice("bearer ".length));
    expect(jwt.header).toEqual({ alg: "ES256", kid: "KEYID12345" });
    expect(jwt.claims).toEqual({ iss: "TEAMID6789", iat: Math.floor(time.now / 1000) });
    expect(jwt.signature).toHaveLength(64); // raw r||s, not DER
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecPublic, jwt.signature, jwt.signingInput)).toBe(true);
    const tampered = Buffer.from(jwt.signingInput.toString().replace(/.$/, "A"));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecPublic, jwt.signature, tampered)).toBe(false);
  });

  test("the provider token is cached and refreshed before it is an hour old", async () => {
    const { provider, sent, time } = setup();
    await provider.send(target, question());
    time.now += APNS_JWT_TTL_MS - 1;
    await Promise.all([provider.send(target, question()), provider.send(target, question())]);
    const tokens = sent.map((r) => r.headers.authorization);
    expect(new Set(tokens).size).toBe(1);

    time.now += 1;
    await provider.send(target, question());
    const fresh = sent[3]!.headers.authorization!;
    expect(fresh).not.toBe(tokens[0]);
    expect(APNS_JWT_TTL_MS).toBeLessThan(60 * 60 * 1000);
    expect(decodeJwt(fresh.slice(7)).claims.iat).toBe(Math.floor(time.now / 1000));
    await provider.send(target, question());
    expect(sent[4]!.headers.authorization).toBe(fresh);
  });

  test("concurrent first sends sign only one token", async () => {
    const { provider, sent } = setup();
    await Promise.all([1, 2, 3, 4].map(() => provider.send(target, question())));
    expect(new Set(sent.map((r) => r.headers.authorization)).size).toBe(1);
  });

  const dead: [string, ApnsTransportResponse][] = [
    ["410 Unregistered", { status: 410, body: '{"reason":"Unregistered","timestamp":1}' }],
    ["410 without a body", { status: 410, body: "" }],
    ["400 BadDeviceToken", { status: 400, body: '{"reason":"BadDeviceToken"}' }],
  ];
  for (const [name, response] of dead) {
    test(`${name} → unregistered`, async () => {
      const { provider } = setup(() => response);
      expect(await provider.send(target, question())).toMatchObject({ ok: false, unregistered: true });
    });
  }

  const alive: [string, ApnsTransportResponse][] = [
    ["400 BadTopic", { status: 400, body: '{"reason":"BadTopic"}' }],
    ["400 DeviceTokenNotForTopic", { status: 400, body: '{"reason":"DeviceTokenNotForTopic"}' }],
    ["403 InvalidProviderToken", { status: 403, body: '{"reason":"InvalidProviderToken"}' }],
    ["429 TooManyRequests", { status: 429, body: '{"reason":"TooManyRequests"}' }],
    ["500 with HTML", { status: 500, body: "<html>oops</html>" }],
    ["503", { status: 503, body: "" }],
  ];
  for (const [name, response] of alive) {
    test(`${name} → failure that keeps the token`, async () => {
      const { provider, sent } = setup(() => response);
      const res = await provider.send(target, question());
      expect(res).toMatchObject({ ok: false, unregistered: false });
      expect((res as { reason: string }).reason).toContain(String(response.status));
      expect(sent).toHaveLength(1);
    });
  }

  test("ExpiredProviderToken → signs a new token and retries once", async () => {
    const { provider, sent, time } = setup((_, n) =>
      n === 2 ? { status: 403, body: '{"reason":"ExpiredProviderToken"}' } : { status: 200, body: "" },
    );
    await provider.send(target, question());
    time.now += 5_000; // well inside the cache window, yet APNs says the token expired
    expect(await provider.send(target, question())).toEqual({ ok: true });
    expect(sent).toHaveLength(3);
    expect(sent[1]!.headers.authorization).toBe(sent[0]!.headers.authorization);
    expect(sent[2]!.headers.authorization).not.toBe(sent[1]!.headers.authorization);
  });

  test("a persistent ExpiredProviderToken does not loop", async () => {
    const { provider, sent } = setup(() => ({ status: 403, body: '{"reason":"ExpiredProviderToken"}' }));
    expect(await provider.send(target, question())).toMatchObject({ ok: false, unregistered: false });
    expect(sent).toHaveLength(2);
  });

  test("a transport error rejects (the dispatcher swallows it)", async () => {
    const { provider } = setup(() => {
      throw new Error("ECONNRESET");
    });
    await expect(provider.send(target, question())).rejects.toThrow("ECONNRESET");
  });

  test("an unusable key is reported by ready() and send()", async () => {
    const bad = createApnsProvider({
      keyPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      keyId: "k",
      teamId: "t",
      bundleId: "b",
      transport: async () => ({ status: 200, body: "" }),
    });
    await expect(bad.ready()).rejects.toThrow();
    await expect(bad.send(target, question())).rejects.toThrow();
  });
});

describe("APNs HTTP/2 transport (against a local h2c server)", () => {
  test("POSTs headers and body over HTTP/2, reuses the session, returns status and body", async () => {
    const seen: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
    let sessions = 0;
    const server = http2.createServer();
    server.on("session", () => sessions++);
    server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        seen.push({ headers, body: Buffer.concat(chunks).toString() });
        const dead = String(headers[":path"]).endsWith("/dead");
        stream.respond({ ":status": dead ? 410 : 200, "content-type": "application/json" });
        stream.end(dead ? '{"reason":"Unregistered"}' : "");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const transport = createHttp2ApnsTransport(2000);
    try {
      const origin = `http://127.0.0.1:${port}`;
      const body = JSON.stringify(fixture("apns_payload.json"));
      const ok = await transport({ origin, path: "/3/device/abc", headers: { "apns-topic": "me.oyobidashi.ios", "apns-push-type": "alert" }, body });
      expect(ok).toEqual({ status: 200, body: "" });
      const dead = await transport({ origin, path: "/3/device/dead", headers: {}, body });
      expect(dead).toEqual({ status: 410, body: '{"reason":"Unregistered"}' });
      expect(seen[0]!.headers[":method"]).toBe("POST");
      expect(seen[0]!.headers[":path"]).toBe("/3/device/abc");
      expect(seen[0]!.headers["apns-topic"]).toBe("me.oyobidashi.ios");
      expect(seen[0]!.headers["apns-push-type"]).toBe("alert");
      expect(JSON.parse(seen[0]!.body)).toEqual(fixture("apns_payload.json"));
      expect(sessions).toBe(1);
    } finally {
      transport.close();
      server.close();
    }
  });

  test("an unreachable host rejects instead of hanging", async () => {
    const transport = createHttp2ApnsTransport(1000);
    try {
      await expect(transport({ origin: "http://127.0.0.1:1", path: "/3/device/x", headers: {}, body: "{}" })).rejects.toThrow();
    } finally {
      transport.close();
    }
  });

  test("a server that never answers times out", async () => {
    const server = http2.createServer();
    server.on("stream", () => {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const transport = createHttp2ApnsTransport(100);
    try {
      await expect(transport({ origin: `http://127.0.0.1:${port}`, path: "/3/device/x", headers: {}, body: "{}" })).rejects.toThrow("timed out");
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      transport.close();
      server.close();
    }
  });
});

describe("FCM payload", () => {
  test("data equals the fixture and every value is a string", () => {
    const data = buildFcmData(question());
    expect(data).toEqual(fixture("fcm_data.json"));
    for (const v of Object.values(data)) expect(typeof v).toBe("string");
  });

  test("no choices → \"[]\"; notification and urgency are passed through", () => {
    expect(buildFcmData({ ...question(), choices: null, urgency: "high" })).toMatchObject({ choices: "[]", urgency: "high" });
    expect(buildFcmData(notification())).toEqual({
      request_id: "req_01JCNTF",
      kind: "notification",
      title: "codex からのお知らせ",
      body: "ビルドが完了しました",
      urgency: "normal",
      choices: "[]",
      priority:"normal",delivery_mode:"text",status:"notified",call:"null",
    });
  });

  test("the message is data-only with high android priority", () => {
    expect(buildFcmMessage("fcm-token", question())).toEqual({
      message: { token: "fcm-token", data: fixture("fcm_data.json"), android: { priority: "high", ttl:"0s",collapse_key:question().id } },
    });
  });
});

describe("FCM provider", () => {
  type Call = { url: string; init: RequestInit };
  function setup(send: (n: number) => Response = () => Response.json({ name: "projects/p/messages/1" }), oauth: (n: number) => Response = (n) => Response.json({ access_token: `access-${n}`, expires_in: 3600, token_type: "Bearer" })) {
    const oauthCalls: Call[] = [];
    const sendCalls: Call[] = [];
    const time = { now: Date.parse("2026-11-15T14:00:00.000Z") };
    const provider = createFcmProvider({
      serviceAccount: { client_email: "relay@proj.iam.gserviceaccount.com", private_key: rsaPem, project_id: "oyobidashi-proj", token_uri: "https://oauth2.googleapis.com/token" },
      now: () => time.now,
      fetch: async (url, init) => {
        if (url === "https://oauth2.googleapis.com/token") {
          oauthCalls.push({ url, init });
          return oauth(oauthCalls.length);
        }
        sendCalls.push({ url, init });
        return send(sendCalls.length);
      },
    });
    return { provider, oauthCalls, sendCalls, time };
  }
  const target: PushTarget = { token: "fcm-device-token", environment: null };
  const authOf = (c: Call) => (c.init.headers as Record<string, string>).authorization;

  test("sends a data-only HTTP v1 message with the fixture data", async () => {
    const { provider, sendCalls } = setup();
    expect(await provider.send(target, question())).toEqual({ ok: true });
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.url).toBe("https://fcm.googleapis.com/v1/projects/oyobidashi-proj/messages:send");
    expect(sendCalls[0]!.init.method).toBe("POST");
    expect(authOf(sendCalls[0]!)).toBe("Bearer access-1");
    const body = JSON.parse(sendCalls[0]!.init.body as string);
    expect(body).toEqual({ message: { token: "fcm-device-token", data: fixture("fcm_data.json"), android: { priority: "high", ttl:"0s",collapse_key:question().id } } });
    expect(body.message.notification).toBeUndefined();
  });

  test("the OAuth assertion is an RS256 JWT signed by the service account", async () => {
    const { provider, oauthCalls, time } = setup();
    await provider.send(target, question());
    expect(oauthCalls).toHaveLength(1);
    expect(oauthCalls[0]!.init.method).toBe("POST");
    expect((oauthCalls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(oauthCalls[0]!.init.body as string);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const jwt = decodeJwt(form.get("assertion")!);
    const iat = Math.floor(time.now / 1000);
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(jwt.claims).toEqual({
      iss: "relay@proj.iam.gserviceaccount.com",
      scope: FCM_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600,
    });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", rsaPublic, jwt.signature, jwt.signingInput)).toBe(true);
  });

  test("the access token is cached until shortly before it expires", async () => {
    const { provider, oauthCalls, sendCalls, time } = setup();
    await Promise.all([provider.send(target, question()), provider.send(target, question())]);
    time.now += 3600_000 - 60_001;
    await provider.send(target, question());
    expect(oauthCalls).toHaveLength(1);
    expect(sendCalls.map(authOf)).toEqual(["Bearer access-1", "Bearer access-1", "Bearer access-1"]);

    time.now += 1;
    await provider.send(target, question());
    expect(oauthCalls).toHaveLength(2);
    expect(authOf(sendCalls[3]!)).toBe("Bearer access-2");
  });

  const dead: [string, () => Response][] = [
    ["404 with UNREGISTERED detail", () => Response.json({ error: { code: 404, status: "NOT_FOUND", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } }, { status: 404 })],
    ["bare 404", () => new Response("not found", { status: 404 })],
    ["UNREGISTERED status with another code", () => Response.json({ error: { code: 400, status: "UNREGISTERED" } }, { status: 400 })],
    ["UNREGISTERED errorCode with 410", () => Response.json({ error: { code: 410, status: "GONE", details: [{ errorCode: "UNREGISTERED" }] } }, { status: 410 })],
  ];
  for (const [name, response] of dead) {
    test(`${name} → unregistered`, async () => {
      const { provider } = setup(response);
      expect(await provider.send(target, question())).toMatchObject({ ok: false, unregistered: true });
    });
  }

  const alive: [string, () => Response][] = [
    ["400 INVALID_ARGUMENT", () => Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", details: [{ errorCode: "INVALID_ARGUMENT" }] } }, { status: 400 })],
    ["403 SENDER_ID_MISMATCH", () => Response.json({ error: { code: 403, status: "PERMISSION_DENIED", details: [{ errorCode: "SENDER_ID_MISMATCH" }] } }, { status: 403 })],
    ["429 QUOTA_EXCEEDED", () => Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429 })],
    ["500 with HTML", () => new Response("<html>", { status: 500 })],
    ["503 UNAVAILABLE", () => Response.json({ error: { code: 503, status: "UNAVAILABLE" } }, { status: 503 })],
  ];
  for (const [name, response] of alive) {
    test(`${name} → failure that keeps the token`, async () => {
      const { provider } = setup(response);
      expect(await provider.send(target, question())).toMatchObject({ ok: false, unregistered: false });
    });
  }

  test("401 → fetches a new access token and retries once", async () => {
    const { provider, oauthCalls, sendCalls } = setup((n) => (n === 1 ? new Response("", { status: 401 }) : Response.json({})));
    expect(await provider.send(target, question())).toEqual({ ok: true });
    expect(oauthCalls).toHaveLength(2);
    expect(sendCalls.map(authOf)).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  test("a persistent 401 does not loop", async () => {
    const { provider, sendCalls } = setup(() => new Response("", { status: 401 }));
    expect(await provider.send(target, question())).toMatchObject({ ok: false, unregistered: false });
    expect(sendCalls).toHaveLength(2);
  });

  test("an OAuth failure rejects and is retried on the next send", async () => {
    const { provider, oauthCalls, sendCalls } = setup(undefined, (n) =>
      n === 1 ? new Response("denied", { status: 400 }) : n === 2 ? Response.json({ nope: true }) : Response.json({ access_token: "ok", expires_in: 3600 }),
    );
    await expect(provider.send(target, question())).rejects.toThrow("oauth");
    await new Promise((r) => setTimeout(r, 5));
    await expect(provider.send(target, question())).rejects.toThrow("access_token");
    await new Promise((r) => setTimeout(r, 5));
    expect(await provider.send(target, question())).toEqual({ ok: true });
    expect(oauthCalls).toHaveLength(3);
    expect(sendCalls).toHaveLength(1);
  });

  test("a network error rejects", async () => {
    const provider = createFcmProvider({
      serviceAccount: { client_email: "a@b", private_key: rsaPem, project_id: "p" },
      fetch: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    await expect(provider.send(target, question())).rejects.toThrow("ENOTFOUND");
  });

  test("parseServiceAccount validates the JSON", () => {
    const ok = parseServiceAccount(JSON.stringify({ type: "service_account", client_email: "a@b", private_key: "k", project_id: "p" }));
    expect(ok).toEqual({ client_email: "a@b", private_key: "k", project_id: "p", token_uri: undefined });
    expect(() => parseServiceAccount("{}")).toThrow("client_email");
    expect(() => parseServiceAccount(JSON.stringify({ client_email: "a@b", private_key: "k" }))).toThrow("project_id");
    expect(() => parseServiceAccount("not json")).toThrow();
  });
});

describe("push dispatch from POST /v1/requests", () => {
  class FakeProvider implements PushProvider {
    calls: { target: PushTarget; request: RequestObject }[] = [];
    constructor(private respond: (target: PushTarget) => PushResult | Promise<PushResult> = () => ({ ok: true })) {}
    send(target: PushTarget, request: RequestObject): Promise<PushResult> {
      this.calls.push({ target, request });
      return Promise.resolve(this.respond(target));
    }
  }

  test("pushes questions and notifications to every device with a token and a configured provider", async () => {
    const ios = new FakeProvider();
    const android = new FakeProvider();
    const h = makeHarness({ push: { ios, android } });
    await h.pair({ push_token: "ios-dev", push_environment: "development" });
    await h.pair({ push_token: "ios-prod" });
    await h.pair({ platform: "android", device_name: "Pixel", push_token: "fcm-1" });
    await h.pair({ device_name: "no token" });

    const q = await h.agent("POST", "/v1/requests", { question: "質問", choices: ["a"], urgency: "high", agent: { name: "claude-code" } });
    expect(q.status).toBe(201);
    expect(q.body.delivery).toEqual({ paired_devices: 4, websocket_delivered: 0, push_attempted: 3 });
    await h.app.idle();
    expect(ios.calls.map((c) => c.target)).toEqual([
      { token: "ios-dev", environment: "development" },
      { token: "ios-prod", environment: "production" },
    ]);
    expect(android.calls.map((c) => c.target)).toEqual([{ token: "fcm-1", environment: null }]);
    for (const c of [...ios.calls, ...android.calls]) expect(c.request).toEqual(q.body.request);

    const n = await h.agent("POST", "/v1/requests", { kind: "notification", question: "done" });
    expect(n.body.delivery.push_attempted).toBe(3);
    await h.app.idle();
    expect(ios.calls[2]!.request).toMatchObject({ kind: "notification", status: "notified" });
    expect(android.calls[1]!.request.kind).toBe("notification");
    expect(h.warnings).toEqual([]);
  });

  test("silent update push for answer / cancel / expiry", async () => {
    const ios = new FakeProvider();
    const h = makeHarness({ push: { ios } });
    const { token } = await h.pair({ push_token: "t" });
    const a = await h.ask();
    const b = await h.ask();
    const c = await h.ask({ expires_in_seconds: 10 });
    await h.json("POST", `/v1/requests/${a.id}/answer`, { token, body: { text: "ok" } });
    await h.agent("POST", `/v1/requests/${b.id}/cancel`);
    h.clock.advance(10_000);
    h.app.sweep();
    await h.app.idle();
    expect(ios.calls.map((x) => x.request.id)).toEqual([a.id,b.id,c.id,a.id,b.id,c.id]);
    expect(ios.calls.slice(3).map(x=>x.target.type)).toEqual(["update","update","update"]);
  });

  test("push is disabled without providers: WebSocket only", async () => {
    const h = makeHarness();
    await h.pair({ push_token: "ios-token" });
    await h.pair({ platform: "android", device_name: "Pixel", push_token: "fcm" });
    const res = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(res.status).toBe(201);
    expect(res.body.delivery).toEqual({ paired_devices: 2, websocket_delivered: 0, push_attempted: 0 });
  });

  test("only the configured platform is attempted", async () => {
    const ios = new FakeProvider();
    const h = makeHarness({ push: { ios } });
    await h.pair({ push_token: "ios-token" });
    await h.pair({ platform: "android", device_name: "Pixel", push_token: "fcm" });
    const res = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(res.body.delivery.push_attempted).toBe(1);
    await h.app.idle();
    expect(ios.calls).toHaveLength(1);
  });

  test("an unregistered token is cleared; the next request no longer pushes to it", async () => {
    const ios = new FakeProvider((t) => (t.token === "dead" ? { ok: false, unregistered: true, reason: "apns 410 Unregistered" } : { ok: true }));
    const h = makeHarness({ push: { ios } });
    const dead = await h.pair({ push_token: "dead" });
    const alive = await h.pair({ push_token: "alive" });
    const first = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(first.status).toBe(201);
    expect(first.body.delivery.push_attempted).toBe(2);
    await h.app.idle();
    expect(h.store.getDevice(dead.device.id)!.push_token).toBeNull();
    expect(h.store.getDevice(alive.device.id)!.push_token).toBe("alive");
    expect(h.store.listDevices()).toHaveLength(2); // the pairing itself stays
    expect((await h.json("GET", "/v1/requests", { token: dead.token })).status).toBe(200);

    const second = await h.agent("POST", "/v1/requests", { question: "q2" });
    expect(second.body.delivery.push_attempted).toBe(1);
  });

  test("a token replaced while the push was in flight is not cleared", async () => {
    let release!: (r: PushResult) => void;
    const ios = new FakeProvider(() => new Promise<PushResult>((r) => (release = r)));
    const h = makeHarness({ push: { ios } });
    const { token, device } = await h.pair({ push_token: "old" });
    await h.agent("POST", "/v1/requests", { question: "q" });
    await h.json("PUT", "/v1/devices/me", { token, body: { push_token: "new" } });
    release({ ok: false, unregistered: true, reason: "apns 410" });
    await h.app.idle();
    expect(h.store.getDevice(device.id)!.push_token).toBe("new");
  });

  const failures: [string, () => PushProvider][] = [
    ["provider reports an error", () => new FakeProvider(() => ({ ok: false, unregistered: false, reason: "apns 500" }))],
    ["provider rejects", () => new FakeProvider(() => Promise.reject(new Error("ECONNRESET")))],
    ["provider throws synchronously", () => ({ send: () => { throw new Error("boom"); } })],
    ["provider never answers (timeout)", () => new FakeProvider(() => new Promise<PushResult>(() => {}))],
  ];
  for (const [name, make] of failures) {
    test(`${name}: creation still succeeds and the token is kept`, async () => {
      const h = makeHarness({ push: { ios: make(), android: make() }, pushTimeoutMs: 30 });
      const a = await h.pair({ push_token: "ios-token" });
      const b = await h.pair({ platform: "android", device_name: "Pixel", push_token: "fcm" });
      const res = await h.agent("POST", "/v1/requests", { question: "q" });
      expect(res.status).toBe(201);
      expect(res.body.request.status).toBe("pending");
      expect(res.body.delivery).toEqual({ paired_devices: 2, websocket_delivered: 0, push_attempted: 2 });
      await h.app.idle();
      expect(h.store.getDevice(a.device.id)!.push_token).toBe("ios-token");
      expect(h.store.getDevice(b.device.id)!.push_token).toBe("fcm");
      expect(h.warnings).toHaveLength(2);
      expect(h.warnings.join("\n")).toContain("push:");
      // the relay keeps working
      expect((await h.agent("GET", `/v1/requests/${res.body.request.id}`)).status).toBe(200);
    });
  }

  test("creation responds without waiting for a slow push", async () => {
    let release!: (r: PushResult) => void;
    const ios = new FakeProvider(() => new Promise<PushResult>((r) => (release = r)));
    const h = makeHarness({ push: { ios } });
    await h.pair({ push_token: "t" });
    const res = await h.agent("POST", "/v1/requests", { question: "q" });
    expect(res.status).toBe(201);
    expect(ios.calls).toHaveLength(1);
    release({ ok: true });
    await h.app.idle();
  });

  test("end to end with the real APNs / FCM providers on fake transports", async () => {
    const apnsSent: ApnsTransportRequest[] = [];
    const fcmSent: any[] = [];
    const ios = createApnsProvider({
      keyPem: ecPem,
      keyId: "K",
      teamId: "T",
      bundleId: "me.oyobidashi.ios",
      transport: async (req) => {
        apnsSent.push(req);
        return req.path.endsWith("/gone") ? { status: 410, body: '{"reason":"Unregistered"}' } : req.path.endsWith("/bad") ? { status: 400, body: '{"reason":"BadDeviceToken"}' } : { status: 200, body: "" };
      },
    });
    const android = createFcmProvider({
      serviceAccount: { client_email: "a@b", private_key: rsaPem, project_id: "p" },
      fetch: async (url, init) => {
        if (url.includes("oauth2")) return Response.json({ access_token: "at", expires_in: 3600 });
        const body = JSON.parse(init.body as string);
        fcmSent.push(body);
        return body.message.token === "fcm-gone"
          ? Response.json({ error: { code: 404, status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 })
          : Response.json({});
      },
    });
    const h = makeHarness({ push: { ios, android } });
    const ok = await h.pair({ push_token: "ok" });
    const gone = await h.pair({ push_token: "gone" });
    const bad = await h.pair({ push_token: "bad" });
    const fcmOk = await h.pair({ platform: "android", device_name: "Pixel", push_token: "fcm-ok" });
    const fcmGone = await h.pair({ platform: "android", device_name: "Old Pixel", push_token: "fcm-gone" });

    const res = await h.agent("POST", "/v1/requests", fixtureQuestionBody());
    expect(res.status).toBe(201);
    expect(res.body.delivery.push_attempted).toBe(5);
    await h.app.idle();

    const expectedApns = buildApnsPayload(res.body.request);
    for (const req of apnsSent) {
      expect(JSON.parse(req.body)).toEqual(expectedApns);
      expect(req.headers["apns-collapse-id"]).toBe(res.body.request.id);
    }
    expect(apnsSent.map((r) => r.path).sort()).toEqual(["/3/device/bad", "/3/device/gone", "/3/device/ok"]);
    for (const body of fcmSent) {
      expect(body.message.data).toEqual(buildFcmData(res.body.request));
    }
    expect(h.store.getDevice(ok.device.id)!.push_token).toBe("ok");
    expect(h.store.getDevice(gone.device.id)!.push_token).toBeNull();
    expect(h.store.getDevice(bad.device.id)!.push_token).toBeNull();
    expect(h.store.getDevice(fcmOk.device.id)!.push_token).toBe("fcm-ok");
    expect(h.store.getDevice(fcmGone.device.id)!.push_token).toBeNull();
  });
});

function fixtureQuestionBody() {
  const r = fixture<RequestObject>("request_pending.json");
  return { question: r.question, context: r.context, choices: r.choices, urgency: r.urgency, agent: r.agent };
}

describe("createPushFromConfig", () => {
  const base = { port: 8787, agent_token: "ka_x" };
  const neverTransport = async () => ({ status: 200, body: "" });

  test("no credentials → push disabled", async () => {
    const setup = await createPushFromConfig(base);
    expect(setup.providers).toEqual({});
    expect(setup.warnings).toEqual([]);
    setup.close();
  });

  test("APNs credentials → ios provider using the .p8 key and bundle id", async () => {
    const keyPath = join(dir, "AuthKey_TEST.p8");
    writeFileSync(keyPath, ecPem);
    const sent: ApnsTransportRequest[] = [];
    const setup = await createPushFromConfig(
      { ...base, apns: { key_path: keyPath, key_id: "KID", team_id: "TID", bundle_id: "com.example.other" } },
      { apnsTransport: async (req) => (sent.push(req), { status: 200, body: "" }) },
    );
    expect(setup.warnings).toEqual([]);
    expect(setup.providers.android).toBeUndefined();
    await setup.providers.ios!.send({ token: "t", environment: "production" }, question());
    expect(sent[0]!.headers["apns-topic"]).toBe("com.example.other");
    const jwt = decodeJwt(sent[0]!.headers.authorization!.slice(7));
    expect(jwt.header.kid).toBe("KID");
    expect(jwt.claims.iss).toBe("TID");
  });

  test("bundle_id defaults to the app id", async () => {
    const keyPath = join(dir, "AuthKey_DEFAULT.p8");
    writeFileSync(keyPath, ecPem);
    const sent: ApnsTransportRequest[] = [];
    const setup = await createPushFromConfig(
      { ...base, apns: { key_path: keyPath, key_id: "KID", team_id: "TID" } },
      { apnsTransport: async (req) => (sent.push(req), { status: 200, body: "" }) },
    );
    await setup.providers.ios!.send({ token: "t", environment: null }, question());
    expect(sent[0]!.headers["apns-topic"]).toBe("me.oyobidashi.ios");
  });

  test("FCM credentials → android provider", async () => {
    const saPath = join(dir, "service-account.json");
    writeFileSync(saPath, JSON.stringify({ type: "service_account", client_email: "a@b", private_key: rsaPem, project_id: "proj-x" }));
    const urls: string[] = [];
    const setup = await createPushFromConfig(
      { ...base, fcm: { service_account_path: saPath } },
      { fetch: async (url) => (urls.push(url), Response.json({ access_token: "at", expires_in: 3600 })) },
    );
    expect(setup.warnings).toEqual([]);
    expect(setup.providers.ios).toBeUndefined();
    await setup.providers.android!.send({ token: "t", environment: null }, question());
    expect(urls).toEqual(["https://oauth2.googleapis.com/token", "https://fcm.googleapis.com/v1/projects/proj-x/messages:send"]);
  });

  test("broken credentials disable that provider with a warning instead of crashing", async () => {
    const garbageKey = join(dir, "garbage.p8");
    writeFileSync(garbageKey, "this is not a key");
    const garbageSa = join(dir, "garbage.json");
    writeFileSync(garbageSa, JSON.stringify({ client_email: "a@b", private_key: "nope", project_id: "p" }));
    const cases = [
      { apns: { key_path: join(dir, "missing.p8"), key_id: "K", team_id: "T" } },
      { apns: { key_path: garbageKey, key_id: "K", team_id: "T" } },
      { apns: { key_path: "", key_id: "K", team_id: "T" } },
      { apns: { key_path: garbageKey, key_id: "", team_id: "T" } },
      { fcm: { service_account_path: join(dir, "missing.json") } },
      { fcm: { service_account_path: garbageSa } },
      { fcm: { service_account_path: garbageKey } },
      { fcm: { service_account_path: "" } },
    ];
    for (const extra of cases) {
      const setup = await createPushFromConfig({ ...base, ...extra }, { apnsTransport: neverTransport });
      expect(setup.providers).toEqual({});
      expect(setup.warnings).toHaveLength(1);
      expect(setup.warnings[0]).toMatch(/^(APNs|FCM) disabled: /);
    }
  });
});

describe("v0.2 mobile push contract",()=>{
 test("Unicode-heavy payloads stay below provider's 4KB limit",()=>{
  const request={...question(),question:"😀".repeat(4000),context:"説".repeat(8000),choices:Array(8).fill("選".repeat(200)),agent:{name:"😀".repeat(100),cwd:null}};
  expect(Buffer.byteLength(JSON.stringify(buildApnsPayload(request)),"utf8")).toBeLessThan(4096);
  expect(Buffer.byteLength(JSON.stringify(buildFcmData(request)),"utf8")).toBeLessThan(4096);
 });
 test("VoIP invitations and silent updates have separate APNs types/topics",async()=>{
  const sent:ApnsTransportRequest[]=[];
  const provider=createApnsProvider({keyPem:ecPem,keyId:"KEY",teamId:"TEAM",bundleId:"me.oyobidashi.ios",transport:async req=>{sent.push(req);return {status:200,body:""};}});
  const request={...question(),subject:"本番デプロイの承認",call:{id:crypto.randomUUID(),request_id:question().id,state:"ringing" as const,outcome:null,device_id:null,started_at:question().created_at,updated_at:question().updated_at,transcript:[]}};
  await provider.send({token:"voice",environment:"development",type:"voip"},request);
  await provider.send({token:"ordinary",environment:"development",type:"update"},{...request,status:"cancelled"});
  expect(sent[0]!.headers).toMatchObject({"apns-topic":"me.oyobidashi.ios.voip","apns-push-type":"voip","apns-expiration":"0"});
  expect(JSON.parse(sent[0]!.body).call_id).toBe(request.call.id);
  expect(JSON.parse(sent[0]!.body)).toMatchObject({subject:request.subject,agent_name:request.agent!.name});
  expect(sent[1]!.headers).toMatchObject({"apns-topic":"me.oyobidashi.ios","apns-push-type":"background","apns-priority":"5"});
  expect(JSON.parse(sent[1]!.body).aps.alert).toBeUndefined();
  expect(JSON.parse(sent[1]!.body).subject).toBeUndefined();
 });
});
