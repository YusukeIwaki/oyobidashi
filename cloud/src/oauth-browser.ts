/// <reference lib="dom" />
import {initializeApp} from "firebase/app";
import {
  getAuth,
  setPersistence,
  inMemoryPersistence,
  signOut,
  signInWithPopup,
  GoogleAuthProvider,
  GithubAuthProvider,
  OAuthProvider,
  type AuthProvider,
  type User,
} from "firebase/auth";
import type {AccountProvider} from "../../relay/src/auth-handoff.ts";
import {browserAuthFailure, parsePublicAuthConfig} from "./auth-browser-flow.ts";
import {authorizationParams, pairedDevices, pairingUrl, qrPath} from "./oauth-browser-flow.ts";

// Consent page for a hosted MCP client (/oauth/authorize) and the standalone
// pairing page (/pair). The Firebase session lives in memory only and its ID
// token is sent to this origin alone; nothing is stored or placed in a URL.

const main = document.querySelector("main");
const element = (id: string) => document.getElementById(id)!;
const heading = element("heading"), explanation = element("explanation"), details = element("details");
const providers = element("providers"), pairing = element("pairing"), qr = element("qr");
const pairingHint = element("pairing-hint"), actions = element("actions"), status = element("status");
const mode = main?.dataset.mode === "pair" ? "pair" : "authorize";
const clientName = main?.dataset.client || "名前のないアプリ";
const request = authorizationParams(location.search);
const labels: Record<AccountProvider,string> = {google:"Google", apple:"Apple", github:"GitHub"};
const UNREACHABLE = "通信できませんでした。接続を確認して、もう一度お試しください。";
let user: User | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let finished = false;

function message(text: string) { status.textContent = text; }
function button(label: string, onClick: (self: HTMLButtonElement) => void, quiet = false) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  if (quiet) node.className = "quiet";
  node.addEventListener("click", () => onClick(node));
  return node;
}
function setDisabled(disabled: boolean) {
  document.querySelectorAll("button").forEach(node => {node.disabled = disabled;});
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
async function call(path: string, init: {method: string; body?: unknown; signedIn?: boolean}): Promise<unknown> {
  const headers: Record<string,string> = {accept:"application/json"};
  if (init.signedIn !== false) {
    if (!user) throw new Error("not signed in");
    headers.authorization = `Bearer ${await user.getIdToken()}`;
  }
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, location.origin), {
    method: init.method, headers, credentials:"omit", cache:"no-store", redirect:"error", signal:AbortSignal.timeout(15000),
    ...(init.body !== undefined ? {body:JSON.stringify(init.body)} : {}),
  });
  if (!response.ok) throw Object.assign(new Error("request failed"), {status:response.status});
  return response.json();
}

/** Sends the decision and leaves for the client's registered redirect address. */
async function decide(decision: "approve" | "deny") {
  if (finished) return;
  setDisabled(true);
  clearTimeout(pollTimer);
  message(decision === "approve" ? "接続しています…" : "取り消しています…");
  try {
    const result = await call("/oauth/authorize", {method:"POST", body:{...request, decision}, signedIn:decision === "approve"}) as {redirect_to?: unknown};
    if (typeof result.redirect_to !== "string") throw new Error("invalid response");
    finished = true;
    providers.replaceChildren();
    actions.replaceChildren();
    pairing.hidden = true;
    message(decision === "approve"
      ? "接続を許可しました。元のアプリに戻ります。画面が切り替わらない場合は、このタブを閉じてください。"
      : "接続を許可しませんでした。このタブは閉じて構いません。");
    location.assign(result.redirect_to);
  } catch (error) {
    const code = (error as {status?: number}).status;
    message(code === 429 ? "試行が集中しています。少し待ってから、もう一度お試しください。"
      : code === 400 || code === 401 || code === 403 ? "接続を完了できませんでした。元のアプリから接続をやり直してください。"
      : UNREACHABLE);
    setDisabled(false);
  }
}

function drawQr(text: string) {
  const {size, path} = qrPath(text);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "ペアリング用のQRコード");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", path);
  shape.setAttribute("fill", "#000");
  svg.append(shape);
  qr.replaceChildren(svg);
}

/** Shows a one-time pairing code and watches for the phone to appear. */
async function showPairing(alreadyPaired: number) {
  clearTimeout(pollTimer);
  providers.replaceChildren();
  actions.replaceChildren();
  message("QRコードを準備しています…");
  let issued: {code?: unknown; expires_at?: unknown};
  try {
    issued = await call("/v1/pairing-codes", {method:"POST", body:{}}) as typeof issued;
    if (typeof issued.code !== "string" || typeof issued.expires_at !== "string") throw new Error("invalid response");
  } catch (error) {
    message((error as {status?: number}).status === 429 ? "ペアリングできる台数の上限か、試行回数の上限に達しました。少し待ってからお試しください。" : UNREACHABLE);
    actions.replaceChildren(button("再試行", () => void showPairing(alreadyPaired)));
    if (mode === "authorize") actions.append(button("ペアリングせずに接続する", () => void decide("approve"), true));
    return;
  }
  const link = pairingUrl(location.origin, issued.code);
  const expires = Date.parse(issued.expires_at);
  drawQr(link);
  pairing.hidden = false;
  heading.textContent = "スマホをペアリング";
  explanation.textContent = mode === "authorize"
    ? "質問や通知を受け取るスマホを登録します。"
    : alreadyPaired > 0 ? `登録済みのスマホが${alreadyPaired}台あります。追加するスマホで読み取ってください。` : "質問や通知を受け取るスマホを登録します。";
  details.hidden = true;
  pairingHint.textContent = "スマホの「お呼び出し」アプリを開き、このQRコードを読み取ってください。QRコードは10分間、1回だけ使えます。";
  actions.replaceChildren(button("このスマホでアプリを開く", () => {location.href = link;}, true));
  if (mode === "authorize") actions.append(button("あとでペアリングする", () => void decide("approve"), true));
  message("スマホの登録を待っています…");

  const poll = async () => {
    if (finished) return;
    if (Date.now() >= expires) {
      pairing.hidden = true;
      qr.replaceChildren();
      message("QRコードの有効期限が切れました。");
      actions.replaceChildren(button("QRコードを更新", () => void showPairing(alreadyPaired)));
      if (mode === "authorize") actions.append(button("あとでペアリングする", () => void decide("approve"), true));
      return;
    }
    try {
      if (pairedDevices(await call("/v1/presence", {method:"GET"})) > alreadyPaired) {
        pairing.hidden = true;
        qr.replaceChildren();
        if (mode === "authorize") return void decide("approve");
        heading.textContent = "ペアリングが完了しました";
        explanation.textContent = "このスマホへ質問や通知が届くようになりました。";
        actions.replaceChildren(button("別のスマホも登録する", () => void showPairing(alreadyPaired + 1), true));
        message("このタブは閉じて構いません。");
        return;
      }
    } catch { /* A missed poll is retried; the code stays valid until it expires. */ }
    pollTimer = setTimeout(() => void poll(), 2500);
  };
  pollTimer = setTimeout(() => void poll(), 2500);
}

async function signedIn() {
  providers.replaceChildren();
  actions.replaceChildren();
  message("アカウントを確認しています…");
  let count: number;
  try { count = pairedDevices(await call("/v1/presence", {method:"GET"})); }
  catch {
    message(UNREACHABLE);
    actions.replaceChildren(button("再試行", () => void signedIn()));
    return;
  }
  if (mode === "authorize" && count > 0) return decide("approve");
  await showPairing(count);
}

async function start() {
  providers.replaceChildren();
  message("準備しています…");
  try {
    const response = await fetch(new URL("/v1/auth/config", location.origin), {credentials:"omit", cache:"no-store", redirect:"error", signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error("authentication configuration unavailable");
    const config = parsePublicAuthConfig(await response.json());
    // A distinct in-memory Firebase instance never adopts another tab's account:
    // the human always chooses the account for this approval explicitly.
    const auth = getAuth(initializeApp(config.firebase, `oyobidashi-oauth-${crypto.randomUUID()}`));
    await setPersistence(auth, inMemoryPersistence);
    await signOut(auth);
    for (const provider of config.providers)
      providers.append(button(`${labels[provider]}でログイン${mode === "authorize" ? "して許可" : ""}`, () => {
        if (user || finished) return;
        setDisabled(true);
        message("ログイン画面で操作を完了してください。");
        // Nothing is awaited before opening the popup: preserve the click gesture.
        void signInWithPopup(auth, providerFor(provider)).then(result => {
          if (result.user.isAnonymous) throw new Error("anonymous account");
          user = result.user;
          return signedIn();
        }).catch(error => {
          user = undefined;
          message(browserAuthFailure(error).message);
          setDisabled(false);
        });
      }));
    if (mode === "authorize") actions.replaceChildren(button("許可しない", () => void decide("deny"), true));
    message(config.providers.length ? "" : "ログイン方法が設定されていません。");
  } catch {
    message("準備ができませんでした。接続を確認して、もう一度お試しください。");
    providers.replaceChildren(button("再試行", () => void start()));
  }
}

if (mode === "authorize") {
  heading.textContent = "お呼び出しへの接続を許可";
  explanation.textContent = `「${clientName}」が、あなたのスマホへ質問や通知を送れるようになります。ログインすると許可したことになります。`;
  for (const [term, value] of [["接続するアプリ", clientName], ["許可後の戻り先", main?.dataset.redirect ?? ""]] as const) {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    details.append(dt, dd);
  }
  details.hidden = false;
} else {
  heading.textContent = "スマホをペアリング";
  explanation.textContent = "MCPの接続に使ったアカウントでログインすると、お呼び出しアプリで読み取るQRコードを表示します。";
}
void start();
