/// <reference lib="dom" />
import {initializeApp} from "firebase/app";
import {
  getAuth,
  setPersistence,
  inMemoryPersistence,
  signOut,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  GithubAuthProvider,
  OAuthProvider,
  type AuthProvider,
  type User,
} from "firebase/auth";
import type {AccountProvider} from "../../relay/src/auth-handoff.ts";
import {browserAuthFailure, parsePublicAuthConfig} from "./auth-browser-flow.ts";
import {appPairingState, authorizationParams, canPostponeInputConsent, isHostedService, isPhoneToPair, MCP_REVIEW_HEADER, openedByApp, pairedDevices, pairingUrl, qrPath, stepAfterSignIn} from "./oauth-browser-flow.ts";
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
const fromApp = openedByApp(location.search);
const appState = appPairingState(location.search);
const reviewProject = main?.dataset.reviewProject;
const reviewApiKey = main?.dataset.reviewApiKey;
const reviewOnly = main?.dataset.reviewOnly === "1";
const claudeBillingEnabled = main?.dataset.claudeBilling === "1";
const labels: Record<AccountProvider,string> = {google:"Google", apple:"Apple", github:"GitHub"};
const UNREACHABLE = "通信できませんでした。接続を確認して、もう一度お試しください。";
let user: User | undefined;
let reviewUser = false;
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
    if (reviewUser) headers[MCP_REVIEW_HEADER] = "1";
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

async function showClaudeBilling() {
  if (!claudeBillingEnabled || reviewUser || location.origin !== "https://api.oyobidashi.me") return;
  const billingPath = "/oauth/claude/billing", orgPath = "/oauth/claude/organization";
  let result: {
    status: string;
    organization: {name: string; role: "admin" | "member"} | null;
    members: {uid: string; email?: string}[];
  };
  try {
    result = await call(billingPath, {method:"GET"}) as typeof result;
    if (!result.status) return;
  } catch { return; }

  const section = document.createElement("section");
  const title = document.createElement("h2");
  title.textContent = "Claude で通話に応答";
  const description = document.createElement("p");
  description.textContent = "管理者が Claude Console の組織を連携すると、招待されたメンバーが音声通話を使えます。Claude API の利用分は Anthropic が連携先の組織に直接請求します。Oyobidashi の有料プランは不要です。";
  section.append(title, description);

  function field(label: string, type = "text") {
    const node = document.createElement("label");
    const input = document.createElement("input");
    input.type = type;
    node.append(label, input);
    section.append(node);
    return input;
  }
  function action(label: string, run: () => Promise<void>) {
    const control = button(label, async () => {
      control.disabled = true;
      try { await run(); }
      catch { message("操作を完了できませんでした。入力内容とアカウントを確認して、もう一度お試しください。"); }
      finally { control.disabled = false; }
    });
    section.append(control);
    return control;
  }
  function consent() {
    const label = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    label.append(check, " 通話の文字起こし、質問、選択肢、補足、会話履歴が Anthropic に送られ、Claude API の利用分が連携した組織に請求されることに同意します。");
    section.append(label);
    return check;
  }

  const org = result.organization;
  const account = document.createElement("p");
  account.textContent = `ログイン中の Oyobidashi アカウント ${user?.email ?? user?.displayName ?? "現在のアカウント"}`;
  section.append(account);
  if (!org) {
    const name = field("新しい組織の名前");
    name.maxLength = 80;
    action("組織を作成", async () => {
      await call(orgPath, {method:"POST", body:{name:name.value.trim()}});
      await showConnections();
    });
    const invitation = field("管理者から受け取った招待コード");
    invitation.maxLength = 43;
    invitation.autocomplete = "off";
    const accepted = consent();
    action("招待を受けて組織に参加", async () => {
      if (!accepted.checked) return message("送信先と請求先を確認してください。");
      await call(`${orgPath}/accept`, {method:"POST", body:{invitation:invitation.value.trim(), accept:true}});
      await showConnections();
    });
  } else {
    const state = document.createElement("p");
    const billingStatus: Record<string, string> = {
      linked: "Claude の請求先を連携済み",
      unlink_pending: "解除の処理中です。質問は文字で返信できます。",
      relink_required: "Claude の認証を更新するため、請求先を解除してもう一度連携してください。",
      unlinked: "Claude の請求先を連携していません。",
    };
    state.textContent = `${org.name} · ${billingStatus[result.status] ?? "連携状況を確認できませんでした。"}`;
    section.append(state);
    if (org.role === "member") {
      action("組織から退出", async () => {
        if (!confirm(`${org.name} から退出しますか？`)) return;
        await call(`${orgPath}/leave`, {method:"DELETE"});
        await showConnections();
      });
    } else {
      if (result.status === "unlinked") {
        const hint = document.createElement("p");
        hint.textContent = `Claude の承認画面で、${org.name} の請求に使う Claude アカウントと組織を確認してください。`;
        section.append(hint);
        const accepted = consent();
        action("Claude の請求先を連携", async () => {
          if (!accepted.checked) return message("送信先と請求先を確認してください。");
          const response = await call(billingPath, {method:"POST", body:{accept:true}}) as {redirect_to?: string};
          const destination = new URL(response.redirect_to ?? "");
          if (destination.origin !== "https://auth.claude.com" || destination.pathname !== "/oauth/authorize") throw new Error();
          location.assign(destination.href);
        });
      } else {
        action("Claude の請求先を解除", async () => {
          if (!confirm(`${org.name} の Claude 連携を解除しますか？ メンバーからの音声通話は文字での返信に切り替わります。`)) return;
          await call(billingPath, {method:"DELETE"});
          await showConnections();
        });
        if (result.status === "linked") {
          const email = field("招待するメンバーのメールアドレス", "email");
          const invitation = field("発行した招待コード");
          invitation.readOnly = true;
          invitation.hidden = true;
          invitation.parentElement!.hidden = true;
          action("招待コードを発行", async () => {
            const issued = await call(`${orgPath}/invite`, {method:"POST", body:{email:email.value}}) as {invitation?: string};
            if (!issued.invitation) throw new Error();
            invitation.value = issued.invitation;
            invitation.hidden = false;
            invitation.parentElement!.hidden = false;
            invitation.select();
            message("招待コードを対象の利用者に渡してください。有効期限は3日間です。");
          });
        }
      }
      for (const member of result.members) {
        const row = document.createElement("p");
        row.textContent = member.email ?? "メンバー";
        section.append(row);
        action("メンバーを外す", async () => {
          if (!confirm(`${member.email ?? "このメンバー"} を ${org.name} から外しますか？`)) return;
          await call(`${orgPath}/member`, {method:"DELETE", body:{uid:member.uid}});
          await showConnections();
        });
      }
    }
  }
  actions.prepend(section);
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
    await showClaudeBilling();
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
  const otherPhone = (self: HTMLButtonElement) => {
    drawQr(link);
    pairingHint.textContent = "登録するスマホのお呼び出しアプリで、このQRコードを読み取ってください。コードは10分間、1回だけ使えます。";
    message("スマホの登録を待っています…");
    self.remove();
  };
  if (fromApp) {
    // The phone in hand cannot scan its own screen: lead with the way back into the app.
    // Only this link carries the app's one-time value; the QR code is for another phone.
    const back = pairingUrl(location.origin, issued.code, appState);
    qr.replaceChildren();
    qr.hidden = true;
    pairingHint.textContent = "下のボタンでお呼び出しアプリに戻り、ペアリングを確認してください。ボタンは10分間、1回だけ使えます。";
    actions.replaceChildren(button("アプリを開く", () => {location.href = back;}), button("別のスマホで読み取るQRコードを表示", otherPhone, true));
  } else if (thisPhone) {
    // A phone browser on its own: the app accepts a link only for a pairing it started itself.
    qr.replaceChildren();
    qr.hidden = true;
    pairingHint.textContent = isHostedService(location.origin) && !reviewUser
      ? "このスマホを登録するには、お呼び出しアプリを開いて「Oyobidashiクラウドに接続」を押し、このアカウントでログインしてください。安全のため、アプリから始めたペアリングだけを受け付けます。"
      : "このスマホを登録するには、このページをパソコンなど別の画面で開いてQRコードを表示し、お呼び出しアプリの「自分で用意したサーバーに接続」→「QRコードを読み取る」で読み取ってください。";
    actions.replaceChildren(button("別のスマホで読み取るQRコードを表示", otherPhone, true));
  } else {
    drawQr(link);
    pairingHint.textContent = isHostedService(location.origin) && !reviewUser
      ? `スマホのお呼び出しアプリで「Oyobidashiクラウドに接続」を押し、このアカウントでログインしてください。${qrHint}`
      : "スマホのお呼び出しアプリで「自分で用意したサーバーに接続」を押し、「QRコードを読み取る」でこのQRコードを読み取ってください。コードは10分間、1回だけ使えます。";
    // A computer cannot open the phone's app: the link back is offered on the phone only.
    actions.replaceChildren();
  }
  if (mode === "authorize") actions.append(button("あとでペアリングする", () => showApproval(), true));
  // On the phone itself the next step is described above; "waiting" would read as a delay.
  message(thisPhone ? "" : "スマホの登録を待っています…");

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
  if (mode === "connections" && claudeBillingEnabled && !reviewUser) return void showConnections();
  let count: number, restriction: InputRestriction;
  try {
    restriction = parseInputRestriction(await call("/v1/input-restriction", {method:"GET"}));
    count = mode === "connections" ? 0 : pairedDevices(await call("/v1/presence", {method:"GET"}));
  } catch (error) {
    if (reviewUser && [401, 403].includes((error as {status?: number}).status ?? 0)) {
      user = undefined;
      reviewUser = false;
      showReviewLogin();
      message("Use the dedicated review account.");
      return;
    }
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

function showReviewLogin() {
  if (!reviewProject || !reviewApiKey || user || finished) return;
  const form = document.createElement("form");
  form.method = "post";
  const email = document.createElement("input"), password = document.createElement("input");
  const signIn = document.createElement("button");
  email.type = "email";
  email.autocomplete = "username";
  email.required = true;
  password.type = "password";
  password.autocomplete = "current-password";
  password.required = true;
  signIn.type = "submit";
  signIn.textContent = "Sign in to the review account";
  for (const [title, input] of [["Email", email], ["Password", password]] as const) {
    const label = document.createElement("label");
    label.append(title, input);
    form.append(label);
  }
  form.append(signIn);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (signIn.disabled || user || finished) return;
    setDisabled(true);
    message("");
    try {
      const auth = getAuth(initializeApp({projectId: reviewProject, apiKey: reviewApiKey}, `oyobidashi-review-${crypto.randomUUID()}`));
      await setPersistence(auth, inMemoryPersistence);
      user = (await signInWithEmailAndPassword(auth, email.value.trim(), password.value)).user;
      reviewUser = true;
      await signedIn();
    } catch {
      message("Could not sign in. Check the review email and password, then try again.");
    } finally {
      password.value = "";
      setDisabled(false);
    }
  });
  message("");
  providers.replaceChildren(form);
  if (!reviewOnly) providers.append(button("通常のログイン方法に戻る", () => void start(), true));
}

async function start() {
  providers.replaceChildren();
  if (reviewOnly) return showReviewLogin();
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
    if (reviewProject && reviewApiKey)
      providers.append(button("Review account sign-in", showReviewLogin, true));
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
  explanation.textContent = fromApp
    ? "エージェント（MCP）の接続に使ったアカウントでログインすると、このスマホを登録できます。"
    : "エージェント（MCP）の接続に使ったアカウントでログインすると、スマホを登録する手順を表示します。";
} else {
  heading.textContent = "接続済みアプリ";
  const result = new URLSearchParams(location.search).get("claude");
  explanation.textContent = result === "linked"
    ? "ログインすると Claude の連携状態を確認できます。"
    : result === "failed"
      ? "Claude の連携は完了しませんでした。ログインしてやり直せます。"
      : "接続に使ったアカウントでログインすると、許可したアプリを確認・取り消しできます。";
}
void start();
