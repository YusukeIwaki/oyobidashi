import { CloudError, conflict, invalid, unauthorized } from "./errors.ts";
import { hash, type CloudService, type Principal } from "./service.ts";
import type { ClaudeAccess, Transaction } from "./types.ts";

export const randomSecret = () =>
  crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });
const inviteLifetime = 3 * 86400_000;
const maxMembers = 100;
export const secretPattern = /^[A-Za-z0-9_-]{43}$/;
export const organizationScope = (id: string) => `claude-org:${id}`;
const emailAddress = (value?: unknown) => {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};
const alreadyMember = () => conflict("claude_membership_exists", "既に別の組織へ参加しています。");

export class ClaudeOrganizations {
  constructor(private readonly service: CloudService) {}

  async create(principal: Principal, name: unknown, verifiedEmail?: string) {
    if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\p{C}]/u.test(name))
      throw invalid("組織名を80文字以内で入力してください。");
    await this.service.run(principal, async tx => {
      await this.service.claudeBillingAttempt(tx);
      if (await tx.claudeAccess()) throw alreadyMember();
    });
    const organizationId = organizationScope(crypto.randomUUID());
    await this.withUniqueMember(organizationId, async tx => {
      if (!await tx.claudeJoinAllowed(principal.uid)) throw unauthorized();
      if (await tx.claudeAccess(principal.uid)) throw alreadyMember();
      await tx.put("claude_organization", "current", { name: name.trim() });
      await tx.put("claude_member", principal.uid, {
        uid: principal.uid, role: "admin", grantId: crypto.randomUUID(),
        ...(emailAddress(verifiedEmail) ? { email: emailAddress(verifiedEmail)! } : {}),
      });
    });
    await this.stopCalls(principal.uid);
  }

  async access(principal: Principal) {
    return this.service.run(principal, tx => tx.claudeAccess());
  }

  async admin<T>(actor: string, access: ClaudeAccess | null, fn: (tx: Transaction) => Promise<T>) {
    if (!access || access.member.role !== "admin") throw forbidden();
    return this.service.db.transaction(access.organizationId, async tx => {
      const member = await tx.get("claude_member", actor);
      if (member?.role !== "admin" || member.grantId !== access.member.grantId) throw forbidden();
      return fn(tx);
    });
  }

  async invite(actor: string, access: ClaudeAccess | null, value: unknown) {
    const email = emailAddress(value);
    if (!email) throw invalid("招待先のメールアドレスを確認してください。");
    return this.admin(actor, access, async tx => {
      await this.service.claudeBillingAttempt(tx);
      const billing = await tx.get("claude_billing", "current");
      if (!billing || billing.disabled) throw conflict("claude_billing_missing", "先に Claude の請求先を連携してください。");
      const now = this.service.now();
      const outstanding = (await tx.list("claude_invite", {}, maxMembers + 1)).filter(invite => invite.expires > now);
      if (outstanding.length >= maxMembers) throw conflict("claude_invite_limit", "未使用の招待が上限に達しました。");
      const code = randomSecret();
      const expires = now + inviteLifetime;
      await tx.put("claude_invite", hash(code), { emailHash: hash(email), expires }, expires);
      return { invitation: code, expires_at: new Date(expires).toISOString() };
    });
  }

  async accept(principal: Principal, value: unknown, verifiedEmail?: string) {
    const email = emailAddress(verifiedEmail);
    if (!email) throw new CloudError(403, "claude_verified_email_required", "招待先の確認済みメールアドレスでログインしてください。");
    if (typeof value !== "string" || !secretPattern.test(value)) throw invalid("招待コードを確認してください。");
    await this.service.run(principal, async tx => {
      await this.service.claudeBillingAttempt(tx);
      if (await tx.claudeAccess()) throw alreadyMember();
    });
    const key = hash(value);
    const organizationId = await this.service.db.findClaudeInvite(key);
    if (!organizationId) throw badInvite();
    await this.withUniqueMember(organizationId, async tx => {
      const invite = await tx.get("claude_invite", key);
      const billing = await tx.get("claude_billing", "current");
      if (!invite || invite.expires <= this.service.now() ||
          invite.emailHash !== hash(email) || !billing || billing.disabled) throw badInvite();
      if (!await tx.claudeJoinAllowed(principal.uid)) throw unauthorized();
      if (await tx.claudeAccess(principal.uid)) throw alreadyMember();
      if ((await tx.list("claude_member", {}, maxMembers)).length >= maxMembers)
        throw conflict("claude_member_limit", "組織のメンバー数が上限に達しました。");
      await tx.put("claude_member", principal.uid, {
        uid: principal.uid, role: "member", grantId: crypto.randomUUID(), email,
      });
      await tx.remove("claude_invite", key);
    });
    await this.stopCalls(principal.uid);
  }

  async removeMember(actor: string, access: ClaudeAccess | null, uid: unknown) {
    if (typeof uid !== "string" || !uid || uid.length > 128) throw invalid("メンバーを確認してください。");
    await this.admin(actor, access, async tx => {
      await this.service.claudeBillingAttempt(tx);
      const target = await tx.get("claude_member", uid);
      if (target?.role !== "member") throw forbidden();
      await tx.remove("claude_member", uid);
    });
    await this.stopCalls(uid);
  }

  async leave(principal: Principal, access: ClaudeAccess | null) {
    if (!access || access.member.role !== "member") throw forbidden();
    await this.service.db.transaction(access.organizationId, async tx => {
      const current = await tx.get("claude_member", principal.uid);
      if (current?.grantId === access.member.grantId) await tx.remove("claude_member", principal.uid);
    });
    await this.stopCalls(principal.uid);
  }

  async stopCalls(uid: string) {
    await this.service.db.transaction(uid, tx => this.service.closeVoiceCalls(tx));
    await this.service.wake(uid);
  }

  private async withUniqueMember(organizationId: string, fn: (tx: Transaction) => Promise<void>) {
    try {
      await this.service.db.transaction(organizationId, fn);
    } catch (error) {
      const e = error as { code?: string; errno?: string; constraint?: string; constraint_name?: string };
      if ((e.errno ?? e.code) === "23505" && (e.constraint ?? e.constraint_name) === "cloud_claude_one_membership") throw alreadyMember();
      throw error;
    }
  }
}

const forbidden = () => new CloudError(403, "forbidden", "組織の管理権限がありません。");
const badInvite = () => new CloudError(403, "invalid_claude_invite", "招待が無効か、招待先のアカウントと一致しません。");
