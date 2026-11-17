/** Deterministic local half of the setup skill. Never prints credential contents. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadOrCreateConfig, readConfig } from "../relay/src/config.ts";
import { ANDROID_APP_ID } from "../relay/src/types.ts";

export { ANDROID_APP_ID } from "../relay/src/types.ts";

class SetupError extends Error {}
type ObjectValue = Record<string, any>;
export interface Context { root: string; home: string }

function objectJSON(path: string): ObjectValue {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch { /* Do not include parser messages: they can quote a private key. */ }
  throw new SetupError("設定JSONを読み取れません。内容を会話へ貼らず、ファイル形式を確認してください。");
}
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
function writePrivate(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
function rawConfig(ctx: Context): ObjectValue {
  // Validate before writing, while preserving unknown keys and existing agent token.
  try {
    if (existsSync(join(ctx.home, "config.json"))) readConfig(ctx.home);
    else loadOrCreateConfig(ctx.home);
  }
  catch { throw new SetupError("既存のrelay設定が不正です。修復するまで上書きしません。"); }
  return objectJSON(join(ctx.home, "config.json"));
}
function mergeConfig(ctx: Context, patch: ObjectValue): void {
  const config = rawConfig(ctx);
  privateDir(ctx.home);
  writePrivate(join(ctx.home, "config.json"), JSON.stringify({ ...config, ...patch }, null, 2) + "\n");
}
function importKey(ctx: Context, name: string, data: string): string {
  privateDir(ctx.home);
  const keys = join(ctx.home, "keys");
  privateDir(keys);
  const path = join(keys, name);
  writePrivate(path, data);
  return path;
}
function validatePrivateKey(pem: unknown, type: "rsa" | "ec"): void {
  try {
    if (typeof pem !== "string" || !pem.trimStart().startsWith("-----BEGIN PRIVATE KEY-----")) throw new SetupError();
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== type) throw new SetupError();
    if (type === "ec" && key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new SetupError();
    if (type === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new SetupError();
  } catch { throw new SetupError(`秘密鍵の形式が不正です (PKCS#8 PEM、${type === "rsa" ? "RSA 2048bit以上" : "EC P-256"} が必要)。`); }
}
function propertyValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new SetupError("ローカル設定値に改行は使えません。");
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/=/g, "\\=").replace(/^ /, "\\ ");
}
export function mergeProperties(original: string, values: Record<string, string>): string {
  const remaining = new Map(Object.entries(values));
  const lines = original.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== "");
  const output: string[] = [];
  for (const line of lines) {
    const key = /^\s*([^#!\s=:]+)\s*[=:]/.exec(line)?.[1];
    if (key && Object.hasOwn(values, key)) {
      if (remaining.has(key)) output.push(`${key}=${propertyValue(remaining.get(key)!)}`);
      remaining.delete(key); // Also remove duplicate definitions of managed keys.
    } else output.push(line);
  }
  for (const [key, value] of remaining) output.push(`${key}=${propertyValue(value)}`);
  return output.join("\n") + "\n";
}
function localProperties(ctx: Context, values: Record<string, string>): void {
  const path = join(ctx.root, "android/local.properties");
  writePrivate(path, mergeProperties(existsSync(path) ? readFileSync(path, "utf8") : "", values));
}
export function initialize(ctx: Context, sdk?: string): void {
  mergeConfig(ctx, {});
  if (sdk) {
    const sdkPath = resolve(sdk);
    if (!existsSync(sdkPath)) throw new SetupError("Android SDKのディレクトリが存在しません。");
    localProperties(ctx, { "sdk.dir": sdkPath });
  }
}
export function configureFirebase(ctx: Context, androidFile: string, serviceFile?: string, auth?: string): void {
  if ((auth && auth !== "gcloud") || (!!serviceFile === (auth === "gcloud"))) {
    throw new SetupError("--service-account または --auth gcloud のどちらか1つを指定してください。");
  }
  const metadata = objectJSON(androidFile);
  const project = metadata.project_info?.project_id;
  const sender = metadata.project_info?.project_number;
  const client = Array.isArray(metadata.client) && metadata.client.find((c: ObjectValue) => c.client_info?.android_client_info?.package_name === ANDROID_APP_ID);
  const application = client?.client_info?.mobilesdk_app_id;
  const apiKey = client?.api_key?.[0]?.current_key;
  if (typeof project !== "string" || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(project) ||
      typeof sender !== "string" || !/^\d+$/.test(sender) ||
      typeof application !== "string" || !new RegExp(`^1:${sender}:android:[a-zA-Z0-9]+$`).test(application) ||
      typeof apiKey !== "string" || !/^[a-zA-Z0-9_-]+$/.test(apiKey)) {
    throw new SetupError("Android Firebase設定が不正です。対象package、project_id、project_number、App ID、API keyを確認してください。");
  }
  let secret: string | undefined;
  if (serviceFile) {
    const account = objectJSON(serviceFile);
    if (account.type !== "service_account" || account.project_id !== project ||
        typeof account.client_email !== "string" || !account.client_email.endsWith(".iam.gserviceaccount.com") ||
        (account.token_uri && account.token_uri !== "https://oauth2.googleapis.com/token")) {
      throw new SetupError("サービスアカウントのプロジェクト・形式・token_uriがAndroid設定と一致しません。");
    }
    validatePrivateKey(account.private_key, "rsa");
    secret = JSON.stringify(account, null, 2) + "\n";
  }
  // All input validation completes before changing either config.
  rawConfig(ctx);
  const fcm = secret ? { service_account_path: importKey(ctx, `fcm-${createHash("sha256").update(secret).digest("hex").slice(0, 16)}.json`, secret) } : { auth: "gcloud", project_id: project };
  localProperties(ctx, {
    "oyobidashi.firebase.projectId": project,
    "oyobidashi.firebase.applicationId": application,
    "oyobidashi.firebase.apiKey": apiKey,
    "oyobidashi.firebase.senderId": sender,
  });
  mergeConfig(ctx, { fcm });
}
function appleIDs(team: string, bundle: string): void {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new SetupError("Team IDは英大文字・数字10文字で指定してください。");
  if (!/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+){2,}$/.test(bundle) || bundle.endsWith(".NotificationService")) {
    throw new SetupError("本体の明示的なBundle IDを指定してください (ワイルドカード不可)。");
  }
}
export function iosSpec(team: string, bundle: string): string {
  appleIDs(team, bundle);
  // JSON is valid YAML. Include keeps sources and package paths relative to project.yml.
  return JSON.stringify({
    include: [{ path: "project.yml", relativePaths: true }],
    settings: { base: { DEVELOPMENT_TEAM: team } },
    targets: {
      Oyobidashi: { settings: { base: { PRODUCT_BUNDLE_IDENTIFIER: bundle } } },
      OyobidashiNotificationService: { settings: { base: { PRODUCT_BUNDLE_IDENTIFIER: `${bundle}.NotificationService` } } },
    },
  }, null, 2) + "\n";
}
export function configureApple(ctx: Context, team: string, keyID: string, keyFile: string, bundle: string): void {
  const spec = iosSpec(team, bundle);
  if (!/^[A-Z0-9]{10}$/.test(keyID)) throw new SetupError("Key IDは英大文字・数字10文字で指定してください。");
  const pem = readFileSync(keyFile, "utf8");
  validatePrivateKey(pem, "ec");
  rawConfig(ctx);
  const path = importKey(ctx, `AuthKey_${keyID}.p8`, pem);
  mergeConfig(ctx, { apns: { key_path: path, key_id: keyID, team_id: team, bundle_id: bundle } });
  writePrivate(join(ctx.root, "ios/project.local.yml"), spec);
}
export function configureMCP(ctx: Context, client: string): void {
  if (!["claude", "codex", "both"].includes(client)) throw new SetupError("--client claude|codex|both を指定してください。");
  const server = { command: join(ctx.root, "scripts/mcp.sh"), env: { OYOBIDASHI_HOME: ctx.home } };
  const writes: [string, string][] = [];
  if (client !== "codex") {
    const path = join(ctx.root, ".mcp.json");
    const config = existsSync(path) ? objectJSON(path) : {};
    if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) throw new SetupError("既存の.mcp.jsonの形式を確認してください。");
    const existing = config.mcpServers?.oyobidashi;
    if (existing && (existing.command !== server.command || (existing.args?.length ?? 0) !== 0 || existing.env?.OYOBIDASHI_HOME !== ctx.home)) throw new SetupError("既存のClaude oyobidashi MCPと競合しています。既存値を確認して統合してください。");
    if (!existing) {
      config.mcpServers = { ...config.mcpServers, oyobidashi: server };
      writes.push([path, JSON.stringify(config, null, 2) + "\n"]);
    }
  }
  if (client !== "claude") {
    const path = join(ctx.root, ".codex/config.toml");
    const original = existsSync(path) ? readFileSync(path, "utf8") : "";
    let parsed: ObjectValue;
    try { parsed = Bun.TOML.parse(original); } catch { throw new SetupError("既存のCodex TOMLを読み取れません。上書きしません。"); }
    const existing = parsed.mcp_servers?.oyobidashi;
    if (existing && (existing.command !== server.command || (existing.args?.length ?? 0) !== 0 || existing.env?.OYOBIDASHI_HOME !== ctx.home)) throw new SetupError("既存のCodex oyobidashi MCPと競合しています。既存値を確認して統合してください。");
    if (!existing) {
      const text = `${original}\n[mcp_servers.oyobidashi]\ncommand = ${JSON.stringify(server.command)}\nenv = { OYOBIDASHI_HOME = ${JSON.stringify(ctx.home)} }\n`;
      try { Bun.TOML.parse(text); } catch { throw new SetupError("既存のCodex設定に追記できません。mcp_serversテーブルを手動で統合してください。"); }
      writes.push([path, text]);
    }
  }
  for (const [path, text] of writes) writePrivate(path, text);
}
export function doctor(ctx: Context): string[] {
  const lines = ["[OK] Bun", ...["git", "claude", "codex", "xcodebuild", "xcodegen", "java", "adb", "sdkmanager"].map(tool => `[${Bun.which(tool) ? "OK" : "未検出"}] ${tool}`)];
  try {
    const config = readConfig(ctx.home);
    lines.push(`[${config ? "OK" : "未設定"}] relay設定 (秘密値は非表示)`);
    const fcm = config?.fcm;
    lines.push(`[${fcm?.auth === "gcloud" && fcm.project_id ? "設定あり: gcloud" : fcm?.service_account_path && existsSync(fcm.service_account_path) ? "設定あり: JSON" : "未設定"}] FCM`);
    lines.push(`[${config?.apns?.key_path && existsSync(config.apns.key_path) ? "設定あり" : "未設定"}] APNs`);
  } catch { lines.push("[要修復] relay設定JSON"); }
  for (const [file, label] of [["android/local.properties", "Androidローカル設定"], ["ios/project.local.yml", "iOSローカル署名設定"], [".mcp.json", "Claude MCP設定"], [".codex/config.toml", "Codex MCP設定"]]) {
    lines.push(`[${existsSync(join(ctx.root, file!)) ? "あり" : "なし"}] ${label}`);
  }
  lines.push("設定あり ≠ 接続検証済み。認証・ビルド・実端末へのPushは docs/SETUP.md の手順で確認してください。");
  return lines;
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: Object.fromEntries(["sdk-dir", "android-config", "service-account", "auth", "team-id", "key-id", "key-file", "bundle-id", "client"].map(name => [name, { type: "string" as const }])), strict: true });
  const ctx: Context = { root: resolve(import.meta.dir, ".."), home: resolve(process.env.OYOBIDASHI_HOME || join(import.meta.dir, "../.oyobidashi")) };
  const required = (name: string): string => {
    const value = values[name];
    if (!value) throw new SetupError(`--${name} が必要です。`);
    return value;
  };
  switch (command) {
    case "doctor": console.log(doctor(ctx).join("\n")); return;
    case "init": initialize(ctx, values["sdk-dir"]); break;
    case "bootstrap": {
      for (const dir of ["relay", "mcp", "integration"]) {
        const result = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], { cwd: join(ctx.root, dir), stdout: "inherit", stderr: "inherit" });
        if (result.exitCode !== 0) throw new SetupError(`${dir}の依存インストールに失敗しました。`);
      }
      const propsPath = join(ctx.root, "android/local.properties");
      const hasLocalSDK = existsSync(propsPath) && /^\s*sdk\.dir\s*[=:]/m.test(readFileSync(propsPath, "utf8"));
      const sdk = values["sdk-dir"] ?? (hasLocalSDK ? undefined : process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? (existsSync(join(homedir(), "Library/Android/sdk")) ? join(homedir(), "Library/Android/sdk") : undefined));
      initialize(ctx, sdk);
      break;
    }
    case "firebase": configureFirebase(ctx, required("android-config"), values["service-account"], values.auth); break;
    case "apple": configureApple(ctx, required("team-id"), required("key-id"), required("key-file"), required("bundle-id")); break;
    case "mcp": configureMCP(ctx, required("client")); break;
    case "help":
      console.log(`Usage: ./scripts/setup.sh doctor|bootstrap|init|firebase|apple|mcp\n\nbootstrap / init [--sdk-dir SDK]\nfirebase --android-config FILE (--service-account FILE | --auth gcloud)\napple --team-id TEAM --key-id KEY --key-file FILE --bundle-id ID\nmcp --client claude|codex|both\n\nクラウド・端末の設定手順: docs/SETUP.md`);
      return;
    default: throw new SetupError("不明なコマンドです。./scripts/setup.sh help を確認してください。");
  }
  console.log("ローカル設定を保存しました (秘密値は非表示)。次の工程は docs/SETUP.md を確認してください。");
}
if (import.meta.main) main().catch((error: unknown) => {
  // Deliberately omit underlying errors: IO / parsers may include input contents.
  console.error(error instanceof SetupError ? error.message : "セットアップに失敗しました。引数・ファイル形式・権限を確認してください。秘密値を貼らず docs/SETUP.md のトラブル対応へ進んでください。");
  process.exitCode = 1;
});
