import { importPKCS8, SignJWT } from "jose";
import {
  ACCOUNT_PROVIDERS,
  type AccountProvider,
} from "../../relay/src/auth-handoff.ts";

export interface PublicAuthConfig {
  firebase: { apiKey: string; projectId: string; authDomain: string };
  providers: AccountProvider[];
  canLinkExisting: boolean;
}
export interface AccountAuth {
  publicConfig: PublicAuthConfig;
  issueLinkToken(uid: string): Promise<string>;
}

/** The signer is used only after the API verifies the caller's own Firebase UID. */
export async function createAccountAuth(
  env: Record<string, string | undefined>,
  now: () => number = Date.now,
): Promise<AccountAuth | undefined> {
  const apiKey = env.FIREBASE_WEB_API_KEY?.trim();
  if (!apiKey) return undefined;
  const projectId = env.FIREBASE_PROJECT_ID ?? "";
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId))
    throw new Error("Invalid Firebase authentication configuration");
  const providers = [
    ...new Set(
      (env.FIREBASE_AUTH_PROVIDERS ?? "google")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  if (providers.some((x) => !ACCOUNT_PROVIDERS.includes(x as AccountProvider)))
    throw new Error("Invalid Firebase authentication providers");
  let key: Awaited<ReturnType<typeof importPKCS8>> | undefined;
  let email = "";
  if (env.FIREBASE_AUTH_SERVICE_ACCOUNT_JSON) {
    try {
      const account = JSON.parse(env.FIREBASE_AUTH_SERVICE_ACCOUNT_JSON);
      if (
        account.type !== "service_account" ||
        account.project_id !== projectId ||
        typeof account.client_email !== "string" ||
        !account.client_email.endsWith(
          `@${projectId}.iam.gserviceaccount.com`,
        ) ||
        typeof account.private_key !== "string"
      )
        throw new Error();
      email = account.client_email;
      key = await importPKCS8(account.private_key, "RS256");
    } catch {
      throw new Error("Invalid Firebase account-link signer configuration");
    }
  }
  return {
    publicConfig: {
      firebase: {
        apiKey,
        projectId,
        authDomain: `${projectId}.firebaseapp.com`,
      },
      providers: providers as AccountProvider[],
      canLinkExisting: !!key,
    },
    async issueLinkToken(uid) {
      if (!key) throw new Error("Account linking is unavailable");
      if (!uid || uid.length > 128 || /[\r\n]/.test(uid))
        throw new Error("Invalid account identifier");
      const at = Math.floor(now() / 1000);
      return new SignJWT({ uid })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(email)
        .setSubject(email)
        .setAudience(
          "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
        )
        .setIssuedAt(at)
        .setExpirationTime(at + 300)
        .sign(key);
    },
  };
}

export const AUTH_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>お呼び出し — アカウント</title><style>
body{font:16px/1.65 system-ui,sans-serif;background:#faf6eb;color:#29251f;margin:0;padding:32px 18px}main{max-width:480px;margin:9vh auto;background:#fffef9;border:1px solid #e6dfd1;border-radius:20px;padding:28px}h1{font-size:24px;line-height:1.4}button{display:block;width:100%;padding:14px;margin:12px 0;border-radius:12px;border:1px solid #d6cdbb;background:#fff;color:#29251f;font:inherit;cursor:pointer}button:disabled{opacity:.55;cursor:wait}p{color:#625b50}#status{min-height:2em;white-space:pre-wrap}footer{font-size:13px;margin-top:28px;color:#746b5b}
</style><script type="module" src="/auth.js"></script></head><body><main><h1 id="heading">お呼び出しのアカウント</h1><p id="explanation">認証を準備しています…</p><div id="providers"></div><p id="status" role="status" aria-live="polite"></p><footer>お使いのパソコンのMCPに接続します。認証画面はご自身で開始した場合だけ進めてください。</footer></main></body></html>`;

export function authPageHeaders(type: string): Record<string, string> {
  return {
    "content-type": type,
    "cache-control": "no-store",
    // Cross-origin form POSTs otherwise send Origin:null. Fragments never enter Referrer.
    "referrer-policy": "origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "content-security-policy":
      "default-src 'none'; script-src 'self' https://apis.google.com; style-src 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://*.firebaseapp.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://appleid.apple.com https://github.com; form-action http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
  };
}
