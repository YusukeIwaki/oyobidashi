import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCloudCredentials } from "./cloud-auth.ts";

export type Env = Record<string, string | undefined>;

export interface Connection {
  /** Base URL of the relay without a trailing slash, e.g. http://127.0.0.1:8787 */
  baseUrl: string;
  agentToken: string;
  cloudAuthFile?: string;
  /** Where each value came from (for error messages / diagnostics). */
  source: { baseUrl: "env" | "config" | "cloud"; agentToken: "env" | "config" | "cloud" };
  /** Path of the config file that was (or would have been) consulted. */
  configPath: string;
}

export type ConfigErrorCode = "config_missing" | "config_invalid";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  constructor(code: ConfigErrorCode, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_WAIT_SECONDS = 50;
export const MAX_WAIT_SECONDS = 3600;

const START_HINT =
  "Start the oyobidashi relay once so that it generates the config (`cd relay && bun run serve` in the oyobidashi repository), " +
  "or set the environment variables OYOBIDASHI_RELAY_URL and OYOBIDASHI_AGENT_TOKEN for this MCP server.";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function oyobidashiHome(env: Env, home: () => string = homedir): string {
  return nonEmpty(env.OYOBIDASHI_HOME) ?? join(home(), ".oyobidashi");
}

function normalizeBaseUrl(raw: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("config_invalid", `${origin} is not a valid URL: ${JSON.stringify(raw)}. Expected something like http://127.0.0.1:${DEFAULT_PORT}.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("config_invalid", `${origin} must be an http(s) URL, got ${JSON.stringify(raw)}.`);
  }
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

interface FileConfig {
  port?: number;
  agentToken?: string;
}

function readConfigFile(path: string): FileConfig | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new ConfigError("config_invalid", `Cannot read oyobidashi config ${path}: ${(e as Error).message}. Check the file permissions (it should be readable by the current user, mode 600).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError("config_invalid", `oyobidashi config ${path} is not valid JSON (${(e as Error).message}). Fix or delete the file and restart the relay (\`cd relay && bun run serve\`) to regenerate it.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError("config_invalid", `oyobidashi config ${path} must be a JSON object. Fix or delete the file and restart the relay (\`cd relay && bun run serve\`) to regenerate it.`);
  }
  const obj = parsed as Record<string, unknown>;
  const out: FileConfig = {};
  if (obj.port !== undefined && obj.port !== null) {
    if (typeof obj.port !== "number" || !Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) {
      throw new ConfigError("config_invalid", `oyobidashi config ${path} has an invalid "port" (${JSON.stringify(obj.port)}); expected an integer 1-65535.`);
    }
    out.port = obj.port;
  }
  if (obj.agent_token !== undefined && obj.agent_token !== null) {
    if (typeof obj.agent_token !== "string" || obj.agent_token.trim() === "") {
      throw new ConfigError("config_invalid", `oyobidashi config ${path} has an invalid "agent_token"; expected a non-empty string.`);
    }
    out.agentToken = obj.agent_token.trim();
  }
  return out;
}

/**
 * Resolve where the relay is and how to authenticate (PROTOCOL.md section 8).
 * Each value is taken from the environment first, then from `$OYOBIDASHI_HOME/config.json`.
 * Called lazily on every tool call so a relay started later is picked up.
 */
export function resolveConnection(env: Env, home: () => string = homedir): Connection {
  const configPath = join(oyobidashiHome(env, home), "config.json");
  const envUrl = nonEmpty(env.OYOBIDASHI_RELAY_URL);
  const envToken = nonEmpty(env.OYOBIDASHI_AGENT_TOKEN);

  if (envUrl && envToken) {
    return {
      baseUrl: normalizeBaseUrl(envUrl, "OYOBIDASHI_RELAY_URL"),
      agentToken: envToken,
      source: { baseUrl: "env", agentToken: "env" },
      configPath,
    };
  }

  // Explicit local endpoint/token settings keep their original precedence. Cloud
  // state lives separately and never overwrites the LAN relay configuration.
  const cloudPath = nonEmpty(env.OYOBIDASHI_CLOUD_AUTH_FILE) ?? join(oyobidashiHome(env, home), "cloud-auth.json");
  if (!envUrl && !envToken && (nonEmpty(env.OYOBIDASHI_CLOUD_AUTH_FILE) || existsSync(cloudPath))) {
    const cloud = readCloudCredentials(cloudPath);
    return {baseUrl:cloud.baseUrl, agentToken:cloud.idToken, cloudAuthFile:cloudPath,
      source:{baseUrl:"cloud",agentToken:"cloud"}, configPath};
  }

  const file = readConfigFile(configPath);
  const agentToken = envToken ?? file?.agentToken;
  if (!agentToken) {
    const what = file
      ? `oyobidashi config ${configPath} has no "agent_token"`
      : `oyobidashi config ${configPath} does not exist`;
    throw new ConfigError("config_missing", `${what} and OYOBIDASHI_AGENT_TOKEN is not set, so the agent token for the relay is unknown. ${START_HINT}`);
  }
  const baseUrl = envUrl
    ? normalizeBaseUrl(envUrl, "OYOBIDASHI_RELAY_URL")
    : `http://127.0.0.1:${file?.port ?? DEFAULT_PORT}`;
  return {
    baseUrl,
    agentToken,
    source: { baseUrl: envUrl ? "env" : "config", agentToken: envToken ? "env" : "config" },
    configPath,
  };
}

export function clampWaitSeconds(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? MAX_WAIT_SECONDS : 0;
  return Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(value)));
}

/** Default for `wait_seconds`: `OYOBIDASHI_DEFAULT_WAIT_SECONDS` if it is a number, else 50; clamped to 0-3600. */
export function defaultWaitSeconds(env: Env, warn: (message: string) => void = () => {}): number {
  const raw = nonEmpty(env.OYOBIDASHI_DEFAULT_WAIT_SECONDS);
  if (raw === undefined) return DEFAULT_WAIT_SECONDS;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    warn(`OYOBIDASHI_DEFAULT_WAIT_SECONDS=${JSON.stringify(raw)} is not a number; using ${DEFAULT_WAIT_SECONDS}`);
    return DEFAULT_WAIT_SECONDS;
  }
  return clampWaitSeconds(n);
}
