import { afterEach, describe, expect, test } from "bun:test";
import { handleMcpHttp } from "../src/http.ts";
import { ACCEPT_PHRASES, confirmInputRestriction, INPUT_RESTRICTION_TEXT, type ConsentTerminal } from "../src/input-consent.ts";
import type { FetchLike } from "../src/relay-client.ts";
import { CONSENT_HINT, consentWarning, PRIVACY_NOTICE } from "../src/results.ts";
import { INPUT_RESTRICTION_PROMPT } from "../src/server.ts";
import { connect, envFor, FakeClock, FakeRelay, fixture, textOf, type Harness, type ToolCallResult } from "./helpers.ts";

// The agent's side of the FREE plan input restriction of the hosted service:
//   - linking over stdio: the owner accepts it in the login command
//   - the prompt: what a restricted account's agent is told, and where
//   - everyone else (LAN relay, self-hosted cloud, subscribers) is told nothing

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function stdio(deps: Parameters<typeof connect>[0] = {}) {
  const clock = new FakeClock();
  const relay = new FakeRelay(clock);
  harness = await connect({ env: envFor(relay), fetch: relay.fetch, clock, ...deps });
  const h = harness;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    clock.run(h.client.callTool({ name, arguments: args })) as Promise<ToolCallResult>;
  return { relay, h, call };
}
const delivered = { paired_devices: 1, websocket_delivered: 1, push_attempted: 0 };

describe("the notice itself", () => {
  test("names what must stay out and every field it applies to", () => {
    for (const word of ["FREE plan", "personal data", "credentials", "confidential", "question", "subject", "context", "choices", "notification"])
      expect(PRIVACY_NOTICE).toContain(word);
    expect(INPUT_RESTRICTION_PROMPT).toContain(PRIVACY_NOTICE);
  });
});

describe("linking over stdio: the login command", () => {
  /** A cloud API that reports `state` and records an acceptance. */
  function cloud(state: { restricted: boolean; accepted: boolean } | "missing") {
    const posts: unknown[] = [];
    const send = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://cloud.example.test/v1/input-restriction");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer id-token");
      expect(init?.redirect).toBe("error");
      if (state === "missing") return Response.json({ error: { code: "not_found" } }, { status: 404 });
      if (init?.method === "POST") {
        posts.push(JSON.parse(init.body as string));
        state.accepted = true;
      }
      return Response.json({ ...state, version: 1 });
    }) as typeof fetch;
    return { posts, send };
  }
  function terminal(answer: string | null): ConsentTerminal & { output: string; asked: number } {
    const t = {
      interactive: answer !== null,
      output: "",
      asked: 0,
      write(text: string) { t.output += text; },
      async ask(question: string) {
        t.asked++;
        t.output += question;
        return answer ?? "";
      },
    };
    return t;
  }
  const run = (api: ReturnType<typeof cloud>, t: ConsentTerminal) =>
    confirmInputRestriction("https://cloud.example.test", "id-token", t, api.send);

  test("a restricted owner reads the restriction and accepts by typing the phrase", async () => {
    for (const phrase of [...ACCEPT_PHRASES, " AGREE \n"]) {
      const api = cloud({ restricted: true, accepted: false }), t = terminal(phrase);
      expect(await run(api, t)).toBe("accepted");
      expect(t.output).toContain(INPUT_RESTRICTION_TEXT);
      expect(api.posts).toEqual([{ accept: true, version: 1 }]);
    }
  });

  test("anything else, including a bare Enter or 'y', accepts nothing", async () => {
    for (const answer of ["", "y", "yes", "同意しません", "はい"]) {
      const api = cloud({ restricted: true, accepted: false }), t = terminal(answer);
      expect(await run(api, t)).toBe("declined");
      expect(api.posts).toEqual([]);
      expect(t.output).toContain("文字で届きます");
    }
  });

  test("a non-interactive run never accepts on the owner's behalf", async () => {
    const api = cloud({ restricted: true, accepted: false }), t = terminal(null);
    expect(await run(api, t)).toBe("needs_terminal");
    expect(t.asked).toBe(0);
    expect(api.posts).toEqual([]);
  });

  test("subscribers, self-hosted servers and already accepted owners are not asked", async () => {
    for (const state of [{ restricted: false, accepted: false }, { restricted: true, accepted: true }, "missing"] as const) {
      const api = cloud(typeof state === "string" ? state : { ...state }), t = terminal("agree");
      expect(await run(api, t)).toBe("not_required");
      expect(t.asked).toBe(0);
      expect(t.output).toBe("");
      expect(api.posts).toEqual([]);
    }
  });

  test("an unreadable status is an error, not a silent pass", async () => {
    const broken = (async () => Response.json({ unexpected: true })) as unknown as typeof fetch;
    await expect(confirmInputRestriction("https://cloud.example.test", "id-token", terminal("agree"), broken)).rejects.toThrow();
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(confirmInputRestriction("https://cloud.example.test", "id-token", terminal("agree"), down)).rejects.toThrow();
  });
});

describe("the prompt over stdio", () => {
  test("a LAN relay or self-hosted cloud adds nothing to any result or description", async () => {
    const { relay, h, call } = await stdio();
    relay.delivery = delivered;
    expect(h.client.getInstructions()).not.toContain("INPUT RESTRICTION");
    expect(JSON.stringify((await h.client.listTools()).tools)).not.toContain("INPUT RESTRICTION");
    for (const result of [
      await call("ask_human", { question: "q", wait_seconds: 0 }),
      await call("notify_human", { message: "done" }),
      await call("get_human_status"),
    ]) {
      expect("privacy_notice" in result.structuredContent!).toBe(false);
      expect("warning" in result.structuredContent!).toBe(false);
      expect(textOf(result)).not.toContain("FREE plan");
    }
  });

  test("a restricted account's notice arrives with questions, notifications and status", async () => {
    const { relay, call } = await stdio();
    relay.delivery = { ...delivered, input_restricted: true };
    relay.presence = { devices: [], recent_events: [], now: "2026-11-15T14:00:00.000Z", input_restricted: true };
    for (const result of [
      await call("ask_human", { question: "q", wait_seconds: 0 }),
      await call("notify_human", { message: "done" }),
      await call("get_human_status"),
    ]) {
      expect(result.structuredContent?.privacy_notice).toBe(PRIVACY_NOTICE);
      expect(textOf(result)).toContain(PRIVACY_NOTICE);
      expect("warning" in result.structuredContent!).toBe(false);
    }
  });

  test("a missing acceptance is reported with the way to give it", async () => {
    const { relay, call } = await stdio();
    relay.delivery = { ...delivered, input_restricted: true, input_consent_required: true };
    relay.presence = { devices: [], recent_events: [], now: "2026-11-15T14:00:00.000Z", input_restricted: true, input_consent_required: true };
    const asked = await call("ask_human", { question: "q", wait_seconds: 0 });
    expect(asked.structuredContent?.warning).toBe(consentWarning());
    expect(asked.structuredContent?.warning).toContain(CONSENT_HINT);
    expect(asked.structuredContent?.privacy_notice).toBe(PRIVACY_NOTICE);
    expect((await call("get_human_status")).structuredContent?.warning).toBe(consentWarning());
    // A notification is never a call, so it carries the notice but not the call warning.
    const notified = await call("notify_human", { message: "done" });
    expect(notified.structuredContent?.privacy_notice).toBe(PRIVACY_NOTICE);
    expect("warning" in notified.structuredContent!).toBe(false);
  });

  test("the pairing warning and the acceptance warning are both kept", async () => {
    const { relay, call } = await stdio();
    relay.delivery = { paired_devices: 0, websocket_delivered: 0, push_attempted: 0, input_restricted: true, input_consent_required: true };
    const warning = (await call("ask_human", { question: "q", wait_seconds: 0 })).structuredContent?.warning as string;
    expect(warning).toContain("No device is paired");
    expect(warning).toContain(consentWarning());
  });
});

describe("the prompt on the hosted endpoint", () => {
  const pending = fixture("request_pending.json");
  const post = (options: { inputRestricted?: boolean; consentUrl?: string }, fetchImpl: FetchLike, message: unknown) =>
    handleMcpHttp(
      new Request("https://cloud.example.test/v1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(message),
      }),
      { baseUrl: "https://cloud.example.test", fetch: fetchImpl, ...options },
    );
  const result = async (response: Response) => (JSON.parse(/^data: (.*)$/m.exec(await response.text())![1]!) as { result: any }).result;
  const unused: FetchLike = async () => { throw new Error("no relay call expected"); };
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };

  test("a restricted owner's server states the restriction before any tool is called", async () => {
    const init = await result(await post({ inputRestricted: true }, unused, initialize));
    expect(init.instructions).toContain(INPUT_RESTRICTION_PROMPT);
    const tools = (await result(await post({ inputRestricted: true }, unused, list))).tools as { name: string; description: string }[];
    const described = tools.filter((t) => t.description.includes(INPUT_RESTRICTION_PROMPT)).map((t) => t.name).sort();
    // Exactly the tools that send content to the human.
    expect(described).toEqual(["ask_human", "notify_human"]);
  });

  test("an unrestricted owner's server never mentions it", async () => {
    for (const options of [{}, { inputRestricted: false }]) {
      expect((await result(await post(options, unused, initialize))).instructions).not.toContain("INPUT RESTRICTION");
      expect(JSON.stringify(await result(await post(options, unused, list)))).not.toContain("INPUT RESTRICTION");
    }
  });

  test("results repeat the notice even when the API omits the flag", async () => {
    const api: FetchLike = async () => Response.json({ request: pending, delivery: delivered }, { status: 201 });
    const asked = await result(await post({ inputRestricted: true }, api, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_human", arguments: { question: "q", wait_seconds: 0 } } }));
    expect(asked.structuredContent.privacy_notice).toBe(PRIVACY_NOTICE);
  });

  test("a missing acceptance points the owner at the hosted page", async () => {
    const api: FetchLike = async () => Response.json({ request: pending, delivery: { ...delivered, input_restricted: true, input_consent_required: true } }, { status: 201 });
    const asked = await result(await post(
      { inputRestricted: true, consentUrl: "https://cloud.example.test/oauth/connections" }, api,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_human", arguments: { question: "q", wait_seconds: 0 } } },
    ));
    expect(asked.structuredContent.warning).toContain("https://cloud.example.test/oauth/connections");
    expect(asked.structuredContent.warning).not.toContain("login command");
  });
});
