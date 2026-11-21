import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { RelayClient, type FetchLike } from "./relay-client.ts";
import { createServer } from "./server.ts";

/** One tool call may hold its HTTP request open this long before reporting "pending". */
export const HTTP_MAX_WAIT_SECONDS = 300;

export interface HttpMcpOptions {
  /** Origin the relay API is reached at. With an in-process `fetch` it only labels requests. */
  baseUrl: string;
  /** Performs relay API calls for the already authenticated caller. */
  fetch: FetchLike;
  /** Name of the connected MCP client, shown to the human as the asking agent. */
  agentName?: string;
  /** Page where the human can pair a phone; mentioned when a request reaches no device. */
  pairUrl?: string;
  /** The authenticated owner is under the FREE plan input restriction of the hosted service. */
  inputRestricted?: boolean;
  /** Page where the owner accepts that restriction; mentioned while the acceptance is missing. */
  consentUrl?: string;
  log?: (message: string) => void;
}

/**
 * Serves one Streamable HTTP request with the same tools as the stdio server.
 *
 * Stateless: every request gets its own server and transport, so any replica can
 * answer any request and nothing is kept between calls. The caller authenticates
 * the request first and rejects GET/DELETE, which would open a session stream.
 */
export async function handleMcpHttp(req: Request, options: HttpMcpOptions): Promise<Response> {
  const server = createServer({
    env: {},
    cwd: () => "",
    log: options.log ?? (() => {}),
    client: () => new RelayClient({
      baseUrl: options.baseUrl,
      agentToken: "",
      // The caller's `fetch` carries the identity; this value never leaves the process.
      tokenProvider: async () => "in-process",
      fetch: options.fetch,
    }),
    subscriptions: false,
    maxWaitSeconds: HTTP_MAX_WAIT_SECONDS,
    ...(options.agentName ? { agentName: options.agentName } : {}),
    ...(options.inputRestricted ? { inputRestricted: true } : {}),
    ...(options.consentUrl ? {
      consentHint: `open ${options.consentUrl} in a browser, sign in with the same account and accept the FREE plan input restriction`,
    } : {}),
    ...(options.pairUrl ? {
      noDeviceWarning:
        "No phone is paired with this oyobidashi account, so nobody was notified. " +
        `Tell the user (in your normal reply) how to pair: for the hosted service, open the お呼び出し app on the phone, tap "Oyobidashiクラウドに接続", ` +
        `sign in with the same account and tap "アプリを開く". The app only accepts that link when it opened the page itself, so do not send the user a pairing link. ` +
        `Otherwise open ${options.pairUrl} on a computer and sign in with the same account: it shows a QR code the app can scan. ` +
        "A phone paired later will still see this request while it is pending.",
    } : {}),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({});
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    req.signal.removeEventListener("abort", close);
    // Closing aborts a tool call that is still waiting for the human.
    void server.close().catch(() => {});
  };
  req.signal.addEventListener("abort", close, { once: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req);
    if (!response.body) {
      close();
      return response;
    }
    // Release the server when the reply is complete or the client stops reading.
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            close();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel(reason) {
        close();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    close();
    throw error;
  }
}
