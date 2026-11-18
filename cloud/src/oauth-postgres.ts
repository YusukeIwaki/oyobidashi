import type { SQL } from "bun";
import type { OAuthKind, OAuthRow, OAuthStore } from "./oauth.ts";

// Registered MCP clients, authorization codes and tokens. Secrets are stored as
// SHA-256 digests only; a database read never yields a usable credential.
export const OAUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_oauth (
  kind text NOT NULL CHECK (kind IN ('client','code','access','refresh')),
  id text NOT NULL, uid text, grant_id text, doc jsonb NOT NULL,
  created_at bigint NOT NULL, expires_at bigint NOT NULL, used_at bigint,
  PRIMARY KEY(kind,id)
);
CREATE INDEX IF NOT EXISTS cloud_oauth_grant ON cloud_oauth(grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cloud_oauth_owner ON cloud_oauth(uid,created_at DESC) WHERE kind='refresh';
CREATE INDEX IF NOT EXISTS cloud_oauth_created ON cloud_oauth(kind,created_at);
CREATE INDEX IF NOT EXISTS cloud_oauth_expiry ON cloud_oauth(expires_at);
`;

const rowFrom = (r: Record<string, unknown>): OAuthRow => ({
  kind: r.kind as OAuthKind,
  id: r.id as string,
  uid: r.uid as string | null,
  grant: r.grant_id as string | null,
  doc: r.doc as OAuthRow["doc"],
  created: Number(r.created_at),
  expires: Number(r.expires_at),
  used: r.used_at === null ? null : Number(r.used_at),
});

export class PostgresOAuthStore implements OAuthStore {
  constructor(private readonly sql: SQL) {}
  async migrate() {
    await this.sql.begin(async (sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock(728194205)");
      await sql.unsafe(OAUTH_SCHEMA);
    });
  }
  async insert(row: OAuthRow) {
    await this.sql.unsafe(
      "INSERT INTO cloud_oauth(kind,id,uid,grant_id,doc,created_at,expires_at,used_at) VALUES($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8)",
      [row.kind, row.id, row.uid, row.grant, JSON.stringify(row.doc), row.created, row.expires, row.used],
    );
  }
  async get(kind: OAuthKind, id: string) {
    const rows = await this.sql.unsafe("SELECT * FROM cloud_oauth WHERE kind=$1 AND id=$2", [kind, id]);
    return rows[0] ? rowFrom(rows[0]) : null;
  }
  async consume(kind: OAuthKind, id: string, now: number, retainMs: number) {
    // The used_at predicate makes exactly one of several concurrent redemptions win.
    const rows = await this.sql.unsafe(
      `UPDATE cloud_oauth SET used_at=$3::bigint,expires_at=LEAST(expires_at,$3::bigint+$4::bigint)
      WHERE kind=$1 AND id=$2 AND used_at IS NULL RETURNING *`,
      [kind, id, now, retainMs],
    );
    return rows[0] ? rowFrom(rows[0]) : null;
  }
  async extend(kind: OAuthKind, id: string, expires: number) {
    await this.sql.unsafe(
      "UPDATE cloud_oauth SET expires_at=GREATEST(expires_at,$3::bigint) WHERE kind=$1 AND id=$2",
      [kind, id, expires],
    );
  }
  async revokeGrant(grant: string) {
    await this.sql.unsafe("DELETE FROM cloud_oauth WHERE grant_id=$1", [grant]);
  }
  async trimGrants(uid: string, keep: number) {
    await this.sql.unsafe(
      `DELETE FROM cloud_oauth WHERE grant_id IN (
        SELECT grant_id FROM cloud_oauth WHERE kind='refresh' AND uid=$1
        GROUP BY grant_id ORDER BY MAX(created_at) DESC, grant_id OFFSET $2)`,
      [uid, keep],
    );
  }
  async listGrants(uid: string) {
    const rows = await this.sql.unsafe(
      "SELECT DISTINCT ON (grant_id) * FROM cloud_oauth WHERE kind='refresh' AND uid=$1 AND used_at IS NULL ORDER BY grant_id,created_at DESC,id DESC",
      [uid],
    );
    return rows.map(rowFrom);
  }
  async revokeOwnedGrant(uid: string, grant: string) {
    await this.sql.unsafe(
      "DELETE FROM cloud_oauth WHERE grant_id=$2 AND EXISTS (SELECT 1 FROM cloud_oauth owner WHERE owner.grant_id=$2 AND owner.uid=$1)",
      [uid, grant],
    );
  }
  async revokeOwner(uid: string) {
    await this.sql.unsafe(
      "DELETE FROM cloud_oauth WHERE grant_id IN (SELECT grant_id FROM cloud_oauth WHERE uid=$1 AND grant_id IS NOT NULL)",
      [uid],
    );
  }
  async countSince(kind: OAuthKind, since: number) {
    const rows = await this.sql.unsafe(
      "SELECT COUNT(*) AS n FROM cloud_oauth WHERE kind=$1 AND created_at>=$2",
      [kind, since],
    );
    return Number(rows[0]?.n ?? 0);
  }
  async countRegistrations(host: string, since: number) {
    const rows = await this.sql.unsafe(
      "SELECT COUNT(*) AS n FROM cloud_oauth WHERE kind='client' AND created_at>=$1 AND doc->'registration_hosts' ? $2",
      [since, host],
    );
    return Number(rows[0]?.n ?? 0);
  }
  async cleanup(now: number) {
    await this.sql.unsafe(
      "DELETE FROM cloud_oauth WHERE (kind,id) IN (SELECT kind,id FROM cloud_oauth WHERE expires_at<$1 LIMIT 5000)",
      [now],
    );
  }
}
