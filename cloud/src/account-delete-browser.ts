/// <reference lib="dom" />
import { initializeApp } from "firebase/app";
import { browserPopupRedirectResolver, inMemoryPersistence, initializeAuth, OAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { parsePublicAuthConfig } from "./auth-browser-flow.ts";

const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
history.replaceState(null, "", location.pathname);
const status = document.getElementById("status")!;
const explanation = document.getElementById("explanation")!;

async function start() {
  if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    explanation.textContent = "設定からアカウント削除を開始してください。";
    return;
  }
  const response = await fetch("/v1/auth/config", { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error();
  const config = parsePublicAuthConfig(await response.json());
  const auth = initializeAuth(initializeApp(config.firebase), { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
  explanation.textContent = "このアカウントで使ったApple Accountで本人確認し、お呼び出しとの連携を解除してアカウントを削除します。";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Appleで本人確認して削除";
  document.getElementById("providers")!.append(button);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await signInWithPopup(auth, new OAuthProvider("apple.com"));
      const credential = OAuthProvider.credentialFromResult(result);
      if (!credential?.accessToken) throw new Error();
      const deletion = await fetch("/v1/account/deletion/apple", {
        method: "POST", redirect: "error", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, identity_token: await result.user.getIdToken(), apple_token: credential.accessToken }),
      });
      if (!deletion.ok) throw new Error();
      status.textContent = "アカウントを削除しました。アプリに戻ってください。";
      await signOut(auth).catch(() => {});
      location.href = "oyobidashi://account-deleted#ticket=" + ticket;
    } catch {
      await signOut(auth).catch(() => {});
      status.textContent = "削除を完了できませんでした。アカウントを確認するか、アプリの設定からやり直してください。";
      button.disabled = false;
    }
  });
}

void start().catch(() => { explanation.textContent = "接続できませんでした。アプリの設定からやり直してください。"; });
