import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authServerJson,
  startBrowserLogin,
  type BrowserLoginSession,
} from "../src/browser-login.ts";
import { decodeAuthFragment } from "../../relay/src/auth-handoff.ts";
import {
  CloudAuthError,
  readCloudCredentials,
  saveCloudCredentials,
  type CloudCredentials,
} from "../src/cloud-auth.ts";
import { finishCloudLogin, parseLoginArguments } from "../src/login.ts";

const sessions: BrowserLoginSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop();
});
const token = (uid = "alice", project = "test-project") =>
  `header.${Buffer.from(JSON.stringify({ sub: uid, aud: project, iss: `https://securetoken.google.com/${project}` })).toString("base64url")}.signature`;
const identity = { uid: "alice", providers: ["google.com"], anonymous: false };
function session(
  options: Partial<Parameters<typeof startBrowserLogin>[0]> = {},
) {
  const value = startBrowserLogin({
    baseUrl: "https://relay.example",
    apiKey: "public-test",
    projectId: "test-project",
    mode: "signin",
    provider: "google",
    timeoutMs: 1000,
    inspect: async () => identity,
    ...options,
  });
  sessions.push(value);
  return value;
}
function form(s: BrowserLoginSession, overrides: Record<string, string> = {}) {
  const handoff = decodeAuthFragment(new URL(s.url).hash);
  return {
    url: handoff.callbackUrl,
    params: new URLSearchParams({
      state: handoff.state,
      id_token: token(),
      refresh_token: "secret-test-refresh",
      expires_at: String(Date.now() + 3600_000),
      ...overrides,
    }),
  };
}
async function submit(
  s: BrowserLoginSession,
  override: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  const f = form(s, override);
  return fetch(f.url, {
    method: "POST",
    headers: { origin: "https://relay.example", ...headers },
    body: f.params,
  });
}

describe("one-use loopback browser callback", () => {
  test("credentials are passed in the POST body, verified and never returned in the HTML", async () => {
    const s = session(),
      h = decodeAuthFragment(new URL(s.url).hash);
    expect(new URL(h.callbackUrl).hostname).toBe("127.0.0.1");
    const response = await submit(s);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).not.toContain("secret-test-refresh");
    expect(html).not.toContain(token());
    const credentials = await s.result;
    expect(credentials.idToken).toBe(token());
    expect(credentials.refreshToken).toBe("secret-test-refresh");
  });
  test("wrong origin, host, state and GET callback never invoke Firebase", async () => {
    let checks = 0;
    const s = session({
        inspect: async () => {
          checks++;
          return identity;
        },
      }),
      f = form(s);
    expect(
      (await submit(s, {}, { origin: "https://attacker.example" })).status,
    ).toBe(403);
    expect((await submit(s, {}, { origin: "null" })).status).toBe(403);
    expect((await submit(s, {}, { host: "attacker.example" })).status).toBe(
      404,
    );
    for (const state of ["wrong", "x".repeat(43), "あ".repeat(43)])
      expect((await submit(s, { state })).status).toBe(403);
    expect((await fetch(f.url + "?state=anything")).status).toBe(404);
    expect(checks).toBe(0);
    expect((await submit(s)).status).toBe(200);
    await s.result;
    expect(checks).toBe(1);
  });
  test("different UID during linking cannot overwrite the selected account", async () => {
    const s = session({
      mode: "link",
      expectedUid: "alice",
      customToken: "header.payload.signature",
      inspect: async () => ({ ...identity, uid: "bob" }),
    });
    const r = await submit(s);
    expect(r.status).toBe(400);
    await expect(s.result).rejects.toBeInstanceOf(CloudAuthError);
  });
  test.each([
    { id_token: token("alice", "other-project") },
    { id_token: "not-a-jwt" },
    { refresh_token: "" },
    { expires_at: "NaN" },
    { expires_at: "0" },
    { expires_at: String(Date.now() + 172800_000) },
  ])(
    "malformed credentials fail closed without echoing values: %p",
    async (fields) => {
      const s = session();
      const response = await submit(s, fields);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("secret-test-refresh");
      await expect(s.result).rejects.toBeInstanceOf(CloudAuthError);
    },
  );
  test("anonymous and other-provider results cannot masquerade as Google recovery", async () => {
    for (const account of [
      { ...identity, anonymous: true, providers: [] },
      { ...identity, providers: ["password"] },
      { ...identity, providers: ["github.com"] },
    ]) {
      const s = session({ inspect: async () => account });
      expect((await submit(s)).status).toBe(400);
      await expect(s.result).rejects.toBeInstanceOf(CloudAuthError);
    }
  });
  test("concurrent callback requests cannot run two credential exchanges", async () => {
    let complete!: (v: typeof identity) => void,
      checks = 0;
    const s = session({
      inspect: () => {
        checks++;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const first = submit(s);
    while (!complete) await Bun.sleep(1);
    expect((await submit(s)).status).toBe(409);
    expect(checks).toBe(1);
    complete(identity);
    expect((await first).status).toBe(200);
    await s.result;
  });
  test("deadline closes even a verifier that never resolves", async () => {
    const s = session({ timeoutMs: 25, inspect: () => new Promise(() => {}) });
    const pending = submit(s).catch(() => undefined);
    await expect(s.result).rejects.toMatchObject({
      code: "cloud_auth_required",
    });
    await pending;
  });
  test("cancellation does not keep a local listener alive", async () => {
    const controller = new AbortController(),
      s = session({ signal: controller.signal });
    controller.abort();
    await expect(s.result).rejects.toMatchObject({
      code: "cloud_auth_required",
    });
    await expect(submit(s)).rejects.toBeDefined();
  });
});

describe("bounded cloud authentication requests", () => {
  const fetcher = (
    fn: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>,
  ) => fn as typeof fetch;
  test("own-UID token is posted to the configured origin without redirects", async () => {
    const value = await authServerJson(
      "https://relay.example",
      "/v1/auth/link-token",
      "PRIVATE_TOKEN",
      fetcher(async (url, init) => {
        expect(String(url)).toBe("https://relay.example/v1/auth/link-token");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer PRIVATE_TOKEN",
        );
        expect(init?.body).toBe("{}");
        return Response.json({ uid: "alice", custom_token: "synthetic" });
      }),
    );
    expect(value.uid).toBe("alice");
  });
  test.each([401, 403, 429, 500, 503, 302])(
    "HTTP %i gives only a safe error",
    async (status) => {
      const promise = authServerJson(
        "https://relay.example",
        "/v1/auth/config",
        undefined,
        fetcher(async () => new Response("SECRET_PROVIDER_BODY", { status })),
      );
      await expect(promise).rejects.toBeInstanceOf(CloudAuthError);
      const error = await promise.catch((e) => e);
      expect(error.message).not.toContain("SECRET");
    },
  );
  test("oversized body is rejected before parsing", async () => {
    await expect(
      authServerJson(
        "https://relay.example",
        "/v1/auth/config",
        undefined,
        fetcher(async () => new Response("x".repeat(64 * 1024 + 1))),
      ),
    ).rejects.toMatchObject({ code: "cloud_auth_invalid" });
  });
  test("network hangs that ignore abort are still bounded", async () => {
    let seen: AbortSignal | null | undefined;
    const promise = authServerJson(
      "https://relay.example",
      "/v1/auth/config",
      undefined,
      fetcher(async (_url, init) => {
        seen = init?.signal;
        return new Promise(() => {});
      }),
      20,
    );
    await expect(promise).rejects.toMatchObject({
      code: "cloud_auth_unavailable",
    });
    expect(seen?.aborted).toBe(true);
  });
});

describe("anonymous-first login and account recovery", () => {
  test("anonymous is the default and linking/recovery must be explicit", () => {
    expect(parseLoginArguments(["--url", "https://relay.example"]).mode).toBe(
      "anonymous",
    );
    expect(
      parseLoginArguments([
        "--url",
        "https://relay.example",
        "--link",
        "google",
      ]),
    ).toMatchObject({ mode: "link", provider: "google" });
    expect(
      parseLoginArguments([
        "--url",
        "https://relay.example",
        "--recover",
        "github",
      ]),
    ).toMatchObject({ mode: "recover", provider: "github" });
    expect(() =>
      parseLoginArguments([
        "--url",
        "https://relay.example",
        "--link",
        "google",
        "--recover",
        "github",
      ]),
    ).toThrow(CloudAuthError);
  });
  const credentials = (uid: string, nonce: string): CloudCredentials => ({
    version: 1,
    baseUrl: "https://relay.example",
    apiKey: "public-test",
    idToken: token(uid) + nonce,
    refreshToken: `refresh-${nonce}`,
    expiresAt: Date.now() + 3600_000,
  });
  test("account switching is refused without recovery, and recovery retains a protected backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyobidashi-recovery-")),
      path = join(dir, "auth.json");
    try {
      const original = credentials("alice", "old"),
        next = credentials("bob", "new");
      saveCloudCredentials(path, original);
      expect(() => finishCloudLogin(path, next, original)).toThrow(
        CloudAuthError,
      );
      expect(readCloudCredentials(path)).toEqual(original);
      const backup = finishCloudLogin(path, next, original, true)!;
      expect(readCloudCredentials(path)).toEqual(next);
      expect(readCloudCredentials(backup)).toEqual(original);
      expect(statSync(backup).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a concurrent new sign-in is never overwritten", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyobidashi-recovery-race-")),
      path = join(dir, "auth.json");
    try {
      const original = credentials("alice", "old");
      saveCloudCredentials(path, credentials("bob", "concurrent"));
      const before = readFileSync(path, "utf8");
      expect(() =>
        finishCloudLogin(path, credentials("alice", "late"), original, true),
      ).toThrow(CloudAuthError);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(() =>
        finishCloudLogin(path, credentials("alice", "late"), undefined),
      ).toThrow(CloudAuthError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
