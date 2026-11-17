import { beforeAll, describe, expect, test } from "bun:test";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { createAccountAuth, type AccountAuth } from "../src/account-auth.ts";
import { CloudApp } from "../src/app.ts";
import { harness } from "./helpers.ts";
import {
  decodeAuthFragment,
  parseAuthHandoff,
} from "../../relay/src/auth-handoff.ts";

let privatePem: string;
let publicKey: CryptoKey;
const project = "test-project";
const email = `signer@${project}.iam.gserviceaccount.com`;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privatePem = await exportPKCS8(pair.privateKey);
  publicKey = pair.publicKey;
});
const env = (overrides: Record<string, string | undefined> = {}) => ({
  FIREBASE_WEB_API_KEY: "public-test-key",
  FIREBASE_PROJECT_ID: project,
  FIREBASE_AUTH_PROVIDERS: "google,apple,github",
  FIREBASE_AUTH_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: "service_account",
    project_id: project,
    client_email: email,
    private_key: privatePem,
  }),
  ...overrides,
});

describe("account-link signing and public configuration", () => {
  test("signs only the verified UID and limits the bootstrap lifetime", async () => {
    const now = Date.now();
    const auth = (await createAccountAuth(env(), () => now))!;
    const token = await auth.issueLinkToken("alice");
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: email,
      subject: email,
      audience:
        "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      algorithms: ["RS256"],
    });
    expect(payload.uid).toBe("alice");
    expect(payload.exp! - payload.iat!).toBe(300);
    const serialized = JSON.stringify(auth.publicConfig);
    expect(serialized).not.toContain("private_key");
    expect(serialized).not.toContain(email);
    expect(auth.publicConfig).toEqual({
      firebase: {
        apiKey: "public-test-key",
        projectId: project,
        authDomain: `${project}.firebaseapp.com`,
      },
      providers: ["google", "apple", "github"],
      canLinkExisting: true,
    });
  });
  test("missing signer allows recovery sign-in but cannot mint another session", async () => {
    const auth = (await createAccountAuth(
      env({ FIREBASE_AUTH_SERVICE_ACCOUNT_JSON: "" }),
    ))!;
    expect(auth.publicConfig.canLinkExisting).toBe(false);
    await expect(auth.issueLinkToken("alice")).rejects.toThrow("unavailable");
    expect(await createAccountAuth({})).toBeUndefined();
  });
  test.each(["", "a".repeat(129), "alice\nbob"])(
    "rejects invalid UID %s",
    async (uid) => {
      const auth = (await createAccountAuth(env()))!;
      await expect(auth.issueLinkToken(uid)).rejects.toThrow(
        "Invalid account identifier",
      );
    },
  );
  test("mismatched project, malformed signer and unsupported provider fail without exposing configuration", async () => {
    for (const change of [
      { FIREBASE_AUTH_SERVICE_ACCOUNT_JSON: "SECRET_MALFORMED" },
      {
        FIREBASE_AUTH_SERVICE_ACCOUNT_JSON: JSON.stringify({
          type: "service_account",
          project_id: "other-project",
          client_email: email,
          private_key: privatePem,
        }),
      },
      { FIREBASE_AUTH_PROVIDERS: "password" },
    ]) {
      const error = await createAccountAuth(env(change)).then(
        () => null,
        (error) => error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("SECRET");
      expect(String(error)).not.toContain("PRIVATE KEY");
    }
  });
});

describe("account-link HTTP authorization", () => {
  function setup() {
    const h = harness(),
      minted: string[] = [];
    const accountAuth: AccountAuth = {
      publicConfig: {
        firebase: {
          apiKey: "public-test-key",
          projectId: project,
          authDomain: `${project}.firebaseapp.com`,
        },
        providers: ["google"],
        canLinkExisting: true,
      },
      issueLinkToken: async (uid) => {
        minted.push(uid);
        return "test.custom.token";
      },
    };
    const app = new CloudApp(
      h.service,
      h.app.verifier,
      10000,
      accountAuth,
      async () => "// bundled Firebase auth UI",
    );
    const call = async (
      path: string,
      token: string | null = "agent-alice",
      body?: unknown,
    ) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: token ? { authorization: `Bearer ${token}` } : {},
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      ) as Promise<Response>;
    return { h, app, accountAuth, minted, call };
  }
  test("public page/config has no signer and limits callback forms to loopback", async () => {
    const s = setup(),
      config = await s.call("/v1/auth/config", null);
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual(s.accountAuth.publicConfig);
    const page = await s.call("/auth?token=DO_NOT_ECHO", null);
    expect(page.headers.get("referrer-policy")).toBe("origin");
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action http://127.0.0.1:*",
    );
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).not.toContain("DO_NOT_ECHO");
    expect(html).not.toContain("private_key");
  });
  test("unauthenticated callers and paired devices cannot mint agent credentials", async () => {
    const s = setup(),
      phone = await s.h.pair();
    expect((await s.call("/v1/auth/link-token", null, {})).status).toBe(401);
    expect(
      (await s.call("/v1/auth/link-token", phone.device_token, {})).status,
    ).toBe(403);
    expect(s.minted).toEqual([]);
  });
  test("caller-supplied UID is rejected and the authenticated owner is retained", async () => {
    const s = setup();
    expect(
      (await s.call("/v1/auth/link-token", "agent-alice", { uid: "bob" }))
        .status,
    ).toBe(400);
    expect(
      (await s.call("/v1/auth/link-token", "agent-alice", {})).status,
    ).toBe(200);
    expect(s.minted).toEqual(["alice"]);
  });
  test("link bootstrap is rate-limited per owner while other users remain available", async () => {
    const s = setup();
    for (let i = 0; i < 10; i++)
      expect(
        (await s.call("/v1/auth/link-token", "agent-alice", {})).status,
      ).toBe(200);
    expect(
      (await s.call("/v1/auth/link-token", "agent-alice", {})).status,
    ).toBe(429);
    expect((await s.call("/v1/auth/link-token", "agent-bob", {})).status).toBe(
      200,
    );
    expect(s.minted).toHaveLength(11);
  });
  test("signer failures and disabled linking return safe retryable errors", async () => {
    const s = setup();
    s.accountAuth.issueLinkToken = async () => {
      throw new Error("SECRET_SIGNER_DETAILS");
    };
    const r = await s.call("/v1/auth/link-token", "agent-alice", {});
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("SECRET");
    s.accountAuth.publicConfig.canLinkExisting = false;
    expect(
      (await s.call("/v1/auth/link-token", "agent-alice", {})).status,
    ).toBe(503);
  });
});

describe("browser handoff validation", () => {
  const handoff = {
    version: 1,
    mode: "signin",
    callbackUrl: "http://127.0.0.1:54321/callback",
    state: "x".repeat(43),
  } as const;
  test("accepts a bounded loopback handoff, including UTF-8 UID when linking", () => {
    expect(parseAuthHandoff(handoff)).toEqual(handoff);
    const linked = {
      ...handoff,
      mode: "link",
      uid: "利用者",
      customToken: "header.payload.signature",
      provider: "google",
    } as const;
    expect(
      decodeAuthFragment(
        Buffer.from(JSON.stringify(linked)).toString("base64url"),
      ),
    ).toEqual(linked);
  });
  test.each([
    "https://attacker.example/callback",
    "http://localhost:1234/callback",
    "http://127.0.0.1.evil.test:1234/callback",
    "http://127.0.0.1:1234/callback?next=evil",
    "http://user:pass@127.0.0.1:1234/callback",
    "http://127.0.0.1:1234/other",
  ])("rejects unsafe callback %s", (callbackUrl) => {
    expect(() => parseAuthHandoff({ ...handoff, callbackUrl })).toThrow(
      "invalid authentication",
    );
  });
  test.each(
    [
      null,
      [],
      {},
      { ...handoff, state: "short" },
      { ...handoff, provider: "unknown" },
      { ...handoff, mode: "link" },
      { ...handoff, uid: "unexpected" },
    ].map((value) => [value]),
  )("rejects malformed handoff without echoing it", (value) => {
    expect(() => parseAuthHandoff(value)).toThrow("invalid authentication");
  });
});
