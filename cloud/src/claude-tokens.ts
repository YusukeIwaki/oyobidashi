import { ClaudeRefreshDeferred, type ClaudeConnectionTokens, type ClaudePlatform } from "./claude-platform.ts";
import type { ClaudeTokenCipher } from "./claude-kms.ts";
import { unavailable } from "./errors.ts";
import type { ClaudeAccess, ClaudeCredentialRef, ClaudeTokenRecord, Database, Transaction } from "./types.ts";

const refreshMargin = 30_000;
const claudeRefreshHoldMs = 45_000;
const waitBudget = 12_000;
type Payload = { access: string; refresh: string };

const binding = (organizationId: string, record: Pick<ClaudeTokenRecord, "connectionId" | "accessExpires" | "refreshExpires">) =>
  JSON.stringify(["oyobidashi:claude-oauth:v1", organizationId, record.connectionId, record.accessExpires, record.refreshExpires]);

export function claudeTokensNeedRelink(access: ClaudeAccess, now: number) {
  const { billing, tokens } = access;
  return !tokens || tokens.connectionId !== billing?.connectionId || tokens.refreshExpires <= now ||
    (tokens.refreshStarted !== null && now - tokens.refreshStarted >= claudeRefreshHoldMs);
}

export async function sealClaudeTokens(cipher: ClaudeTokenCipher, organizationId: string, tokens: ClaudeConnectionTokens): Promise<ClaudeTokenRecord> {
  const row = { connectionId: tokens.connectionId, accessExpires: tokens.accessExpires, refreshExpires: tokens.refreshExpires };
  return {
    ...row,
    ciphertext: await cipher.encrypt(JSON.stringify({ access: tokens.access, refresh: tokens.refresh }), binding(organizationId, row)),
    refreshId: null, refreshStarted: null, retryAfter: null,
  };
}

function matchesBilling(billing: { connectionId: string; profileId: string; disabled?: boolean } | null, ref: ClaudeCredentialRef) {
  return !!billing && !billing.disabled && billing.connectionId === ref.connectionId && billing.profileId === ref.profileId;
}

async function memberTokens(tx: Transaction, ref: ClaudeCredentialRef) {
  if (!matchesBilling(await tx.get("claude_billing", "current"), ref) ||
      (await tx.get("claude_member", ref.uid))?.grantId !== ref.grantId) throw unavailable();
  const tokens = await tx.getClaudeTokens();
  if (!tokens || tokens.connectionId !== ref.connectionId) throw unavailable();
  return tokens;
}

export class ClaudeTokenWorker {
  constructor(
    private readonly db: Database,
    private readonly cipher: ClaudeTokenCipher,
    private readonly platform: Pick<ClaudePlatform, "refresh">,
    private readonly now: () => number = Date.now,
  ) {}

  async access(ref: ClaudeCredentialRef, signal?: AbortSignal): Promise<string> {
    const deadline = performance.now() + waitBudget;
    do {
      signal?.throwIfAborted();
      const reading = await this.db.transaction(ref.organizationId, async tx => {
        const row = await memberTokens(tx, ref);
        const now = this.now();
        if (row.refreshExpires <= now || (row.retryAfter ?? 0) > now) throw unavailable();
        if (row.refreshId) {
          if (now - row.refreshStarted! >= claudeRefreshHoldMs) throw unavailable();
          return { kind: "wait" } as const;
        }
        if (row.accessExpires > now + refreshMargin) return { kind: "use", row } as const;
        const claimed = { ...row, refreshId: crypto.randomUUID(), refreshStarted: now, retryAfter: null };
        // The marker commits before the refresh token can leave this process.
        await tx.putClaudeTokens(claimed);
        return { kind: "refresh", row: claimed } as const;
      });
      if (reading.kind === "wait") {
        await Bun.sleep(200);
        continue;
      }
      if (reading.kind === "refresh") return this.rotate(ref, reading.row, signal);
      const tokens = await this.open(ref.organizationId, reading.row);
      const current = await this.db.transaction(ref.organizationId, tx => memberTokens(tx, ref));
      if (!current.refreshId && current.ciphertext === reading.row.ciphertext && current.accessExpires > this.now()) {
        signal?.throwIfAborted();
        return tokens.access;
      }
    } while (performance.now() < deadline);
    throw unavailable();
  }

  private async open(organizationId: string, row: ClaudeTokenRecord) {
    const plain = await this.cipher.decrypt(row.ciphertext, binding(organizationId, row));
    const tokens = JSON.parse(plain) as Partial<Payload>;
    if (typeof tokens.access !== "string" || !tokens.access || typeof tokens.refresh !== "string" || !tokens.refresh)
      throw unavailable();
    return tokens as Payload;
  }

  private async rotate(ref: ClaudeCredentialRef, row: ClaudeTokenRecord, signal?: AbortSignal) {
    let tokens: Payload;
    try {
      signal?.throwIfAborted();
      tokens = await this.open(ref.organizationId, row);
      signal?.throwIfAborted();
      const current = await this.db.transaction(ref.organizationId, tx => memberTokens(tx, ref));
      if (current.refreshId !== row.refreshId) throw unavailable();
    } catch {
      // The token has not been sent. A retry later is safe.
      await this.release(ref, row, this.now() + 5000);
      throw unavailable();
    }

    let fresh: ClaudeConnectionTokens;
    try {
      fresh = await this.platform.refresh(ref.connectionId, tokens.refresh);
      if (fresh.connectionId !== row.connectionId || fresh.refresh === tokens.refresh) throw unavailable();
    } catch (error) {
      if (error instanceof ClaudeRefreshDeferred) await this.release(ref, row, error.retryAfter);
      // Other outcomes might have consumed the token. Leave the hold in place.
      throw unavailable();
    }

    // Complete the rotation even if the triggering call has stopped. Retry
    // only encryption/storage of the returned value, never the OAuth request.
    let sealed: ClaudeTokenRecord | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        sealed ??= await sealClaudeTokens(this.cipher, ref.organizationId, fresh);
        const replacement = sealed;
        await this.db.transaction(ref.organizationId, async tx => {
          if (!matchesBilling(await tx.get("claude_billing", "current"), ref)) return;
          const current = await tx.getClaudeTokens();
          if (current?.refreshId === row.refreshId) await tx.putClaudeTokens(replacement);
        });
        break;
      } catch {
        if (attempt === 2) throw unavailable();
        await Bun.sleep(250 * (attempt + 1));
      }
    }
    const verified = await this.db.transaction(ref.organizationId, tx => memberTokens(tx, ref));
    if (verified.ciphertext !== sealed.ciphertext || verified.refreshId || verified.accessExpires <= this.now()) throw unavailable();
    signal?.throwIfAborted();
    return fresh.access;
  }

  private async release(ref: ClaudeCredentialRef, row: ClaudeTokenRecord, retryAfter: number) {
    await this.db.transaction(ref.organizationId, async tx => {
      const current = await tx.getClaudeTokens();
      if (current?.refreshId === row.refreshId && current.connectionId === ref.connectionId)
        await tx.putClaudeTokens({ ...current, refreshId: null, refreshStarted: null, retryAfter });
    });
  }
}
