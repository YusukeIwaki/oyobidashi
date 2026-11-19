#!/usr/bin/env bun
/**
 * Builds the single binary for your own machine, with the push credentials that
 * `$OYOBIDASHI_HOME/config.json` points at baked in.
 *
 * The result contains your APNs key and service account in recoverable form.
 * Keep it on your own machines; never distribute or commit it.
 */
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readConfig } from "../relay/src/config.ts";
import type { EmbeddedPush } from "../relay/src/embedded.ts";
import { parseServiceAccount } from "../relay/src/push/fcm.ts";

const root = resolve(import.meta.dir, "..");

export interface BuildOptions {
  /** State directory whose config.json names the credentials to embed. */
  home: string;
  outfile: string;
  /** Bun compile target such as `bun-linux-x64`; defaults to this machine. */
  target?: string;
  log?: (line: string) => void;
}

/** Reads the credentials config.json points at. Missing or unusable ones are reported, never fatal. */
export function collectEmbeddedPush(home: string, log: (line: string) => void): EmbeddedPush {
  const embedded: EmbeddedPush = {};
  const config = readConfig(home);
  if (!config) {
    log(`警告: ${join(home, "config.json")} がありません。Push の資格情報は埋め込みません。`);
    return embedded;
  }
  if (config.apns) {
    const { key_path, key_id, team_id, bundle_id } = config.apns;
    try {
      if (!key_path || !key_id || !team_id) throw new Error("key_path / key_id / team_id are required");
      embedded.apns = { key_pem: readFileSync(key_path, "utf8"), key_id, team_id, ...(bundle_id ? { bundle_id } : {}) };
    } catch (e) {
      log(`警告: APNs は埋め込みません: ${(e as Error).message}`);
    }
  }
  if (config.fcm) {
    try {
      if (!config.fcm.service_account_path) {
        throw new Error(config.fcm.auth === "gcloud" ? "gcloud 認証は埋め込めません (service_account_path が必要)" : "service_account_path is required");
      }
      const json = readFileSync(config.fcm.service_account_path, "utf8");
      parseServiceAccount(json);
      embedded.fcm = { service_account_json: json };
    } catch (e) {
      log(`警告: FCM は埋め込みません: ${(e as Error).message}`);
    }
  }
  return embedded;
}

export async function buildBinary(options: BuildOptions): Promise<EmbeddedPush> {
  const log = options.log ?? console.log;
  const embedded = collectEmbeddedPush(options.home, log);
  mkdirSync(dirname(options.outfile), { recursive: true });
  // The credentials go in through `define` (in memory), so they never appear in argv or a temp file.
  const result = await Bun.build({
    entrypoints: [join(root, "standalone/main.ts")],
    compile: { outfile: options.outfile, ...(options.target ? { target: options.target as Bun.Build.Target } : {}) },
    define: { __OYOBIDASHI_EMBEDDED_PUSH__: JSON.stringify(embedded) },
  });
  if (!result.success) throw new Error(`build failed:\n${result.logs.join("\n")}`);
  chmodSync(options.outfile, 0o700);
  if (process.platform === "darwin" && (!options.target || options.target.includes("darwin"))) {
    // The signature Bun leaves on the binary can be invalid, and macOS kills such a process at launch.
    const sign = Bun.spawnSync(["codesign", "--force", "--sign", "-", options.outfile], { stdout: "ignore", stderr: "pipe" });
    if (sign.exitCode !== 0) throw new Error(`codesign failed: ${sign.stderr.toString().trim()}`);
  }
  log(`作成しました: ${options.outfile} (${(statSync(options.outfile).size / 1024 / 1024).toFixed(0)}MB)`);
  log(`  APNs: ${embedded.apns ? `埋め込み済み (key ${embedded.apns.key_id})` : "なし"}`);
  log(`  FCM : ${embedded.fcm ? "埋め込み済み" : "なし"}`);
  if (embedded.apns || embedded.fcm) log("このバイナリには鍵が含まれます。配布・コミットしないでください。");
  return embedded;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { home: { type: "string" }, out: { type: "string" }, target: { type: "string" } },
  });
  const home = resolve(values.home ?? process.env.OYOBIDASHI_HOME ?? join(root, ".oyobidashi"));
  const outfile = resolve(values.out ?? join(root, "standalone/dist/oyobidashi"));
  try {
    await buildBinary({ home, outfile, target: values.target });
  } catch (e) {
    console.error(`エラー: ${(e as Error).message}`);
    process.exit(1);
  }
}
