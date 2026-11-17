import { describe, expect, test } from "bun:test";
import { harness } from "./helpers.ts";
import { JobWorker } from "../src/worker.ts";
import type { RequestObject } from "../../relay/src/types.ts";

describe("call subjects", () => {
  test("validates, normalizes, and persists subjects for authenticated device reads", async () => {
    const h = harness();
    const d = await h.pair();
    const created = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "実行してよいですか？", subject: " 本番デプロイ\nの承認 ",
    });
    expect(created.status).toBe(201);
    expect(created.body.request.subject).toBe("本番デプロイ の承認");
    const fetched = await h.call("GET", `/v1/requests/${created.body.request.id}`, d.device_token);
    expect(fetched.body.request.subject).toBe("本番デプロイ の承認");
    for (const subject of [undefined, null, "", " \n\t ", "😀".repeat(40)]) {
      const r = await h.call("POST", "/v1/requests", "agent-alice", { question: "q", subject });
      expect(r.status).toBe(201);
      expect(r.body.request.subject ?? null).toBe(subject?.trim() ? subject : null);
    }
    for (const subject of ["用".repeat(41), 42, {}, []]) {
      const r = await h.call("POST", "/v1/requests", "agent-alice", { question: "q", subject });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_request");
    }
  });

  test("VoIP pushes expose only the short subject while ordinary and cancellation pushes stay generic", async () => {
    const h = harness();
    const d = await h.pair();
    await h.call("PUT", "/v1/devices/me", d.device_token, { push_token: "synthetic-push", voip_token: "synthetic-voip" });
    const sent: { type: string | undefined; request: RequestObject }[] = [];
    const worker = new JobWorker(h.service, {
      publicOrigin: "https://relay.example",
      push: { ios: { send: async (target, request) => { sent.push({ type: target.type, request }); return { ok: true }; } } },
    });
    const r = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "private question", context: "private context", choices: ["private yes"],
      subject: "本番デプロイの承認", priority: "high", delivery_mode: "call", agent: { name: "private agent" },
    });
    await worker.runOnce("push");
    expect(sent[0]!.type).toBe("voip");
    expect(sent[0]!.request.subject).toBe("本番デプロイの承認");
    expect(sent[0]!.request.agent).toBeNull();
    expect(JSON.stringify(sent[0])).not.toContain("private");
    await h.call("POST", `/v1/requests/${r.body.request.id}/cancel`);
    await worker.runOnce("push");
    expect(sent[1]!.type).toBe("update");
    expect(sent[1]!.request.subject ?? null).toBeNull();
    await h.call("POST", "/v1/requests", "agent-alice", { question: "private question", subject: "本番デプロイの承認" });
    await worker.runOnce("push");
    expect(sent[2]!.type).toBe("alert");
    expect(sent[2]!.request.subject ?? null).toBeNull();
  });
});
