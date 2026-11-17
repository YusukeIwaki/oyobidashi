import { readFile } from "node:fs/promises";
import {
  parseServiceAccount,
  type ServiceAccount,
} from "../../relay/src/push/fcm.ts";

export interface CloudPushConfig {
  fcm?: ServiceAccount;
  apns?: { keyPem: string; keyId: string; teamId: string; bundleId: string };
}
/** Railway secrets can be supplied as variables, without a shared disk/Volume. */
export async function loadPushConfig(
  env: Record<string, string | undefined>,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<CloudPushConfig> {
  const result: CloudPushConfig = {};
  const source = async (
    value: string | undefined,
    path: string | undefined,
    name: string,
  ) => {
    if (value && path)
      throw new Error(`${name}: configure a value or a path, not both`);
    if (value) return value;
    if (path) {
      try {
        return await read(path);
      } catch {
        throw new Error(`${name}: cannot read credential file`);
      }
    }
    return undefined;
  };
  const fcm = await source(
    env.FCM_SERVICE_ACCOUNT_JSON,
    env.FCM_SERVICE_ACCOUNT_PATH,
    "FCM_SERVICE_ACCOUNT",
  );
  if (fcm) {
    try {
      result.fcm = parseServiceAccount(fcm);
    } catch {
      throw new Error("FCM_SERVICE_ACCOUNT is invalid");
    }
  }
  const apns = await source(env.APNS_KEY_PEM, env.APNS_KEY_PATH, "APNS_KEY");
  if (apns) {
    const keyId = env.APNS_KEY_ID,
      teamId = env.APNS_TEAM_ID,
      bundleId = env.APNS_BUNDLE_ID;
    if (!keyId || !teamId || !bundleId)
      throw new Error(
        "APNS_KEY_ID, APNS_TEAM_ID and APNS_BUNDLE_ID are required",
      );
    result.apns = {
      keyPem: apns.includes("\n") ? apns : apns.replaceAll("\\n", "\n"),
      keyId,
      teamId,
      bundleId,
    };
  }
  return result;
}
