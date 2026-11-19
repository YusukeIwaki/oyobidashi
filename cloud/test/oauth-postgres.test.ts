import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { PostgresOAuthStore } from "../src/oauth-postgres.ts";
import type { OAuthRow } from "../src/oauth.ts";
import { PostgresDatabase } from "../src/postgres.ts";

const url = process.env.CLOUD_TEST_DATABASE_URL;
const suite = describe.skipIf(!url);
const admin = url ? postgres(url, { max: 2, onnotice: () => {} }) : null;
const resources: { db: PostgresDatabase; schema: string }[] = [];
async function setup() {
  const schema = `oyobidashi_test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  const db = new PostgresDatabase(url!, 10, schema);
  resources.push({ db, schema });
  await db.migrate();
  const store = new PostgresOAuthStore(db.sql);
  await store.migrate();
  await store.migrate();
  return store;
}
afterAll(async () => {
  for (const r of resources) {
    await r.db.close();
    await admin!.unsafe(`DROP SCHEMA ${r.schema} CASCADE`);
  }
  await admin?.end();
});
const row = (over: Partial<OAuthRow>): OAuthRow => ({
  kind: "refresh", id: crypto.randomUUID(), uid: "alice", grant: "g1",
  doc: { client: "c1", name: "Client" }, created: 1000, expires: 10_000_000, used: null, ...over,
});

suite("real PostgreSQL OAuth store", () => {
  test("rows round-trip and a duplicate secret is refused", async () => {
    const store = await setup();
    const client = row({ kind: "client", id: "c1", uid: null, grant: null, doc: { name: null, redirect_uris: ["http://127.0.0.1/cb"] } });
    await store.insert(client);
    expect(await store.get("client", "c1")).toEqual(client);
    expect(await store.get("access", "c1")).toBeNull();
    await expect(store.insert(client)).rejects.toThrow();
    await store.extend("client", "c1", 5);
    expect((await store.get("client", "c1"))!.expires).toBe(10_000_000);
    await store.extend("client", "c1", 20_000_000);
    expect((await store.get("client", "c1"))!.expires).toBe(20_000_000);
    expect(await store.countSince("client", 1000)).toBe(1);
    expect(await store.countSince("client", 1001)).toBe(0);
  });
  test("exactly one of many concurrent redemptions wins", async () => {
    const store = await setup();
    await store.insert(row({ kind: "code", id: "code1" }));
    const results = await Promise.all(Array.from({ length: 12 }, () => store.consume("code", "code1", 5000, 600)));
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ used: 5000, expires: 5600, uid: "alice", grant: "g1" });
    expect((await store.get("code", "code1"))!.used).toBe(5000);
    expect(await store.consume("code", "missing", 5000, 600)).toBeNull();
  });
  test("revoking an approval removes all of its credentials and nothing else", async () => {
    const store = await setup();
    await store.insert(row({ kind: "code", id: "k1" }));
    await store.insert(row({ kind: "access", id: "a1" }));
    await store.insert(row({ kind: "refresh", id: "r1" }));
    await store.insert(row({ kind: "refresh", id: "r2", grant: "g2" }));
    await store.insert(row({ kind: "client", id: "c1", uid: null, grant: null }));
    await store.revokeGrant("g1");
    expect(await store.get("code", "k1")).toBeNull();
    expect(await store.get("access", "a1")).toBeNull();
    expect(await store.get("refresh", "r1")).toBeNull();
    expect(await store.get("refresh", "r2")).not.toBeNull();
    expect(await store.get("client", "c1")).not.toBeNull();
  });
  test("an owner can list and revoke only their grants, and registration quota is per host", async () => {
    const store = await setup();
    await store.insert(row({ kind: "client", id: "c1", uid: null, grant: null,
      doc: { registration_hosts: ["app.example", "callback.example"] } }));
    await store.insert(row({ kind: "client", id: "c2", uid: null, grant: null,
      doc: { registration_hosts: ["other.example"] } }));
    await store.insert(row({ kind: "refresh", id: "alice-r", grant: "ga" }));
    await store.insert(row({ kind: "access", id: "alice-a", grant: "ga" }));
    await store.insert(row({ kind: "refresh", id: "bob-r", uid: "bob", grant: "gb" }));
    expect((await store.listGrants("alice")).map((r: OAuthRow) => r.grant)).toEqual(["ga"]);
    expect(await store.countRegistrations("app.example", 1000)).toBe(1);
    expect(await store.countRegistrations("other.example", 1000)).toBe(1);
    expect(await store.countRegistrations("missing.example", 1000)).toBe(0);
    await store.revokeOwnedGrant("alice", "gb");
    expect(await store.get("refresh", "bob-r")).not.toBeNull();
    await store.revokeOwnedGrant("alice", "ga");
    expect(await store.get("refresh", "alice-r")).toBeNull();
    expect(await store.get("access", "alice-a")).toBeNull();
    await store.insert(row({ kind: "refresh", id: "alice-r2", grant: "ga2" }));
    await store.revokeOwner("alice");
    expect(await store.get("refresh", "alice-r2")).toBeNull();
    expect(await store.get("refresh", "bob-r")).not.toBeNull();
  });
  test("trimming keeps a user's newest approvals and other users untouched", async () => {
    const store = await setup();
    for (let i = 1; i <= 4; i++) {
      await store.insert(row({ kind: "refresh", id: `r${i}`, grant: `g${i}`, created: i * 100 }));
      await store.insert(row({ kind: "access", id: `a${i}`, grant: `g${i}`, created: i * 100 }));
    }
    // A rotated approval counts by its most recent token.
    await store.insert(row({ kind: "refresh", id: "r1b", grant: "g1", created: 900 }));
    await store.insert(row({ kind: "refresh", id: "bob", uid: "bob", grant: "gb", created: 1 }));
    await store.trimGrants("alice", 2);
    expect(await store.get("refresh", "r1b")).not.toBeNull();
    expect(await store.get("access", "a1")).not.toBeNull();
    expect(await store.get("refresh", "r4")).not.toBeNull();
    expect(await store.get("refresh", "r2")).toBeNull();
    expect(await store.get("access", "a3")).toBeNull();
    expect(await store.get("refresh", "bob")).not.toBeNull();
  });
  test("cleanup removes only expired rows", async () => {
    const store = await setup();
    await store.insert(row({ id: "old", expires: 100 }));
    await store.insert(row({ id: "live", expires: 300 }));
    await store.cleanup(200);
    expect(await store.get("refresh", "old")).toBeNull();
    expect(await store.get("refresh", "live")).not.toBeNull();
  });
});
