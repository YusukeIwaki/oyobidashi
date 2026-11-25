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
  {
    ...h.app.verifier,
    identify: async (token: string) => ({
      uid: await h.app.verifier.verify(token),
      provider: "google.com",
    }),
  },
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
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(6);
  for (const tool of tools) {
    expect(tool.annotations?.title).toBeString();
    expect(tool.annotations?.title).toBe(tool.title);
    expect(tool.description).not.toMatch(/ask_human|wait_for_answer|notify_human|cancel_request|get_human_status|update_request/);
  }

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

test("an MCP client creates item questions and gets item IDs and conditional results back", async () => {
  const client = await connectHosted(`${origin}/v1/mcp`, new MemoryOAuthProvider(), approveAs("items-user"));
  try {
    const device = await h.pair("items-user");
    expect((await h.call("GET", "/v1/requests", device.device_token, undefined, {
      "x-oyobidashi-request-items": "1",
    })).status).toBe(200);
    const asked = await client.callTool({ name: "ask_human", arguments: {
      question: "発送の確認です", wait_seconds: 0, items: [
        { id: "route", question: "通常便と速達のどちらですか？", choices: ["通常便", "速達"] },
        { id: "deadline", question: "速達の期限はいつですか？", applies_when: { item_id: "route", choice_index: 1 } },
        { id: "label", question: "ラベルの版はどれですか？" },
      ],
    } });
    expect(asked.structuredContent).toMatchObject({ status: "pending", delivery_mode: "text", item_answers: [] });
    const id = (asked.structuredContent as { request_id: string }).request_id;
    const sent = await h.call("POST", `/v1/requests/${id}/answer`, device.device_token, {
      item_answers: [{ item_id: "route", choice_index: 0 }, { item_id: "label", text: "新版" }],
    });
    expect(sent.status).toBe(200);
    const result = await client.callTool({ name: "wait_for_answer", arguments: { request_id: id, wait_seconds: 0 } });
    expect(result.structuredContent).toMatchObject({
      status: "answered",
      item_answers: [
        { item_id: "route", status: "answered", choice_index: 0, text: "通常便" },
        { item_id: "deadline", status: "not_applicable" },
        { item_id: "label", status: "answered", text: "新版" },
      ],
    });
  } finally {
    await client.close();
  }
});

test("a paired older mobile client receives a numbered reply request instead of an item form", async () => {
  const uid = "items-legacy";
  const client = await connectHosted(`${origin}/v1/mcp`, new MemoryOAuthProvider(), approveAs(uid));
  try {
    const oldDevice = await h.pair(uid);
    const currentDevice = await h.pair(uid);
    await h.call("GET", "/v1/requests", currentDevice.device_token, undefined, { "x-oyobidashi-request-items": "1" });
    const asked = await client.callTool({ name: "ask_human", arguments: {
      question: "発送の確認です", wait_seconds: 0, delivery_mode: "call", priority: "high",
      items: [
        { id: "route", question: "通常便と速達のどちらですか？", choices: ["通常便", "速達"] },
        { id: "deadline", question: "速達の期限はいつですか？", applies_when: { item_id: "route", choice_index: 1 } },
      ],
    } });
    expect(asked.structuredContent).toMatchObject({ status: "pending", delivery_mode: "text", warning: expect.stringContaining("numbered text request") });
    const id = (asked.structuredContent as { request_id: string }).request_id;
    const fetched = (await h.call("GET", `/v1/requests/${id}`, oldDevice.device_token)).body.request;
    expect(fetched.items).toBeUndefined();
    expect(fetched.context).toContain("1. 通常便と速達のどちらですか？");
    expect(fetched.context).toContain("2. 速達の期限はいつですか？（1で「速達」を選んだ場合のみ）");
    expect((await h.call("POST", `/v1/requests/${id}/answer`, oldDevice.device_token, {
      text: "1. 通常便", input_method: "text",
    })).status).toBe(200);
  } finally {
    await client.close();
  }
});
