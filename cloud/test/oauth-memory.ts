import type { OAuthKind, OAuthRow, OAuthStore } from "../src/oauth.ts";

/** In-memory double with the same single-winner semantics as the SQL store. */
export class MemoryOAuthStore implements OAuthStore {
  rows = new Map<string, OAuthRow>();
  fail = false;
  private check() {
    if (this.fail) throw new Error("injected store failure with private details");
  }
  async insert(row: OAuthRow) {
    this.check();
    const key = `${row.kind}:${row.id}`;
    if (this.rows.has(key)) throw new Error("duplicate key");
    this.rows.set(key, structuredClone(row));
  }
  async get(kind: OAuthKind, id: string) {
    this.check();
    return structuredClone(this.rows.get(`${kind}:${id}`) ?? null);
  }
  async consume(kind: OAuthKind, id: string, now: number, retainMs: number) {
    this.check();
    const row = this.rows.get(`${kind}:${id}`);
    if (!row || row.used !== null) return null;
    row.used = now;
    row.expires = Math.min(row.expires, now + retainMs);
    return structuredClone(row);
  }
  async extend(kind: OAuthKind, id: string, expires: number) {
    const row = this.rows.get(`${kind}:${id}`);
    if (row) row.expires = Math.max(row.expires, expires);
  }
  async revokeGrant(grant: string) {
    this.check();
    for (const [k, r] of this.rows) if (r.grant === grant) this.rows.delete(k);
  }
  async trimGrants(uid: string, keep: number) {
    const latest = new Map<string, number>();
    for (const r of this.rows.values())
      if (r.kind === "refresh" && r.uid === uid && r.grant)
        latest.set(r.grant, Math.max(latest.get(r.grant) ?? 0, r.created));
    const stale = [...latest].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(keep);
    for (const [grant] of stale) await this.revokeGrant(grant);
  }
  async listGrants(uid: string) {
    this.check();
    const latest = new Map<string, OAuthRow>();
    for (const row of this.rows.values())
      if (row.kind === "refresh" && row.uid === uid && row.grant && row.used === null) {
        const old = latest.get(row.grant);
        if (!old || row.created >= old.created) latest.set(row.grant, row);
      }
    return [...latest.values()].map((row) => structuredClone(row));
  }
  async revokeOwnedGrant(uid: string, grant: string) {
    this.check();
    if ([...this.rows.values()].some((row) => row.uid === uid && row.grant === grant))
      await this.revokeGrant(grant);
  }
  async revokeOwner(uid: string) {
    this.check();
    const grants = new Set([...this.rows.values()].filter((row) => row.uid === uid && row.grant).map((row) => row.grant!));
    for (const grant of grants) await this.revokeGrant(grant);
  }
  async countSince(kind: OAuthKind, since: number) {
    this.check();
    return [...this.rows.values()].filter((r) => r.kind === kind && r.created >= since).length;
  }
  async countRegistrations(host: string, since: number) {
    this.check();
    return [...this.rows.values()].filter((row) => row.kind === "client" && row.created >= since &&
      row.doc.registration_hosts?.includes(host)).length;
  }
  async cleanup(now: number) {
    for (const [k, r] of this.rows) if (r.expires < now) this.rows.delete(k);
  }
}
