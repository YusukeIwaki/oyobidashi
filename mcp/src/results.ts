import { ConfigError } from "./config.ts";
import { CloudAuthError } from "./cloud-auth.ts";
import { RelayError, type RelayPresence, type RelayPresenceEvent, type RelayRequest } from "./relay-client.ts";

/** `structuredContent` of every tool result (PROTOCOL.md section 9, plus `error_code` on failures). */
export interface ToolOutput {
  [key: string]: unknown;
  status: string;
  request_id?: string;
  answer?: string;
  input_method?: string;
  choice_index?: number;
  priority?: string;
  delivery_mode?: string;
  requested_mode?: string;
  call?: unknown;
  feedback?: unknown;
  devices?: unknown;
  recent_events?: unknown;
  now?: string;
  warning?: string;
  privacy_notice?: string;
  error_code?: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: ToolOutput;
  isError: boolean;
}

export const NO_DEVICE_WARNING =
  "No device is paired with the oyobidashi relay, so nobody's phone was notified. " +
  "Tell the user (in your normal reply) to pair their phone with the relay (show the pairing QR code with the relay CLI and scan it with the oyobidashi app). " +
  "A device paired later will still see this request while it is pending.";

/**
 * The FREE plan of the hosted service accepts no personal or confidential input.
 * A relay reports it per account; a self-hosted relay and a subscriber never do.
 */
export const PRIVACY_NOTICE =
  "This oyobidashi account is on the FREE plan of the hosted service, which does not accept personal or confidential information. " +
  "Do not put personal data (names, contact details, addresses, account or ID numbers), credentials or secrets, or confidential business information " +
  "in question, subject, context, choices or notification messages, and do not ask the human to state such information in their answer. " +
  "Refer to it indirectly instead (for example \"the customer in the ticket you opened\"), or leave the decision until the human is back at the keyboard.";

/** Default hint for a stdio connection, where the owner accepts the restriction in the login command. */
export const CONSENT_HINT = "run the oyobidashi cloud login command again in a terminal and accept the FREE plan input restriction";

/** Added to `warning` while the owner has not accepted the FREE plan input restriction. */
export function consentWarning(hint: string = CONSENT_HINT): string {
  return (
    "Voice calls are unavailable for this account until its owner accepts the FREE plan input restriction, so this request is delivered as text. " +
    `Tell the user (in your normal reply) to ${hint}. Do not retry as a call until they have done so.`
  );
}

/** What a relay reported about the account's input restriction, in tool-result terms. */
export interface RestrictionNotice {
  inputRestricted?: boolean | null | undefined;
  consentRequired?: boolean | null | undefined;
  consentHint?: string | undefined;
}

function applyRestriction(output: ToolOutput, notice: RestrictionNotice | undefined): void {
  if (!notice) return;
  if (notice.inputRestricted) output.privacy_notice = PRIVACY_NOTICE;
  if (notice.consentRequired) {
    const warning = consentWarning(notice.consentHint);
    output.warning = output.warning ? `${output.warning} ${warning}` : warning;
  }
}

function result(text: string, output: ToolOutput, isError = false): ToolResult {
  let full = text;
  if (output.warning) full = `${full}\n\nWARNING: ${output.warning}`;
  if (output.privacy_notice) full = `${full}\n\n${output.privacy_notice}`;
  return { content: [{ type: "text", text: full }], structuredContent: output, isError };
}

/** Copies extension telemetry (priority, effective delivery mode, call) into a tool output. */
function addTelemetry(output: ToolOutput, request: RelayRequest): void {
  if (request.priority) output.priority = request.priority;
  if (request.delivery_mode) output.delivery_mode = request.delivery_mode;
  if (request.requested_mode) output.requested_mode = request.requested_mode;
  if (request.call) output.call = request.call;
  if (request.feedback !== null && request.feedback !== undefined) output.feedback = request.feedback;
}

/** One-line human summary of the effective delivery mode and call state, for pending text. */
function telemetryLine(request: RelayRequest): string | undefined {
  const parts: string[] = [];
  if (request.delivery_mode) {
    const requested = request.requested_mode && request.requested_mode !== request.delivery_mode ? ` (requested ${request.requested_mode})` : "";
    parts.push(`Delivery: ${request.delivery_mode}${requested}.`);
  }
  const call = request.call;
  if (call) {
    const state = call.state ?? "unknown";
    const outcome = call.outcome ? `, outcome ${call.outcome}` : "";
    parts.push(`Call ${call.id}: ${state}${outcome}.`);
    if (call.outcome === "declined" || call.outcome === "hangup") {
      parts.push("The human declined or hung up the call: do NOT redial. Continue over text instead.");
    } else if (call.outcome === "missed" || call.outcome === "failed") {
      parts.push("The call did not connect: do NOT redial automatically. Continue over text.");
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Result for a request in whatever state it is in. `waitedSeconds` is only used for the pending text. */
export function requestResult(
  request: RelayRequest,
  opts: { waitedSeconds?: number; warning?: string | undefined; feedback?: unknown; restriction?: RestrictionNotice | undefined } = {},
): ToolResult {
  const id = request.id;
  const base: ToolOutput = { status: request.status, request_id: id };
  addTelemetry(base, request);
  if (opts.feedback !== null && opts.feedback !== undefined) base.feedback = opts.feedback;
  if (opts.warning) base.warning = opts.warning;
  applyRestriction(base, opts.restriction);

  switch (request.status) {
    case "answered": {
      const answer = request.answer;
      if (!answer) {
        return result(
          `The relay reports request ${id} as answered but sent no answer text. Call wait_for_answer with request_id "${id}" to re-read it; if this persists, ask the human again.`,
          { ...base, error_code: "bad_response" },
          true,
        );
      }
      const output: ToolOutput = { ...base, answer: answer.text };
      if (answer.input_method) output.input_method = answer.input_method;
      if (typeof answer.choice_index === "number") output.choice_index = answer.choice_index;

      let how: string;
      if (answer.input_method === "voice") {
        how =
          "The human answered by voice. The text below is an automatic speech-to-text transcription, so it may contain recognition errors " +
          "(wrong homophones, garbled identifiers, missing punctuation). Interpret it in context; if it is ambiguous and the decision matters, ask again to confirm.";
      } else if (typeof answer.choice_index === "number") {
        how = `The human picked choice #${answer.choice_index + 1} (choice_index ${answer.choice_index}, zero-based) of the choices you offered.`;
      } else {
        how = "The human answered by typing.";
      }
      return result(`${how}\n\nAnswer: ${answer.text}\n\n(request_id: ${id})`, output);
    }
    case "pending": {
      const waited = opts.waitedSeconds !== undefined ? ` after waiting ${opts.waitedSeconds}s` : "";
      const telemetry = telemetryLine(request);
      return result(
        `No answer yet${waited}. This is not an error: the question is still waiting on the human's phone (request_id: ${id}).` +
          (telemetry ? `\n${telemetry}` : "") +
          `\nCall wait_for_answer with request_id "${id}" to keep waiting, and repeat until you get an answer. ` +
          "Do NOT call ask_human again for the same question (that would ring the phone twice). " +
          "If you no longer need the answer, call cancel_request.",
        base,
      );
    }
    case "cancelled":
      return result(
        `Request ${id} was cancelled before the human answered it. No answer will arrive. If you still need a decision, ask again with ask_human.`,
        base,
      );
    case "expired":
      return result(
        `Request ${id} expired: the human did not answer before the deadline. No answer will arrive for it. ` +
          "If you still need the decision, ask again with ask_human (the human may simply have been away); otherwise continue with the safest option that does not need their approval.",
        base,
      );
    case "notified":
      return result(
        `Request ${id} is a one-way notification that was delivered to the human's phone. Notifications cannot be answered, so there is nothing to wait for.`,
        base,
      );
    default:
      return result(`Request ${id} is in state "${request.status}", which this MCP server does not know. Treat it as finished without an answer.`, base);
  }
}

export function notifiedResult(request: RelayRequest, warning: string | undefined, restriction?: RestrictionNotice): ToolResult {
  const output: ToolOutput = { status: request.status, request_id: request.id };
  addTelemetry(output, request);
  if (warning) output.warning = warning;
  // A notification is never a call, so only the content rule applies to it.
  applyRestriction(output, restriction ? { inputRestricted: restriction.inputRestricted } : undefined);
  return result(
    `Notification sent to the human's phone (request_id: ${request.id}). It is one-way: no answer will come back.`,
    output,
  );
}

export function cancelledResult(request: RelayRequest): ToolResult {
  const output: ToolOutput = { status: request.status, request_id: request.id };
  addTelemetry(output, request);
  return result(`Request ${request.id} was cancelled. The human can no longer answer it.`, output);
}

/** `cancel_request` hit 409 already_resolved and we looked up what the request resolved to. */
export function alreadyResolvedResult(request: RelayRequest): ToolResult {
  const inner = requestResult(request);
  const lead = `Nothing was cancelled: request ${request.id} was already resolved (status: ${request.status}).`;
  return {
    ...inner,
    content: [{ type: "text", text: `${lead}\n\n${inner.content[0]?.text ?? ""}` }],
  };
}

/** Result for `update_request`: the current request plus a confirmation of the effective mode. */
export function updateResult(request: RelayRequest, feedback: unknown): ToolResult {
  const inner = requestResult(request, { feedback });
  const mode = request.delivery_mode ? ` Effective delivery mode is "${request.delivery_mode}"` : "";
  const prio = request.priority ? ` with priority "${request.priority}"` : "";
  const lead =
    request.status === "pending"
      ? `Request ${request.id} was updated and is still pending.${mode}${prio}.`
      : `Request ${request.id} is no longer pending (status: ${request.status}), so the update had no effect on delivery.`;
  return {
    ...inner,
    content: [{ type: "text", text: `${lead}\n\n${inner.content[0]?.text ?? ""}` }],
  };
}

function formatPresenceEvent(event: RelayPresenceEvent): string {
  const when = event.at ?? "unknown time";
  const req = event.request_id ? ` request ${event.request_id}` : "";
  const dev = event.device_id ? ` on ${event.device_id}` : "";
  return `- ${event.event}${req}${dev} at ${when}`;
}

/** Result for `get_human_status`: availability plus recent human feedback. */
export function presenceResult(presence: RelayPresence, consentHint?: string): ToolResult {
  const devices = presence.devices ?? [];
  const events = presence.recent_events ?? [];
  const output: ToolOutput = { status: "ok", devices, recent_events: events };
  if (presence.now) output.now = presence.now;
  applyRestriction(output, {
    inputRestricted: presence.input_restricted,
    consentRequired: presence.input_consent_required,
    consentHint,
  });

  const lines: string[] = [];
  if (devices.length === 0) {
    lines.push("No devices are paired with the relay, so the human cannot be reached right now.");
  } else {
    for (const d of devices) {
      const avail = d.availability ?? "available";
      const note = d.note ? ` note: ${d.note}` : "";
      const until = d.until ? ` until ${d.until}` : "";
      lines.push(`Device ${d.device_id}: ${avail}${until}${note}.`);
    }
  }
  if (events.length === 0) {
    lines.push("No recent human feedback events.");
  } else {
    lines.push("Recent human feedback:");
    for (const e of events.slice(0, 20)) lines.push(formatPresenceEvent(e));
    const declined = events.some((e) => e.event.includes("declin") || e.event.includes("hangup"));
    if (declined) lines.push("The human recently declined or hung up: do NOT escalate to a call. Use text and wait.");
    const busy = devices.some((d) => d.availability === "busy" || d.availability === "away");
    if (busy) lines.push("The human is marked busy or away: prefer low priority and text, and only escalate if truly blocked.");
  }
  lines.push("Presence is what the human chose to share. It never proves a notification was seen: delivery is not guaranteed by the OS.");
  return result(lines.join("\n"), output);
}

export function inputErrorResult(message: string): ToolResult {
  return result(message, { status: "error", error_code: "invalid_request" }, true);
}

const START_RELAY = "start it with `cd relay && bun run serve` (in the oyobidashi repository)";

/**
 * Turns any failure into an actionable `isError: true` result.
 * `requestId` is the request the call was about, if one is known (it is echoed so the agent can retry).
 */
export function errorResult(error: unknown, ctx: { requestId?: string | undefined; created?: boolean } = {}): ToolResult {
  const id = ctx.requestId;
  const out = (code: string): ToolOutput => (id ? { status: "error", request_id: id, error_code: code } : { status: "error", error_code: code });
  const resume =
    id && ctx.created
      ? ` The question was already delivered as request_id "${id}", so do NOT ask it again: once the relay is reachable, call wait_for_answer with request_id "${id}".`
      : id
        ? ` Once that is fixed, call wait_for_answer with request_id "${id}" again.`
        : "";

  if (error instanceof CloudAuthError) return result(error.message, out(error.code), true);

  if (error instanceof ConfigError) {
    return result(`oyobidashi is not configured: ${error.message}`, out(error.code), true);
  }

  if (error instanceof RelayError) {
    const where = error.baseUrl;
    if (error.cloud) {
      if (error.status === 401) return result("Cloud sign-in was rejected after refreshing. Run the cloud login command in your terminal, then reconnect this MCP server.", out(error.code ?? "unauthorized"), true);
      if (error.status === 403) return result("Your cloud account is not permitted to perform this action. Check the account and resource permissions.", out(error.code ?? "forbidden"), true);
      if (error.kind === "network" || error.kind === "timeout" || (error.status !== undefined && error.status >= 500)) {
        return result(`The cloud service is temporarily unreachable or unavailable. Check connectivity and retry later.${resume}`, out(error.kind === "timeout" ? "relay_timeout" : error.code ?? "relay_unreachable"), true);
      }
      if (error.status === 404) return result(`The request is unavailable to this cloud account. Use the request_id returned by ask_human and the same account.${resume}`, out(error.code ?? "not_found"), true);
      if (error.status === 429) return result(`The cloud service is busy. Wait briefly before retrying.${resume}`, out(error.code ?? "rate_limited"), true);
      return result(`The cloud service rejected the operation (HTTP ${error.status ?? "unknown"}). Check the arguments and current request state.${resume}`, out(error.code ?? "bad_response"), true);
    }
    if (error.kind === "network") {
      return result(
        `Cannot reach the oyobidashi relay at ${where} (${causeText(error)}). The relay is probably not running: ask the user to ${START_RELAY}, then retry. ` +
          `If the relay runs on another address, set OYOBIDASHI_RELAY_URL.${resume}`,
        out("relay_unreachable"),
        true,
      );
    }
    if (error.kind === "timeout") {
      return result(
        `${error.message}. It may be hung or overloaded: ask the user to check or restart it (\`cd relay && bun run serve\`), then retry.${resume}`,
        out("relay_timeout"),
        true,
      );
    }
    if (error.kind === "bad_response") {
      return result(
        `Unexpected response from ${where}: ${error.message}. Probably something other than the oyobidashi relay is listening there, or the relay version does not match. ` +
          `Check OYOBIDASHI_RELAY_URL / the "port" in the oyobidashi config.json and make sure the relay is running (\`cd relay && bun run serve\`).${resume}`,
        out("bad_response"),
        true,
      );
    }

    const detail = error.relayMessage ? ` (${error.relayMessage})` : "";
    switch (error.status) {
      case 400:
        return result(
          `The relay rejected the request as invalid${detail || ` (${error.message})`}. Fix the arguments and call the tool again.`,
          out(error.code ?? "invalid_request"),
          true,
        );
      case 401:
        return result(
          `The relay at ${where} rejected the agent token (401 ${error.code ?? "unauthorized"}${detail}). ` +
            "The token must equal \"agent_token\" in the relay's config.json ($OYOBIDASHI_HOME/config.json, default ~/.oyobidashi/config.json). " +
            "If OYOBIDASHI_AGENT_TOKEN is set for this MCP server it overrides the file: update or unset it. " +
            "Also check that OYOBIDASHI_RELAY_URL / OYOBIDASHI_HOME point at the same relay instance. This needs the user's attention; retrying will not help.",
          out(error.code ?? "unauthorized"),
          true,
        );
      case 403:
        return result(
          `The relay at ${where} refused the call (403 ${error.code ?? "forbidden"}${detail}). The agent API only accepts direct local connections with the agent token: ` +
            "do not point OYOBIDASHI_RELAY_URL at the public tunnel (ngrok) URL or through a proxy that adds X-Forwarded-* headers (check HTTP_PROXY / NO_PROXY), " +
            "and make sure the token is the agent token (ka_...), not a device token. Use http://127.0.0.1:<port>.",
          out(error.code ?? "forbidden"),
          true,
        );
      case 404:
        if (id && error.code === "not_found") {
          return result(
            `Unknown request_id "${id}": the relay has no such request${detail}. Use the exact request_id returned by ask_human. ` +
              "If the relay's database was reset the request is gone; ask again with ask_human.",
            out("not_found"),
            true,
          );
        }
        return result(
          `The relay at ${where} answered 404${id ? ` for request_id "${id}"` : ""} (${error.message}). ` +
            (error.code
              ? "Check the request_id."
              : "That does not look like the oyobidashi relay: check OYOBIDASHI_RELAY_URL / the \"port\" in config.json and make sure the relay is running (`cd relay && bun run serve`)."),
          out(error.code ?? "not_found"),
          true,
        );
      case 409:
        return result(
          `The relay refused because of the request's current state (409 ${error.code ?? "conflict"}${detail}).${id ? ` Call wait_for_answer with request_id "${id}" to see its final state.` : ""}`,
          out(error.code ?? "conflict"),
          true,
        );
      case 413:
        return result(
          `The request is too large for the relay (413${detail}; the limit is 64KB). Shorten the question/context and try again.`,
          out(error.code ?? "payload_too_large"),
          true,
        );
      case 429:
        return result(`The relay is rate limiting (429${detail}). Wait a little and try again.${resume}`, out(error.code ?? "rate_limited"), true);
      default:
        if (error.status !== undefined && error.status >= 500) {
          return result(
            `The oyobidashi relay at ${where} failed internally (HTTP ${error.status}${detail}). Retry once; if it keeps failing ask the user to check the relay's log and restart it (\`cd relay && bun run serve\`).${resume}`,
            out(error.code ?? "internal"),
            true,
          );
        }
        return result(`Unexpected response from the oyobidashi relay at ${where}: ${error.message}.${resume}`, out(error.code ?? "unexpected_status"), true);
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return result(`oyobidashi MCP server hit an unexpected error: ${message}.${resume}`, out("internal"), true);
}

function causeText(error: RelayError): string {
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" && !cause.message.includes(code) ? `${code}: ${cause.message}` : cause.message;
  }
  return cause === undefined ? "connection failed" : String(cause);
}
