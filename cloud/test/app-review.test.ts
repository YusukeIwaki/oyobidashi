import { expect, test } from "bun:test";
import { CloudApp } from "../src/app.ts";
import { ReviewPortal } from "../src/app-review.ts";
import { OFFICIAL_CLOUD_ORIGIN } from "../src/config.ts";
import { unauthorized } from "../src/errors.ts";
import { INPUT_RESTRICTION_VERSION } from "../src/input-restriction.ts";
import { hash } from "../src/service.ts";
import { harness } from "./helpers.ts";

test.each([false, true])("reviewers get their own pairing, call and reset controls (restricted: %s)", async (restricted) => {
  const h = harness();
  h.service.freeInputRestricted = restricted;
  const ordinaryPhone = await h.pair("customer");
  const demo = new ReviewPortal(h.service, {
    uid: "reviewer", username: "review", passwordHash: hash("demo-test-password"),
  });
  const app = new CloudApp(h.service, { async verify() { throw unauthorized(); } },
    undefined, undefined, undefined, undefined, undefined, undefined, demo);
  const auth = "Basic " + Buffer.from("review:demo-test-password").toString("base64");
  const visit = (path: string, options?: { auth?: boolean; origin?: string }) =>
    app.fetch(new Request(OFFICIAL_CLOUD_ORIGIN + "/review/" + path, {
      method: path ? "POST" : "GET",
      headers: {
        ...(options?.auth !== false ? { authorization: auth } : {}),
        origin: options?.origin ?? OFFICIAL_CLOUD_ORIGIN,
      },
    }));

  expect((await visit("", { auth: false }))?.status).toBe(401);
  expect((await visit("pair", { origin: "https://example.org" }))?.status).toBe(403);
  const consentAction = `input-consent/${INPUT_RESTRICTION_VERSION}`;
  const consentButton = "I agree not to send personal or confidential information";
  expect((await (await visit(""))!.text()).includes(consentButton)).toBe(restricted);
  expect((await visit("call"))?.status).toBe(409);
  const pairedPage = await (await visit("pair"))!.text();
  const code = /&amp;code=([A-Za-z0-9_-]+)/.exec(pairedPage)?.[1];
  expect(code).toBeTruthy();
  const paired = await h.service.pair({ code, device_name: "review iPhone", platform: "ios" });
  const device = await h.devicePrincipal(paired.device_token);
  expect(device.uid).toBe("reviewer");
  expect((await visit("pair"))?.status).toBe(409);
  expect((await visit("call"))?.status).toBe(409);

  await h.db.transaction("reviewer", tx => h.service.updateDevice(tx, paired.device.id, { voip_token: "review-test-token" }));
  if (restricted) {
    expect((await visit("call"))?.status).toBe(409);
    expect((await (await visit(""))!.text()).includes("Send a test call")).toBe(false);
    expect((await visit(consentAction, { auth: false }))?.status).toBe(401);
    expect((await visit(consentAction, { origin: "https://example.org" }))?.status).toBe(403);
    expect((await visit("input-consent/0"))?.status).toBe(404);
    expect((await visit(consentAction))?.status).toBe(303);
    expect(await h.db.transaction("reviewer", tx => tx.get("input_consent", "current"))).toMatchObject({version: INPUT_RESTRICTION_VERSION});
    expect(await h.db.transaction("customer", tx => tx.get("input_consent", "current"))).toBeNull();
    expect(await (await visit(""))?.text()).not.toContain(consentButton);
  }
  expect(await (await visit(""))?.text()).toContain("The review iPhone is ready for calls.");
  expect(await (await visit("call"))?.text()).toContain("Test call requested");
  const requests = await h.db.transaction("reviewer", tx => tx.list("request"));
  expect(requests[0]?.call?.state).toBe("ringing");
  expect((await visit("reset"))?.status).toBe(303);
  expect(await h.db.transaction("reviewer", tx => tx.list("device"))).toEqual([]);
  expect((await h.db.transaction("reviewer", tx => tx.list("request")))[0]?.status).toBe("cancelled");
  expect((await h.devicePrincipal(ordinaryPhone.device_token)).uid).toBe("customer");
});
