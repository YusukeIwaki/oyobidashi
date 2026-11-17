import { describe, expect, test } from "bun:test";
import { loadPushConfig } from "../src/push-config.ts";
const account = {
  client_email: "test@example.invalid",
  project_id: "test-project",
  private_key: "synthetic-secret",
};
describe("volume-free push credentials", () => {
  test("unconfigured providers stay disabled without reading files", async () => {
    expect(
      await loadPushConfig({}, async () => {
        throw new Error("must not read");
      }),
    ).toEqual({});
  });
  test("Railway JSON and multiline PEM variables work without disk access", async () => {
    const config = await loadPushConfig(
      {
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
        APNS_KEY_PEM: "key\\nbody",
        APNS_KEY_ID: "key-id",
        APNS_TEAM_ID: "own-team",
        APNS_BUNDLE_ID: "own.bundle",
      },
      async () => {
        throw new Error("no disk");
      },
    );
    expect(config.fcm).toMatchObject(account);
    expect(config.apns).toMatchObject({
      keyPem: "key\nbody",
      keyId: "key-id",
      teamId: "own-team",
      bundleId: "own.bundle",
    });
  });
  test("protected file sources remain supported", async () => {
    expect(
      (
        await loadPushConfig(
          { FCM_SERVICE_ACCOUNT_PATH: "protected.json" },
          async () => JSON.stringify(account),
        )
      ).fcm,
    ).toMatchObject(account);
  });
  test("ambiguous sources and provider errors never print credential values", async () => {
    for (const env of [
      {
        FCM_SERVICE_ACCOUNT_JSON: "synthetic-secret",
        FCM_SERVICE_ACCOUNT_PATH: "path",
      },
      { APNS_KEY_PEM: "synthetic-secret", APNS_KEY_PATH: "path" },
      { FCM_SERVICE_ACCOUNT_JSON: "synthetic-secret" },
      { FCM_SERVICE_ACCOUNT_PATH: "private-secret-path" },
      { APNS_KEY_PEM: "synthetic-secret" },
    ]) {
      let caught = false;
      try {
        await loadPushConfig(env, async () => {
          throw new Error("private-secret-path");
        });
      } catch (e) {
        caught = true;
        expect(String(e)).not.toContain("synthetic-secret");
        expect(String(e)).not.toContain("private-secret-path");
      }
      expect(caught).toBe(true);
    }
  });
});
