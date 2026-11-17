#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  CloudAuthError,
  CloudTokenProvider,
  cloudBaseUrl,
  inspectCloudAccount,
  readCloudCredentials,
  saveCloudCredentials,
  signInAnonymous,
  signInCloud,
  type CloudCredentials,
} from "./cloud-auth.ts";
import { oyobidashiHome } from "./config.ts";
import {
  ACCOUNT_PROVIDERS,
  type AccountProvider,
} from "../../relay/src/auth-handoff.ts";
import { authServerJson, startBrowserLogin } from "./browser-login.ts";

export interface LoginArguments {
  baseUrl: string;
  apiKey?: string;
  authFile: string;
  projectId?: string;
  mode: "anonymous" | "password" | "signin" | "link" | "recover";
  provider?: AccountProvider;
}

/** Credentials are accepted only from protected files or terminal input, never argv. */
export function parseLoginArguments(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): LoginArguments {
  const values: Record<string, string> = {};
  const allowed = new Set([
    "--url",
    "--api-key",
    "--auth-file",
    "--project-id",
    "--provider",
    "--link",
    "--recover",
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key])
      throw new CloudAuthError(
        "cloud_auth_invalid",
        "Usage: bun run src/login.ts --url https://YOUR_HOST --api-key FIREBASE_WEB_API_KEY [--project-id PROJECT_ID] [--auth-file PATH]",
      );
    values[key] = value;
  }
  if (!values["--url"])
    throw new CloudAuthError(
      "cloud_auth_invalid",
      "Cloud login requires --url https://YOUR_HOST.",
    );
  const selected = ["--provider", "--link", "--recover"].filter(
    (key) => values[key],
  );
  if (selected.length > 1)
    throw new CloudAuthError(
      "cloud_auth_invalid",
      "Choose one of --provider, --link, or --recover.",
    );
  let mode: LoginArguments["mode"] = "anonymous",
    provider: AccountProvider | undefined;
  const selection = selected[0],
    value = selection ? values[selection] : undefined;
  if (value) {
    if (
      selection === "--provider" &&
      (value === "anonymous" || value === "password")
    )
      mode = value;
    else {
      if (!ACCOUNT_PROVIDERS.includes(value as AccountProvider))
        throw new CloudAuthError(
          "cloud_auth_invalid",
          "Provider must be anonymous, google, apple, github, or password.",
        );
      provider = value as AccountProvider;
      mode =
        selection === "--link"
          ? "link"
          : selection === "--recover"
            ? "recover"
            : "signin";
    }
  }
  return {
    baseUrl: cloudBaseUrl(values["--url"]),
    ...(values["--api-key"] ? { apiKey: values["--api-key"] } : {}),
    authFile:
      values["--auth-file"] ??
      env.OYOBIDASHI_CLOUD_AUTH_FILE ??
      join(oyobidashiHome(env, homedir), "cloud-auth.json"),
    mode,
    ...(provider ? { provider } : {}),
    ...(values["--project-id"] ? { projectId: values["--project-id"] } : {}),
  };
}

async function passwordPrompt(): Promise<string> {
  process.stderr.write("Password: ");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  let onData: (data: string) => void;
  let onEnd: () => void;
  try {
    return await new Promise<string>((resolve, reject) => {
      let password = "";
      onEnd = () =>
        reject(new CloudAuthError("cloud_auth_required", "Login cancelled."));
      onData = (data) => {
        for (const character of data) {
          if (character === "\u0003" || character === "\u0004") {
            onEnd();
            return;
          }
          if (character === "\r" || character === "\n") {
            resolve(password);
            return;
          }
          if (character === "\u007f" || character === "\b")
            password = Array.from(password).slice(0, -1).join("");
          else if (character >= " ") password += character;
          if (password.length > 4096) {
            reject(
              new CloudAuthError("cloud_auth_invalid", "Password is too long."),
            );
            return;
          }
        }
      };
      process.stdin.on("data", onData);
      process.stdin.once("end", onEnd);
    });
  } finally {
    process.stdin.removeListener("data", onData!);
    process.stdin.removeListener("end", onEnd!);
    process.stdin.setRawMode(wasRaw ?? false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
}

async function passwordLogin(
  options: LoginArguments & { apiKey: string },
): Promise<CloudCredentials> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new CloudAuthError(
      "cloud_auth_required",
      "Run password login in an interactive terminal. Passwords must not be piped through logs or command arguments.",
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  let email: string;
  try {
    email = await prompt.question("Email: ");
  } finally {
    prompt.close();
  }
  const password = await passwordPrompt();
  return signInCloud({ ...options, email, password });
}

function sameAccount(a: CloudCredentials, b: CloudCredentials): boolean {
  const subject = (token: string) => {
    try {
      return JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ).sub;
    } catch {
      return undefined;
    }
  };
  const uid = subject(a.idToken);
  return (
    a.baseUrl === b.baseUrl &&
    a.apiKey === b.apiKey &&
    ((typeof uid === "string" && uid === subject(b.idToken)) ||
      (a.idToken === b.idToken && a.refreshToken === b.refreshToken))
  );
}

/** A recovery explicitly backs up the previous account; concurrent login never loses it. */
export function finishCloudLogin(
  path: string,
  next: CloudCredentials,
  original: CloudCredentials | undefined,
  recover = false,
): string | undefined {
  const current = existsSync(path) ? readCloudCredentials(path) : undefined;
  if (original ? !current || !sameAccount(original, current) : !!current)
    throw new CloudAuthError(
      "cloud_auth_required",
      "Another sign-in changed this account. Existing credentials were preserved; retry the login.",
    );
  if (original && !recover && !sameAccount(original, next))
    throw new CloudAuthError(
      "cloud_auth_required",
      "This account is different from the current pairing. Use --link to retain it, or --recover to restore another saved account.",
    );
  let backup: string | undefined;
  if (recover && current && !sameAccount(current, next)) {
    backup = `${path}.before-recovery-${Date.now()}-${crypto.randomUUID()}.json`;
    saveCloudCredentials(backup, current);
  }
  saveCloudCredentials(path, next);
  return backup;
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  const p = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  if ((await p.exited) !== 0)
    throw new CloudAuthError(
      "cloud_auth_required",
      "Could not open the browser. Run login from an interactive desktop terminal.",
    );
}

export async function login(args = process.argv.slice(2)): Promise<void> {
  const options = parseLoginArguments(args);
  let original = existsSync(options.authFile)
    ? readCloudCredentials(options.authFile)
    : undefined;
  if (original && original.baseUrl !== options.baseUrl)
    throw new CloudAuthError(
      "cloud_auth_invalid",
      "A different cloud endpoint already uses this credential file. Choose another --auth-file to keep that pairing.",
    );
  let apiKey = options.apiKey ?? original?.apiKey,
    projectId = options.projectId ?? original?.projectId;
  let providers: AccountProvider[] = [];
  if (!apiKey || ["signin", "link", "recover"].includes(options.mode)) {
    const config = await authServerJson(options.baseUrl, "/v1/auth/config");
    const firebase = config.firebase as Record<string, unknown> | undefined;
    if (
      !firebase ||
      typeof firebase.apiKey !== "string" ||
      typeof firebase.projectId !== "string" ||
      !Array.isArray(config.providers) ||
      config.providers.some(
        (p) => !ACCOUNT_PROVIDERS.includes(p as AccountProvider),
      )
    )
      throw new CloudAuthError("cloud_auth_invalid");
    if (
      (apiKey && apiKey !== firebase.apiKey) ||
      (projectId && projectId !== firebase.projectId)
    )
      throw new CloudAuthError(
        "cloud_auth_invalid",
        "Cloud authentication project does not match the saved account.",
      );
    apiKey = firebase.apiKey;
    projectId = firebase.projectId;
    providers = config.providers as AccountProvider[];
    if (options.mode === "link" && !config.canLinkExisting)
      throw new CloudAuthError(
        "cloud_auth_unavailable",
        "Account recovery linking is not configured on this cloud server.",
      );
  }
  if (!apiKey) throw new CloudAuthError("cloud_auth_invalid");
  const input = {
    baseUrl: options.baseUrl,
    apiKey,
    ...(projectId ? { projectId } : {}),
  };
  if (options.mode === "anonymous") {
    if (original) {
      if (original.apiKey !== apiKey)
        throw new CloudAuthError("cloud_auth_invalid");
      await new CloudTokenProvider(options.authFile).getToken();
      const account = await inspectCloudAccount(
        readCloudCredentials(options.authFile),
      );
      process.stderr.write(
        account.anonymous
          ? "Saved anonymous account reused. Existing pairings were preserved.\n"
          : "Saved account reused. Existing pairings were preserved.\n",
      );
    } else {
      const credentials = await signInAnonymous(input);
      finishCloudLogin(options.authFile, credentials, undefined);
      process.stderr.write(
        "Anonymous cloud account saved. Link a recovery account with --link google (or apple/github) before losing this credential file.\n",
      );
    }
    return;
  }
  if (options.mode === "password") {
    const next = await passwordLogin({ ...options, ...input });
    finishCloudLogin(options.authFile, next, original);
    process.stderr.write("Cloud sign-in saved.\n");
    return;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new CloudAuthError(
      "cloud_auth_required",
      "Run browser sign-in in an interactive desktop terminal.",
    );
  if (!options.provider || !providers.includes(options.provider))
    throw new CloudAuthError(
      "cloud_auth_required",
      "This sign-in provider is not enabled on the cloud server. Choose an enabled recovery provider.",
    );
  let uid: string | undefined, customToken: string | undefined;
  if (original) {
    await new CloudTokenProvider(options.authFile).getToken();
    original = readCloudCredentials(options.authFile);
    const account = await inspectCloudAccount(original);
    uid = account.uid;
    if (options.mode === "link" && account.providers.includes(`${options.provider}.com`)) {
      process.stderr.write("This recovery provider is already linked. Existing pairings were preserved.\n");
      return;
    }
  }
  if (options.mode === "link") {
    if (!original || !uid)
      throw new CloudAuthError(
        "cloud_auth_required",
        "Create or restore the cloud account before linking a recovery provider.",
      );
    const bootstrap = await authServerJson(
      options.baseUrl,
      "/v1/auth/link-token",
      original.idToken,
    );
    if (bootstrap.uid !== uid || typeof bootstrap.custom_token !== "string")
      throw new CloudAuthError("cloud_auth_invalid");
    customToken = bootstrap.custom_token;
  }
  const session = startBrowserLogin({
    ...input,
    mode: options.mode === "link" ? "link" : "signin",
    provider: options.provider,
    ...(uid && options.mode !== "recover" ? { expectedUid: uid } : {}),
    ...(customToken ? { customToken } : {}),
  });
  try {
    process.stderr.write(
      options.mode === "link"
        ? "Opening the browser to link a recovery account without changing pairings…\n"
        : "Opening the browser to restore a cloud account…\n",
    );
    await openBrowser(session.url);
    const next = await session.result;
    const backup = finishCloudLogin(
      options.authFile,
      next,
      original,
      options.mode === "recover",
    );
    process.stderr.write(
      "Cloud authentication saved. Reconnect the MCP client if needed.\n",
    );
    if (backup)
      process.stderr.write(
        `The previous account was retained privately at ${backup}\n`,
      );
  } finally {
    await session.stop();
  }
}

if (import.meta.main) {
  try {
    await login();
  } catch (error) {
    process.stderr.write(
      `${error instanceof CloudAuthError ? error.message : "Cloud login failed. Existing credentials were preserved."}\n`,
    );
    process.exitCode = 1;
  }
}
