import type { JWTVerifyGetKey } from "jose";
import { firebaseVerifier } from "./auth.ts";
import { CloudError, unauthorized } from "./errors.ts";
import { hash } from "./service.ts";

export const MCP_REVIEW_OWNER_PREFIX = "review-mcp-";

export interface McpReviewAuth {
  projectId: string;
  apiKey: string;
  ownerUid: string;
  verify(token: string): Promise<void>;
}

export function loadMcpReviewAuth(raw: string | undefined, productionProjectId: string, keys?: JWTVerifyGetKey): McpReviewAuth | undefined {
  if (!raw) return;
  const config = JSON.parse(raw) as Record<string, unknown> | null;
  const { projectId, apiKey, uid } = config ?? {};
  if (typeof projectId !== "string" || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId) ||
      projectId === productionProjectId || typeof apiKey !== "string" || !/^[\w-]{20,100}$/.test(apiKey) ||
      typeof uid !== "string" || !uid || uid.length > 128)
    throw new Error("MCP_REVIEW_FIREBASE must specify a separate Firebase project, API key, and one review UID");
  const verifier = firebaseVerifier(projectId, keys);
  return {
    projectId, apiKey,
    ownerUid: `${MCP_REVIEW_OWNER_PREFIX}${hash(`${projectId}:${uid}`).slice(0, 32)}`,
    async verify(token) {
      if (token.length > 8192) throw unauthorized();
      const identity = await verifier.identify!(token);
      if (identity.uid !== uid || identity.provider !== "password")
        throw new CloudError(403, "forbidden", "sign in with the dedicated review account");
    },
  };
}
