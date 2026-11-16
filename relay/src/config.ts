import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { newAgentToken } from "./ids.ts";

export const DEFAULT_PORT = 8787;
/** The phone reaches the relay over the LAN; access control is the peer-address check plus tokens. */
export const DEFAULT_HOST = "0.0.0.0";

export interface ApnsConfig {
  key_path: string;
  key_id: string;
  team_id: string;
  bundle_id?: string;
}
export interface FcmConfig {
  service_account_path?: string;
  project_id?: string;
  auth?: "gcloud";
}
export interface Config {
  port: number;
  agent_token: string;
  apns?: ApnsConfig;
  fcm?: FcmConfig;
}

export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.OYOBIDASHI_HOME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".oyobidashi");
}

export const configPath = (home: string) => join(home, "config.json");
export const dbPath = (home: string) => join(home, "oyobidashi.db");

function parse(raw: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function normalize(raw: Record<string, unknown>, path: string): Config {
  const port = raw.port ?? DEFAULT_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${path}: "port" must be an integer between 1 and 65535`);
  }
  if (typeof raw.agent_token !== "string" || raw.agent_token.length === 0) {
    throw new Error(`${path}: "agent_token" must be a non-empty string`);
  }
  const config: Config = { port, agent_token: raw.agent_token };
  if (raw.apns && typeof raw.apns === "object") config.apns = raw.apns as ApnsConfig;
  if (raw.fcm && typeof raw.fcm === "object") config.fcm = raw.fcm as FcmConfig;
  return config;
}

/** Atomic write with mode 600; unknown keys already in the file are preserved by the callers. */
function write(path: string, raw: Record<string, unknown>): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Reads config.json without creating anything. Returns null when it does not exist yet. */
export function readConfig(home: string): Config | null {
  const path = configPath(home);
  if (!existsSync(path)) return null;
  return normalize(parse(readFileSync(path, "utf8"), path), path);
}

/** First start: creates `$OYOBIDASHI_HOME/config.json` (mode 600) with a fresh agent token. */
export function loadOrCreateConfig(home: string): { config: Config; created: boolean } {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = configPath(home);
  if (!existsSync(path)) {
    const raw = { port: DEFAULT_PORT, agent_token: newAgentToken() };
    write(path, raw);
    return { config: normalize(raw, path), created: true };
  }
  const raw = parse(readFileSync(path, "utf8"), path);
  if (typeof raw.agent_token !== "string" || raw.agent_token.length === 0) {
    raw.agent_token = newAgentToken();
    if (raw.port === undefined || raw.port === null) raw.port = DEFAULT_PORT;
    write(path, raw);
  }
  return { config: normalize(raw, path), created: false };
}

/** Persists a new port so that mcp (which reads config.json) finds the relay. */
export function updateConfigPort(home: string, port: number): void {
  const path = configPath(home);
  const raw = parse(readFileSync(path, "utf8"), path);
  raw.port = port;
  write(path, raw);
}

/** True when group/other can read the file (it holds the agent token). */
export function configIsTooOpen(home: string): boolean {
  try {
    return (statSync(configPath(home)).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
