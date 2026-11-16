#!/usr/bin/env bun
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import { createConversationProvider } from "./conversation.ts";
import { createApp } from "./app.ts";
import {
  DEFAULT_HOST,
  configIsTooOpen,
  configPath,
  dbPath,
  loadOrCreateConfig,
  resolveHome,
  updateConfigPort,
} from "./config.ts";
import { Store } from "./db.ts";
import { buildPairingUri, issuePairingCode, normalizeBaseUrl, resolvePublicUrl, type Interfaces } from "./pairing.ts";
import { createPushFromConfig } from "./push/index.ts";
import { startServer } from "./server.ts";
import { VERSION } from "./types.ts";

export interface CliDeps {
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Network interface enumeration (os.networkInterfaces by default). */
  interfaces?: Interfaces;
  /** Name of the default-route interface (asks the OS by default). */
  defaultInterface?: () => string | null;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => number;
  /** Renders the QR code; injectable so tests do not depend on terminal output. */
  qr?: (text: string) => string;
}

interface ServeState {
  pid: number;
  host: string;
  port: number;
  public_url: string | null;
}

const USAGE = `oyobidashi relay ${VERSION}

Usage: bun run src/cli.ts <command> [options]

Commands:
  serve [--port N] [--host HOST] [--public-url URL]   中継サーバーを起動する
  pair [--public-url URL] [--port N]                  ペアリングコードを発行して QR コードを表示する
                                                      (URL 既定値: http://<Mac の LAN 内プライベート IPv4>:<port>)
  devices                                             ペアリング済みデバイスの一覧
  revoke <device_id>                                  デバイスのペアリングを解除する
  status                                              設定・サーバー・デバイスの状態を表示する

Environment:
  OYOBIDASHI_HOME   設定と DB の置き場所 (既定 ~/.oyobidashi)`;

class UsageError extends Error {}

const serveStatePath = (home: string) => join(home, "serve.json");

function readServeState(home: string): ServeState | null {
  try {
    const state = JSON.parse(readFileSync(serveStatePath(home), "utf8")) as ServeState;
    if (typeof state.pid !== "number" || typeof state.port !== "number") return null;
    process.kill(state.pid, 0); // throws when that process is gone (stale file)
    return state;
  } catch {
    return null;
  }
}

const isLoopbackHost = (host: string) => host === "localhost" || host === "::1" || host.startsWith("127.");

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 0 || port > 65535) throw new UsageError(`invalid --port: ${value}`);
  return port;
}

function renderQr(text: string): string {
  let rendered = "";
  qrcode.generate(text, { small: true }, (qr) => {
    rendered = qr;
  });
  return rendered;
}

/** Address to reach a server bound to `host` from this machine. */
function localHost(host: string | undefined): string {
  if (!host || host === "0.0.0.0" || host === "localhost") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") ? `[${host}]` : host;
}

async function isServing(host: string, port: number, fetchFn: NonNullable<CliDeps["fetch"]>): Promise<boolean> {
  try {
    const res = await fetchFn(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    return ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

export interface ServeOptions {
  port?: number;
  host?: string;
  publicUrl?: string;
}

export interface ServeHandle {
  url: string;
  port: number;
  home: string;
  stop(): Promise<void>;
}

/** Starts the relay: config (created on first start), DB, push providers, HTTP/WebSocket server. */
export async function startServe(options: ServeOptions, deps: CliDeps = {}): Promise<ServeHandle> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const home = resolveHome(deps.env ?? process.env);
  const { config, created } = loadOrCreateConfig(home);
  if (created) out(`設定ファイルを作成しました: ${configPath(home)}`);
  if (configIsTooOpen(home)) err(`警告: ${configPath(home)} が他ユーザーから読めます (chmod 600 を推奨)`);
  const publicUrl = options.publicUrl ? normalizeBaseUrl(options.publicUrl) : null;

  const store = new Store(dbPath(home));
  const push = await createPushFromConfig(config, { fetch: deps.fetch });
  for (const warning of push.warnings) err(`警告: ${warning}`);
  const app = createApp({ store, agentToken: config.agent_token, push: push.providers, logger: { warn: err }, conversation: createConversationProvider(deps.env ?? process.env), trustedProxyOrigin: publicUrl?.startsWith("https://") ? publicUrl : undefined });

  const host = options.host ?? DEFAULT_HOST;
  let server;
  try {
    server = startServer(app, { hostname: host, port: options.port ?? config.port });
  } catch (e) {
    push.close();
    store.close();
    throw new Error(`サーバーを起動できませんでした (${host}:${options.port ?? config.port}): ${(e as Error).message}`);
  }
  if (server.port !== config.port) {
    // mcp resolves the relay through config.json, so the port in use must be recorded there.
    updateConfigPort(home, server.port);
    out(`config.json の port を ${server.port} に更新しました`);
  }
  const state: ServeState = { pid: process.pid, host, port: server.port, public_url: publicUrl };
  writeFileSync(serveStatePath(home), `${JSON.stringify(state)}\n`, { mode: 0o600 });

  out(`oyobidashi relay ${VERSION}`);
  out(`  listening : ${server.url}`);
  try {
    const lan = resolvePublicUrl({
      explicit: publicUrl,
      port: server.port,
      interfaces: deps.interfaces,
      defaultInterface: deps.defaultInterface,
    });
    out(`  スマホから: ${lan.url}${publicUrl?.startsWith("https://") ? " (HTTPS proxy; device API only)" : " (同じ Wi-Fi / LAN 内のみ)"}`);
  } catch {
    err("警告: LAN 内のプライベート IPv4 アドレスが見つかりません。pair には --public-url を指定してください。");
  }
  if (isLoopbackHost(host) && !publicUrl?.startsWith("https://")) err("警告: ループバックにバインドしているため、スマホからは接続できません。");
  out(`  home      : ${home}`);
  out(`  push      : APNs ${push.providers.ios ? "有効" : "無効"} / FCM ${push.providers.android ? "有効" : "無効"}`);
  out(`  devices   : ${store.listDevices().length} 台ペアリング済み`);
  out(`ペアリングするには別のターミナルで: bun run pair`);

  return {
    url: server.url,
    port: server.port,
    home,
    async stop() {
      await server.stop();
      await app.idle();
      push.close();
      store.close();
      const current = readServeState(home);
      if (current?.pid === process.pid) rmSync(serveStatePath(home), { force: true });
    },
  };
}

async function pairCommand(options: { publicUrl?: string; port?: number }, deps: CliDeps): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const fetchFn = deps.fetch ?? fetch;
  const home = resolveHome(deps.env ?? process.env);
  const { config } = loadOrCreateConfig(home);
  const serve = readServeState(home);
  const port = options.port ?? serve?.port ?? config.port;

  const { url, source } = resolvePublicUrl({
    explicit: options.publicUrl,
    fromServe: serve?.public_url,
    port,
    interfaces: deps.interfaces,
    defaultInterface: deps.defaultInterface,
  });

  // The code is written straight to the shared SQLite file, so it works while `serve` is running.
  const store = new Store(dbPath(home));
  let code: string;
  try {
    code = issuePairingCode(store, (deps.now ?? Date.now)()).code;
  } finally {
    store.close();
  }

  const uri = buildPairingUri(url, code);
  out((deps.qr ?? renderQr)(uri));
  out(`ペアリングURI : ${uri}`);
  out(`サーバーURL   : ${url}`);
  out(`コード        : ${code}`);
  out("コードは 10 分間・1 回だけ有効です。アプリで QR コードを読み取るか、URL とコードを手入力してください。");
  out("スマホを Mac と同じ Wi-Fi (LAN) に接続してください。Mac の IP が変わったら再ペアリングが必要です。");
  if (source === "lan" && serve && isLoopbackHost(serve.host)) {
    err(`警告: relay が ${serve.host} にバインドされているため、スマホから ${url} には届きません (--host を外して起動し直してください)。`);
  }
  if (!(await isServing(localHost(serve?.host), port, fetchFn))) {
    err(`警告: port ${port} で relay が応答しません。先に \`bun run serve\` で起動してください。`);
  }
  return 0;
}

function devicesCommand(deps: CliDeps): number {
  const out = deps.out ?? console.log;
  const home = resolveHome(deps.env ?? process.env);
  if (!existsSync(dbPath(home))) {
    out("ペアリング済みのデバイスはありません。");
    return 0;
  }
  const store = new Store(dbPath(home));
  try {
    const devices = store.listDevices();
    if (devices.length === 0) {
      out("ペアリング済みのデバイスはありません。");
      return 0;
    }
    for (const d of devices) {
      const pushState = d.push_token
        ? `push:あり${d.platform === "ios" ? ` (${d.push_environment ?? "production"})` : ""}`
        : "push:なし";
      out(`${d.id}\t${d.platform}\t${d.name}\t${pushState}\t${new Date(d.created_at).toISOString()}`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function revokeCommand(deviceId: string | undefined, deps: CliDeps): number {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (!deviceId) throw new UsageError("usage: revoke <device_id>");
  const home = resolveHome(deps.env ?? process.env);
  if (!existsSync(dbPath(home))) {
    err(`デバイスが見つかりません: ${deviceId}`);
    return 1;
  }
  const store = new Store(dbPath(home));
  try {
    if (!store.deleteDevice(deviceId)) {
      err(`デバイスが見つかりません: ${deviceId}`);
      return 1;
    }
    out(`ペアリングを解除しました: ${deviceId} (接続中の WebSocket は数秒以内に切断されます)`);
    return 0;
  } finally {
    store.close();
  }
}

async function statusCommand(deps: CliDeps): Promise<number> {
  const out = deps.out ?? console.log;
  const fetchFn = deps.fetch ?? fetch;
  const home = resolveHome(deps.env ?? process.env);
  out(`home      : ${home}`);
  if (!existsSync(configPath(home))) {
    out("config    : 未作成 (`bun run serve` で初回起動すると作成されます)");
    return 0;
  }
  const { config } = loadOrCreateConfig(home);
  const serve = readServeState(home);
  const port = serve?.port ?? config.port;
  const running = await isServing(localHost(serve?.host), port, fetchFn);
  out(`config    : ${configPath(home)}`);
  out(`server    : ${running ? `起動中 (${serve?.host ?? "?"}:${port})` : `停止中 (port ${port})`}`);
  try {
    const resolved = resolvePublicUrl({
      fromServe: serve?.public_url,
      port,
      interfaces: deps.interfaces,
      defaultInterface: deps.defaultInterface,
    });
    out(`pairing URL: ${resolved.url}${resolved.source === "lan" ? " (LAN 内プライベート IP)" : " (--public-url)"}`);
  } catch {
    out("pairing URL: (プライベート IPv4 が見つかりません: pair に --public-url を指定してください)");
  }
  const push = await createPushFromConfig(config, { fetch: fetchFn, apnsTransport: async () => ({ status: 0, body: "" }) });
  out(`push APNs : ${push.providers.ios ? "有効" : config.apns ? "設定エラー" : "未設定"}`);
  out(`push FCM  : ${push.providers.android ? "有効" : config.fcm ? "設定エラー" : "未設定"}`);
  for (const warning of push.warnings) out(`  警告: ${warning}`);
  push.close();
  if (existsSync(dbPath(home))) {
    const store = new Store(dbPath(home));
    try {
      store.expireDue((deps.now ?? Date.now)());
      out(`devices   : ${store.listDevices().length} 台`);
      out(`pending   : ${store.countRequests("pending")} 件`);
    } finally {
      store.close();
    }
  } else {
    out("devices   : 0 台");
  }
  return 0;
}

/** Runs one CLI command and returns its exit code. `serve` resolves only after SIGINT/SIGTERM. */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "serve": {
        const { values } = parseArgs({
          args: rest,
          options: { port: { type: "string" }, host: { type: "string" }, "public-url": { type: "string" } },
        });
        const handle = await startServe(
          { port: parsePort(values.port), host: values.host, publicUrl: values["public-url"] },
          deps,
        );
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        await handle.stop();
        return 0;
      }
      case "pair": {
        const { values } = parseArgs({
          args: rest,
          options: { port: { type: "string" }, "public-url": { type: "string" } },
        });
        return await pairCommand({ publicUrl: values["public-url"], port: parsePort(values.port) }, deps);
      }
      case "devices":
        parseArgs({ args: rest, options: {} });
        return devicesCommand(deps);
      case "revoke": {
        const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
        return revokeCommand(positionals[0], deps);
      }
      case "status":
        parseArgs({ args: rest, options: {} });
        return await statusCommand(deps);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (e) {
    const usage = e instanceof UsageError || (e as { code?: string })?.code?.startsWith("ERR_PARSE_ARGS");
    err(`エラー: ${(e as Error).message}`);
    if (usage) err(`\n${USAGE}`);
    return usage ? 2 : 1;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
