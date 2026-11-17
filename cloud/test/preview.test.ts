import { describe, expect, test } from "bun:test";
import { harness } from "./helpers.ts";
import { JobWorker } from "../src/worker.ts";
import type { RequestObject } from "../../relay/src/types.ts";
import { buildApnsPayload } from "../../relay/src/push/apns.ts";
import { buildFcmData } from "../../relay/src/push/fcm.ts";

async function setup() {
  const h = harness(),
    d = await h.pair();
  await h.call("PUT", "/v1/devices/me", d.device_token, {
    push_token: "synthetic-push",
  });
  const r = await h.call("POST", "/v1/requests", "agent-alice", {
    question: "private question",
    context: "private context",
    choices: ["private yes", "private no"],
  });
  let push!: RequestObject;
  await new JobWorker(h.service, {
    publicOrigin: "https://relay.example",
    push: {
      ios: {
        send: async (_, request) => {
          push = request;
          return { ok: true };
        },
      },
    },
  }).runOnce("push");
  const path = new URL(push.preview_url!).pathname;
  return { h, d, r, push, path, token: push.preview_token! };
}
describe("scoped notification preview", () => {
  test("Push contains only a generic fallback and bounded capability, while preview restores question/actions", async () => {
    const s = await setup();
    expect(s.push.question).not.toContain("private");
    expect(s.push.context).toBeNull();
    expect(s.push.choices).toBeNull();
    const preview = await s.h.call("GET", s.path, s.token);
    expect(preview.status).toBe(200);
    expect(preview.body.request.question).toBe("private question");
    expect(preview.body.request.choices).toEqual(["private yes", "private no"]);
    expect(preview.body.recipient_device_id).toBe(s.d.device.id);
    expect(s.push.preview_url).not.toContain(s.token);
    expect(buildApnsPayload(s.push)).toMatchObject({
      recipient_device_id: s.d.device.id,
      preview_url: s.push.preview_url,
      preview_token: s.token,
    });
    expect(buildFcmData(s.push)).toMatchObject({
      recipient_device_id: s.d.device.id,
      preview_url: s.push.preview_url,
      preview_token: s.token,
    });
  });
  test("preview token cannot read other questions or any agent API", async () => {
    const s = await setup();
    expect((await s.h.call("GET", "/v1/previews/other", s.token)).status).toBe(
      401,
    );
    expect(
      (await s.h.call("GET", `/v1/requests/${s.r.body.request.id}`, s.token))
        .status,
    ).toBe(401);
    expect((await s.h.call("POST", "/v1/pairing-codes", s.token)).status).toBe(
      401,
    );
    expect(
      (await s.h.call("GET", `${s.path}?access_token=${s.token}`, null)).status,
    ).toBe(401);
  });
  test("expired or revoked preview cannot fetch confidential content", async () => {
    const s = await setup();
    s.h.advance(300_001);
    expect((await s.h.call("GET", s.path, s.token)).status).toBe(401);
    const revoked = await setup();
    await revoked.h.call("DELETE", "/v1/devices/me", revoked.d.device_token);
    expect(
      (await revoked.h.call("GET", revoked.path, revoked.token)).status,
    ).toBe(401);
  });
  test("in-flight old-account notification cannot preview after endpoint reassignment or reclaim ownership", async () => {
    const s = await setup(),
      code = (await s.h.call("POST", "/v1/pairing-codes", "agent-bob")).body
        .code;
    const paired = await s.h.call("POST", "/v1/pair", null, {
      code,
      device_name: "same installation",
      platform: "ios",
      push_token: "synthetic-push",
    });
    expect(paired.status).toBe(201);
    expect((await s.h.call("GET", s.path, s.token)).status).toBe(401);
    expect(
      (
        await s.h.call("PUT", "/v1/devices/me", s.d.device_token, {
          push_token: "synthetic-push",
        })
      ).status,
    ).toBe(401);
    expect(
      (await s.h.call("GET", "/v1/requests", paired.body.device_token)).status,
    ).toBe(200);
  });
  test("a cancelled question is visible as closed, never an actionable stale preview", async () => {
    const s = await setup();
    await s.h.call("POST", `/v1/requests/${s.r.body.request.id}/cancel`);
    const preview = await s.h.call("GET", s.path, s.token);
    expect(preview.status).toBe(200);
    expect(preview.body.request.status).toBe("cancelled");
  });
});
