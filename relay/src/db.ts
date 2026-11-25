import type { ItemAnswer, RequestItem } from "./request-items.ts";
import { Database, type Statement } from "bun:sqlite";
import { freshPushRegistration } from "./push/lifecycle.ts";
import type {
  Call,
  Presence,
  Priority,
  DeliveryMode,
  RequestedMode,
  FeedbackEvent,
  DeviceObject,
  InputMethod,
  Kind,
  Platform,
  PushEnvironment,
  RequestObject,
  Status,
  Urgency,
} from "./types.ts";

export interface RequestRow {
  priority: Priority;
  delivery_mode: DeliveryMode;
  requested_mode: RequestedMode;
  call_json: string | null;
  items_json: string | null;
  item_answers_json: string | null;
  seq: number;
  id: string;
  kind: Kind;
  question: string;
  subject: string | null;
  context: string | null;
  choices: string | null;
  urgency: Urgency;
  status: Status;
  answer_text: string | null;
  answer_choice_index: number | null;
  answer_input_method: InputMethod | null;
  answer_device_id: string | null;
  answered_at: number | null;
  agent_name: string | null;
  agent_cwd: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface DeviceRow {
  supports_request_items?: number;
  push_client_id?: string | null;
  push_registered_at?: number | null;
  voip_registered_at?: number | null;
  voip_token?: string | null;
  id: string;
  name: string;
  platform: Platform;
  token_hash: string;
  push_token: string | null;
  push_environment: PushEnvironment | null;
  created_at: number;
}

export interface NewRequest {
  priority?: Priority;
  delivery_mode?: DeliveryMode;
  requested_mode?: RequestedMode;
  id: string;
  kind: Kind;
  question: string;
  subject?: string | null;
  context: string | null;
  choices: string[] | null;
  items?: RequestItem[] | undefined;
  urgency: Urgency;
  status: Status;
  agent_name: string | null;
  agent_cwd: string | null;
  created_at: number;
  expires_at: number;
}

export interface NewAnswer {
  text: string;
  choice_index: number | null;
  input_method: InputMethod;
  device_id: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function toRequestObject(row: RequestRow): RequestObject {
  return {
    id: row.id,
    priority: row.priority ?? "normal",
    delivery_mode: row.delivery_mode ?? "text",
    requested_mode: row.requested_mode ?? "auto",
    call: row.call_json ? JSON.parse(row.call_json) as Call : null,
    kind: row.kind,
    question: row.question,
    ...(row.subject ? { subject: row.subject } : {}),
    context: row.context,
    choices: row.choices === null ? null : (JSON.parse(row.choices) as string[]),
    ...(row.items_json ? {
      items: JSON.parse(row.items_json) as RequestItem[],
      item_answers: row.item_answers_json ? JSON.parse(row.item_answers_json) as ItemAnswer[] : [],
    } : {}),
    urgency: row.urgency,
    status: row.status,
    answer:
      row.status === "answered" && row.answer_text !== null
        ? {
            text: row.answer_text,
            choice_index: row.answer_choice_index,
            input_method: row.answer_input_method ?? "text",
            device_id: row.answer_device_id ?? "",
            answered_at: iso(row.answered_at ?? row.updated_at),
          }
        : null,
    agent:
      row.agent_name === null && row.agent_cwd === null
        ? null
        : { name: row.agent_name, cwd: row.agent_cwd },
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    expires_at: iso(row.expires_at),
  };
}

export function toDeviceObject(row: DeviceRow): DeviceObject {
  return { id: row.id, name: row.name, platform: row.platform, created_at: iso(row.created_at) };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  choices TEXT,
  urgency TEXT NOT NULL,
  status TEXT NOT NULL,
  answer_text TEXT,
  answer_choice_index INTEGER,
  answer_input_method TEXT,
  answer_device_id TEXT,
  answered_at INTEGER,
  agent_name TEXT,
  agent_cwd TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_pending_expiry ON requests (expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS requests_status ON requests (status, created_at);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  push_token TEXT,
  push_environment TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
`;

/** All persistence. bun:sqlite is synchronous, so every method is an atomic step. */
export class Store {
  readonly db: Database;
  private stmts = new Map<string, Statement>();

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
    }
    // The CLI (pair / revoke) writes to the same file while `serve` is running.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Additive migrations also cover databases created by the reference app.
    const columns = new Set((this.db.query("PRAGMA table_info(requests)").all() as { name: string }[]).map(x => x.name));
    for (const [name, definition] of Object.entries({ priority: "TEXT NOT NULL DEFAULT 'normal'", delivery_mode: "TEXT NOT NULL DEFAULT 'text'", requested_mode: "TEXT NOT NULL DEFAULT 'auto'", call_json: "TEXT", subject: "TEXT", items_json: "TEXT", item_answers_json: "TEXT" })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${definition}`);
    }
    const deviceColumns = new Set((this.db.query("PRAGMA table_info(devices)").all() as { name: string }[]).map(x => x.name));
    if (!deviceColumns.has("supports_request_items")) this.db.exec("ALTER TABLE devices ADD COLUMN supports_request_items INTEGER NOT NULL DEFAULT 0");
    if (!deviceColumns.has("voip_token")) this.db.exec("ALTER TABLE devices ADD COLUMN voip_token TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS presence (device_id TEXT PRIMARY KEY, availability TEXT NOT NULL, until_ms INTEGER, note TEXT, updated_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, device_id TEXT, event TEXT NOT NULL, at INTEGER NOT NULL);`);
    for (const name of ["push_client_id", "push_registered_at", "voip_registered_at"]) {
      if (deviceColumns.has(name)) continue;
      this.db.exec(`ALTER TABLE devices ADD COLUMN ${name} ${name === "push_client_id" ? "TEXT" : "INTEGER"}`);
      if (name !== "push_client_id") this.db.exec(`UPDATE devices SET ${name} = COALESCE((SELECT last_seen_at FROM presence WHERE device_id = devices.id), created_at)`);
    }
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  private q(sql: string): Statement {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  // ---- requests ----

  insertRequest(r: NewRequest): RequestRow {
    const row = this.q(
      `INSERT INTO requests (id, kind, question, subject, context, choices, items_json, urgency, status, agent_name, agent_cwd, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      r.id,
      r.kind,
      r.question,
      r.subject ?? null,
      r.context,
      r.choices === null ? null : JSON.stringify(r.choices),
      r.items ? JSON.stringify(r.items) : null,
      r.urgency,
      r.status,
      r.agent_name,
      r.agent_cwd,
      r.created_at,
      r.created_at,
      r.expires_at,
    ) as RequestRow;
    this.q("UPDATE requests SET priority = ?, delivery_mode = ?, requested_mode = ? WHERE id = ?").run(r.priority ?? "normal", r.delivery_mode ?? "text", r.requested_mode ?? "auto", r.id);
    return this.getRequest(row.id)!;
  }

  updateRouting(id: string, priority: Priority, mode: DeliveryMode, requested: RequestedMode, now: number): RequestRow | null {
    return this.q("UPDATE requests SET priority = ?, delivery_mode = ?, requested_mode = ?, updated_at = MAX(?, updated_at + (items_json IS NOT NULL)) WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING *").get(priority, mode, requested, now, id, now) as RequestRow | null;
  }

  saveCall(id: string, call: Call, now: number, items?: ItemAnswer[]): RequestRow {
    this.q("UPDATE requests SET call_json = ?, updated_at = MAX(?, updated_at + (items_json IS NOT NULL)), item_answers_json = COALESCE(?, item_answers_json) WHERE id = ?")
      .run(JSON.stringify(call), now, items ? JSON.stringify(items) : null, id);
    return this.getRequest(id)!;
  }

  liveCalls(): RequestRow[] {
    return (this.q("SELECT * FROM requests WHERE call_json IS NOT NULL AND status = 'pending'").all() as RequestRow[]).filter(row => JSON.parse(row.call_json!).state !== "ended");
  }

  feedback(requestId: string, deviceId: string | null, event: string, now: number): void {
    this.q("INSERT INTO feedback (request_id, device_id, event, at) VALUES (?, ?, ?, ?)").run(requestId, deviceId, event, now);
    this.q("DELETE FROM feedback WHERE seq NOT IN (SELECT seq FROM feedback ORDER BY seq DESC LIMIT 200)").run();
  }

  recentFeedback(): FeedbackEvent[] {
    return (this.q("SELECT request_id, device_id, event, at FROM feedback ORDER BY seq DESC LIMIT 50").all() as {request_id:string;device_id:string|null;event:string;at:number}[]).map(x=>({...x, at:iso(x.at)}));
  }

  setPresence(deviceId: string, availability: Presence["availability"], until: number | null, note: string | null, now: number): void {
    this.q("INSERT INTO presence VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET availability=excluded.availability, until_ms=excluded.until_ms, note=excluded.note, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at").run(deviceId, availability, until, note, now, now);
  }

  noteRequestItemsSupport(deviceId: string): void {
    this.q("UPDATE devices SET supports_request_items = 1 WHERE id = ? AND supports_request_items = 0").run(deviceId);
  }

  touchDevice(deviceId: string, now: number): void {
    this.q("INSERT INTO presence VALUES (?, 'available', NULL, NULL, ?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen_at=excluded.last_seen_at").run(deviceId, now, now);
  }

  listPresence(now: number): Presence[] {
    return this.listDevices().map(d => {
      const row = this.q("SELECT * FROM presence WHERE device_id = ?").get(d.id) as {availability:Presence["availability"];until_ms:number|null;note:string|null;updated_at:number;last_seen_at:number}|null;
      const expired = row?.until_ms != null && row.until_ms <= now;
      return {device_id:d.id, availability: expired ? "available" : row?.availability ?? "available", until: !expired && row?.until_ms ? iso(row.until_ms) : null, note:expired ? null : row?.note ?? null, updated_at:iso(row?.updated_at ?? d.created_at), last_seen_at:iso(row?.last_seen_at ?? d.created_at)};
    });
  }

  getRequest(id: string): RequestRow | null {
    return (this.q("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | null) ?? null;
  }

  listRequests(status: Status | null, limit: number): RequestRow[] {
    if (status === null) {
      return this.q("SELECT * FROM requests ORDER BY created_at DESC, seq DESC LIMIT ?").all(limit) as RequestRow[];
    }
    return this.q("SELECT * FROM requests WHERE status = ? ORDER BY created_at DESC, seq DESC LIMIT ?").all(
      status,
      limit,
    ) as RequestRow[];
  }

  countRequests(status: Status): number {
    return (this.q("SELECT COUNT(*) AS n FROM requests WHERE status = ?").get(status) as { n: number }).n;
  }

  /** First answer wins: only a pending, non-expired request can be answered. */
  answerRequest(id: string, a: NewAnswer, now: number, items?: ItemAnswer[]): RequestRow | null {
    return (
      (this.q(
        `UPDATE requests SET status = 'answered', answer_text = ?, answer_choice_index = ?, answer_input_method = ?,
           answer_device_id = ?, answered_at = ?, updated_at = MAX(?, updated_at + (items_json IS NOT NULL)), item_answers_json = COALESCE(?, item_answers_json)
         WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING *`,
      ).get(a.text, a.choice_index, a.input_method, a.device_id, now, now, items ? JSON.stringify(items) : null, id, now) as RequestRow | null) ?? null
    );
  }

  cancelRequest(id: string, now: number): RequestRow | null {
    return (
      (this.q(
        `UPDATE requests SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND (status = 'notified' OR (status = 'pending' AND expires_at > ?)) RETURNING *`,
      ).get(now, id, now) as RequestRow | null) ?? null
    );
  }

  /** Transitions every overdue pending request to expired and returns them. */
  expireDue(now: number): RequestRow[] {
    return this.q(
      `UPDATE requests SET status = 'expired', updated_at = ?
       WHERE status = 'pending' AND expires_at <= ? RETURNING *`,
    ).all(now, now) as RequestRow[];
  }

  // ---- devices ----

  insertDevice(d: DeviceRow): DeviceRow {
    this.q(
      `INSERT INTO devices (id, name, platform, token_hash, push_token, push_environment, created_at, push_client_id, push_registered_at, voip_token, voip_registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(d.id, d.name, d.platform, d.token_hash, d.push_token, d.push_environment, d.created_at, d.push_client_id ?? null, d.push_token ? d.created_at : null, d.voip_token ?? null, d.voip_token ? d.created_at : null);
    return this.getDevice(d.id)!;
  }

  getDevice(id: string): DeviceRow | null {
    return (this.q("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | null) ?? null;
  }

  getDeviceByTokenHash(hash: string): DeviceRow | null {
    return (this.q("SELECT * FROM devices WHERE token_hash = ?").get(hash) as DeviceRow | null) ?? null;
  }

  listDevices(): DeviceRow[] {
    return this.q("SELECT * FROM devices ORDER BY created_at ASC, rowid ASC").all() as DeviceRow[];
  }

  listDeviceIds(): string[] {
    return (this.q("SELECT id FROM devices").all() as { id: string }[]).map((r) => r.id);
  }

  updateDevice(
    id: string,
    patch: { name?: string; push_token?: string | null; voip_token?: string | null; push_environment?: PushEnvironment | null; push_client_id?: string },
    now = Date.now(),
  ): DeviceRow | null {
    const cur = this.getDevice(id);
    if (!cur) return null;
    const next: DeviceRow = {
      ...cur,
      name: patch.name ?? cur.name,
      voip_token: patch.voip_token !== undefined ? patch.voip_token : cur.voip_token,
      push_token: patch.push_token !== undefined ? patch.push_token : cur.push_token,
      push_environment: patch.push_environment !== undefined ? patch.push_environment : cur.push_environment,
    };
    next.push_client_id = patch.push_client_id ?? cur.push_client_id;
    next.push_registered_at = patch.push_token !== undefined ? (patch.push_token ? now : null) : cur.push_registered_at;
    next.voip_registered_at = patch.voip_token !== undefined ? (patch.voip_token ? now : null) : cur.voip_registered_at;
    this.q("UPDATE devices SET name = ?, push_token = ?, push_environment = ?, voip_token = ?, push_client_id = ?, push_registered_at = ?, voip_registered_at = ? WHERE id = ?").run(
      next.name,
      next.push_token,
      next.push_environment,
      next.voip_token ?? null,
      next.push_client_id ?? null,
      next.push_registered_at ?? null,
      next.voip_registered_at ?? null,
      id,
    );
    return next;
  }

  clearVoipToken(id: string, token: string): void {
    this.q("UPDATE devices SET voip_token = NULL WHERE id = ? AND voip_token = ?").run(id, token);
  }

  /** Reinstallation can rotate both tokens; the stable client ID revokes the whole old pairing. */
  retirePushClients(device: DeviceRow): string[] {
    if (!device.push_client_id) return [];
    const old = this.listDevices().filter(d => d.id !== device.id && d.platform === device.platform && d.push_client_id === device.push_client_id);
    for (const d of old) this.deleteDevice(d.id);
    return old.map(d => d.id);
  }

  prunePushRegistrations(now: number): void {
    for (const d of this.listDevices()) {
      if (d.push_token && !freshPushRegistration(d.push_registered_at ?? d.created_at, now)) this.clearPushToken(d.id, d.push_token);
      if (d.voip_token && !freshPushRegistration(d.voip_registered_at ?? d.created_at, now)) this.clearVoipToken(d.id, d.voip_token);
    }
  }

  clearVoipTokenFromOthers(token: string, exceptId: string): void {
    this.q("UPDATE devices SET voip_token = NULL WHERE voip_token = ? AND id <> ?").run(token, exceptId);
  }

  deleteDevice(id: string): boolean {
    this.q("DELETE FROM presence WHERE device_id = ?").run(id);
    return this.q("DELETE FROM devices WHERE id = ?").run(id).changes > 0;
  }

  /** Clears the push token only if it is still the one that was reported dead. */
  clearPushToken(id: string, token: string): boolean {
    return this.q("UPDATE devices SET push_token = NULL WHERE id = ? AND push_token = ?").run(id, token).changes > 0;
  }

  /** A push token belongs to one app install; when it shows up on a new pairing, older pairings stop using it. */
  clearPushTokenFromOthers(platform: Platform, token: string, exceptId: string): void {
    this.q("UPDATE devices SET push_token = NULL WHERE platform = ? AND push_token = ? AND id <> ?").run(
      platform,
      token,
      exceptId,
    );
  }

  // ---- pairing codes ----

  insertPairingCode(codeHash: string, createdAt: number, expiresAt: number): void {
    this.q("INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)").run(
      codeHash,
      createdAt,
      expiresAt,
    );
  }

  /** Single use: succeeds exactly once per code, and only before it expires. */
  consumePairingCode(codeHash: string, now: number): boolean {
    return (
      this.q("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").run(
        now,
        codeHash,
        now,
      ).changes > 0
    );
  }

  purgePairingCodes(now: number): void {
    this.q("DELETE FROM pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
  }
}
