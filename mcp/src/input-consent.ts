import { CloudAuthError, cloudBaseUrl } from "./cloud-auth.ts";

// The stdio bridge links an agent to a cloud account in the terminal, so that is
// where the owner accepts the FREE plan input restriction of the hosted service.
// A self-hosted server and a subscriber report no restriction and are never asked.

/** What the owner types to accept. Deliberately more than a keypress. */
export const ACCEPT_PHRASES = ["同意します", "agree"] as const;

export const INPUT_RESTRICTION_TEXT = [
  "FREEプランの入力制限 / FREE plan input restriction",
  "",
  "FREEプランの音声通話では、質問や会話の内容がAIモデルの学習に使われる場合があります。",
  "そのため、個人情報や機密情報を扱えません。",
  "  - エージェントから届く質問・補足・選択肢に、個人情報や機密情報を含めさせません。",
  "  - 通話で、個人情報や機密情報を話しません。",
  "個人情報や機密情報を扱う場合は、PLUSプランをご利用ください。PLUSプランにこの制限はありません。",
  "",
  "On the FREE plan, voice calls may be used to train AI models, so they must not",
  "contain personal or confidential information. The PLUS plan has no such restriction.",
  "",
].join("\n");

export interface ConsentTerminal {
  interactive: boolean;
  write(text: string): void;
  ask(question: string): Promise<string>;
}

export type ConsentOutcome = "not_required" | "accepted" | "declined" | "needs_terminal";

async function call(
  baseUrl: string,
  token: string,
  send: typeof fetch,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await send(`${cloudBaseUrl(baseUrl)}/v1/input-restriction`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CloudAuthError("cloud_auth_unavailable");
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    /* judged by status below */
  }
  return {
    status: response.status,
    body: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
  };
}

/**
 * Asks the owner to accept the restriction when, and only when, the server says
 * this account is restricted and has not accepted yet.
 */
export async function confirmInputRestriction(
  baseUrl: string,
  token: string,
  terminal: ConsentTerminal,
  send: typeof fetch = fetch,
): Promise<ConsentOutcome> {
  const status = await call(baseUrl, token, send);
  // A server without this endpoint has no restricted plan.
  if (status.status === 404) return "not_required";
  if (status.status !== 200 || typeof status.body.restricted !== "boolean")
    throw new CloudAuthError("cloud_auth_unavailable");
  if (!status.body.restricted || status.body.accepted === true) return "not_required";

  terminal.write(`\n${INPUT_RESTRICTION_TEXT}`);
  if (!terminal.interactive) {
    terminal.write("Run this login command again in an interactive terminal to accept. Until then, voice calls stay unavailable and questions are delivered as text.\n");
    return "needs_terminal";
  }
  const answer = (await terminal.ask(`同意する場合は「${ACCEPT_PHRASES[0]}」(または "${ACCEPT_PHRASES[1]}") と入力してください: `)).trim().toLowerCase();
  if (!(ACCEPT_PHRASES as readonly string[]).includes(answer)) {
    terminal.write("同意を確認できませんでした。音声通話は利用できず、質問は文字で届きます。同意するには、このログインコマンドをもう一度実行してください。\n");
    return "declined";
  }
  const accepted = await call(baseUrl, token, send, { accept: true, version: status.body.version });
  if (accepted.status !== 200 || accepted.body.accepted !== true)
    throw new CloudAuthError("cloud_auth_unavailable");
  terminal.write("FREEプランの入力制限に同意しました。\n");
  return "accepted";
}
