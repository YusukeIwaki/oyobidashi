import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { makeHarness } from "./helpers.ts";

describe("request subject", () => {
  test("normalizes a subject and preserves it through device reads and call fallback", async () => {
    const h = makeHarness();
    const device = await h.pair();
    const request = await h.ask({ subject: "  本番デプロイ\n の承認  ", priority: "high", delivery_mode: "call" });
    expect(request.subject).toBe("本番デプロイ の承認");
    const fetched = await h.json("GET", `/v1/requests/${request.id}`, { token: device.token });
    expect(fetched.body.request.subject).toBe(request.subject);
    const fallback = await h.json("POST", `/v1/requests/${request.id}/call`, { token: device.token, body: { event: "decline" } });
    expect(fallback.body.request.subject).toBe(request.subject);
    expect(fallback.body.request.delivery_mode).toBe("text");
  });

  test("missing, null, and blank subjects remain compatible with old requests", async () => {
    const h = makeHarness();
    for (const subject of [undefined, null, "", " \n\t "]) {
      const r = await h.ask({ subject });
      expect(r.subject ?? null).toBeNull();
    }
  });

  test("limits subjects to 40 Unicode code points and rejects other types", async () => {
    const h = makeHarness();
    expect((await h.ask({ subject: "😀".repeat(40) })).subject).toBe("😀".repeat(40));
    for (const subject of ["用".repeat(41), 42, {}, []]) {
      const response = await h.agent("POST", "/v1/requests", { question: "q", subject });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("invalid_request");
    }
  });

  test("migrates an existing database and keeps subjects after reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oyobidashi-subject-"));
    const path = join(directory, "relay.sqlite");
    let store = new Store(path);
    try {
      const old = await makeHarness({ store }).ask();
      store.db.exec("ALTER TABLE requests DROP COLUMN subject");
      store.close();
      store = new Store(path);
      const h = makeHarness({ store });
      expect((await h.agent("GET", `/v1/requests/${old.id}`)).body.request.subject ?? null).toBeNull();
      const created = await h.ask({ subject: "本番デプロイの承認" });
      store.close();
      store = new Store(path);
      expect(store.getRequest(created.id)?.subject).toBe("本番デプロイの承認");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
