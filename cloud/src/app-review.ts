import { timingSafeEqual } from "node:crypto";
import qrcode from "qrcode-generator";
import { OFFICIAL_CLOUD_ORIGIN } from "./config.ts";
import { CloudError, missing } from "./errors.ts";
import { INPUT_RESTRICTION_VERSION } from "./input-restriction.ts";
import { requestOrigin } from "./oauth.ts";
import { CloudService, hash } from "./service.ts";

export interface ReviewPortalConfig {
  uid: string;
  username: string;
  passwordHash: string;
}

function parseReviewPortal(
  raw: string | undefined,
  name: string,
  allowsUid: (uid: string) => boolean,
): ReviewPortalConfig | undefined {
  if (!raw) return;
  const config = JSON.parse(raw) as Partial<ReviewPortalConfig> | null;
  if (!config || typeof config.uid !== "string" || !allowsUid(config.uid) ||
      typeof config.username !== "string" || !/^[a-z0-9_-]{3,40}$/.test(config.username) ||
      typeof config.passwordHash !== "string" || !/^[0-9a-f]{64}$/.test(config.passwordHash))
    throw new Error(`${name} must name a dedicated review UID and a hashed login`);
  return { uid: config.uid, username: config.username, passwordHash: config.passwordHash };
}

export function loadReviewPortal(raw: string | undefined, reviewUids: ReadonlySet<string>) {
  return parseReviewPortal(raw, "APPLE_REVIEW_PORTAL", uid => reviewUids.has(uid));
}

export function loadAndroidReviewPortal(raw: string | undefined) {
  return parseReviewPortal(raw, "ANDROID_REVIEW_PORTAL", uid => /^review-android-[0-9a-f]{32}$/.test(uid));
}
const reviewPlusDuration = 2 * 60 * 60_000;
const consentAction = `input-consent/${INPUT_RESTRICTION_VERSION}`;
const headers = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function form(root: string, action: string, label: string) {
  return `<form method="post" action="${root}${action}"><button>${label}</button></form>`;
}

function page(content: string, status = 200) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oyobidashi App Review</title>
<style>
body{margin:0;color:#29251f;background:#faf6eb;font:16px/1.6 system-ui,sans-serif}
main{max-width:34rem;margin:3rem auto;padding:1.5rem;background:#fffef9;border:1px solid #e5ddcf;border-radius:1rem}
h1{font-size:1.5rem}a{color:#893814}img{display:block;max-width:100%;height:auto;margin:1rem 0}
button{font:inherit;padding:.65rem 1rem;margin:.4rem 0;cursor:pointer;border:1px solid #a79a87;border-radius:.55rem;background:#fff;color:inherit}
@media(max-width:38rem){main{margin:1rem}}
</style><main><h1>Oyobidashi App Review</h1>${content}</main></html>`, { status, headers });
}

function pairingPage(code: string, root: string, phoneName: string) {
  const link = `oyobidashi://pair?url=${encodeURIComponent(OFFICIAL_CLOUD_ORIGIN)}&code=${encodeURIComponent(code)}`;
  const qr = qrcode(0, "M");
  qr.addData(link);
  qr.make();
  return page(`<p>On the review ${phoneName}, open Oyobidashi and tap <strong lang="ja">自分で用意したサーバーに接続</strong> (Connect to your own server).</p>
<p>If this page is open on another screen, tap <strong lang="ja">QRコードを読み取る</strong> (Scan QR code) and scan this code:</p>
<img src="${qr.createDataURL(5)}" width="220" height="220" alt="Pairing QR code for the review ${phoneName}">
<p>If this page is open on the review ${phoneName}, use the manual fields in the app instead. Server URL: <code>${OFFICIAL_CLOUD_ORIGIN}</code>. Pairing code: <code>${code}</code>.</p>
<p>Confirm pairing in the app. The code works for 10 minutes and can be used once.</p>
<p><a href="${root}">Return to the review page</a></p>`);
}

export class ReviewPortal {
  readonly root: string;
  private readonly phoneName: string;

  constructor(
    readonly service: CloudService,
    readonly config: ReviewPortalConfig,
    private readonly platform: "ios" | "android" = "ios",
  ) {
    this.root = platform === "ios" ? "/review/" : "/review/android/";
    this.phoneName = platform === "ios" ? "iPhone" : "Android device";
  }

  async fetch(request: Request): Promise<Response> {
    if (requestOrigin(request) !== OFFICIAL_CLOUD_ORIGIN) throw missing();
    const { root, phoneName, platform } = this;
    const path = new URL(request.url).pathname;
    const action = path.slice(root.length);
    const planAction = platform === "android" && (action === "plus" || action === "free");
    if ((request.method !== "GET" || path !== root) &&
        (request.method !== "POST" || (!planAction && !["pair", "call", "text", "reset", consentAction].includes(action)))) throw missing();
    const basic = /^Basic ([A-Za-z0-9+/=]{1,256})$/i.exec(request.headers.get("authorization") ?? "");
    const value = basic ? Buffer.from(basic[1]!, "base64").toString("utf8") : "";
    const separator = value.indexOf(":");
    if (separator < 0 || value.slice(0, separator) !== this.config.username ||
        !timingSafeEqual(Buffer.from(hash(value.slice(separator + 1)), "hex"), Buffer.from(this.config.passwordHash, "hex")))
      return new Response(platform === "ios" ? "Use the credentials in App Review Information." : "Use the credentials in the Google Play app access instructions.", {
        status: 401,
        headers: {
          ...headers,
          "www-authenticate": platform === "ios"
            ? 'Basic realm="Oyobidashi App Review", charset="UTF-8"'
            : 'Basic realm="Oyobidashi Google Play Review", charset="UTF-8"',
        },
      });
    if (request.method === "POST" && request.headers.get("origin") !== OFFICIAL_CLOUD_ORIGIN)
      throw new CloudError(403, "forbidden", "Open the review page to perform this action.");
    const principal = { uid: this.config.uid, role: "agent" } as const;
    const response = await this.service.run(principal, async tx => {
      if (planAction) {
        if (action === "plus") {
          const expires = this.service.now() + reviewPlusDuration;
          await tx.put("review_plus", "current", { expires }, expires);
        } else {
          await tx.remove("review_plus", "current");
        }
        return new Response(null, { status: 303, headers: { ...headers, location: root } });
      }
      const consentRequired = await this.service.inputConsentMissing(tx);
      if (action === consentAction) {
        if (consentRequired) await this.service.acceptInputRestriction(tx, INPUT_RESTRICTION_VERSION);
        return new Response(null, { status: 303, headers: { ...headers, location: root } });
      }
      const devices = await tx.list("device", {}, 33);
      if (action === "pair") {
        if (devices.length) return page(`<p>A demo ${phoneName} is already paired. To pair another, disconnect the previous demo ${phoneName} first.</p><p><a href="${root}">Return to the review page</a></p>`, 409);
        const { code } = await this.service.issuePairing(tx, platform === "android" ? platform : undefined);
        return pairingPage(code, root, phoneName);
      }
      if (action === "reset") {
        if (platform === "android") await tx.remove("review_plus", "current");
        for (const device of devices) {
          await tx.releasePush(device.id);
          for (const kind of ["voice_key", "voice_access", "attest", "presence", "device"] as const)
            await tx.remove(kind, device.id);
        }
        for (const pending of await tx.list("request", { status: "pending" }, 201))
          await this.service.cancel(tx, pending.id);
        // Clear a decline cooldown from the previous demo phone.
        await tx.remove("call_cooldown", "declined");
        return new Response(null, { status: 303, headers: { ...headers, location: root } });
      }
      const phone = devices.length === 1 && devices[0]?.platform === platform ? devices[0] : null;
      const pushField = platform === "ios" ? "voip_token" : "push_token";
      const ready = !!phone && !!phone[pushField] && await tx.ownsPush(phone, pushField);
      if (action === "call" || action === "text") {
        if (action === "call" && consentRequired)
          return page(`<p>Accept the FREE plan input restriction in the review portal before sending a test call.</p><p><a href="${root}">Return to the review page</a></p>`, 409);
        if (!phone || (action === "call" && !ready))
          return page(`<p>Pair one ${phoneName} and open Oyobidashi once. Wait for the page to show that the device is ready.</p><p><a href="${root}">Check the ${phoneName}</a></p>`, 409);
        const result = await this.service.create(tx, {
          question: action === "call" ? "お呼び出しのテストです。質問が聞こえたら、はい、と答えてください。" : "お呼び出しのテストです。短い文を入力して返信してください。",
          priority: action === "call" ? "high" : "normal",
          delivery_mode: action,
          expires_in_seconds: 600,
          agent: {name: "App Review"},
        }, null);
        const message = result.request.delivery_mode === "call" ? `Test call requested. Answer on the paired ${phoneName}.` :
          action === "call" ? "Delivered as a text question. Set the app to Available and try again after any current call ends." :
          "Test message created. Open Oyobidashi to reply.";
        return page(`<p role="status">${message}</p><p><a href="${root}">Return to the review page</a></p>`);
      }
      const consent = consentRequired
        ? `<h2>FREE plan input restriction</h2><p>The FREE voice model may use questions and conversation content for AI training. Questions, context and answer choices sent by an agent must contain no personal or confidential information. Do not speak personal or confidential information during calls.</p>${form(root, consentAction, "I agree not to send personal or confidential information")}`
        : "";
      const plan = platform === "android"
        ? await this.service.reviewPlusExpiration(tx)
          ? `<h2>Demo plan: PLUS</h2><p>Reopen Settings in Oyobidashi to refresh the plan. Preview access ends after two hours.</p>${form(root, "free", "Return to FREE")}`
          : `<h2>Demo plan: FREE</h2><p>Preview PLUS voice without a purchase. You can return to FREE to see the Google Play subscription screen.</p>${form(root, "plus", "Preview PLUS for two hours")}`
        : "";
      return page(`<p>Pair the ${phoneName} running the build under review, then trigger a test call or text question.</p>
<p role="status">${ready && !consentRequired ? `The review ${phoneName} is ready for calls.` : ready ? `The review ${phoneName} is paired. Accept the FREE plan input restriction below to enable test calls.` : phone ? `The ${phoneName} is paired. Open Oyobidashi to finish enabling calls, then refresh this page.` : devices.length ? "Disconnect the previous demo pairing to continue." : `No review ${phoneName} is paired.`}</p>
${plan}
${consent}
${devices.length ? "" : form(root, "pair", `Pair the ${phoneName}`)}
${phone ? form(root, "text", "Send a test message") : ""}
${ready && !consentRequired ? form(root, "call", "Send a test call") : ""}
${devices.length ? form(root, "reset", `Disconnect the demo ${phoneName}`) : ""}
<p>For purchase and restore, open Settings → Change plan in the app.</p>`);
    });
    if (request.method === "POST") await this.service.wake(principal.uid);
    return response;
  }
}
