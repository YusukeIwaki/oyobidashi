import { expect, test } from "bun:test";
import { handleMcpHttp } from "../src/http.ts";
import type { FetchLike } from "../src/relay-client.ts";
import { fixture } from "./helpers.ts";
import { PRIVACY_NOTICE } from "../src/results.ts";

const post = (fetchImpl: FetchLike, message: unknown, signal?: AbortSignal) =>
  handleMcpHttp(
    new Request("https://cloud.example.test/v1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(message),
      ...(signal ? { signal } : {}),
    }),
    { baseUrl: "https://cloud.example.test", fetch: fetchImpl, agentName: "Hosted client", pairUrl: "https://cloud.example.test/pair" },
  );
const result = async (response: Response) =>
  JSON.parse(/^data: (.*)$/m.exec(await response.text())![1]!) as { result: any };
const unused: FetchLike = async () => {
  throw new Error("no relay call expected");
};

test("a stateless request needs no initialize and advertises no subscriptions", async () => {
  const init = await result(await post(unused, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } }));
  expect(init.result.capabilities.resources.subscribe).toBeUndefined();
  const listed = await result(await post(unused, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const ask = listed.result.tools.find((t: { name: string }) => t.name === "ask_human");
  expect(ask.inputSchema.properties.wait_seconds.description).toContain("0-300");
  const subscribe = await post(unused, { jsonrpc: "2.0", id: 3, method: "resources/subscribe", params: { uri: "human://status" } });
  expect(await subscribe.text()).toContain("Method not found");
});

test("tool calls use the injected connection, the client's name and never the server's directory", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const pending = fixture("request_pending.json");
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ request: pending, delivery: { paired_devices: 0, websocket_delivered: 0, push_attempted: 0 } }, { status: 201 });
  };
  const called = await result(await post(fetchImpl, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_human", arguments: { question: "進めますか？", wait_seconds: 0 } } }));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://cloud.example.test/v1/requests");
  expect(JSON.parse(calls[0]!.init.body as string).agent).toEqual({ name: "Hosted client" });
  expect(called.result.structuredContent.status).toBe("pending");
  expect(called.result.structuredContent.warning).toContain("https://cloud.example.test/pair");
  expect(called.result.structuredContent.warning).not.toContain("relay CLI");
});

test("hosted ask_human and get_human_status surface privacy_notice only when input_restricted is true", async () => {
  const notice = PRIVACY_NOTICE;
  const pending = fixture("request_pending.json");
  const flaggedFetch: FetchLike = async (url) => {
    if (url.endsWith("/v1/presence")) return Response.json({ devices: [], recent_events: [], now: "2026-11-15T14:00:00.000Z", input_restricted: true });
    return Response.json({ request: pending, delivery: { paired_devices: 1, websocket_delivered: 1, push_attempted: 0, input_restricted: true } }, { status: 201 });
  };
  const asked = await result(await post(flaggedFetch, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_human", arguments: { question: "進めますか？", wait_seconds: 0 } } }));
  expect(asked.result.structuredContent.privacy_notice).toBe(notice);
  expect(asked.result.content[0].text).toContain(notice);
  const status = await result(await post(flaggedFetch, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_human_status", arguments: {} } }));
  expect(status.result.structuredContent.privacy_notice).toBe(notice);
  expect(status.result.content[0].text).toContain(notice);

  const plainFetch: FetchLike = async (url) => {
    if (url.endsWith("/v1/presence")) return Response.json({ devices: [], recent_events: [], now: "2026-11-15T14:00:00.000Z" });
    return Response.json({ request: pending, delivery: { paired_devices: 1, websocket_delivered: 1, push_attempted: 0 } }, { status: 201 });
  };
  const askedPlain = await result(await post(plainFetch, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_human", arguments: { question: "進めますか？", wait_seconds: 0 } } }));
  expect("privacy_notice" in askedPlain.result.structuredContent).toBe(false);
  expect(askedPlain.result.content[0].text).not.toContain(notice);
  const statusPlain = await result(await post(plainFetch, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_human_status", arguments: {} } }));
  expect("privacy_notice" in statusPlain.result.structuredContent).toBe(false);
  expect(statusPlain.result.content[0].text).not.toContain(notice);

  const listed = await result(await post(unused, { jsonrpc: "2.0", id: 5, method: "tools/list" }));
  const askTool = listed.result.tools.find((t: { name: string }) => t.name === "ask_human");
  expect(askTool.outputSchema.properties.privacy_notice.description).toContain("personal or confidential");
  const presenceTool = listed.result.tools.find((t: { name: string }) => t.name === "get_human_status");
  expect(presenceTool.outputSchema.properties.privacy_notice.description).toContain("personal or confidential");
});

test("a disconnecting client ends its waiting tool call", async () => {
  const pending = fixture("request_pending.json");
  let polls = 0;
  let aborted = false;
  const fetchImpl: FetchLike = (_url, init) => {
    if (init.method === "POST") return Promise.resolve(Response.json({ request: pending }, { status: 201 }));
    polls++;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  };
  const controller = new AbortController();
  const response = await post(fetchImpl, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_human", arguments: { question: "進めますか？", wait_seconds: 300 } } }, controller.signal);
  while (polls === 0) await Bun.sleep(5);
  controller.abort();
  await Bun.sleep(20);
  expect(aborted).toBe(true);
  await response.body?.cancel().catch(() => {});
});
