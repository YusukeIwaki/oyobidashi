import { handleMcpHttp } from "../../mcp/src/http.ts";
import type { FetchLike } from "../../mcp/src/relay-client.ts";
import { json } from "./errors.ts";
import type { InputRestriction } from "./input-restriction.ts";
import { MCP_PATH, preflight, withCors, type OAuthServer } from "./oauth.ts";
import type { Principal } from "./service.ts";

/**
 * Hosted MCP endpoint (Streamable HTTP, stateless). It authenticates the OAuth
 * access token and then runs the same tools as the stdio server against this
 * process's own API, as the token's owner. The owner's FREE plan input
 * restriction is resolved first so that the server's own instructions carry it.
 */
export async function serveMcp(
  req: Request,
  oauth: OAuthServer,
  api: (principal: Principal) => FetchLike,
  restriction: (principal: Principal) => Promise<InputRestriction>,
): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();
  const grant = await oauth.access(req);
  if (!("uid" in grant)) return oauth.challenge(req, grant.rejected);
  // GET would open a server-push stream and DELETE ends a session; a stateless endpoint has neither.
  if (req.method !== "POST") {
    const response = withCors(
      json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }),
    );
    response.headers.set("allow", "POST, OPTIONS");
    return response;
  }
  const origin = oauth.origin(req);
  const principal: Principal = { uid: grant.uid, role: "agent" };
  const { restricted } = await restriction(principal);
  return withCors(
    await handleMcpHttp(req, {
      baseUrl: origin,
      fetch: api(principal),
      pairUrl: `${origin}/pair`,
      inputRestricted: restricted,
      consentUrl: `${origin}/oauth/connections`,
      ...(grant.name ? { agentName: grant.name } : {}),
    }),
  );
}
export { MCP_PATH };
