import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.ts";
import { clampWaitSeconds, defaultWaitSeconds, MAX_WAIT_SECONDS, resolveConnection, type Env } from "./config.ts";
import {
  isAbortError,
  RelayClient,
  RelayError,
  type FetchLike,
  type RelayDelivery,
  type RelayDeliveryMode,
  type RelayPriority,
} from "./relay-client.ts";
import {
  alreadyResolvedResult,
  cancelledResult,
  errorResult,
  inputErrorResult,
  NO_DEVICE_WARNING,
  notifiedResult,
  PRIVACY_NOTICE,
  presenceResult,
  requestResult,
  updateResult,
  type RestrictionNotice,
  type ToolResult,
} from "./results.ts";
import { waitForResolution } from "./wait.ts";
import { CloudTokenProvider } from "./cloud-auth.ts";

export const SERVER_NAME = "oyobidashi";
export const SERVER_VERSION = "0.1.0";

/** Everything with side effects is injectable for tests. */
export interface ServerDeps {
  env?: Env;
  fetch?: FetchLike;
  clock?: Clock;
  cwd?: () => string;
  homedir?: () => string;
  /** Diagnostics sink. Must never write to stdout (stdout carries the MCP protocol). */
  log?: (message: string) => void;
  requestTimeoutMs?: number;
  pollGraceMs?: number;
  retryBackoffMs?: readonly number[];
  minCycleMs?: number;
  /** Supplies the relay connection directly instead of reading env/config files (hosted HTTP endpoint). */
  client?: () => RelayClient;
  /** Shown to the human as the asking agent when the transport has no initialize handshake to read it from. */
  agentName?: string;
  /** false omits resources/subscribe: a stateless HTTP request has no stream to push updates on. */
  subscriptions?: boolean;
  /** Upper bound for wait_seconds (default 3600). A hosted endpoint keeps HTTP requests short. */
  maxWaitSeconds?: number;
  /** Replaces the pairing hint, which by default describes the local relay CLI. */
  noDeviceWarning?: string;
  /**
   * True when the caller already knows this account is under the FREE plan input
   * restriction (hosted endpoint). The restriction then becomes part of the server's
   * own instructions and tool descriptions instead of arriving with the first result.
   */
  inputRestricted?: boolean;
  /** How the owner accepts the restriction; completes "Tell the user to ...". */
  consentHint?: string;
}

/** Appended to the instructions and to the descriptions of the tools that send content. */
export const INPUT_RESTRICTION_PROMPT = `INPUT RESTRICTION: ${PRIVACY_NOTICE}`;

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const waitSecondsDescription = (max: number) =>
  `How long this call blocks waiting for the human's answer, in seconds (0-${max}; out-of-range values are clamped). ` +
  "Default: 50, chosen to stay under typical MCP tool-call timeouts (the user can change it with OYOBIDASHI_DEFAULT_WAIT_SECONDS). " +
  "Only pass a larger value if you know your MCP client allows tool calls that long. " +
  "0 returns immediately with status \"pending\". When the time runs out you get status \"pending\" and continue with wait_for_answer.";

const ASK_HUMAN_DESCRIPTION = `Ask your human (the user who started you) a question via their phone, and wait for their reply.

The relay tries to notify the human's smartphone (oyobidashi app). Delivery depends on the device, network, and OS and is never guaranteed. They answer by typing, by voice, or by tapping one of the choices you offer, and the answer is returned to you.

WHEN TO USE: you are blocked on something only the human can decide or provide, and they are probably not watching the terminal (long-running or autonomous work, they said they would step away, or a question in the chat went unanswered). Typical cases: approval for a risky or irreversible action (deploy, DB migration, deleting data, force-push), choosing between designs with real trade-offs, ambiguous requirements, missing information (not secrets), or "I finished X, should I continue with Y?". Asking is much better than guessing wrong or stopping silently and leaving the human unaware that you are stuck.
WHEN NOT TO USE: things you can find out yourself (reading code, running a command, searching), trivial choices, or pure status updates (use notify_human).

RESPECT THEIR ATTENTION: the human uses this tool because they are busy with something else and want to be pulled away only when it is worth it. Their experience comes first, ahead of your convenience. Two things break their focus: being interrupted again and again with small questions, and being held on one long interruption. Balance how often you interrupt against how long each interruption takes:
- Before you interrupt, and above all before a call, work out everything you currently need from them and ask it in ONE request. Do not send one question now and the next a few minutes later.
- A question that does not block you yet can wait. Note it, keep doing the work that does not depend on it, and ask it together with the others at the point where you are really blocked or have a natural batch.
- Keep each interruption short. Ask only what changes what you do next, word each item so it can be answered in a few words, and settle everything you can settle yourself first. A call should cover about 3 to 5 items at most. If you have more, ask the ones that block you and send the rest as a low-priority text question.
- After they answer, use the answer to get as far as you can before interrupting again.

HOW TO ASK: the human reads this on a small phone screen without your conversation in front of them. Make the question self-contained, short and specific, in the language the human uses with you. Put supporting detail in "context". Whenever the answer is one of a few options, pass "choices" so they can answer with one tap (free-form text/voice answers remain possible).

On a call, assume the human is listening without a screen. Before calling, look up referenced Jira issues or other material if you have access. In "question", briefly say what the issue is and give the verified facts that affect the decision, then ask for the specific decision you need. Aim for one or two short spoken sentences. When offering options, name them and state the trade-off if it affects the decision. Keep issue keys, URLs, and extra detail in "context" for later reference. If you cannot verify essential facts or the human needs to read the source to decide, use text.

Several items in one request: number them. In "question", say how many items there are and state the first one with the facts needed to answer it (e.g. "I have two decisions to confirm. First, the fix for failed payments passed staging and customers still can't check out. Should I deploy it now?"). Put the remaining items in "context" as a numbered list, each with the background needed to answer it. At the start of a call only "question" is read aloud. The voice intermediary then goes through the items in "context" one at a time and returns one answer per item number. Do not pass "choices" with several items, because one tap can answer only one of them.

PRIORITY AND DELIVERY: "priority" is low/normal/high/urgent (default normal). Prefer low with short choice-only questions (3 or fewer choices) when the human can answer at leisure. Use "delivery_mode" auto (default) unless you have a reason: auto uses one-tap action buttons for short choice-only questions and a text view otherwise. Use text when the human needs to read supporting details or give a long free-form answer. Use call ONLY when priority is high/urgent AND you are actually blocked; check get_human_status before escalating to a call. If a call was declined, hung up, missed, or failed, do NOT redial: continue over text. "urgency" (normal/high) is a legacy alias of priority and is only sent for compatibility; prefer "priority".

RESULT (structuredContent.status):
- "answered": "answer" holds the reply. "input_method" is "text", "voice" or "choice"; for "choice", "choice_index" is the zero-based index into your choices. A "voice" answer is a speech-to-text transcription and may contain recognition errors (wrong homophones, garbled names/identifiers): interpret it in context and re-ask if it is ambiguous and the decision matters.
- "pending": no answer within wait_seconds. This is NOT an error and the question is still on their phone. "priority", "delivery_mode", and "call" report how it is being delivered. Call wait_for_answer with the returned "request_id" and keep doing so until it resolves. Do not call ask_human again for the same question. If the question is no longer useful, call cancel_request.
- "cancelled" / "expired": no answer will arrive (requests expire after expires_in_seconds, about an hour by default).
A "warning" field means delivery is doubtful (e.g. no phone is paired); pass that on to the user.
A "privacy_notice" field means this account does not accept personal or confidential information; when it is present, follow it for every later question and notification.`;

const WAIT_FOR_ANSWER_DESCRIPTION = `Keep waiting for the human's answer to a question previously sent with ask_human.

Call this whenever ask_human (or an earlier wait_for_answer) returned status "pending": pass the same request_id. It blocks up to wait_seconds and returns the same result shape as ask_human ("answered" with the answer, "pending" again, "cancelled" or "expired"). A "pending" result also carries delivery telemetry ("priority", "delivery_mode", "call") so you can decide whether to escalate with update_request. Humans can take minutes to notice their phone, so getting "pending" repeatedly is normal: keep calling until the status is no longer "pending", or do other useful work that does not depend on the answer and check back later. It never re-sends the notification, so it is always safe to call. Pass wait_seconds 0 to just check the current state without blocking.

As with ask_human, an answer with input_method "voice" is a speech-to-text transcription and may contain recognition errors. If the call outcome is declined or hangup, do NOT redial. If you no longer need the answer, call cancel_request.`;

const NOTIFY_HUMAN_DESCRIPTION = `Send a one-way notification to your human's phone. No answer comes back and this call does not wait.

Use it to tell a human who is away from the keyboard something they would want to know right now: a long task finished, a build/deploy/test run succeeded or failed, or you are stopping and why. Keep the message short and self-contained (it is shown as a phone notification), in the language the human uses with you. The relay tries to deliver it; delivery depends on the device, network, and OS and is never guaranteed.
Do not use it for questions: if you need a reply or a decision, use ask_human instead. Do not send routine progress chatter; each call may buzz the phone. A sent notification can be withdrawn with cancel_request while it is still current.
A "privacy_notice" field means this account does not accept personal or confidential information; when it is present, follow it for every later question and notification.`;

const CANCEL_REQUEST_DESCRIPTION = `Withdraw a pending question sent with ask_human, or a one-way notification sent with notify_human, so the human no longer needs to see or answer it.

Use it when the question or notification became irrelevant: you found the answer yourself, the user replied in the terminal instead, or the plan changed. Withdrawing a notification removes the need to act on it. If the request was already answered (or expired/cancelled) nothing is cancelled and the current state is returned instead, including the answer if there is one.`;

const GET_HUMAN_STATUS_DESCRIPTION = `Check whether your human is reachable before you escalate, and read their recent feedback.

Returns device availability (available/busy/away with an optional note), recent feedback events (answers, call declined/hangup/missed/failed), and the relay time. Use it before raising priority or switching delivery to call: if the human is busy or away, prefer low priority and text and only escalate when truly blocked; if they recently declined or hung up, do NOT redial. Presence is what the human chose to share and never proves a notification was seen: delivery is not guaranteed by the OS. A "privacy_notice" field means this account does not accept personal or confidential information; when it is present, follow it for every later question and notification.`;

const UPDATE_REQUEST_DESCRIPTION = `Change the priority or delivery mode of a pending question sent with ask_human.

Pass "priority" (low/normal/high/urgent) and/or "delivery_mode" (auto/actions/text/call). At least one is required. The relay recalculates the effective delivery and the result reports the current request including the effective "delivery_mode" and "call" state plus any human "feedback". Use it to escalate when truly blocked (check get_human_status first) or to quieten a question that can wait. A call needs high/urgent priority and explicit "call" mode; if the call was declined, hung up, missed, or failed, do NOT switch back to call. If the question is no longer useful, call cancel_request instead.

Switch to call only if the existing "question" already gives the human enough background to answer by listening. If the human needs to open a Jira issue, follow a link, or read "context" to answer the opening question, keep the request in text.`;

const outputSchema = {
  status: z
    .string()
    .describe('"answered", "pending", "cancelled", "expired", "notified" (notification delivered), or "error" (failed calls only)'),
  request_id: z.string().optional().describe("ID of the request; pass it to wait_for_answer / cancel_request / update_request"),
  answer: z.string().optional().describe("The human's reply (only when status is \"answered\")"),
  input_method: z
    .string()
    .optional()
    .describe('How the human answered: "text", "voice" (speech-to-text transcription; may contain recognition errors) or "choice"'),
  choice_index: z.number().int().optional().describe("Zero-based index of the picked choice (only when input_method is \"choice\")"),
  priority: z.string().optional().describe('Request priority: "low", "normal", "high", or "urgent" (when the relay reports it)'),
  delivery_mode: z.string().optional().describe('Effective delivery mode: "actions", "text", or "call" (when the relay reports it)'),
  requested_mode: z.string().optional().describe('Requested delivery mode: "auto", "actions", "text", or "call" (when the relay reports it)'),
  call: z.record(z.string(), z.unknown()).optional().describe("Live call state (id, state ringing/active/ended, outcome, transcript) when there is one"),
  feedback: z.unknown().optional().describe("Human feedback for this request when the relay returns it"),
  warning: z.string().optional().describe("Present when delivery is doubtful, e.g. no phone is paired with the relay"),
  privacy_notice: z.string().optional().describe("Present when this account does not accept personal or confidential information; keep both out of every question and notification"),
  error_code: z.string().optional().describe("Machine-readable error code (only when the call failed)"),
};

const presenceOutputSchema = {
  status: z.string().describe('"ok" when presence was read, or "error" (failed calls only)'),
  devices: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Paired devices with availability (available/busy/away), until, note, updated_at, last_seen_at"),
  recent_events: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Recent human feedback events (request_id, device_id, event, at), newest first"),
  now: z.string().optional().describe("Relay time (ISO8601)"),
  warning: z.string().optional().describe("Present when delivery is doubtful, e.g. no phone is paired with the relay"),
  privacy_notice: z.string().optional().describe("Present when this account does not accept personal or confidential information; keep both out of every question and notification"),
  error_code: z.string().optional().describe("Machine-readable error code (only when the call failed)"),
};

function deliveryWarning(delivery: RelayDelivery | undefined, noDevice: string = NO_DEVICE_WARNING): string | undefined {
  if (delivery?.paired_devices === 0) return noDevice;
  if (delivery && delivery.websocket_delivered === 0 && delivery.push_attempted === 0) return "A phone is paired, but no live connection or push provider could deliver this request. Ask the human to open お呼び出し or configure APNs/FCM. Delivery is not confirmed.";
  return undefined;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? systemClock;
  const cwd = deps.cwd ?? (() => process.cwd());
  const log = deps.log ?? ((message: string) => void process.stderr.write(`[oyobidashi-mcp] ${message}\n`));
  const subscriptions = deps.subscriptions !== false;
  const maxWaitSeconds = clampWaitSeconds(deps.maxWaitSeconds ?? MAX_WAIT_SECONDS);
  const WAIT_SECONDS_DESCRIPTION = waitSecondsDescription(maxWaitSeconds);
  const restrictionPrompt = deps.inputRestricted ? `\n\n${INPUT_RESTRICTION_PROMPT}` : "";

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { resources: subscriptions ? { subscribe: true } : {} },
      instructions:
        "oyobidashi lets you try to reach your human on their phone while they are away from the keyboard. Delivery is never guaranteed. " +
        "Your human is busy, which is why they use this: their focus comes first. Many small interruptions and one long interruption both cost them, so collect what you need, keep working on what is not blocked, and ask everything in one short request (numbered items) instead of calling again and again. " +
        "Use ask_human when you are blocked on a decision only they can make; if it returns status \"pending\", keep calling wait_for_answer with the request_id. " +
        "For phone calls, give the essential facts in plain language before asking for a decision. The opening question must make sense by listening alone. " +
        "Use get_human_status before escalating priority or delivery. Use update_request to change priority or delivery of a pending question. " +
        "Use notify_human for one-way news (e.g. a long task finished); withdraw it with cancel_request when it is no longer useful. " +
        "Voice answers are speech-to-text and may contain recognition errors. Never redial after declined/hangup. " +
        "If a result carries \"privacy_notice\", the account does not accept personal or confidential information: keep both out of every later question and notification." +
        restrictionPrompt,
    },
  );

  const cloudProviders = new Map<string, CloudTokenProvider>();

  /** Resolved on every call so that a relay (and its config.json) started later is picked up. */
  function connect(): RelayClient {
    if (deps.client) return deps.client();
    const connection = resolveConnection(env, deps.homedir);
    let cloud: CloudTokenProvider | undefined;
    if (connection.cloudAuthFile) {
      cloud = cloudProviders.get(connection.cloudAuthFile);
      if (!cloud) {
        cloud = new CloudTokenProvider(connection.cloudAuthFile, {clock, ...(deps.fetch ? {fetch:deps.fetch} : {})});
        cloudProviders.set(connection.cloudAuthFile, cloud);
      }
    }
    return new RelayClient({
      baseUrl: cloud?.baseUrl ?? connection.baseUrl,
      agentToken: connection.agentToken,
      ...(cloud ? {tokenProvider:(force: boolean, signal?: AbortSignal) => cloud.getToken(force, signal)} : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.requestTimeoutMs !== undefined ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
      ...(deps.pollGraceMs !== undefined ? { pollGraceMs: deps.pollGraceMs } : {}),
    });
  }

  // Availability is also a subscribable resource, so a client can receive feedback
  // while its agent is doing other work instead of repeatedly invoking a tool.
  const humanStatusURI = "human://status";
  let subscribed = false;
  let presenceTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let fingerprint: string | undefined;
  let presenceAbort: AbortController | undefined;
  const signature = (status: Awaited<ReturnType<RelayClient["getPresence"]>>) => JSON.stringify({devices: status.devices, recent_events: status.recent_events});
  mcp.registerResource("human_status", humanStatusURI, {
    title: "Human availability and call feedback", mimeType: "application/json",
    description: subscriptions
      ? "Explicitly shared availability, expiry, last seen and recent call outcomes. Subscribe to receive resources/updated when it changes; read again for the current state."
      : "Explicitly shared availability, expiry, last seen and recent call outcomes. Read again for the current state.",
  }, async (uri, extra) => {
    const status = await connect().getPresence({signal: extra.signal});
    return {contents:[{uri:uri.href,mimeType:"application/json",text:JSON.stringify(status)}]};
  });
  const stopPresence = () => {
    subscribed = false;
    clearInterval(presenceTimer);
    presenceTimer = undefined;
    presenceAbort?.abort();
  };
  if (subscriptions) mcp.server.setRequestHandler(SubscribeRequestSchema, async request => {
    if(request.params.uri !== humanStatusURI) throw new McpError(ErrorCode.InvalidParams,"Unknown resource URI");
    if (subscribed) return {};
    fingerprint = signature(await connect().getPresence());
    subscribed = true;
    presenceTimer = setInterval(() => {
      if (!subscribed || polling) return;
      polling = true;
      presenceAbort = new AbortController();
      void Promise.resolve().then(() => connect().getPresence({signal:presenceAbort!.signal})).then(async status => {
        const next = signature(status);
        if (subscribed && next !== fingerprint) {
          fingerprint = next;
          await mcp.server.sendResourceUpdated({uri:humanStatusURI});
        }
      }).catch(() => { /* Reconnection is retried on the next tick; no synthetic availability. */ })
        .finally(() => {polling = false;});
    }, 5000);
    presenceTimer.unref?.();
    return {};
  });
  if (subscriptions) mcp.server.setRequestHandler(UnsubscribeRequestSchema, async request => {
    if(request.params.uri !== humanStatusURI) throw new McpError(ErrorCode.InvalidParams,"Unknown resource URI");
    stopPresence();
    return {};
  });
  const previousClose = mcp.server.onclose;
  mcp.server.onclose = () => {stopPresence();previousClose?.();};

  function agentInfo(): { name?: string; cwd?: string } {
    const agent: { name?: string; cwd?: string } = {};
    const name = truncate(deps.agentName ?? mcp.server.getClientVersion()?.name, 100);
    if (name) agent.name = name;
    let dir: string | undefined;
    try {
      dir = truncate(cwd(), 1000);
    } catch {
      dir = undefined; // cwd was deleted
    }
    if (dir) agent.cwd = dir;
    return agent;
  }

  function effectiveWait(requested: number | undefined): number {
    return Math.min(maxWaitSeconds, requested === undefined ? defaultWaitSeconds(env, log) : clampWaitSeconds(requested));
  }

  function progressReporter(extra: Extra): ((info: { elapsedSeconds: number; waitSeconds: number }) => void) | undefined {
    const progressToken = extra._meta?.progressToken;
    if (progressToken === undefined) return undefined;
    return ({ elapsedSeconds, waitSeconds }) => {
      extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: Math.min(elapsedSeconds, waitSeconds),
            total: waitSeconds,
            message: `Waiting for the human's answer (${elapsedSeconds}s)`,
          },
        })
        .catch((e: unknown) => log(`failed to send progress notification: ${String(e)}`));
    };
  }

  /** The account's restriction as the relay reported it with a newly created request. */
  function restrictionOf(delivery: RelayDelivery | undefined): RestrictionNotice {
    return {
      // What the caller established before the handshake holds even if a relay omits the flag.
      inputRestricted: deps.inputRestricted === true || delivery?.input_restricted === true,
      consentRequired: delivery?.input_consent_required === true,
      consentHint: deps.consentHint,
    };
  }

  /** Shared failure path. Cancellation by the MCP client is re-thrown (no result is expected). */
  function fail(error: unknown, extra: Extra, ctx: { requestId?: string; created?: boolean }): ToolResult {
    if (extra.signal.aborted || isAbortError(error)) throw error;
    const result = errorResult(error, ctx);
    log(`tool call failed: ${result.content[0]?.text ?? String(error)}`);
    return result;
  }

  async function waitAndReport(
    client: RelayClient,
    requestId: string,
    waitSeconds: number,
    extra: Extra,
    opts: { initial?: Awaited<ReturnType<RelayClient["getRequest"]>>; warning?: string | undefined; restriction?: RestrictionNotice | undefined },
  ): Promise<ToolResult> {
    const request = await waitForResolution(client, requestId, {
      clock,
      waitSeconds,
      signal: extra.signal,
      initial: opts.initial,
      onPoll: progressReporter(extra),
      retryBackoffMs: deps.retryBackoffMs,
      minCycleMs: deps.minCycleMs,
    });
    return requestResult(request, { waitedSeconds: waitSeconds, warning: opts.warning, restriction: opts.restriction });
  }

  mcp.registerTool(
    "ask_human",
    {
      title: "Ask the human (via their phone)",
      description: ASK_HUMAN_DESCRIPTION + restrictionPrompt,
      inputSchema: {
        question: z
          .string()
          .max(4000)
          .describe("The question, self-contained and concise (1-4000 characters). It is the body of the phone notification and the first thing read aloud on a call. For calls, give the essential facts in plain language before asking for the decision. With several items, give the count and the first item here and the rest in context."),
        subject: z
          .string()
          .refine((value) => Array.from(value).length <= 40, "subject must be at most 40 characters")
          .optional()
          .describe("Optional short subject for the call (max 40 characters, one line), e.g. 'Production deployment approval'. Include it for calls: iPhone appends it to the caller name and Android shows it above the question. Visible on the lock screen; keep sensitive details in the question/context."),
        context: z
          .string()
          .max(8000)
          .optional()
          .describe("Optional supporting details and references (max 8000 characters). With several items, the numbered list of the remaining items goes here. This field is not read aloud at the start of a call. The voice intermediary uses it during the conversation. Put the facts needed for the opening decision in question."),
        choices: z
          .array(z.string().min(1).max(200))
          .max(8)
          .optional()
          .describe("Optional answer buttons for one-tap replies (max 8, each 1-200 characters), e.g. [\"Yes\", \"No\"]. Prefer 3 or fewer short choices for action buttons; the human can still answer in free text or by voice instead."),
        priority: z
          .enum(["low", "normal", "high", "urgent"])
          .optional()
          .describe('How urgently the human should be interrupted. Default "normal". Prefer "low" for short choice-only questions that can wait; "high"/"urgent" only when a late answer causes real harm and you are blocked.'),
        delivery_mode: z
          .enum(["auto", "actions", "text", "call"])
          .optional()
          .describe('"auto" (default) picks one-tap actions for short choice-only questions and text otherwise. "text" fits context and long free-form answers. "call" only with high/urgent priority when actually blocked, after checking get_human_status.'),
        urgency: z
          .enum(["normal", "high"])
          .optional()
          .describe('Legacy alias of priority ("high" only if a late answer causes real harm). Prefer "priority"; when both are given, "priority" decides the urgency sent for compatibility.'),
        expires_in_seconds: z
          .number()
          .int()
          .min(10)
          .max(86400)
          .optional()
          .describe("How long the question stays answerable, 10-86400 seconds (default about an hour). After that it expires."),
        wait_seconds: z.number().optional().describe(WAIT_SECONDS_DESCRIPTION),
      },
      outputSchema,
      annotations: { title: "Ask the human (via their phone)", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra): Promise<ToolResult> => {
      const question = args.question.trim();
      if (question === "") {
        return inputErrorResult("\"question\" must not be empty. Pass the question you want to ask the human (1-4000 characters).");
      }
      const context = args.context?.trim() || undefined;
      const subject = args.subject?.trim().replace(/\s+/gu, " ") || undefined;
      const choices = args.choices?.map((c) => c.trim());
      if (choices?.some((c) => c === "")) {
        return inputErrorResult("\"choices\" must not contain blank entries. Each choice needs 1-200 characters.");
      }
      const waitSeconds = effectiveWait(args.wait_seconds);
      const priority: RelayPriority | undefined = args.priority;
      // Compatibility: old relays only know urgency. New priority decides when both are given.
      const urgency = args.priority
        ? ((args.priority === "high" || args.priority === "urgent" ? "high" : "normal") as "normal" | "high")
        : args.urgency;
      const deliveryMode: RelayDeliveryMode | undefined = args.delivery_mode;

      let requestId: string | undefined;
      try {
        const client = connect();
        const created = await client.createRequest(
          {
            kind: "question",
            question,
            subject,
            context,
            choices,
            urgency,
            priority,
            deliveryMode,
            expiresInSeconds: args.expires_in_seconds,
            agent: agentInfo(),
          },
          { signal: extra.signal },
        );
        requestId = created.request.id;
        return await waitAndReport(client, requestId, waitSeconds, extra, {
          initial: created.request,
          warning: deliveryWarning(created.delivery, deps.noDeviceWarning),
          restriction: restrictionOf(created.delivery),
        });
      } catch (e) {
        return fail(e, extra, requestId ? { requestId, created: true } : {});
      }
    },
  );

  mcp.registerTool(
    "wait_for_answer",
    {
      title: "Keep waiting for the human's answer",
      description: WAIT_FOR_ANSWER_DESCRIPTION,
      inputSchema: {
        request_id: z.string().describe("The request_id returned by ask_human (looks like \"req_...\")."),
        wait_seconds: z.number().optional().describe(WAIT_SECONDS_DESCRIPTION),
      },
      outputSchema,
      annotations: { title: "Keep waiting for the human's answer", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra): Promise<ToolResult> => {
      const requestId = args.request_id.trim();
      if (requestId === "") {
        return inputErrorResult("\"request_id\" must not be empty. Pass the request_id returned by ask_human.");
      }
      try {
        return await waitAndReport(connect(), requestId, effectiveWait(args.wait_seconds), extra, {});
      } catch (e) {
        return fail(e, extra, { requestId });
      }
    },
  );

  mcp.registerTool(
    "notify_human",
    {
      title: "Notify the human (one-way)",
      description: NOTIFY_HUMAN_DESCRIPTION + restrictionPrompt,
      inputSchema: {
        message: z.string().max(4000).describe("The notification text, short and self-contained (1-4000 characters)."),
      },
      outputSchema,
      annotations: { title: "Notify the human (one-way)", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra): Promise<ToolResult> => {
      const message = args.message.trim();
      if (message === "") {
        return inputErrorResult("\"message\" must not be empty. Pass the text to show on the human's phone (1-4000 characters).");
      }
      try {
        const created = await connect().createRequest(
          { kind: "notification", question: message, agent: agentInfo() },
          { signal: extra.signal },
        );
        return notifiedResult(created.request, deliveryWarning(created.delivery, deps.noDeviceWarning), restrictionOf(created.delivery));
      } catch (e) {
        return fail(e, extra, {});
      }
    },
  );

  mcp.registerTool(
    "cancel_request",
    {
      title: "Cancel a pending question or notification",
      description: CANCEL_REQUEST_DESCRIPTION,
      inputSchema: {
        request_id: z.string().describe("The request_id returned by ask_human or notify_human (looks like \"req_...\")."),
      },
      outputSchema,
      annotations: { title: "Cancel a pending question or notification", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra): Promise<ToolResult> => {
      const requestId = args.request_id.trim();
      if (requestId === "") {
        return inputErrorResult("\"request_id\" must not be empty. Pass the request_id returned by ask_human.");
      }
      try {
        const client = connect();
        try {
          return cancelledResult(await client.cancelRequest(requestId, { signal: extra.signal }));
        } catch (e) {
          if (!(e instanceof RelayError) || e.status !== 409 || e.code !== "already_resolved") throw e;
          // Not pending any more: report what it resolved to (the human may have answered meanwhile).
          let current;
          try {
            current = await client.getRequest(requestId, { signal: extra.signal });
          } catch (lookupError) {
            if (isAbortError(lookupError)) throw lookupError;
            throw e;
          }
          return alreadyResolvedResult(current);
        }
      } catch (e) {
        return fail(e, extra, { requestId });
      }
    },
  );

  mcp.registerTool(
    "get_human_status",
    {
      title: "Check human presence and feedback",
      description: GET_HUMAN_STATUS_DESCRIPTION,
      inputSchema: {},
      outputSchema: presenceOutputSchema,
      annotations: { title: "Check human presence and feedback", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (_args, extra): Promise<ToolResult> => {
      try {
        return presenceResult(await connect().getPresence({ signal: extra.signal }), deps.consentHint);
      } catch (e) {
        return fail(e, extra, {});
      }
    },
  );

  mcp.registerTool(
    "update_request",
    {
      title: "Update a pending question's priority or delivery",
      description: UPDATE_REQUEST_DESCRIPTION,
      inputSchema: {
        request_id: z.string().describe("The request_id returned by ask_human (looks like \"req_...\")."),
        priority: z
          .enum(["low", "normal", "high", "urgent"])
          .optional()
          .describe("New priority. At least one of priority or delivery_mode is required."),
        delivery_mode: z
          .enum(["auto", "actions", "text", "call"])
          .optional()
          .describe('New requested delivery mode. "call" needs high/urgent priority and a blocked task; check get_human_status first.'),
      },
      outputSchema,
      annotations: { title: "Update a pending question's priority or delivery", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra): Promise<ToolResult> => {
      const requestId = args.request_id.trim();
      if (requestId === "") {
        return inputErrorResult("\"request_id\" must not be empty. Pass the request_id returned by ask_human.");
      }
      if (args.priority === undefined && args.delivery_mode === undefined) {
        return inputErrorResult("Pass at least one of \"priority\" or \"delivery_mode\" to change.");
      }
      try {
        const updated = await connect().updateRequest(
          requestId,
          { priority: args.priority, deliveryMode: args.delivery_mode },
          { signal: extra.signal },
        );
        return updateResult(updated.request, updated.feedback);
      } catch (e) {
        return fail(e, extra, { requestId });
      }
    },
  );

  return mcp;
}
