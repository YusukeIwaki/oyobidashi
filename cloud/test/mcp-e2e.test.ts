import { afterAll, expect, test } from "bun:test";
import { connectHosted, MemoryOAuthProvider } from "../../mcp/test/hosted-client.ts";
import { CloudApp } from "../src/app.ts";
import { harness } from "./helpers.ts";
import { MemoryOAuthStore } from "./oauth-memory.ts";

// The MCP SDK's own client drives discovery, registration, PKCE and refresh over
// real HTTP, so the endpoint is checked against an implementation we did not write.
const h = harness();
const app = new CloudApp(
  h.service,
  h.app.verifier,
  10_000,
  {
    publicConfig: {
      firebase: { apiKey: "synthetic", projectId: "synthetic-project", authDomain: "synthetic-project.firebaseapp.com" },
      providers: ["google"],
      canLinkExisting: false,
    },
    issueLinkToken: async () => "unused",
  },
  async () => "",
  { store: new MemoryOAuthStore(), script: async () => "" },
);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) as Promise<Response> });
const origin = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

/** Plays the human: opens the consent page, signs in as `user` and approves. */
const approveAs = (user: string) => async (authorizationUrl: URL) => {
  expect(authorizationUrl.origin).toBe(origin);
  const page = await fetch(authorizationUrl);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('data-mode="authorize"');
  const decision = await fetch(`${origin}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, authorization: `Bearer agent-${user}` },
    body: JSON.stringify({ ...Object.fromEntries(authorizationUrl.searchParams), decision: "approve" }),
  });
  expect(decision.status).toBe(200);
  return new URL(((await decision.json()) as { redirect_to: string }).redirect_to);
};

test("the SDK client authorizes by URL alone, calls tools and refreshes silently", async () => {
  const provider = new MemoryOAuthProvider(undefined, "SDK e2e");
  const client = await connectHosted(`${origin}/v1/mcp`, provider, approveAs("carol"));
  expect(provider.authorizationUrl!.searchParams.get("code_challenge_method")).toBe("S256");
  expect(provider.authorizationUrl!.searchParams.get("resource")).toBe(`${origin}/v1/mcp`);
  expect(client.getServerVersion()?.name).toBe("oyobidashi");
  expect((await client.listTools()).tools).toHaveLength(6);

  const device = await h.pair("carol");
  const asked = await client.callTool({ name: "ask_human", arguments: { question: "本番に反映しますか？", wait_seconds: 0 } });
  const pending = asked.structuredContent as { status: string; request_id: string };
  expect(pending.status).toBe("pending");
  const waiting = client.callTool({ name: "wait_for_answer", arguments: { request_id: pending.request_id, wait_seconds: 20 } });
  await Bun.sleep(100);
  const answer = await fetch(`${origin}/v1/requests/${pending.request_id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${device.device_token}` },
    body: JSON.stringify({ text: "お願いします", input_method: "text" }),
  });
  expect(answer.status).toBe(200);
  expect((await waiting).structuredContent).toMatchObject({ status: "answered", answer: "お願いします" });
  const stored = await h.service.run(h.principal("carol"), (tx) => h.service.request(tx, pending.request_id));
  expect(stored.agent?.name).toBe("SDK e2e");

  // An expired access token is replaced through the refresh token without asking the human again.
  const before = provider.tokens()!.refresh_token;
  provider.expireAccessToken();
  provider.authorizationUrl = undefined;
  const status = await client.callTool({ name: "get_human_status", arguments: {} });
  expect((status.structuredContent as { status: string }).status).toBe("ok");
  expect(provider.authorizationUrl).toBeUndefined();
  expect(provider.tokens()!.refresh_token).not.toBe(before);
  await client.close();
});

test("a second user of the same server never sees the first user's requests", async () => {
  const carol = await connectHosted(`${origin}/v1/mcp`, new MemoryOAuthProvider(), approveAs("carol"));
  const dave = await connectHosted(`${origin}/v1/mcp`, new MemoryOAuthProvider(), approveAs("dave"));
  const sent = await carol.callTool({ name: "notify_human", arguments: { message: "完了しました" } });
  const id = (sent.structuredContent as { request_id: string }).request_id;
  const peek = await dave.callTool({ name: "wait_for_answer", arguments: { request_id: id, wait_seconds: 0 } });
  expect(peek.isError).toBe(true);
  expect((peek.structuredContent as { error_code: string }).error_code).toBe("not_found");
  await carol.close();
  await dave.close();
});
