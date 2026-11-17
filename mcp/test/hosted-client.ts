import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** What a real MCP client keeps between runs, held in memory for tests. */
export class MemoryOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  private client: OAuthClientInformationMixed | undefined;
  private current: OAuthTokens | undefined;
  private verifier = "";
  constructor(readonly redirectUrl = "http://127.0.0.1:43110/callback", private readonly name = "SDK client") {}
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() { return this.client; }
  saveClientInformation(client: OAuthClientInformationMixed) { this.client = client; }
  tokens() { return this.current; }
  saveTokens(tokens: OAuthTokens) { this.current = tokens; }
  /** A real client opens the browser here; the test plays the human instead. */
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
  /** Simulates an access token that has run out, leaving the refresh token. */
  expireAccessToken() {
    if (this.current) this.current = { ...this.current, access_token: "kma_" + "0".repeat(43) };
  }
}

/**
 * Connects the SDK's own client to a hosted endpoint, following its discovery,
 * registration and PKCE flow. `approve` receives the authorization URL the
 * browser would open and returns the URL the client is redirected back to.
 */
export async function connectHosted(
  endpoint: string,
  provider: MemoryOAuthProvider,
  approve: (authorizationUrl: URL) => Promise<URL>,
): Promise<Client> {
  const open = () => ({
    client: new Client({ name: "hosted-e2e", version: "1.0.0" }),
    transport: new StreamableHTTPClientTransport(new URL(endpoint), { authProvider: provider }),
  });
  const first = open();
  try {
    await first.client.connect(first.transport);
    return first.client;
  } catch (error) {
    if (!(error instanceof UnauthorizedError) || !provider.authorizationUrl) throw error;
  }
  const back = await approve(provider.authorizationUrl);
  const code = back.searchParams.get("code");
  if (!code) throw new Error(`authorization was not approved: ${back.searchParams.get("error") ?? "no code"}`);
  await first.transport.finishAuth(code);
  const second = open();
  await second.client.connect(second.transport);
  return second.client;
}
