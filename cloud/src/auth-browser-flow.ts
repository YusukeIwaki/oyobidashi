import {
  ACCOUNT_PROVIDERS,
  parseAuthHandoff,
  type AccountProvider,
  type AuthHandoff,
} from "../../relay/src/auth-handoff.ts";

export interface PublicAuthConfig {
  firebase: { apiKey: string; projectId: string; authDomain: string };
  providers: AccountProvider[];
  canLinkExisting: boolean;
}

export interface BrowserAuthUser {
  readonly uid: string;
  readonly refreshToken: string;
  getIdToken(): Promise<string>;
  getIdTokenResult(): Promise<{ expirationTime: string }>;
}

export interface BrowserAuthSdk<User extends BrowserAuthUser> {
  resetSession(): Promise<void>;
  signInWithCustomToken(token: string): Promise<{ user: User }>;
  signInWithPopup(provider: AccountProvider): Promise<{ user: User }>;
  linkWithPopup(user: User, provider: AccountProvider): Promise<{ user: User }>;
}

export interface AuthCallbackFields {
  state: string;
  id_token: string;
  refresh_token: string;
  expires_at: string;
}

export interface BrowserFlowResult {
  status: "ready" | "complete" | "busy" | "error";
  message: string;
  retryable: boolean;
}

class FlowFailure extends Error {
  constructor(readonly reason: "identity" | "tokens" | "provider" | "link_unavailable") {
    super("authentication flow could not continue");
  }
}

function safeConfigString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/\s/.test(value);
}

/** Validate the public configuration without exposing malformed response contents. */
export function parsePublicAuthConfig(value: unknown): PublicAuthConfig {
  const fail = (): never => { throw new Error("invalid public authentication configuration"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  const firebase = raw.firebase;
  if (!firebase || typeof firebase !== "object" || Array.isArray(firebase)) return fail();
  const fields = firebase as Record<string, unknown>;
  if (!safeConfigString(fields.apiKey, 256) || !safeConfigString(fields.projectId, 128) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(fields.projectId) || !safeConfigString(fields.authDomain, 253)) return fail();
  let domain: URL;
  try { domain = new URL(`https://${fields.authDomain}`); } catch { return fail(); }
  if (domain.hostname !== fields.authDomain.toLowerCase() || domain.port || domain.pathname !== "/" ||
      domain.username || domain.password || domain.search || domain.hash) return fail();
  if (!Array.isArray(raw.providers) || raw.providers.length > ACCOUNT_PROVIDERS.length ||
      raw.providers.some(item => !ACCOUNT_PROVIDERS.includes(item as AccountProvider)) || typeof raw.canLinkExisting !== "boolean") return fail();
  return {
    firebase: { apiKey: fields.apiKey, projectId: fields.projectId, authDomain: fields.authDomain },
    providers: [...new Set(raw.providers as AccountProvider[])],
    canLinkExisting: raw.canLinkExisting,
  };
}

/** Provider errors are classified by known code only; raw messages never reach UI. */
export function browserAuthFailure(error: unknown): BrowserFlowResult {
  if (error instanceof FlowFailure) {
    if (error.reason === "identity") return {status:"error", retryable:false, message:"元の利用者を確認できませんでした。元のターミナルからやり直してください。"};
    if (error.reason === "provider") return {status:"error", retryable:false, message:"指定されたログイン方法は現在利用できません。元のターミナルから別の方法を選んでください。"};
    if (error.reason === "link_unavailable") return {status:"error", retryable:false, message:"復旧用アカウントの登録は現在利用できません。しばらくしてから、元のターミナルでお試しください。"};
    return {status:"error", retryable:true, message:"認証情報を確認できませんでした。もう一度お試しください。"};
  }
  const code = error && typeof error === "object" ? (error as {code?:unknown}).code : undefined;
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return {status:"error", retryable:true, message:"操作を取り消しました。もう一度ログイン方法を選んでください。"};
    case "auth/popup-blocked":
      return {status:"error", retryable:true, message:"ポップアップがブロックされました。許可してから、もう一度お試しください。"};
    case "auth/credential-already-in-use":
    case "auth/account-exists-with-different-credential":
    case "auth/email-already-in-use":
      return {status:"error", retryable:true, message:"別の利用者に登録済みのため、このペアリングへはひも付けられません。既存の利用者に戻る場合は復旧ログインを使ってください。"};
    case "auth/operation-not-allowed":
    case "auth/unauthorized-domain":
    case "auth/invalid-provider-id":
      return {status:"error", retryable:true, message:"このログイン方法は現在利用できません。別の方法を選ぶか、しばらくしてからお試しください。"};
    case "auth/network-request-failed":
      return {status:"error", retryable:true, message:"通信できませんでした。接続を確認して、もう一度お試しください。"};
    case "auth/too-many-requests":
      return {status:"error", retryable:true, message:"試行が集中しています。少し待ってから、もう一度お試しください。"};
    case "auth/invalid-custom-token":
    case "auth/custom-token-mismatch":
    case "auth/user-token-expired":
    case "auth/invalid-user-token":
      return {status:"error", retryable:false, message:"認証の有効期限が切れた可能性があります。元のターミナルからやり直してください。"};
    default:
      return {status:"error", retryable:true, message:"認証を完了できませんでした。もう一度お試しください。"};
  }
}

const ready = (): BrowserFlowResult => ({status:"ready", retryable:false, message:"ログイン方法を選んでください。"});
const busy = (): BrowserFlowResult => ({status:"busy", retryable:false, message:"認証処理中です。そのままお待ちください。"});
const complete = (): BrowserFlowResult => ({status:"complete", retryable:false, message:"認証が完了しました。元の画面に戻っています。"});
const tokenString = (value: unknown): value is string => safeConfigString(value, 32768);

/** SDK and submission are injected so identity/ordering guarantees are unit-testable. */
export function createAuthBrowserFlow<User extends BrowserAuthUser>(
  input: AuthHandoff,
  publicConfig: PublicAuthConfig,
  dependencies: {
    sdk: BrowserAuthSdk<User>;
    submit(callbackUrl: string, fields: AuthCallbackFields): void;
    now?: () => number;
  },
) {
  const handoff = parseAuthHandoff(input);
  const config = parsePublicAuthConfig(publicConfig);
  const providers = config.providers.filter(provider => !handoff.provider || provider === handoff.provider);
  let prepared = false;
  let working = false;
  let submitted = false;
  let fatal: BrowserFlowResult | undefined;
  let preparing: Promise<BrowserFlowResult> | undefined;
  let linkUser: User | undefined;
  const now = dependencies.now ?? Date.now;
  const checkUser = (user: User) => {
    if (!user || typeof user.uid !== "string" || !user.uid.trim() || user.uid.length > 128 || /[\r\n]/.test(user.uid) || (handoff.mode === "link" && user.uid !== handoff.uid)) throw new FlowFailure("identity");
  };

  async function prepare(): Promise<BrowserFlowResult> {
    if (submitted) return complete();
    if (fatal) return fatal;
    if (prepared) return ready();
    if (preparing) return preparing;
    working = true;
    preparing = (async () => {
      try {
        if (handoff.mode === "link" && !config.canLinkExisting) throw new FlowFailure("link_unavailable");
        if (!providers.length) throw new FlowFailure("provider");
        await dependencies.sdk.resetSession();
        if (handoff.mode === "link") {
          const signedIn = await dependencies.sdk.signInWithCustomToken(handoff.customToken!);
          checkUser(signedIn.user);
          linkUser = signedIn.user;
        }
        prepared = true;
        return ready();
      } catch (error) {
        const result = browserAuthFailure(error);
        if (!result.retryable) fatal = result;
        return result;
      } finally {
        working = false;
        preparing = undefined;
      }
    })();
    return preparing;
  }

  async function choose(provider: AccountProvider): Promise<BrowserFlowResult> {
    if (submitted) return complete();
    if (fatal) return fatal;
    if (working) return busy();
    if (!prepared || !providers.includes(provider)) return browserAuthFailure(new FlowFailure("provider"));
    working = true;
    try {
      // Nothing is awaited before opening the popup: preserve the click gesture.
      let result: {user:User};
      if (handoff.mode === "link") {
        if (!linkUser) throw new FlowFailure("identity");
        checkUser(linkUser);
        result = await dependencies.sdk.linkWithPopup(linkUser, provider);
      } else result = await dependencies.sdk.signInWithPopup(provider);
      checkUser(result.user);
      const idToken = await result.user.getIdToken();
      const tokenResult = await result.user.getIdTokenResult();
      const expiresAt = Date.parse(tokenResult.expirationTime);
      const refreshToken = result.user.refreshToken;
      checkUser(result.user);
      if (!tokenString(idToken) || !tokenString(refreshToken) || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) throw new FlowFailure("tokens");
      dependencies.submit(handoff.callbackUrl, {state:handoff.state, id_token:idToken, refresh_token:refreshToken, expires_at:String(expiresAt)});
      submitted = true;
      return complete();
    } catch (error) {
      const result = browserAuthFailure(error);
      if (!result.retryable) fatal = result;
      return result;
    } finally { working = false; }
  }
  return {providers, prepare, choose, get busy(){return working;}, get completed(){return submitted;}};
}
