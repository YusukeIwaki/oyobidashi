import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import { APP_ID } from "../types.ts";
import { createApnsProvider, createHttp2ApnsTransport, type ApnsTransport } from "./apns.ts";
import { createFcmProvider, gcloudTokenProvider, parseServiceAccount, type FetchLike } from "./fcm.ts";
import type { PushProviders } from "./types.ts";

export * from "./types.ts";

export interface PushSetup {
  providers: PushProviders;
  /** Human readable problems (bad key path etc.). A broken provider is disabled, never fatal. */
  warnings: string[];
  close(): void;
}

export interface PushSetupDeps {
  apnsTransport?: ApnsTransport;
  fetch?: FetchLike;
  now?: () => number;
}

/** Builds providers from config.json. No credentials → empty providers → WebSocket delivery only. */
export async function createPushFromConfig(config: Config, deps: PushSetupDeps = {}): Promise<PushSetup> {
  const providers: PushProviders = {};
  const warnings: string[] = [];
  let close = () => {};

  if (config.apns) {
    try {
      const { key_path, key_id, team_id } = config.apns;
      if (!key_path || !key_id || !team_id) throw new Error("key_path / key_id / team_id are required");
      let transport = deps.apnsTransport;
      if (!transport) {
        const real = createHttp2ApnsTransport();
        transport = real;
        close = () => real.close();
      }
      const provider = createApnsProvider({
        keyPem: readFileSync(key_path, "utf8"),
        keyId: key_id,
        teamId: team_id,
        bundleId: config.apns.bundle_id || APP_ID,
        transport,
        now: deps.now,
      });
      await provider.ready();
      providers.ios = provider;
    } catch (e) {
      warnings.push(`APNs disabled: ${(e as Error).message}`);
    }
  }

  if (config.fcm) {
    try {
      if (!config.fcm.service_account_path && !(config.fcm.auth === "gcloud" && config.fcm.project_id)) throw new Error("service_account_path or gcloud auth with project_id is required");
      const provider = createFcmProvider({
        ...(config.fcm.auth === "gcloud" ? {projectId:config.fcm.project_id,tokenProvider:gcloudTokenProvider()} : {serviceAccount: parseServiceAccount(readFileSync(config.fcm.service_account_path!, "utf8"))}),
        fetch: deps.fetch,
        now: deps.now,
      });
      await provider.ready();
      providers.android = provider;
    } catch (e) {
      warnings.push(`FCM disabled: ${(e as Error).message}`);
    }
  }

  return { providers, warnings, close };
}
