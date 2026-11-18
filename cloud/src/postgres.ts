import { SQL } from "bun";
import { unauthorized } from "./errors.ts";
import {
  newerAppleProof,
  pushEndpointKey,
  pushClientKey,
  scopedJobId,
  type Database,
  type Device,
  type AppleBillingProof,
  type Entitlement,
  type EntitlementSource,
  type Job,
  type Kind,
  type NewJob,
  type Records,
  type Transaction,
} from "./types.ts";

// One JSON document per entity, never a whole user's history. UID is part of
// every primary key and is supplied by the verified server identity only.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS cloud_records (
  uid text NOT NULL, kind text NOT NULL, id text NOT NULL, doc jsonb NOT NULL,
  due_at bigint, touched_at bigint NOT NULL,
  PRIMARY KEY(uid,kind,id)
);
ALTER TABLE cloud_records ADD COLUMN IF NOT EXISTS sort_key text GENERATED ALWAYS AS (COALESCE(doc->>'created_at',doc->>'at','')) STORED;
ALTER TABLE cloud_records ADD COLUMN IF NOT EXISTS record_status text GENERATED ALWAYS AS (doc->>'status') STORED;
CREATE INDEX IF NOT EXISTS cloud_records_recent ON cloud_records(uid,kind,sort_key DESC,id DESC);
CREATE INDEX IF NOT EXISTS cloud_records_status_recent ON cloud_records(uid,kind,record_status,sort_key DESC,id DESC);
CREATE INDEX IF NOT EXISTS cloud_records_due ON cloud_records(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS cloud_requests_status ON cloud_records(uid,(doc->>'status'),(doc->>'created_at') DESC) WHERE kind='request';
CREATE UNIQUE INDEX IF NOT EXISTS cloud_one_live_call ON cloud_records(uid)
  WHERE kind='request' AND doc->'call'->>'state' IN ('ringing','active');
CREATE UNIQUE INDEX IF NOT EXISTS cloud_device_hash ON cloud_records((doc->>'tokenHash')) WHERE kind='device';
CREATE UNIQUE INDEX IF NOT EXISTS cloud_pairing_hash ON cloud_records(id) WHERE kind='pairing';
CREATE UNIQUE INDEX IF NOT EXISTS cloud_preview_hash ON cloud_records(id) WHERE kind='preview';
CREATE INDEX IF NOT EXISTS cloud_turn_request ON cloud_records(uid,(doc->>'requestId')) WHERE kind='turn';
CREATE UNIQUE INDEX IF NOT EXISTS cloud_one_pending_turn ON cloud_records(uid,(doc->>'callId'))
  WHERE kind='turn' AND doc->>'state' IN ('queued','running');
CREATE TABLE IF NOT EXISTS cloud_jobs (
  id text PRIMARY KEY, uid text NOT NULL, kind text NOT NULL,
  request_id text NOT NULL, payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('ready','leased','done')),
  available_at bigint NOT NULL, deadline bigint NOT NULL,
  lease_token text, lease_until bigint, attempts integer NOT NULL DEFAULT 0,
  finished_at bigint
);
CREATE INDEX IF NOT EXISTS cloud_jobs_ready ON cloud_jobs(kind,available_at) WHERE state='ready';
CREATE INDEX IF NOT EXISTS cloud_jobs_leased ON cloud_jobs(kind,lease_until) WHERE state='leased';
CREATE INDEX IF NOT EXISTS cloud_jobs_cleanup ON cloud_jobs(finished_at) WHERE state='done';
CREATE TABLE IF NOT EXISTS cloud_push_owners (
  endpoint_hash text PRIMARY KEY,uid text NOT NULL,device_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS cloud_push_owner_device ON cloud_push_owners(uid,device_id);
CREATE TABLE IF NOT EXISTS cloud_billing_claims(source text NOT NULL,uid text NOT NULL,PRIMARY KEY(source,uid));
CREATE TABLE IF NOT EXISTS cloud_billing_superseded(source text PRIMARY KEY,successor text NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_apple_billing_state(source text PRIMARY KEY,doc jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_owner_versions(uid text PRIMARY KEY,revision bigint NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_displaced_devices(uid text NOT NULL,device_id text NOT NULL,PRIMARY KEY(uid,device_id));
ALTER TABLE cloud_displaced_devices ADD COLUMN IF NOT EXISTS generation bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX IF NOT EXISTS cloud_displaced_generation ON cloud_displaced_devices(uid,generation DESC);
UPDATE cloud_records SET doc = jsonb_build_object('push_registered_at', doc->'lastSeen', 'voip_registered_at', doc->'lastSeen') || doc
WHERE kind='device' AND (NOT doc ? 'push_registered_at' OR NOT doc ? 'voip_registered_at');
`;

type Query = Pick<SQL, "unsafe">;
const jobFrom = (r: Record<string, unknown>): Job => ({
  id: r.id as string,
  uid: r.uid as string,
  kind: r.kind as Job["kind"],
  requestId: r.request_id as string,
  payload: r.payload as Job["payload"],
  state: r.state as Job["state"],
  available: Number(r.available_at),
  deadline: Number(r.deadline),
  leaseToken: r.lease_token as string | null,
  leaseUntil: r.lease_until === null ? null : Number(r.lease_until),
  attempts: Number(r.attempts),
});

class PgTransaction implements Transaction {
  constructor(
    readonly uid: string,
    private sql: Query,
  ) {}
  async get<K extends Kind>(kind: K, id: string): Promise<Records[K] | null> {
    const rows = await this.sql.unsafe(
      `SELECT doc FROM cloud_records r WHERE uid=$1 AND kind=$2 AND id=$3 ${kind === "device" ? "AND NOT EXISTS(SELECT 1 FROM cloud_displaced_devices x WHERE x.uid=r.uid AND x.device_id=r.id)" : ""}`,
      [this.uid, kind, id],
    );
    return (rows[0]?.doc as Records[K]) ?? null;
  }
  async put<K extends Kind>(
    kind: K,
    id: string,
    doc: Records[K],
    due: number | null = null,
  ) {
    await this.sql.unsafe(
      `INSERT INTO cloud_records(uid,kind,id,doc,due_at,touched_at) VALUES($1,$2,$3,$4::text::jsonb,$5,$6)
      ON CONFLICT(uid,kind,id) DO UPDATE SET doc=EXCLUDED.doc,due_at=EXCLUDED.due_at,touched_at=EXCLUDED.touched_at`,
      [this.uid, kind, id, JSON.stringify(doc), due, Date.now()],
    );
    if (kind === "request" || kind === "device" || kind === "presence")
      await this.bump();
  }
  private async bump() {
    await this.sql.unsafe(
      "INSERT INTO cloud_owner_versions(uid,revision) VALUES($1,1) ON CONFLICT(uid) DO UPDATE SET revision=cloud_owner_versions.revision+1",
      [this.uid],
    );
  }
  async revision() {
    const rows = await this.sql.unsafe(
      "SELECT revision,(SELECT MAX(generation) FROM cloud_displaced_devices WHERE uid=$1) AS displaced FROM cloud_owner_versions WHERE uid=$1",
      [this.uid],
    );
    return `${rows[0]?.revision ?? 0}:${rows[0]?.displaced ?? 0}`;
  }
  async remove(kind: Kind, id: string) {
    await this.sql.unsafe(
      "DELETE FROM cloud_records WHERE uid=$1 AND kind=$2 AND id=$3",
      [this.uid, kind, id],
    );
    if (kind === "request" || kind === "device" || kind === "presence")
      await this.bump();
  }
  async due(now: number) {
    const rows = await this.sql.unsafe(
      "SELECT kind,id,doc FROM cloud_records WHERE uid=$1 AND due_at<=$2 ORDER BY due_at LIMIT 250",
      [this.uid, now],
    );
    return rows as unknown as { kind: Kind; id: string; doc: Records[Kind] }[];
  }
  async list<K extends Kind>(
    kind: K,
    filter: { status?: string; requestId?: string } = {},
    limit = 200,
  ): Promise<Records[K][]> {
    const params: (string | number)[] = [this.uid, kind];
    let where = "uid=$1 AND kind=$2";
    if (kind === "device")
      where +=
        " AND NOT EXISTS(SELECT 1 FROM cloud_displaced_devices x WHERE x.uid=cloud_records.uid AND x.device_id=cloud_records.id)";
    if (filter.status !== undefined) {
      params.push(filter.status);
      where += ` AND record_status=$${params.length}`;
    }
    if (filter.requestId !== undefined) {
      params.push(filter.requestId);
      where += ` AND doc->>'requestId'=$${params.length}`;
    }
    params.push(limit);
    // Keep status predicates and ordering indexable even after long histories.
    // Only fixed SQL fragments are composed; all user values stay parameters.
    const rows = await this.sql.unsafe(
      `SELECT doc FROM cloud_records WHERE ${where} ORDER BY sort_key DESC,id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r: { doc: Records[K] }) => r.doc);
  }
  async enqueue(j: NewJob) {
    await this.sql.unsafe(
      `INSERT INTO cloud_jobs(id,uid,kind,request_id,payload,state,available_at,deadline)
      VALUES($1,$2,$3,$4,$5::text::jsonb,'ready',$6,$7) ON CONFLICT(id) DO NOTHING`,
      [
        scopedJobId(this.uid, j.id ?? crypto.randomUUID()),
        this.uid,
        j.kind,
        j.requestId,
        JSON.stringify(j.payload),
        j.available ?? Date.now(),
        j.deadline,
      ],
    );
  }
  async job(id: string): Promise<Job | null> {
    const rows = await this.sql.unsafe(
      "SELECT * FROM cloud_jobs WHERE uid=$1 AND id=$2 FOR UPDATE",
      [this.uid, id],
    );
    return rows[0] ? jobFrom(rows[0]) : null;
  }
  async saveJob(j: Job) {
    if (j.uid !== this.uid) throw new Error("job owner mismatch");
    await this.sql.unsafe(
      `UPDATE cloud_jobs SET state=$3,available_at=$4,lease_token=$5,lease_until=$6,attempts=$7,
      finished_at=CASE WHEN $3='done' THEN $8::bigint ELSE NULL END WHERE uid=$1 AND id=$2`,
      [
        this.uid,
        j.id,
        j.state,
        j.available,
        j.leaseToken,
        j.leaseUntil,
        j.attempts,
        Date.now(),
      ],
    );
  }
  async claimPush(
    d: Device,
    fields: readonly ("push_token" | "voip_token")[] = [
      "push_token",
      "voip_token",
    ],
  ) {
    // A single globally owned endpoint prevents an old account's queued push
    // from being sent after the same installation pairs with another account.
    const keys = [pushClientKey(d), ...fields.map(field => pushEndpointKey(d, field))].filter((key): key is string => !!key).sort();
    for (const key of keys) {
      if (!key) continue;
      await this.sql.unsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`push:${key}`],
      );
      const displaced = await this.sql.unsafe(
        "SELECT 1 FROM cloud_displaced_devices WHERE uid=$1 AND device_id=$2",
        [this.uid, d.id],
      );
      if (displaced.length) throw unauthorized();
      const previous = await this.sql.unsafe(
        "SELECT uid,device_id FROM cloud_push_owners WHERE endpoint_hash=$1",
        [key],
      );
      const old = previous[0];
      if (old && (old.uid !== this.uid || old.device_id !== d.id)) {
        await this.sql.unsafe(
          "INSERT INTO cloud_displaced_devices(uid,device_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [old.uid, old.device_id],
        );
      }
      await this.sql.unsafe(
        `INSERT INTO cloud_push_owners(endpoint_hash,uid,device_id) VALUES($1,$2,$3)
        ON CONFLICT(endpoint_hash) DO UPDATE SET uid=EXCLUDED.uid,device_id=EXCLUDED.device_id`,
        [key, this.uid, d.id],
      );
    }
  }
  async ownsPush(d: Device, field: "push_token" | "voip_token") {
    const key = pushEndpointKey(d, field);
    if (!key) return false;
    const rows = await this.sql.unsafe(
      "SELECT 1 FROM cloud_push_owners WHERE endpoint_hash=$1 AND uid=$2 AND device_id=$3",
      [key, this.uid, d.id],
    );
    return rows.length > 0;
  }
  async releasePush(deviceId: string) {
    await this.sql.unsafe(
      "DELETE FROM cloud_push_owners WHERE uid=$1 AND device_id=$2",
      [this.uid, deviceId],
    );
  }
}

export class PostgresDatabase implements Database {
  readonly sql: SQL;
  constructor(url: string, max = 10, schema?: string) {
    if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema))
      throw new Error("invalid database schema");
    this.sql = new SQL(url, {
      max,
      connectionTimeout: 5,
      idleTimeout: 20,
      connection: {
        application_name: "oyobidashi",
        statement_timeout: 5000,
        lock_timeout: 2000,
        idle_in_transaction_session_timeout: 10000,
        ...(schema ? { search_path: schema } : {}),
      },
      onclose: () => {},
    });
  }
  async migrate() {
    await this.sql.begin(async (sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock(728194204)");
      await sql.unsafe(SCHEMA);
    });
  }
  async transaction<T>(
    uid: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    if (!uid || uid.length > 128) throw new Error("invalid owner");
    const result = await this.sql.begin(async (sql) => {
      // A brief owner lock serializes claim/answer/cancel/queue updates across all
      // replicas. It is released BEFORE any network, LLM or push operation.
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        uid,
      ]);
      return await fn(new PgTransaction(uid, sql as unknown as Query));
    });
    return result as T;
  }
  async findDevice(hash: string) {
    const rows = await this.sql.unsafe(
      "SELECT uid,doc FROM cloud_records r WHERE kind='device' AND doc->>'tokenHash'=$1 AND NOT EXISTS(SELECT 1 FROM cloud_displaced_devices x WHERE x.uid=r.uid AND x.device_id=r.id)",
      [hash],
    );
    return rows[0]
      ? { uid: rows[0].uid as string, device: rows[0].doc as Device }
      : null;
  }
  async findPairing(hash: string) {
    const rows = await this.sql.unsafe(
      "SELECT uid FROM cloud_records WHERE kind='pairing' AND id=$1",
      [hash],
    );
    return (rows[0]?.uid as string) ?? null;
  }
  async findPreview(hash: string) {
    const rows = await this.sql.unsafe(
      "SELECT uid FROM cloud_records WHERE kind='preview' AND id=$1",
      [hash],
    );
    return (rows[0]?.uid as string) ?? null;
  }
  async isBanned(uid: string) {
    const rows = await this.sql.unsafe(
      "SELECT 1 FROM cloud_records WHERE uid=$1 AND kind='ban' AND id='current'",
      [uid],
    );
    return rows.length > 0;
  }
  async claim(
    kind: Job["kind"],
    now: number,
    leaseMs: number,
  ): Promise<Job | null> {
    const token = crypto.randomUUID();
    // SKIP LOCKED allows workers to compete without a scheduler or a per-user
    // process. All subsequent updates are fenced by the fresh random lease token.
    const rows = await this.sql.unsafe(
      `WITH candidate AS (
      SELECT id FROM cloud_jobs WHERE kind=$1 AND ((state='ready' AND available_at<=$2)
      OR (state='leased' AND lease_until<=$2)) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE cloud_jobs j SET state='leased',lease_token=$3,lease_until=$4,attempts=j.attempts+1
      FROM candidate c WHERE j.id=c.id RETURNING j.*`,
      [kind, now, token, now + leaseMs],
    );
    return rows[0] ? jobFrom(rows[0]) : null;
  }
  async dueOwners(now: number, limit = 100) {
    const rows = await this.sql.unsafe(
      "SELECT DISTINCT uid FROM cloud_records WHERE due_at<=$1 LIMIT $2",
      [now, limit],
    );
    return rows.map((r: { uid: string }) => r.uid);
  }
  async health() {
    await this.sql.unsafe("SELECT 1");
  }
  async billingClaim(source: string, uid: string, exclusive: boolean) {
    return (await this.sql.begin(async (sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `billing:${source}`,
      ]);
      if ((await sql.unsafe("SELECT 1 FROM cloud_billing_superseded WHERE source=$1", [source])).length)
        return null;
      const others = exclusive
        ? await sql.unsafe(
            "DELETE FROM cloud_billing_claims WHERE source=$1 AND uid<>$2 RETURNING uid",
            [source, uid],
          )
        : [];
      await sql.unsafe(
        "INSERT INTO cloud_billing_claims(source,uid) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [source, uid],
      );
      return others.map((r: { uid: string }) => r.uid);
    })) as string[] | null;
  }
  async billingSupersede(source: string, successor: string) {
    if (source === successor) return [];
    return (await this.sql.begin(async (sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`billing:${source}`]);
      await sql.unsafe(
        "INSERT INTO cloud_billing_superseded(source,successor) VALUES($1,$2) ON CONFLICT(source) DO UPDATE SET successor=EXCLUDED.successor",
        [source, successor],
      );
      const displaced = await sql.unsafe("DELETE FROM cloud_billing_claims WHERE source=$1 RETURNING uid", [source]);
      return displaced.map((row: { uid: string }) => row.uid);
    })) as string[];
  }
  async billingHolders(source: string) {
    const rows = await this.sql.unsafe(
      "SELECT uid FROM cloud_billing_claims WHERE source=$1 LIMIT 10000",
      [source],
    );
    return rows.map((r: { uid: string }) => r.uid);
  }
  async billingHeld(source: string, uid: string) {
    const rows = await this.sql.unsafe(
      "SELECT 1 FROM cloud_billing_claims WHERE source=$1 AND uid=$2",
      [source, uid],
    );
    return rows.length > 0;
  }
  async billingRelease(source: string, uid: string) {
    await this.sql.unsafe(
      "DELETE FROM cloud_billing_claims WHERE source=$1 AND uid=$2",
      [source, uid],
    );
  }
  async applyAppleBilling(source: string, uid: string | null, proof: AppleBillingProof) {
    await this.sql.begin(async (sql) => {
      await sql.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`billing:${source}`]);
      const previous = await sql.unsafe("SELECT doc FROM cloud_apple_billing_state WHERE source=$1", [source]);
      if (!newerAppleProof((previous[0]?.doc as AppleBillingProof) ?? null, proof)) return;
      const old = await sql.unsafe("SELECT uid FROM cloud_billing_claims WHERE source=$1", [source]);
      const oldHolders = old.map((row: { uid: string }) => row.uid);
      if (proof.revoked) {
        await sql.unsafe("DELETE FROM cloud_billing_claims WHERE source=$1", [source]);
      } else if (uid) {
        await sql.unsafe("DELETE FROM cloud_billing_claims WHERE source=$1 AND uid<>$2", [source, uid]);
        await sql.unsafe("INSERT INTO cloud_billing_claims(source,uid) VALUES($1,$2) ON CONFLICT DO NOTHING", [source, uid]);
      }
      const affected = [...new Set([...oldHolders, ...(uid ? [uid] : [])])].sort();
      for (const owner of affected) {
        await sql.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [owner]);
        const rows = await sql.unsafe("SELECT doc FROM cloud_records WHERE uid=$1 AND kind='entitlement' AND id='current'", [owner]);
        const entitlement = (rows[0]?.doc as { sources: Record<string, unknown> } | undefined) ?? { sources: {} };
        const held = !proof.revoked && (uid === owner || (uid === null && oldHolders.includes(owner)));
        if (held) entitlement.sources[source] = proof.value;
        else delete entitlement.sources[source];
        await sql.unsafe(
          `INSERT INTO cloud_records(uid,kind,id,doc,touched_at) VALUES($1,'entitlement','current',$2::text::jsonb,$3)
           ON CONFLICT(uid,kind,id) DO UPDATE SET doc=EXCLUDED.doc,touched_at=EXCLUDED.touched_at`,
          [owner, JSON.stringify(entitlement), Date.now()],
        );
      }
      await sql.unsafe(
        "INSERT INTO cloud_apple_billing_state(source,doc) VALUES($1,$2::text::jsonb) ON CONFLICT(source) DO UPDATE SET doc=EXCLUDED.doc",
        [source, JSON.stringify(proof)],
      );
    });
  }
  async applyGoogleBilling(source: string, uid: string, value: EntitlementSource, linkedSource?: string) {
    await this.sql.begin(async (sql) => {
      const sources = [...new Set([source, ...(linkedSource && linkedSource !== source ? [linkedSource] : [])])].sort();
      for (const s of sources)
        await sql.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`billing:${s}`]);
      if ((await sql.unsafe("SELECT 1 FROM cloud_billing_superseded WHERE source=$1", [source])).length) return;
      const old = await sql.unsafe("SELECT uid FROM cloud_billing_claims WHERE source=$1", [source]);
      const oldHolders = old.map((row: { uid: string }) => row.uid);
      let linkedHolders: string[] = [];
      if (linkedSource && linkedSource !== source) {
        await sql.unsafe(
          "INSERT INTO cloud_billing_superseded(source,successor) VALUES($1,$2) ON CONFLICT(source) DO UPDATE SET successor=EXCLUDED.successor",
          [linkedSource, source],
        );
        const displaced = await sql.unsafe("DELETE FROM cloud_billing_claims WHERE source=$1 RETURNING uid", [linkedSource]);
        linkedHolders = displaced.map((row: { uid: string }) => row.uid);
      }
      await sql.unsafe("DELETE FROM cloud_billing_claims WHERE source=$1 AND uid<>$2", [source, uid]);
      await sql.unsafe("INSERT INTO cloud_billing_claims(source,uid) VALUES($1,$2) ON CONFLICT DO NOTHING", [source, uid]);
      for (const owner of [...new Set([...oldHolders, ...linkedHolders, uid])].sort()) {
        await sql.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [owner]);
        const rows = await sql.unsafe("SELECT doc FROM cloud_records WHERE uid=$1 AND kind='entitlement' AND id='current'", [owner]);
        const entitlement = (rows[0]?.doc as Entitlement | undefined) ?? { sources: {} };
        if (linkedSource) delete entitlement.sources[linkedSource];
        if (owner === uid) entitlement.sources[source] = value;
        else delete entitlement.sources[source];
        await sql.unsafe(
          `INSERT INTO cloud_records(uid,kind,id,doc,touched_at) VALUES($1,'entitlement','current',$2::text::jsonb,$3)
           ON CONFLICT(uid,kind,id) DO UPDATE SET doc=EXCLUDED.doc,touched_at=EXCLUDED.touched_at`,
          [owner, JSON.stringify(entitlement), Date.now()],
        );
      }
    });
  }
  async revisions(uids: string[]) {
    if (!uids.length) return new Map<string, string>();
    const rows = await this.sql.unsafe(
      "SELECT uid,revision,(SELECT MAX(generation) FROM cloud_displaced_devices x WHERE x.uid=v.uid) AS displaced FROM cloud_owner_versions v WHERE uid IN (SELECT jsonb_array_elements_text($1::text::jsonb))",
      [JSON.stringify(uids)],
    );
    return new Map<string, string>(
      rows.map((r: { uid: string; revision: unknown; displaced: unknown }) => [
        r.uid,
        `${r.revision}:${r.displaced ?? 0}`,
      ]),
    );
  }
  async cleanup(now = Date.now()) {
    await this.sql.unsafe(
      "DELETE FROM cloud_jobs WHERE id IN (SELECT id FROM cloud_jobs WHERE state='done' AND finished_at<$1 LIMIT 1000)",
      [now - 86400_000],
    );
  }
  async close() {
    await this.sql.end({ timeout: 5 });
  }
}
