import {
  pushEndpointKey,
  scopedJobId,
  type Database,
  type Device,
  type Job,
  type Kind,
  type Records,
  type Transaction,
} from "../src/types.ts";

/** Transactional fault-injection double. Never imported by production code. */
export class MemoryDatabase implements Database {
  records = new Map<
    string,
    {
      kind: Kind;
      id: string;
      uid: string;
      doc: Records[Kind];
      due: number | null;
    }
  >();
  jobs = new Map<string, Job>();
  locks = new Map<string, Promise<void>>();
  fail = false;
  now = Date.now();
  pushOwners = new Map<string, { uid: string; deviceId: string }>();
  versions = new Map<string, number>();
  displaced = new Set<string>();
  private check() {
    if (this.fail)
      throw new Error("injected database disconnection with private details");
  }
  async transaction<T>(
    uid: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    this.check();
    const previous = this.locks.get(uid) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(uid, lock);
    await previous;
    const rows = new Map(
      [...this.records]
        .filter(([, r]) => r.uid === uid)
        .map(([k, v]) => [k, structuredClone(v)]),
    );
    const jobs = new Map(
      [...this.jobs]
        .filter(([, j]) => j.uid === uid)
        .map(([k, v]) => [k, structuredClone(v)]),
    );
    const claims = new Map<string, { uid: string; deviceId: string } | null>();
    let bumps = 0;
    const displaced = new Set<string>();
    const key = (kind: Kind, id: string) => `${uid}:${kind}:${id}`;
    const tx: Transaction = {
      uid,
      get: async <K extends Kind>(kind: K, id: string) =>
        (kind === "device" &&
        (this.displaced.has(`${uid}:${id}`) || displaced.has(`${uid}:${id}`))
          ? null
          : (structuredClone(rows.get(key(kind, id))?.doc) ?? null)) as
          | Records[K]
          | null,
      put: async (kind, id, doc, due = null) => {
        this.check();
        rows.set(key(kind, id), {
          uid,
          kind,
          id,
          doc: structuredClone(doc),
          due,
        });
        if (["request", "device", "presence"].includes(kind)) bumps++;
      },
      remove: async (kind, id) => {
        rows.delete(key(kind, id));
        if (["request", "device", "presence"].includes(kind)) bumps++;
      },
      list: async <K extends Kind>(
        kind: K,
        filter: { status?: string; requestId?: string } = {},
        limit = 200,
      ) =>
        [...rows.values()]
          .filter(
            (r) =>
              r.kind === kind &&
              !(
                kind === "device" &&
                (this.displaced.has(`${uid}:${r.id}`) ||
                  displaced.has(`${uid}:${r.id}`))
              ) &&
              (!filter.status ||
                (r.doc as Records["request"]).status === filter.status) &&
              (!filter.requestId ||
                (r.doc as Records["turn"]).requestId === filter.requestId),
          )
          .sort((a, b) =>
            String(
              (b.doc as Records["request"]).created_at ??
                (b.doc as Records["feedback"]).at ??
                b.id,
            ).localeCompare(
              String(
                (a.doc as Records["request"]).created_at ??
                  (a.doc as Records["feedback"]).at ??
                  a.id,
              ),
            ),
          )
          .slice(0, limit)
          .map((r) => structuredClone(r.doc) as Records[K]),
      due: async (now) =>
        [...rows.values()]
          .filter((r) => r.due !== null && r.due <= now)
          .map((r) => ({
            kind: r.kind,
            id: r.id,
            doc: structuredClone(r.doc),
          })),
      enqueue: async (j) => {
        const id = scopedJobId(uid, j.id ?? crypto.randomUUID());
        if (!jobs.has(id))
          jobs.set(id, {
            ...j,
            id,
            uid,
            state: "ready",
            available: j.available ?? this.now,
            leaseToken: null,
            leaseUntil: null,
            attempts: 0,
          });
      },
      job: async (id) => structuredClone(jobs.get(id) ?? null),
      saveJob: async (j) => {
        jobs.set(j.id, structuredClone(j));
      },
      claimPush: async (d, fields = ["push_token", "voip_token"]) => {
        if (this.displaced.has(`${uid}:${d.id}`))
          throw new Error("superseded pairing");
        for (const field of fields) {
          const k = pushEndpointKey(d, field);
          if (k) {
            const previous = claims.get(k) ?? this.pushOwners.get(k);
            if (
              previous &&
              (previous.uid !== uid || previous.deviceId !== d.id)
            )
              displaced.add(`${previous.uid}:${previous.deviceId}`);
            claims.set(k, { uid, deviceId: d.id });
          }
        }
      },
      ownsPush: async (d, field) => {
        const k = pushEndpointKey(d, field);
        if (!k) return false;
        const owner = claims.has(k) ? claims.get(k) : this.pushOwners.get(k);
        return owner?.uid === uid && owner.deviceId === d.id;
      },
      releasePush: async (deviceId) => {
        for (const [k, v] of this.pushOwners)
          if (v.uid === uid && v.deviceId === deviceId) claims.set(k, null);
      },
      revision: async () => String((this.versions.get(uid) ?? 0) + bumps),
    };
    try {
      const result = await fn(tx);
      this.check();
      for (const [k, r] of this.records)
        if (r.uid === uid) this.records.delete(k);
      for (const [k, j] of this.jobs) if (j.uid === uid) this.jobs.delete(k);
      for (const [k, r] of rows) this.records.set(k, r);
      for (const [k, j] of jobs) this.jobs.set(k, j);
      for (const [k, v] of claims)
        if (v) this.pushOwners.set(k, v);
        else this.pushOwners.delete(k);
      if (bumps) this.versions.set(uid, (this.versions.get(uid) ?? 0) + bumps);
      for (const old of displaced) {
        this.displaced.add(old);
        const owner = old.slice(0, old.indexOf(":"));
        this.versions.set(owner, (this.versions.get(owner) ?? 0) + 1);
      }
      return result;
    } finally {
      release();
      if (this.locks.get(uid) === lock) this.locks.delete(uid);
    }
  }
  async findDevice(hash: string) {
    this.check();
    const r = [...this.records.values()].find(
      (r) =>
        r.kind === "device" &&
        (r.doc as Device).tokenHash === hash &&
        !this.displaced.has(`${r.uid}:${r.id}`),
    );
    return r ? { uid: r.uid, device: structuredClone(r.doc) as Device } : null;
  }
  async findPairing(hash: string) {
    this.check();
    return (
      [...this.records.values()].find(
        (r) => r.kind === "pairing" && r.id === hash,
      )?.uid ?? null
    );
  }
  async findPreview(hash: string) {
    this.check();
    return (
      [...this.records.values()].find(
        (r) => r.kind === "preview" && r.id === hash,
      )?.uid ?? null
    );
  }
  async claim(kind: Job["kind"], now: number, leaseMs: number) {
    this.check();
    const j = [...this.jobs.values()].find(
      (j) =>
        j.kind === kind &&
        ((j.state === "ready" && j.available <= now) ||
          (j.state === "leased" && (j.leaseUntil ?? 0) <= now)),
    );
    if (!j) return null;
    j.state = "leased";
    j.leaseUntil = now + leaseMs;
    j.leaseToken = crypto.randomUUID();
    j.attempts++;
    return structuredClone(j);
  }
  async dueOwners(now: number, limit = 100) {
    this.check();
    return [
      ...new Set(
        [...this.records.values()]
          .filter((r) => r.due !== null && r.due <= now)
          .map((r) => r.uid),
      ),
    ].slice(0, limit);
  }
  async health() {
    this.check();
  }
  async revisions(uids: string[]) {
    this.check();
    return new Map(
      uids.map((uid) => [uid, String(this.versions.get(uid) ?? 0)]),
    );
  }
  async close() {}
}
