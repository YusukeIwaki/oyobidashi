import { describe, expect, test } from "bun:test";
import type { Call, RequestObject } from "../../relay/src/types.ts";
import {
  apiConversation,
  configuredConversation,
  configuredConversations,
  modelTranscript,
  ProviderFailure,
  voiceModels,
} from "../src/provider.ts";

const request: RequestObject = {
  id: "req-test",
  kind: "question",
  question: "進めますか？",
  context: "検証環境への反映",
  choices: ["はい", "あとで"],
  urgency: "high",
  status: "pending",
  answer: null,
  agent: { name: "test", cwd: null },
  created_at: "2026-11-16T00:00:00.000Z",
  updated_at: "2026-11-16T00:00:00.000Z",
  expires_at: "2026-11-16T01:00:00.000Z",
};
const call: Call = {
  id: "call-test",
  request_id: request.id,
  state: "active",
  outcome: null,
  device_id: "device-1",
  started_at: request.created_at,
  updated_at: request.updated_at,
  transcript: [
    { role: "assistant", text: request.question },
    { role: "user", text: "はい" },
  ],
};
test("the model receives at most eight bounded voice messages", () => {
  const many = { transcript: Array.from({ length: 100 }, (_, i) => ({ role: "user", text: `${i}:` + "あ".repeat(10_000) })) };
  const bounded = modelTranscript(many);
  expect(bounded).toHaveLength(8);
  expect(bounded[0]!.text.startsWith("92:")).toBe(true);
  expect(bounded.every((entry) => Array.from(entry.text).length <= 2000)).toBe(true);
});
const resolved = {
  reply: "承知しました。お伝えします。",
  resolved: true,
  answer: "進めてください",
};
const unfinished = { reply: "いつ進めますか？", resolved: false, answer: null };
const payload = (result: unknown = resolved, stop = "end_turn") => ({
  stop_reason: stop,
  content: [{ type: "text", text: JSON.stringify(result) }],
});
const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const fetcher = (
  fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) => fn as typeof fetch;
async function failure(promise: Promise<unknown>, retryable: boolean) {
  try {
    await promise;
    throw new Error("expected provider failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderFailure);
    expect((error as ProviderFailure).retryable).toBe(retryable);
    expect((error as Error).message).not.toContain("SECRET");
    return error as ProviderFailure;
  }
}

describe.each(["anthropic", "meta"] as const)(
  "cloud conversation API (%s)",
  (selected) => {
    const provider = (send: typeof fetch) =>
      apiConversation({
        provider: selected,
        apiKey: "SECRET_API_KEY",
        model: "test-model",
        fetch: send,
      });
    test("sends only the conversation data with no tools and forwards cancellation", async () => {
      const controller = new AbortController();
      const result = await provider(
        fetcher(async (url, init) => {
          expect(String(url)).toBe(
            selected === "meta"
              ? "https://api.meta.ai/v1/messages"
              : "https://api.anthropic.com/v1/messages",
          );
          expect(init?.method).toBe("POST");
          expect(init?.redirect).toBe("error");
          expect(init?.signal).toBe(controller.signal);
          const headers = new Headers(init?.headers);
          expect(
            headers.get(selected === "meta" ? "authorization" : "x-api-key"),
          ).toBe(
            selected === "meta" ? "Bearer SECRET_API_KEY" : "SECRET_API_KEY",
          );
          expect(
            headers.get(selected === "meta" ? "x-api-key" : "authorization"),
          ).toBeNull();
          const body = JSON.parse(String(init?.body));
          expect(body.model).toBe("test-model");
          expect(body.max_tokens).toBe(selected === "meta" ? 4096 : 1024);
          if (selected === "meta") {
            expect(body.output_config.effort).toBe("medium");
            expect(body.output_config.format.schema.required).toEqual([
              "reply",
              "resolved",
              "answer",
            ]);
            expect(body.thinking).toBeUndefined();
          }
          expect(body.tools).toBeUndefined();
          expect(JSON.parse(body.messages[0].content)).toEqual({
            question: request.question,
            context: request.context,
            choices: request.choices,
            transcript: call.transcript,
          });
          return json(payload());
        }),
      ).turn(request, call, controller.signal);
      expect(result).toEqual(resolved);
    });
    test("unresolved answers retain the call instead of inventing a final answer", async () => {
      expect(
        await provider(fetcher(async () => json(payload(unfinished)))).turn(
          request,
          call,
          new AbortController().signal,
        ),
      ).toEqual(unfinished);
    });
    test.each([429, 500, 502, 503, 504])(
      "HTTP %i is retryable without returning provider error contents",
      async (status) => {
        const error = await failure(
          provider(
            fetcher(async () =>
              json({ error: { message: "SECRET_PROVIDER_DETAILS" } }, status, {
                "retry-after": "3",
              }),
            ),
          ).turn(request, call, new AbortController().signal),
          true,
        );
        expect(error.retryAfterMs).toBe(3000);
      },
    );
    test.each([400, 401, 403, 404, 422])(
      "HTTP %i fails without pointless authentication/config retries",
      async (status) => {
        await failure(
          provider(
            fetcher(async () => new Response("SECRET_REJECTED", { status })),
          ).turn(request, call, new AbortController().signal),
          false,
        );
      },
    );
    test.each([
      ["100000", 10000],
      ["-5", 0],
      ["invalid", 0],
      ["0", 0],
    ])("Retry-After %s is bounded to %i ms", async (raw, expected) => {
      const error = await failure(
        provider(
          fetcher(
            async () =>
              new Response(null, {
                status: 429,
                headers: { "retry-after": String(raw) },
              }),
          ),
        ).turn(request, call, new AbortController().signal),
        true,
      );
      expect(error.retryAfterMs).toBe(Number(expected));
    });
    test("network reset is retryable and its error details are redacted", async () => {
      await failure(
        provider(
          fetcher(async () => {
            throw new Error("SECRET_SOCKET_DETAILS");
          }),
        ).turn(request, call, new AbortController().signal),
        true,
      );
    });
    test("a cancelled request reaches the transport rather than leaving an uncancellable model call", async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      const pending = provider(
        fetcher(
          async (_url, init) =>
            new Promise<Response>((_, reject) => {
              seen = init?.signal ?? undefined;
              seen?.addEventListener(
                "abort",
                () => reject(new DOMException("SECRET_ABORT", "AbortError")),
                { once: true },
              );
            }),
        ),
      ).turn(request, call, controller.signal);
      expect(seen).toBe(controller.signal);
      controller.abort();
      await failure(pending, true);
      expect(seen?.aborted).toBe(true);
    });
    test("redirect responses fail rather than forwarding the API key", async () => {
      let calls = 0;
      await failure(
        provider(
          fetcher(async (_url, init) => {
            calls++;
            expect(init?.redirect).toBe("error");
            return new Response(null, {
              status: 302,
              headers: { location: "https://attacker.example" },
            });
          }),
        ).turn(request, call, new AbortController().signal),
        false,
      );
      expect(calls).toBe(1);
    });
    test.each(
      [
        null,
        [],
        {},
        { stop_reason: "end_turn" },
        { stop_reason: "end_turn", content: "bad" },
        {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "not JSON" }],
        },
        { stop_reason: "end_turn", content: [{ type: "tool_use", input: {} }] },
      ].map((value) => [value]),
    )(
      "malformed envelope is a terminal provider failure: %p",
      async (value) => {
        await failure(
          provider(fetcher(async () => json(value))).turn(
            request,
            call,
            new AbortController().signal,
          ),
          false,
        );
      },
    );
    test.each([
      "max_tokens",
      "tool_use",
      "refusal",
      "pause_turn",
      "stop_sequence",
    ])(
      "incomplete stop reason %s never resolves the human's answer",
      async (stop) => {
        await failure(
          provider(fetcher(async () => json(payload(resolved, stop)))).turn(
            request,
            call,
            new AbortController().signal,
          ),
          false,
        );
      },
    );
    test.each(
      [
        null,
        [],
        {},
        { reply: "ok", resolved: true, answer: null },
        { reply: "ok", resolved: true, answer: "" },
        { reply: "ok", resolved: true, answer: "   " },
        { reply: "", resolved: false, answer: null },
        { reply: "   ", resolved: false, answer: null },
        { reply: "ok", resolved: "true", answer: "yes" },
        { reply: "ok", resolved: false },
        { reply: "x".repeat(2001), resolved: false, answer: null },
        { reply: "ok", resolved: true, answer: "x".repeat(10001) },
      ].map((value) => [value]),
    )("malformed result is not a valid answer: %p", async (result) => {
      await failure(
        provider(fetcher(async () => json(payload(result)))).turn(
          request,
          call,
          new AbortController().signal,
        ),
        false,
      );
    });
    test("provider output is bounded before JSON decoding, independent of Content-Length", async () => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(128 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      });
      await failure(
        provider(
          fetcher(
            async () =>
              new Response(stream, { headers: { "content-length": "10" } }),
          ),
        ).turn(request, call, new AbortController().signal),
        false,
      );
      expect(cancelled).toBe(true);
    });
    test("a broken response body returns a sanitized failure", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("SECRET_RESPONSE_DETAILS"));
        },
      });
      await failure(
        provider(fetcher(async () => new Response(stream))).turn(
          request,
          call,
          new AbortController().signal,
        ),
        false,
      );
    });
    test("reply and final answer are trimmed after validation", async () => {
      expect(
        await provider(
          fetcher(async () =>
            json(
              payload({
                reply: "  了解です  ",
                resolved: true,
                answer: "  明日です  ",
              }),
            ),
          ),
        ).turn(request, call, new AbortController().signal),
      ).toEqual({ reply: "了解です", resolved: true, answer: "明日です" });
    });
    test("missing API key/model fails at startup without echoing credentials", () => {
      expect(() => apiConversation({ apiKey: "", model: "test" })).toThrow();
      expect(() => apiConversation({ apiKey: "SECRET", model: "" })).toThrow();
    });
    test("reasoning blocks are ignored and never spoken to the human", async () => {
      const value = payload();
      value.content.unshift({ type: "thinking", text: "PRIVATE_REASONING" });
      expect(
        await provider(fetcher(async () => json(value))).turn(
          request,
          call,
          new AbortController().signal,
        ),
      ).toEqual(resolved);
    });
  },
);

describe("voice provider configuration", () => {
  test("missing selected key disables voice without falling back to another provider", () => {
    expect(
      configuredConversation({
        VOICE_PROVIDER: "meta",
        ANTHROPIC_API_KEY: "SECRET",
        ANTHROPIC_MODEL: "wrong",
      }),
    ).toBeUndefined();
    expect(
      configuredConversation({ MODEL_API_KEY: "SECRET", META_MODEL: "wrong" }),
    ).toBeUndefined();
  });
  test("unknown provider and selected credentials without a model fail at startup", () => {
    expect(() =>
      configuredConversation({
        VOICE_PROVIDER: "invalid",
        MODEL_API_KEY: "SECRET",
      }),
    ).toThrow("VOICE_PROVIDER");
    expect(() =>
      configuredConversation({
        VOICE_PROVIDER: "meta",
        MODEL_API_KEY: "SECRET",
      }),
    ).toThrow("API key and model");
  });
  test("Meta selection uses only Meta credentials even when Anthropic is also configured", async () => {
    const conversation = configuredConversation(
      {
        VOICE_PROVIDER: "meta",
        MODEL_API_KEY: "META_SECRET",
        META_MODEL: "muse-spark-1.3",
        ANTHROPIC_API_KEY: "OTHER_SECRET",
        ANTHROPIC_MODEL: "other",
      },
      fetcher(async (url, init) => {
        expect(String(url)).toBe("https://api.meta.ai/v1/messages");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer META_SECRET",
        );
        expect(JSON.parse(String(init?.body)).model).toBe("muse-spark-1.3");
        expect(String(init?.body)).not.toContain("OTHER_SECRET");
        return json(payload());
      }),
    );
    expect(
      await conversation!.turn(request, call, new AbortController().signal),
    ).toEqual(resolved);
  });
});

describe.each(["anthropic", "meta"] as const)(
  "configuredConversations (%s)",
  (selected) => {
    const env = (freeModel?: string) =>
      selected === "meta"
        ? {
            VOICE_PROVIDER: "meta",
            MODEL_API_KEY: "SECRET_API_KEY",
            META_MODEL: "standard-model",
            ...(freeModel !== undefined
              ? { VOICE_MODEL_FREE: freeModel }
              : {}),
          }
        : {
            ANTHROPIC_API_KEY: "SECRET_API_KEY",
            ANTHROPIC_MODEL: "standard-model",
            ...(freeModel !== undefined
              ? { VOICE_MODEL_FREE: freeModel }
              : {}),
          };
    const expectedUrl =
      selected === "meta"
        ? "https://api.meta.ai/v1/messages"
        : "https://api.anthropic.com/v1/messages";
    const headerName = selected === "meta" ? "authorization" : "x-api-key";
    const headerValue =
      selected === "meta" ? "Bearer SECRET_API_KEY" : "SECRET_API_KEY";
    test("free provider sends the free model with the same key and URL", async () => {
      const seen: { url: string; model: string; header: string | null }[] =
        [];
      const conversations = configuredConversations(
        voiceModels(env("free-model"), true),
        fetcher(async (u, init) => {
          seen.push({
            url: String(u),
            model: JSON.parse(String(init?.body)).model,
            header: new Headers(init?.headers).get(headerName),
          });
          return json(payload());
        }),
      );
      expect(conversations).toBeDefined();
      expect(conversations!.free).toBeDefined();
      expect(
        await conversations!.standard.turn(
          request,
          call,
          new AbortController().signal,
        ),
      ).toEqual(resolved);
      expect(
        await conversations!.free!.turn(
          request,
          call,
          new AbortController().signal,
        ),
      ).toEqual(resolved);
      expect(seen).toEqual([
        { url: expectedUrl, model: "standard-model", header: headerValue },
        { url: expectedUrl, model: "free-model", header: headerValue },
      ]);
    });
    test("unset VOICE_MODEL_FREE yields no free provider", () => {
      const conversations = configuredConversations(voiceModels(env(), true));
      expect(conversations?.standard).toBeDefined();
      expect(conversations?.free).toBeUndefined();
    });
    test("empty VOICE_MODEL_FREE yields no free provider", () => {
      const conversations = configuredConversations(voiceModels(env(""), true));
      expect(conversations?.standard).toBeDefined();
      expect(conversations?.free).toBeUndefined();
    });
    test("identical VOICE_MODEL_FREE yields no free provider", () => {
      const conversations = configuredConversations(voiceModels(env("standard-model"), true));
      expect(conversations?.standard).toBeDefined();
      expect(conversations?.free).toBeUndefined();
    });
  },
);

test("voice training follows the model selected for each deployment and plan", () => {
  const env = {
    ANTHROPIC_MODEL: "standard",
    VOICE_MODEL_FREE: "free",
    VOICE_STANDARD_TRAINING: "0",
    VOICE_FREE_TRAINING: "1",
  };
  const official = voiceModels(env, true);
  expect(official.freeModel).toBe("free");
  expect(official.training).toEqual({ free: true, plus: false });
  const selfHosted = voiceModels(env, false);
  expect(selfHosted.freeModel).toBeUndefined();
  expect(selfHosted.training).toEqual({ free: false, plus: false });
  expect(voiceModels({ ...env, VOICE_MODEL_FREE: "standard" }, true).training)
    .toEqual({ free: false, plus: false });
  expect(voiceModels({}, false).training).toEqual({ free: null, plus: null });
});
