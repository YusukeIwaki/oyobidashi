import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import { embeddedPush, type EmbeddedPush } from "../embedded.ts";
import { IOS_APP_ID } from "../types.ts";
import { createApnsProvider, createHttp2ApnsTransport, type ApnsTransport } from "./apns.ts";
import { createFcmProvider, gcloudTokenProvider, parseServiceAccount, type FetchLike } from "./fcm.ts";
import type { PushProviders } from "./types.ts";

export * from "./types.ts";

export interface PushSetup {
  providers: PushProviders;
  /** Where each configured provider's credentials come from (set even when the provider failed to load). */
  sources: { ios?: PushCredentialSource; android?: PushCredentialSource };
  /** Human readable problems (bad key path etc.). A broken provider is disabled, never fatal. */
  warnings: string[];
  close(): void;
}

export type PushCredentialSource = "embedded" | "config";

export interface PushSetupDeps {
  /** Credentials baked into a single binary; they win over config.json. Defaults to the build's own. */
  embedded?: EmbeddedPush | null;
  apnsTransport?: ApnsTransport;
  fetch?: FetchLike;
  now?: () => number;
}

/** Builds providers from embedded credentials or config.json. No credentials → empty providers → WebSocket delivery only. */
export async function createPushFromConfig(config: Config, deps: PushSetupDeps = {}): Promise<PushSetup> {
  const providers: PushProviders = {};
  const warnings: string[] = [];
  const sources: PushSetup["sources"] = {};
  const embedded = deps.embedded === undefined ? embeddedPush() : deps.embedded;
  let close = () => {};

  const apns = embedded?.apns ?? config.apns;
  if (apns) {
    sources.ios = embedded?.apns ? "embedded" : "config";
    try {
      const { key_id, team_id } = apns;
      const keyPem = "key_pem" in apns ? apns.key_pem : apns.key_path && readFileSync(apns.key_path, "utf8");
      if (!keyPem || !key_id || !team_id) throw new Error("key_path / key_id / team_id are required");
      let transport = deps.apnsTransport;
      if (!transport) {
        const real = createHttp2ApnsTransport();
        transport = real;
        close = () => real.close();
      }
      const provider = createApnsProvider({
        keyPem,
        keyId: key_id,
        teamId: team_id,
        bundleId: apns.bundle_id || IOS_APP_ID,
        transport,
        now: deps.now,
      });
      await provider.ready();
      providers.ios = provider;
    } catch (e) {
      warnings.push(`APNs disabled: ${(e as Error).message}`);
    }
  }

  if (embedded?.fcm) {
    sources.android = "embedded";
    try {
      const provider = createFcmProvider({
        serviceAccount: parseServiceAccount(embedded.fcm.service_account_json),
        fetch: deps.fetch,
        now: deps.now,
      });
      await provider.ready();
      providers.android = provider;
    } catch (e) {
      warnings.push(`FCM disabled: ${(e as Error).message}`);
    }
  } else if (config.fcm) {
    sources.android = "config";
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

  return { providers, sources, warnings, close };
}
