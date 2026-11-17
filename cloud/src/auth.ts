import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { CloudError, unauthorized, unavailable } from "./errors.ts";
import { hash, type Principal } from "./service.ts";
import type { Database, IdentityVerifier } from "./types.ts";

export function firebaseVerifier(
  projectId: string,
  keys?: JWTVerifyGetKey,
  now: () => number = Date.now,
): IdentityVerifier {
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId))
    throw new Error("valid FIREBASE_PROJECT_ID required");
  const jwks =
    keys ??
    createRemoteJWKSet(
      new URL(
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      ),
      { timeoutDuration: 5000, cacheMaxAge: 3600_000 },
    );
  const cache = new Map<
    string,
    { uid: string; provider: string | null; until: number }
  >();
  return {
    async verify(token) {
      return (await this.identify!(token)).uid;
    },
    async identify(token) {
      if (token.length > 8192) throw unauthorized();
      const digest = hash(token),
        cached = cache.get(digest);
      if (cached && cached.until > now())
        return { uid: cached.uid, provider: cached.provider };
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ["RS256"],
          issuer: `https://securetoken.google.com/${projectId}`,
          audience: projectId,
          currentDate: new Date(now()),
          requiredClaims: ["sub", "exp", "iat", "auth_time"],
        });
        if (
          typeof payload.sub !== "string" ||
          !payload.sub ||
          payload.sub.length > 128 ||
          payload.aud !== projectId ||
          !Number.isFinite(payload.iat) ||
          payload.iat! > now() / 1000 ||
          typeof payload.auth_time !== "number" ||
          payload.auth_time > now() / 1000
        )
          throw unauthorized();
        const raw = (payload.firebase as { sign_in_provider?: unknown })
            ?.sign_in_provider,
          provider = typeof raw === "string" && raw.length <= 64 ? raw : null;
        if (cache.size >= 5000) cache.delete(cache.keys().next().value!);
        cache.set(digest, {
          uid: payload.sub,
          provider,
          until: Math.min(payload.exp! * 1000, now() + 60_000),
        });
        return { uid: payload.sub, provider };
      } catch (e) {
        if (e instanceof CloudError) throw e;
        const code = (e as { code?: string })?.code;
        if (
          code?.startsWith("ERR_JWT") ||
          code?.startsWith("ERR_JWS") ||
          code === "ERR_JWKS_NO_MATCHING_KEY" ||
          code === "ERR_JOSE_ALG_NOT_ALLOWED"
        )
          throw unauthorized();
        throw unavailable();
      }
    },
  };
}

export async function authenticate(
  req: Request,
  db: Database,
  verifier: IdentityVerifier,
): Promise<Principal> {
  const match = /^Bearer +(\S+)$/i.exec(
    (req.headers.get("authorization") ?? "").trim(),
  );
  if (!match || match[1]!.length > 8192) throw unauthorized();
  const token = match[1]!;
  if (token.startsWith("kd_")) {
    const tokenHash = hash(token),
      found = await db.findDevice(tokenHash);
    if (!found) throw unauthorized();
    return {
      uid: found.uid,
      role: "device",
      deviceId: found.device.id,
      tokenHash,
    };
  }
  return { uid: await verifier.verify(token), role: "agent" };
}
export function requireRole(p: Principal, role: "agent" | "device") {
  if (p.role !== role)
    throw new CloudError(403, "forbidden", `${role} credentials required`);
}
