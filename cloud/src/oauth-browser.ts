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
import {authorizationParams, canPostponeInputConsent, isHostedService, isPhoneToPair, pairedDevices, pairingUrl, qrPath, stepAfterSignIn} from "./oauth-browser-flow.ts";
import {INPUT_RESTRICTION_TERMS, UNRESTRICTED_INPUT, parseInputRestriction, type InputRestriction} from "./input-restriction.ts";

// Consent page for a hosted MCP client (/oauth/authorize) and the standalone
// pairing page (/pair). The Firebase session lives in memory only and its ID
// token is sent to this origin alone; nothing is stored or placed in a URL.

const main = document.querySelector("main");
const element = (id: string) => document.getElementById(id)!;
const heading = element("heading"), explanation = element("explanation"), details = element("details");
const providers = element("providers"), pairing = element("pairing"), qr = element("qr");
const pairingHint = element("pairing-hint"), actions = element("actions"), status = element("status");
const mode = main?.dataset.mode === "pair" ? "pair" : main?.dataset.mode === "connections" ? "connections" : "authorize";
const clientName = main?.dataset.client || "名前のないアプリ";
const request = authorizationParams(location.search);
const thisPhone = isPhoneToPair(location.search, navigator.userAgent);
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
  if (response.status === 204) return null;
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
      : code === 409 ? "FREEプランの入力制限への同意が必要です。ページを読み込み直して、もう一度お試しください。"
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
  qr.hidden = false;
}

function describe(entries: readonly (readonly [string, string])[]) {
  details.replaceChildren();
  for (const [term, value] of entries) {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    details.append(dt, dd);
  }
  details.hidden = false;
}
const clientDetails = [["アプリの自己申告名（未確認）", clientName], ["許可後の戻り先", main?.dataset.redirect ?? ""]] as const;

/**
 * The FREE plan input restriction. Its own screen and its own button: the human
 * accepts what they must not send, not a generic set of terms.
 */
function showInputRestriction(restriction: InputRestriction, paired: number) {
  clearTimeout(pollTimer);
  providers.replaceChildren();
  pairing.hidden = true;
  const terms = INPUT_RESTRICTION_TERMS;
  heading.textContent = terms.heading;
  explanation.textContent = terms.summary;
  describe([...terms.rules.map((rule, index) => [`同意する内容 ${index + 1}`, rule] as const), ["制限のないプラン", terms.alternative]]);
  const proceed = () => continueSignedIn(UNRESTRICTED_INPUT, paired);
  actions.replaceChildren(button(terms.accept, async () => {
    setDisabled(true);
    message("記録しています…");
    try {
      const accepted = parseInputRestriction(await call("/v1/input-restriction", {method:"POST", body:{accept:true, version:restriction.version}}));
      if (!accepted.accepted) throw new Error("not accepted");
      setDisabled(false);
      proceed();
    } catch (error) {
      message((error as {status?: number}).status === 409 ? "内容が更新されました。ページを読み込み直してください。" : UNREACHABLE);
      setDisabled(false);
    }
  }));
  if (canPostponeInputConsent(mode)) actions.append(button("あとで確認する", proceed, true));
  else actions.append(button("同意せず、接続しない", () => void decide("deny"), true));
  message(canPostponeInputConsent(mode)
    ? "同意するまで音声通話は使えず、質問は文字で届きます。"
    : "同意すると、次の画面でアプリの接続を確認できます。");
}

function showApproval() {
  if (mode !== "authorize") return;
  clearTimeout(pollTimer);
  pairing.hidden = true;
  qr.replaceChildren();
  heading.textContent = "接続の許可を確認";
  explanation.textContent = `未確認のアプリ「${clientName}」に、あなたのスマホへの質問・通知を許可しますか？`;
  describe(clientDetails);
  actions.replaceChildren(
    button("このアプリを許可する", () => void decide("approve")),
    button("許可しない", () => void decide("deny"), true),
  );
  message("接続先を確認してから選んでください。");
}

async function showConnections() {
  if (mode !== "connections") return;
  providers.replaceChildren();
  actions.replaceChildren();
  details.hidden = true;
  message("接続済みアプリを確認しています…");
  try {
    const result = await call("/oauth/grants", {method:"GET"}) as {
      grants?: {id: string; name: string | null; redirect_uri: string | null; last_used_at: string}[];
    };
    if (!Array.isArray(result.grants)) throw new Error("invalid response");
    heading.textContent = "接続済みアプリ";
    explanation.textContent = "ここで取り消すと、そのアプリはスマホへ質問や通知を送れなくなります。";
    for (const grant of result.grants) {
      const section = document.createElement("section");
      const title = document.createElement("p");
      title.textContent = `未確認のアプリ: ${grant.name || "名前なし"}`;
      const destination = document.createElement("p");
      destination.textContent = `戻り先: ${grant.redirect_uri || "不明"}`;
      const revoke = button("接続を取り消す", async () => {
        setDisabled(true);
        try {
          await call(`/oauth/grants/${encodeURIComponent(grant.id)}`, {method:"DELETE"});
          section.remove();
          message("接続を取り消しました。");
        } catch { message(UNREACHABLE); }
        setDisabled(false);
      });
      section.append(title, destination, revoke);
      actions.append(section);
    }
    message(result.grants.length ? "アプリ名は接続元の自己申告です。" : "接続済みアプリはありません。");
  } catch {
    message(UNREACHABLE);
    actions.replaceChildren(button("再試行", () => void showConnections()));
  }
}

/** Shows a one-time pairing code and watches for the phone to appear. */
async function showPairing(alreadyPaired: number) {
  clearTimeout(pollTimer);
  providers.replaceChildren();
  actions.replaceChildren();
  message("ペアリングを準備しています…");
  let issued: {code?: unknown; expires_at?: unknown};
  try {
    issued = await call("/v1/pairing-codes", {method:"POST", body:{}}) as typeof issued;
    if (typeof issued.code !== "string" || typeof issued.expires_at !== "string") throw new Error("invalid response");
  } catch (error) {
    message((error as {status?: number}).status === 429 ? "ペアリングできる台数の上限か、試行回数の上限に達しました。少し待ってからお試しください。" : UNREACHABLE);
    actions.replaceChildren(button("再試行", () => void showPairing(alreadyPaired)));
    if (mode === "authorize") actions.append(button("ペアリングせずに進む", () => showApproval(), true));
    return;
  }
  const link = pairingUrl(location.origin, issued.code);
  const expires = Date.parse(issued.expires_at);
  pairing.hidden = false;
  heading.textContent = "スマホをペアリング";
  explanation.textContent = mode === "authorize"
    ? "質問や通知を受け取るスマホを登録します。"
    : alreadyPaired > 0 ? `登録済みのスマホが${alreadyPaired}台あります。追加するスマホを登録します。` : "質問や通知を受け取るスマホを登録します。";
  details.hidden = true;
  const qrHint = "お呼び出しアプリの「QRコードを読み取る」でも登録できます。コードは10分間、1回だけ使えます。";
  if (thisPhone) {
    // The phone in hand cannot scan its own screen: lead with the way back into the app.
    qr.replaceChildren();
    qr.hidden = true;
    pairingHint.textContent = "下のボタンでお呼び出しアプリに戻り、ペアリングを確認してください。ボタンは10分間、1回だけ使えます。";
    actions.replaceChildren(button("アプリを開く", () => {location.href = link;}), button("別のスマホで読み取るQRコードを表示", self => {
      drawQr(link);
      pairingHint.textContent = "登録するスマホのお呼び出しアプリで、このQRコードを読み取ってください。コードは10分間、1回だけ使えます。";
      self.remove();
    }, true));
  } else {
    drawQr(link);
    pairingHint.textContent = isHostedService(location.origin)
      ? `スマホのお呼び出しアプリで「Oyobidashiクラウドに接続」を押し、このアカウントでログインしてください。${qrHint}`
      : "スマホのお呼び出しアプリで「自分で用意したサーバーに接続」を押し、「QRコードを読み取る」でこのQRコードを読み取ってください。コードは10分間、1回だけ使えます。";
    // A computer cannot open the phone's app: the link back is offered on the phone only.
    actions.replaceChildren();
  }
  if (mode === "authorize") actions.append(button("あとでペアリングする", () => showApproval(), true));
  message("スマホの登録を待っています…");

  const poll = async () => {
    if (finished) return;
    if (Date.now() >= expires) {
      pairing.hidden = true;
      qr.replaceChildren();
      message("ペアリングコードの有効期限が切れました。");
      actions.replaceChildren(button("コードを更新", () => void showPairing(alreadyPaired)));
      if (mode === "authorize") actions.append(button("あとでペアリングする", () => showApproval(), true));
      return;
    }
    try {
      if (pairedDevices(await call("/v1/presence", {method:"GET"})) > alreadyPaired) {
        pairing.hidden = true;
        qr.replaceChildren();
        if (mode === "authorize") return showApproval();
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
  let count: number, restriction: InputRestriction;
  try {
    restriction = parseInputRestriction(await call("/v1/input-restriction", {method:"GET"}));
    count = mode === "connections" ? 0 : pairedDevices(await call("/v1/presence", {method:"GET"}));
  } catch {
    message(UNREACHABLE);
    actions.replaceChildren(button("再試行", () => void signedIn()));
    return;
  }
  continueSignedIn(restriction, count);
}

function continueSignedIn(restriction: InputRestriction, paired: number) {
  message("");
  switch (stepAfterSignIn(mode, restriction, paired)) {
    case "input_restriction": return showInputRestriction(restriction, paired);
    case "connections": return void showConnections();
    case "approval": return showApproval();
    case "pairing": return void showPairing(paired);
  }
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
      providers.append(button(`${labels[provider]}でログイン`, () => {
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
  explanation.textContent = `未確認のアプリ「${clientName}」が、あなたのスマホへ質問や通知を送ろうとしています。ログイン後に許可するか選べます。`;
  describe(clientDetails);
} else if (mode === "pair") {
  heading.textContent = "スマホをペアリング";
  explanation.textContent = thisPhone
    ? "エージェント（MCP）の接続に使ったアカウントでログインすると、このスマホを登録できます。"
    : "エージェント（MCP）の接続に使ったアカウントでログインすると、スマホを登録する手順を表示します。";
} else {
  heading.textContent = "接続済みアプリ";
  explanation.textContent = "接続に使ったアカウントでログインすると、許可したアプリを確認・取り消しできます。";
}
void start();
