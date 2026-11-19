import { timingSafeEqual } from "node:crypto";
import qrcode from "qrcode-generator";
import { OFFICIAL_CLOUD_ORIGIN } from "./config.ts";
import { CloudError, missing } from "./errors.ts";
import { requestOrigin } from "./oauth.ts";
import { CloudService, hash } from "./service.ts";

export interface ReviewPortalConfig {
  uid: string;
  username: string;
  passwordHash: string;
}

export function loadReviewPortal(
  raw: string | undefined,
  reviewUids: ReadonlySet<string>,
): ReviewPortalConfig | undefined {
  if (!raw) return;
  const config = JSON.parse(raw) as Partial<ReviewPortalConfig> | null;
  if (!config || typeof config.uid !== "string" || !reviewUids.has(config.uid) ||
      typeof config.username !== "string" || !/^[a-z0-9_-]{3,40}$/.test(config.username) ||
      typeof config.passwordHash !== "string" || !/^[0-9a-f]{64}$/.test(config.passwordHash))
    throw new Error("APPLE_REVIEW_PORTAL must name an allowed Sandbox UID and a hashed login");
  return { uid: config.uid, username: config.username, passwordHash: config.passwordHash };
}

const root = "/review/";
const headers = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function form(action: string, label: string) {
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

function pairingPage(code: string) {
  const link = `oyobidashi://pair?url=${encodeURIComponent(OFFICIAL_CLOUD_ORIGIN)}&amp;code=${encodeURIComponent(code)}`;
  const qr = qrcode(0, "M");
  qr.addData(link.replace("&amp;", "&"));
  qr.make();
  return page(`<p>On the iPhone under review, open Oyobidashi and scan this QR code. You can also tap the link in Safari on that iPhone.</p>
<img src="${qr.createDataURL(5)}" width="220" height="220" alt="Pair the review iPhone">
<p><a href="${link}">Open Oyobidashi and pair this iPhone</a></p>
<p>Confirm pairing in the app. The code works for 10 minutes and can be used once.</p>
<p><a href="${root}">Return to the review page</a></p>`);
}

export class ReviewPortal {
  constructor(readonly service: CloudService, readonly config: ReviewPortalConfig) {}

  async fetch(request: Request): Promise<Response> {
    if (requestOrigin(request) !== OFFICIAL_CLOUD_ORIGIN) throw missing();
    const path = new URL(request.url).pathname;
    const action = path.slice(root.length);
    if ((request.method !== "GET" || path !== root) &&
        (request.method !== "POST" || !["pair", "call", "text", "reset"].includes(action))) throw missing();
    const basic = /^Basic ([A-Za-z0-9+/=]{1,256})$/i.exec(request.headers.get("authorization") ?? "");
    const value = basic ? Buffer.from(basic[1]!, "base64").toString("utf8") : "";
    const separator = value.indexOf(":");
    if (separator < 0 || value.slice(0, separator) !== this.config.username ||
        !timingSafeEqual(Buffer.from(hash(value.slice(separator + 1)), "hex"), Buffer.from(this.config.passwordHash, "hex")))
      return new Response("Use the credentials in App Review Information.", {
        status: 401,
        headers: { ...headers, "www-authenticate": 'Basic realm="Oyobidashi App Review", charset="UTF-8"' },
      });
    if (request.method === "POST" && request.headers.get("origin") !== OFFICIAL_CLOUD_ORIGIN)
      throw new CloudError(403, "forbidden", "Open the review page to perform this action.");
    const principal = { uid: this.config.uid, role: "agent" } as const;
    const response = await this.service.run(principal, async tx => {
      const devices = await tx.list("device", {}, 33);
      if (action === "pair") {
        if (devices.length) return page(`<p>A demo iPhone is already paired. To pair another, disconnect the previous demo iPhone first.</p><p><a href="${root}">Return to the review page</a></p>`, 409);
        return pairingPage((await this.service.issuePairing(tx)).code);
      }
      if (action === "reset") {
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
      const phone = devices.length === 1 && devices[0]?.platform === "ios" ? devices[0] : null;
      const ready = !!phone && !!phone.voip_token && await tx.ownsPush(phone, "voip_token");
      if (action === "call" || action === "text") {
        if (!phone || (action === "call" && !ready))
          return page(`<p>Pair one iPhone and open Oyobidashi once. Wait for the page to show that the iPhone is ready.</p><p><a href="${root}">Check the iPhone</a></p>`, 409);
        const result = await this.service.create(tx, {
          question: action === "call" ? "お呼び出しのテストです。質問が聞こえたら、はい、と答えてください。" : "お呼び出しのテストです。短い文を入力して返信してください。",
          priority: action === "call" ? "high" : "normal",
          delivery_mode: action,
          expires_in_seconds: 600,
          agent: {name: "App Review"},
        }, null);
        const message = result.request.delivery_mode === "call" ? "Test call requested. Answer on the paired iPhone." :
          action === "call" ? "Delivered as a text question. Set the app to Available and try again after any current call ends." :
          "Test message created. Open Oyobidashi to reply.";
        return page(`<p role="status">${message}</p><p><a href="${root}">Return to the review page</a></p>`);
      }
      return page(`<p>Pair an iPhone running the build under review, then trigger a test call or text question.</p>
<p role="status">${ready ? "The review iPhone is ready for calls." : phone ? "The iPhone is paired. Open Oyobidashi to finish enabling calls, then refresh this page." : devices.length ? "Disconnect the previous demo pairing to continue." : "No review iPhone is paired."}</p>
${devices.length ? "" : form("pair", "Pair an iPhone")}
${phone ? form("text", "Send a test message") : ""}
${ready ? form("call", "Send a test call") : ""}
${devices.length ? form("reset", "Disconnect the demo iPhone") : ""}
<p>For purchase and restore, open Settings → Change plan in the app.</p>`);
    });
    if (request.method === "POST") await this.service.wake(principal.uid);
    return response;
  }
}
