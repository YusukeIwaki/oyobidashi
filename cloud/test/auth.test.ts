import { beforeAll, describe, expect, test } from "bun:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import { authenticate, firebaseVerifier, requireRole } from "../src/auth.ts";
import { CloudError } from "../src/errors.ts";
import { hash } from "../src/service.ts";
import { MemoryDatabase } from "./memory.ts";

const project = "test-project";
const epoch = 1_800_000_000;
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let keys: JWTVerifyGetKey;
beforeAll(async () => {
  const first = await generateKeyPair("RS256", { modulusLength: 2048 });
  const second = await generateKeyPair("RS256", { modulusLength: 2048 });
  signingKey = first.privateKey;
  otherKey = second.privateKey;
  keys = createLocalJWKSet({
    keys: [
      {
        ...(await exportJWK(first.publicKey)),
        kid: "test-signing",
        alg: "RS256",
        use: "sig",
      },
    ],
  });
});
async function token(
  overrides: Record<string, unknown> = {},
  omit: string[] = [],
  key = signingKey,
  header: Record<string, unknown> = {},
) {
  const claims: Record<string, unknown> = {
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    sub: "alice",
    iat: epoch - 5,
    exp: epoch + 3600,
    auth_time: epoch - 60,
    ...overrides,
  };
  for (const name of omit) delete claims[name];
  return new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: "RS256", kid: "test-signing", ...header })
    .sign(key);
}
async function denied(promise: Promise<unknown>, status = 401) {
  try {
    await promise;
    throw new Error("expected authentication rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CloudError);
    expect((error as CloudError).status).toBe(status);
    return error as CloudError;
  }
}

describe("Firebase JWT verification", () => {
  test("signed Firebase profile claims never escape the UID-only verifier", async () => {
    expect(
      await firebaseVerifier(project, keys, () => epoch * 1000).verify(
        await token({
          email: "synthetic-account@example.invalid",
          email_verified: true,
          name: "Synthetic display name",
          picture: "https://example.invalid/avatar.png",
          firebase: {
            sign_in_provider: "google.com",
            identities: {
              email: ["synthetic-account@example.invalid"],
              "google.com": ["synthetic-google-identity"],
              "apple.com": ["synthetic-apple-identity"],
              "github.com": ["synthetic-github-identity"],
            },
          },
        }),
      ),
    ).toBe("alice");
  });
  test.each(["", "bad", "has.dot", "a.b.c", "Bearer token"])(
    "malformed credentials reject with 401: %s",
    async (value) => {
      const error = await denied(
        firebaseVerifier(project, keys, () => epoch * 1000).verify(value),
      );
      expect(error.code).toBe("unauthorized");
    },
  );
  test("a token signed by a different key is rejected", async () => {
    await denied(
      firebaseVerifier(project, keys, () => epoch * 1000).verify(
        await token({}, [], otherKey),
      ),
    );
  });
  test("unknown key IDs and disallowed algorithms are rejected", async () => {
    await denied(
      firebaseVerifier(project, keys, () => epoch * 1000).verify(
        await token({}, [], signingKey, { kid: "unknown" }),
      ),
    );
    const hmac = await new SignJWT({ sub: "alice" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new Uint8Array(32));
    await denied(
      firebaseVerifier(project, keys, () => epoch * 1000).verify(hmac),
    );
  });
  test.each([
    { aud: "other-project" },
    { iss: "https://securetoken.google.com/other-project" },
    { iss: "https://attacker.example" },
    { exp: epoch },
    { exp: epoch - 1 },
    { iat: epoch + 1 },
    { auth_time: epoch + 1 },
    { auth_time: "yesterday" },
    { sub: "" },
    { sub: "x".repeat(129) },
    { nbf: epoch + 1 },
  ])("invalid claims reject: %p", async (claims) => {
    await denied(
      firebaseVerifier(project, keys, () => epoch * 1000).verify(
        await token(claims),
      ),
    );
  });
  test.each(["auth_time", "sub", "exp", "iat", "iss", "aud"])(
    "required claim %s must be present",
    async (claim) => {
      await denied(
        firebaseVerifier(project, keys, () => epoch * 1000).verify(
          await token({}, [claim]),
        ),
      );
    },
  );
  test("subject must be a string, even when an otherwise valid JWT is signed", async () => {
    for (const subject of [123, { uid: "alice" }, ["alice"]])
      await denied(
        firebaseVerifier(project, keys, () => epoch * 1000).verify(
          await token({ sub: subject }),
        ),
      );
  });
  test("Firebase audience must be the project ID string, rather than a generic JWT audience list", async () => {
    await denied(
      firebaseVerifier(project, keys, () => epoch * 1000).verify(
        await token({ aud: [project, "other-project"] }),
      ),
    );
  });
  test("a JWKS/network failure returns 503 with no provider error or token data", async () => {
    const verifier = firebaseVerifier(
      project,
      async () => {
        throw new Error("SECRET_JWKS_NETWORK_DETAILS");
      },
      () => epoch * 1000,
    );
    const error = await denied(verifier.verify(await token()), 503);
    expect(error.message).not.toContain("SECRET");
    expect(error.code).toBe("temporarily_unavailable");
  });
  test("oversized tokens are rejected before key resolution", async () => {
    let lookups = 0;
    const verifier = firebaseVerifier(
      project,
      async (...args) => {
        lookups++;
        return keys(...args);
      },
      () => epoch * 1000,
    );
    await denied(verifier.verify("x".repeat(8193)));
    expect(lookups).toBe(0);
  });
  test("verified-token cache lasts at most a minute and never outlives JWT expiry", async () => {
    let now = epoch * 1000,
      lookups = 0;
    const verifier = firebaseVerifier(
      project,
      async (...args) => {
        lookups++;
        return keys(...args);
      },
      () => now,
    );
    const valid = await token();
    expect(await verifier.verify(valid)).toBe("alice");
    now += 59_999;
    expect(await verifier.verify(valid)).toBe("alice");
    expect(lookups).toBe(1);
    now += 1;
    expect(await verifier.verify(valid)).toBe("alice");
    expect(lookups).toBe(2);
    const soon = await token({ exp: epoch + 70 });
    expect(await verifier.verify(soon)).toBe("alice");
    now = (epoch + 70) * 1000;
    await denied(verifier.verify(soon));
    expect(lookups).toBe(4);
  });
  test("cache keys distinguish principals and changed JWT contents", async () => {
    const verifier = firebaseVerifier(project, keys, () => epoch * 1000);
    expect(await verifier.verify(await token())).toBe("alice");
    expect(await verifier.verify(await token({ sub: "bob" }))).toBe("bob");
    await denied(verifier.verify(await token({ sub: "bob", aud: "wrong" })));
  });
  test.each([
    "",
    "bad project",
    "UPPERCASE",
    "x",
    "https://example.com",
    "a".repeat(65),
  ])(
    "invalid project configuration fails before authentication: %s",
    (value) => {
      expect(() => firebaseVerifier(value, keys)).toThrow();
    },
  );
});

describe("principal binding", () => {
  test("agent UID comes from the verifier and never client input", async () => {
    const db = new MemoryDatabase();
    const req = new Request("https://relay.example/v1/requests?uid=mallory", {
      headers: { authorization: "bearer signed-token", "x-user-id": "mallory" },
    });
    expect(
      await authenticate(req, db, {
        verify: async (value) => {
          expect(value).toBe("signed-token");
          return "alice";
        },
      }),
    ).toEqual({ uid: "alice", role: "agent" });
  });
  test.each([undefined, "", "Basic abc", "Bearer", "Bearer abc extra"])(
    "malformed authorization is rejected without consulting the verifier: %p",
    async (header) => {
      let called = false;
      await denied(
        authenticate(
          new Request("https://relay.example", {
            headers: header === undefined ? {} : { authorization: header },
          }),
          new MemoryDatabase(),
          {
            verify: async () => {
              called = true;
              return "alice";
            },
          },
        ),
      );
      expect(called).toBe(false);
    },
  );
  test("a token in the URL is not authentication", async () => {
    await denied(
      authenticate(
        new Request("https://relay.example?token=SECRET"),
        new MemoryDatabase(),
        { verify: async () => "alice" },
      ),
    );
  });
  test("device principal is bound to the persisted owner and a revoked token is rejected", async () => {
    const db = new MemoryDatabase();
    const bearer = "kd_test-device";
    const tokenHash = hash(bearer);
    await db.transaction("alice", (tx) =>
      tx.put("device", "device-1", {
        id: "device-1",
        name: "phone",
        platform: "ios",
        created_at: new Date(epoch * 1000).toISOString(),
        tokenHash,
        push_token: null,
        voip_token: null,
        push_environment: "production",
        lastSeen: epoch * 1000,
      }),
    );
    const req = new Request("https://relay.example", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    const principal = await authenticate(req, db, {
      verify: async () => {
        throw new Error("device must not use Firebase");
      },
    });
    expect(principal).toEqual({
      uid: "alice",
      role: "device",
      deviceId: "device-1",
      tokenHash,
    });
    await db.transaction("alice", (tx) => tx.remove("device", "device-1"));
    await denied(authenticate(req, db, { verify: async () => "wrong" }));
  });
  test("role checks distinguish authenticated agent and device credentials", () => {
    expect(() =>
      requireRole({ uid: "alice", role: "agent" }, "agent"),
    ).not.toThrow();
    expect(() =>
      requireRole({ uid: "alice", role: "agent" }, "device"),
    ).toThrow(CloudError);
    expect(() =>
      requireRole(
        {
          uid: "alice",
          role: "device",
          deviceId: "device-1",
          tokenHash: "hash",
        },
        "agent",
      ),
    ).toThrow(CloudError);
  });
});

describe("MCP cloud wire compatibility", () => {
  test("MCP client recovers a lost create response with one durable question and can read the final answer", async () => {
    const { RelayClient } = await import("../../mcp/src/relay-client.ts");
    const { harness } = await import("./helpers.ts");
    const h = harness();
    const device = await h.pair("alice");
    let creates = 0;
    const keys: string[] = [];
    const client = new RelayClient({
      baseUrl: "https://relay.example",
      agentToken: "",
      tokenProvider: async () => "agent-alice",
      fetch: async (url, init) => {
        const req = new Request(url, init);
        const response = (await h.app.fetch(req))!;
        if (
          req.method === "POST" &&
          new URL(req.url).pathname === "/v1/requests"
        ) {
          creates++;
          keys.push(req.headers.get("idempotency-key")!);
          if (creates === 1)
            throw new TypeError("injected response loss after commit");
        }
        return response;
      },
    });
    try {
      const created = await client.createRequest({
        kind: "question",
        question: "進めますか？",
        choices: ["はい", "あとで"],
        priority: "normal",
        deliveryMode: "actions",
      });
      expect(creates).toBe(2);
      expect(keys[0]).toBe(keys[1]);
      expect(created.request.status).toBe("pending");
      expect(created.delivery?.paired_devices).toBe(1);
      expect(
        await h.db.transaction("alice", (tx) => tx.list("request")),
      ).toHaveLength(1);
      expect((await client.getPresence()).devices).toHaveLength(1);
      expect(
        (await client.getRequest(created.request.id, { waitSeconds: 0 }))
          .status,
      ).toBe("pending");
      const answer = await h.call(
        "POST",
        `/v1/requests/${created.request.id}/answer`,
        device.device_token,
        { text: "はい", input_method: "choice", choice_index: 0 },
      );
      expect(answer.status).toBe(200);
      expect((await client.getRequest(created.request.id)).answer?.text).toBe(
        "はい",
      );
    } finally {
      h.app.close();
      await h.db.close();
    }
  });
  test("MCP credentials only expose the caller's device presence and own request IDs", async () => {
    const { RelayClient } = await import("../../mcp/src/relay-client.ts");
    const { harness } = await import("./helpers.ts");
    const h = harness();
    await h.pair("alice");
    await h.pair("bob");
    const client = (uid: string) =>
      new RelayClient({
        baseUrl: "https://relay.example",
        agentToken: "",
        tokenProvider: async () => `agent-${uid}`,
        fetch: async (url, init) =>
          (await h.app.fetch(new Request(url, init)))!,
      });
    try {
      const alice = client("alice"),
        bob = client("bob");
      const created = await alice.createRequest({
        kind: "question",
        question: "test",
      });
      expect((await alice.getPresence()).devices).toHaveLength(1);
      expect((await bob.getPresence()).devices).toHaveLength(1);
      await expect(bob.getRequest(created.request.id)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
      expect((await alice.cancelRequest(created.request.id)).status).toBe(
        "cancelled",
      );
    } finally {
      h.app.close();
      await h.db.close();
    }
  });
});
