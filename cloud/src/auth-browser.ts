/// <reference lib="dom" />
import {initializeApp} from "firebase/app";
import {
  getAuth,
  setPersistence,
  inMemoryPersistence,
  signOut,
  signInWithCustomToken,
  signInWithPopup,
  linkWithPopup,
  GoogleAuthProvider,
  GithubAuthProvider,
  OAuthProvider,
  type AuthProvider,
} from "firebase/auth";
import {decodeAuthFragment, type AccountProvider, type AuthHandoff} from "../../relay/src/auth-handoff.ts";
import {createAuthBrowserFlow, parsePublicAuthConfig, type AuthCallbackFields, type BrowserFlowResult} from "./auth-browser-flow.ts";

const heading = document.getElementById("heading");
const explanation = document.getElementById("explanation");
const providers = document.getElementById("providers");
const status = document.getElementById("status");
const labels: Record<AccountProvider,string> = {google:"Google", apple:"Apple", github:"GitHub"};
let handoff: AuthHandoff | undefined;

// Remove the custom token and one-time state from the address bar before any
// configuration request or provider interaction. Invalid fragments are cleared too.
try { handoff = decodeAuthFragment(location.hash); }
catch { /* Only the safe static message below is rendered. */ }
finally { history.replaceState(null, "", location.pathname + location.search); }

function message(text: string) { if (status) status.textContent = text; }
function setDisabled(disabled: boolean) {
  providers?.querySelectorAll("button").forEach(button => {button.disabled = disabled;});
}
function retry(action: () => Promise<void>) {
  if (!providers) return;
  providers.replaceChildren();
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "再試行";
  button.addEventListener("click", () => {button.disabled = true; void action().catch(() => {message("通信できませんでした。接続を確認して、もう一度お試しください。");button.disabled = false;});});
  providers.append(button);
}
function providerFor(provider: AccountProvider): AuthProvider {
  if (provider === "google") {
    const google = new GoogleAuthProvider();
    google.setCustomParameters({prompt:"select_account"});
    return google;
  }
  if (provider === "github") return new GithubAuthProvider();
  return new OAuthProvider("apple.com");
}
function submit(callbackUrl: string, fields: AuthCallbackFields) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = callbackUrl;
  form.target = "_self";
  form.hidden = true;
  form.acceptCharset = "UTF-8";
  form.autocomplete = "off";
  for (const [name,value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  // A top-level form navigation supports the loopback handoff without CORS or
  // putting credentials in URLs, storage, logs or visible page content.
  HTMLFormElement.prototype.submit.call(form);
}

async function start() {
  if (!handoff || !providers) return;
  const current = handoff;
  providers.replaceChildren();
  message("認証の準備中です…");
  try {
    const response = await fetch(new URL("/v1/auth/config", location.origin), {credentials:"omit", cache:"no-store", redirect:"error", signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error("authentication configuration unavailable");
    const config = parsePublicAuthConfig(await response.json());
    // A distinct in-memory Firebase instance never adopts another browser tab's
    // persisted account. resetSession also signs out before either explicit flow.
    const app = initializeApp(config.firebase, `oyobidashi-auth-${crypto.randomUUID()}`);
    const auth = getAuth(app);
    const flow = createAuthBrowserFlow(current, config, {
      sdk: {
        async resetSession(){await setPersistence(auth, inMemoryPersistence);await signOut(auth);},
        signInWithCustomToken: token => signInWithCustomToken(auth, token),
        signInWithPopup: provider => signInWithPopup(auth, providerFor(provider)),
        linkWithPopup: (user,provider) => linkWithPopup(user, providerFor(provider)),
      },
      submit,
    });
    const renderProviders = () => {
      providers.replaceChildren();
      for (const provider of flow.providers) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${labels[provider]}で${current.mode === "link" ? "登録" : "ログイン"}`;
        button.addEventListener("click", () => {
          if (flow.busy || flow.completed) return;
          setDisabled(true);
          message("認証画面で操作を完了してください。");
          void flow.choose(provider).then((result:BrowserFlowResult) => {
            message(result.message);
            if (result.status !== "complete" && result.retryable) setDisabled(false);
          }).catch(() => {message("認証を完了できませんでした。もう一度お試しください。");setDisabled(false);});
        });
        providers.append(button);
      }
    };
    const prepare = async () => {
      message("認証の準備中です…");
      const result = await flow.prepare();
      message(result.message);
      if (result.status === "ready") renderProviders();
      else if (result.retryable) retry(prepare);
      else providers.replaceChildren();
    };
    await prepare();
  } catch {
    message("認証の準備ができませんでした。接続を確認して、もう一度お試しください。");
    retry(start);
  }
}

if (!handoff) {
  message("認証リンクが無効か、有効期限が切れています。元のターミナルからやり直してください。");
  providers?.replaceChildren();
} else {
  if (heading) heading.textContent = handoff.mode === "link" ? "復旧用アカウントを登録" : "ログインしてペアリングを復元";
  if (explanation) explanation.textContent = handoff.mode === "link"
    ? "この端末のペアリングを保ったまま、復旧に使うアカウントを登録します。"
    : "登録済みのアカウントでログインし、ペアリングを復元します。";
  void start();
}
