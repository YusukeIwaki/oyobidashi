import { OFFICIAL_CLOUD_ORIGIN } from "./config.ts";
import { CloudError, conflict, json, readBody, unauthorized } from "./errors.ts";
import { requestOrigin } from "./oauth.ts";
import { hash, type CloudService } from "./service.ts";
import { CLAUDE_CALLBACK, type ClaudePlatform } from "./claude-platform.ts";
import type { ClaudeAccess, IdentityVerifier } from "./types.ts";
import { claudeTokensNeedRelink, sealClaudeTokens } from "./claude-tokens.ts";
import type { ClaudeTokenCipher } from "./claude-kms.ts";
import { ClaudeOrganizations, randomSecret, secretPattern } from "./claude-organizations.ts";

const FLOW = new URL(CLAUDE_CALLBACK).pathname;
const CONNECTIONS = "/oauth/connections";
const COOKIE = "__Host-oyobidashi-claude";
const age = 10 * 60_000;
const BILLING = "/oauth/claude/billing";
const ORGANIZATION = "/oauth/claude/organization";
const paths = new Set([BILLING, ORGANIZATION, `${ORGANIZATION}/invite`,
  `${ORGANIZATION}/accept`, `${ORGANIZATION}/member`, `${ORGANIZATION}/leave`]);

// Billing belongs to an Oyobidashi organization, separate from Firebase and MCP OAuth grants.
export class ClaudeBilling {
  private readonly organizations: ClaudeOrganizations;

  constructor(
    private readonly service: CloudService,
    private readonly verifier: IdentityVerifier,
    private readonly platform: Pick<ClaudePlatform, "authorize" | "createProfile" | "exchange" | "revoke" | "connectionStatus">,
    private readonly cipher: ClaudeTokenCipher,
  ) { this.organizations = new ClaudeOrganizations(service); }

  async fetch(req: Request, url: URL) {
    if (requestOrigin(req) !== OFFICIAL_CLOUD_ORIGIN) return undefined;
    const method = req.method;
    if (url.pathname === FLOW && method === "GET")
      return this.callback(req, url).catch(() => result("failed", false));
    const path = url.pathname;
    if (!paths.has(path)) return undefined;
    if (method !== "GET" && req.headers.get("origin") !== OFFICIAL_CLOUD_ORIGIN) throw unauthorized();
    const token = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!token || !this.verifier.identify || req.headers.has("x-oyobidashi-review")) throw unauthorized();
    const owner = await this.verifier.identify(token);
    if (!["google.com", "github.com", "apple.com"].includes(owner.provider ?? "")) throw unauthorized();
    const principal = { uid: owner.uid, role: "agent" as const };
    const access = await this.organizations.access(principal);
    if (path === BILLING && method === "GET") {
      const billing = access?.billing;
      const needsRelink = billing && access && claudeTokensNeedRelink(access, this.service.now());
      const status = billing?.disabled ? "unlink_pending" : needsRelink ? "relink_required" : billing
        ? await this.platform.connectionStatus(billing.profileId).catch(() => "unknown")
        : "unlinked";
      const members = access?.member.role === "admin" ? await this.organizations.admin(owner.uid, access,
        async tx => (await tx.list("claude_member", {}, 100)).filter(member => member.role === "member")
          .map(({ uid, email }) => ({ uid, email }))) : [];
      return json(200, { status, organization: access ? { name: access.name, role: access.member.role } : null, members });
    }
    if (path === ORGANIZATION && method === "POST") {
      await this.organizations.create(principal, (await readBody(req)).name, owner.verifiedEmail);
      return json(201, { ok: true });
    }
    if (path === `${ORGANIZATION}/invite` && method === "POST")
      return json(201, await this.organizations.invite(owner.uid, access, (await readBody(req)).email));
    if (path === `${ORGANIZATION}/accept` && method === "POST") {
      const body = await readBody(req);
      if (body.accept !== true) throw new CloudError(400, "invalid_request", "音声の送信と請求先に同意してください。");
      await this.organizations.accept(principal, body.invitation, owner.verifiedEmail);
      return json(200, { ok: true });
    }
    if (path === `${ORGANIZATION}/member` && method === "DELETE") {
      await this.organizations.removeMember(owner.uid, access, (await readBody(req)).uid);
      return new Response(null, { status: 204 });
    }
    if (path === `${ORGANIZATION}/leave` && method === "DELETE") {
      await this.organizations.leave(principal, access);
      return new Response(null, { status: 204 });
    }
    if (path !== BILLING || (method !== "POST" && method !== "DELETE")) return undefined;
    if (!access || access.member.role !== "admin") throw new CloudError(403, "forbidden", "組織の管理権限がありません。");
    const organizationId = access.organizationId;
    const admin = <T>(fn: (tx: import("./types.ts").Transaction) => Promise<T>) =>
      this.organizations.admin(owner.uid, access, fn);
    if (method === "DELETE") {
      const billing = await admin(async tx => {
        await this.service.claudeBillingAttempt(tx);
        const pending = await tx.get("claude_billing_pending", "current");
        if (pending && pending.busyUntil > this.service.now()) throw busy();
        await tx.remove("claude_billing_pending", "current");
        const entry = await tx.get("claude_billing", "current");
        if (entry) {
          if ((entry.busyUntil ?? 0) > this.service.now()) throw busy();
          await tx.put("claude_billing", "current", { ...entry, disabled: true, busyUntil: this.service.now() + 20_000 });
          await tx.removeClaudeTokens();
        }
        return entry;
      });
      await this.organizations.stopCalls(owner.uid);
      if (billing) {
        try {
          await this.platform.revoke(billing.connectionId);
        } catch (error) {
          await admin(async tx => {
            const current = await tx.get("claude_billing", "current");
            if (current?.disabled && current.connectionId === billing.connectionId)
              await tx.put("claude_billing", "current", { ...current, busyUntil: 0 });
          });
          throw error;
        }
        await admin(async tx => {
          if ((await tx.get("claude_billing", "current"))?.connectionId === billing.connectionId)
            await tx.remove("claude_billing", "current");
        });
      }
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    const body = await readBody(req);
    if (body.accept !== true) throw new CloudError(400, "invalid_request", "Claude の送信と課金に同意してください。");
    const state = randomSecret(), browser = randomSecret(), verifier = randomSecret(), key = hash(state);
    const pending = { actor: owner.uid, state: key, browser: hash(browser), verifier, profileId: "", expires: this.service.now() + age, busyUntil: this.service.now() + 40_000 };
    const priorProfile = await admin(async tx => {
      await this.service.claudeBillingAttempt(tx);
      if (await tx.get("claude_billing", "current")) throw conflict("claude_billing_linked", "先に現在の Claude 連携を解除してください。");
      const current = await tx.get("claude_billing_pending", "current");
      if (current && current.busyUntil > this.service.now()) throw busy();
      await tx.put("claude_billing_pending", "current", pending, pending.expires);
      return await tx.get("claude_profile", "current");
    });
    try {
      const profileId = priorProfile?.id ?? await this.platform.createProfile(hash(`oyobidashi:claude:${organizationId}`));
      await admin(async tx => {
        if ((await tx.get("claude_billing_pending", "current"))?.state !== key) throw busy();
        await tx.put("claude_profile", "current", { id: profileId });
      });
      const redirect = await this.platform.authorize(profileId, state, verifier);
      await admin(async tx => {
        if ((await tx.get("claude_billing_pending", "current"))?.state !== key) throw busy();
        await tx.put("claude_billing_pending", "current", { ...pending, profileId, busyUntil: 0 }, pending.expires);
      });
      const response = json(200, { redirect_to: redirect });
      response.headers.set("set-cookie", cookie(browser, age / 1000));
      return response;
    } catch (error) {
      await this.clear(organizationId, key);
      throw error;
    }
  }

  private async clear(organizationId: string, state: string) {
    await this.service.db.transaction(organizationId, async tx => {
      if ((await tx.get("claude_billing_pending", "current"))?.state === state)
        await tx.remove("claude_billing_pending", "current");
    });
  }

  private async callback(req: Request, url: URL) {
    const state = url.searchParams.get("state") ?? "";
    const browser = req.headers.get("cookie")?.split(/;\s*/).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
    const code = url.searchParams.get("code");
    if (url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1)
      return result("failed", false);
    if (!secretPattern.test(state) || !secretPattern.test(browser)) return result("failed", false);
    const key = hash(state);
    const organizationId = await this.service.db.findClaudeBillingState(key);
    if (!organizationId) return result("failed", false);
    const pending = await this.service.db.transaction(organizationId, async tx => {
      const flow = await tx.get("claude_billing_pending", "current");
      if (!flow || flow.state !== key || flow.browser !== hash(browser) || !flow.profileId ||
          flow.expires <= this.service.now() || flow.busyUntil > this.service.now() ||
          (await tx.get("claude_member", flow.actor))?.role !== "admin") return null;
      if (!code || code.length > 2048 || url.searchParams.has("error")) {
        await tx.remove("claude_billing_pending", "current");
        return null;
      }
      await tx.put("claude_billing_pending", "current", { ...flow, busyUntil: this.service.now() + 20_000 }, flow.expires);
      return flow;
    });
    if (!pending || !code) return result("failed", false);
    let connectionId: string | undefined;
    try {
      await this.service.run({ uid: pending.actor, role: "agent" }, async () => {});
      const tokens = await this.platform.exchange(code, pending.verifier);
      connectionId = tokens.connectionId;
      const record = await sealClaudeTokens(this.cipher, organizationId, tokens);
      await this.service.db.transaction(organizationId, async tx => {
        if ((await tx.get("claude_billing_pending", "current"))?.state !== key ||
            (await tx.get("claude_member", pending.actor))?.role !== "admin") throw busy();
        await tx.put("claude_billing", "current", { profileId: pending.profileId, connectionId: record.connectionId });
        await tx.putClaudeTokens(record);
        await tx.remove("claude_billing_pending", "current");
      });
      return result("linked", true);
    } catch {
      if (connectionId) await this.platform.revoke(connectionId).catch(() => {});
      await this.clear(organizationId, key);
      return result("failed", true);
    }
  }

  async revokeForDeletion(uid: string, access: ClaudeAccess) {
    const billing = await this.organizations.admin(uid, access, async tx => {
      await tx.remove("claude_billing_pending", "current");
      const current = await tx.get("claude_billing", "current");
      if (current) await tx.put("claude_billing", "current", { ...current, disabled: true });
      await tx.removeClaudeTokens();
      return current;
    });
    if (billing) await this.platform.revoke(billing.connectionId);
    await this.organizations.admin(uid, access, tx => tx.eraseAccount());
  }
}

function busy() {
  return conflict("claude_billing_busy", "Claude の連携を処理しています。少し待ってからお試しください。");
}
function cookie(value: string, seconds: number) {
  return `${COOKIE}=${value}; Max-Age=${seconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
function result(status: "linked" | "failed", clearCookie: boolean) {
  return new Response(null, { status: 303, headers: {
    location: `${CONNECTIONS}?claude=${status}`, "cache-control": "no-store", "referrer-policy": "no-referrer",
    ...(clearCookie ? { "set-cookie": cookie("", 0) } : {}),
  } });
}
