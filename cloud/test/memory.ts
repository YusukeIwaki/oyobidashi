import { resolvePurchaseOwner } from "../src/billing/account.ts";
import {
  newerAppleProof,
  pushEndpointKey,
  pushClientKey,
  scopedJobId,
  type Database,
  type AppleBillingProof,
  type EntitlementSource,
  type GoogleBillingProof,
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
  private deleted = new Set<string>();
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
    let erased = false;
    const displaced = new Set<string>();
    const key = (kind: Kind, id: string) => `${uid}:${kind}:${id}`;
    const tx: Transaction = {
      uid,
      accountDeleted: async () => erased || this.deleted.has(uid),
      eraseAccount: async () => {
        rows.clear();
        jobs.clear();
        for (const [key, owner] of this.pushOwners) if (owner.uid === uid) claims.set(key, null);
        erased = true;
      },
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
        for (const k of [pushClientKey(d), ...fields.map(field => pushEndpointKey(d, field))]) {
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
      if (erased) {
        const marker = "deleted:" + new Bun.CryptoHasher("sha256").update(uid).digest("hex");
        for (const owners of this.billing.values()) if (owners.delete(uid)) owners.add(marker);
        this.deleted.add(uid);
        this.versions.delete(uid);
        for (const key of this.displaced) if (key.startsWith(uid + ":")) this.displaced.delete(key);
      }
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
  async findAccountDeletion(hash: string) {
    return [...this.records.values()].find(row => row.kind === "account_delete_ticket" && row.id === hash)?.uid ?? null;
  }
  async isBanned(uid: string) {
    this.check();
    return this.records.has(`${uid}:ban:current`);
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
  billing = new Map<string, Set<string>>();
  billingSuperseded = new Map<string, string>();
  appleState = new Map<string, AppleBillingProof>();
  private async withBillingLock<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    const key = "billing";
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, lock);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === lock) this.locks.delete(key);
    }
  }
  private async updateEntitlement(owner: string, source: string, value: EntitlementSource | null, predecessor?: string) {
    return await this.transaction(owner, async (tx) => {
      if (owner.startsWith("deleted:") || await tx.accountDeleted() || await tx.get("account_deletion", "current")) return false;
      const entitlement = (await tx.get("entitlement", "current")) ?? { sources: {} };
      if (predecessor) delete entitlement.sources[predecessor];
      if (value) entitlement.sources[source] = value;
      else delete entitlement.sources[source];
      await tx.put("entitlement", "current", entitlement);
      return true;
    });
  }
  async applyAppleBilling(source: string, uid: string | null, proof: AppleBillingProof, now: number) {
    await this.withBillingLock(async () => {
      const previous = this.appleState.get(source) ?? null;
      if (!newerAppleProof(previous, proof)) return;
      if (previous?.accountId !== undefined) {
        if (proof.accountId !== undefined && proof.accountId !== previous.accountId) return;
        proof = { ...proof, accountId: previous.accountId };
      }
      const owners = await this.billingHolders(source);
      const owner = resolvePurchaseOwner(owners, uid, proof.accountId);
      if (!owner && (uid !== null || owners.length > 0)) return;
      const active = !proof.revoked && proof.value.expires > now;
      if (owner && (owners.length > 0 || active)) {
        if (await this.updateEntitlement(owner, source, active ? proof.value : null))
          this.billing.set(source, new Set([owner]));
      }
      this.appleState.set(source, structuredClone(proof));
    });
  }
  async applyGoogleBilling(source: string, uid: string | null, proof: GoogleBillingProof, now: number) {
    return this.withBillingLock(async () => {
      const active = proof.value.expires > now;
      const predecessor = active && proof.linkedSource !== source ? proof.linkedSource : undefined;
      const successor = predecessor ? this.billingSuperseded.get(predecessor) : undefined;
      if (this.billingSuperseded.has(source) || (successor && successor !== source)) return false;
      const owners = await this.billingHolders(source);
      if (predecessor) owners.push(...await this.billingHolders(predecessor));
      const owner = resolvePurchaseOwner(owners, uid, proof.accountId);
      if (!owner || (!active && !owners.length)) return false;
      if (!await this.updateEntitlement(owner, source, active ? proof.value : null, predecessor)) return false;
      if (active) {
        this.billing.set(source, new Set([owner]));
        if (predecessor) {
          this.billing.set(predecessor, new Set([owner]));
          this.billingSuperseded.set(predecessor, source);
        }
      }
      return active;
    });
  }
  async billingHolders(source: string) {
    this.check();
    return [...(this.billing.get(source) ?? [])];
  }
  async revisions(uids: string[]) {
    this.check();
    return new Map(
      uids.map((uid) => [uid, String(this.versions.get(uid) ?? 0)]),
    );
  }
  async close() {}
}
