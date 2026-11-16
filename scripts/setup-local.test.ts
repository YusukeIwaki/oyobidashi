import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_ID, configureApple, configureFirebase, configureMCP, doctor, initialize, iosSpec, mergeProperties, type Context } from "./setup-local.ts";

const roots: string[] = [];
let rsa: string, ec: string;
beforeAll(() => {
  rsa = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  ec = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): Context {
  const root = mkdtempSync(join(tmpdir(), "oyobidashi-setup space-"));
  roots.push(root);
  mkdirSync(join(root, "android")); mkdirSync(join(root, "ios"));
  return { root, home: join(root, ".oyobidashi") };
}
function json(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }
function config(ctx: Context): any { return json(join(ctx.home, "config.json")); }
function firebaseFiles(ctx: Context, project = "example-dev", accountProject = project): [string, string] {
  const meta = join(ctx.root, "google-services.json"), sa = join(ctx.root, "download.json");
  writeFileSync(meta, JSON.stringify({ project_info: { project_id: project, project_number: "123456" }, client: [
    { client_info: { android_client_info: { package_name: "other.app" } } },
    { client_info: { android_client_info: { package_name: APP_ID }, mobilesdk_app_id: "1:123456:android:abcdef" }, api_key: [{ current_key: "TEST_ONLY_VALUE" }] },
  ] }));
  writeFileSync(sa, JSON.stringify({ type: "service_account", project_id: accountProject, client_email: `relay@${accountProject}.iam.gserviceaccount.com`, private_key: rsa, token_uri: "https://oauth2.googleapis.com/token" }));
  return [meta, sa];
}

describe("local setup without cloud accounts", () => {
  test("init preserves token, port, other providers and unknown keys on repeat", () => {
    const ctx = fixture(); initialize(ctx);
    const initial = config(ctx);
    writeFileSync(join(ctx.home, "config.json"), JSON.stringify({ ...initial, port: 9123, apns: { key_id: "keep" }, custom: { value: "keep" } }));
    initialize(ctx); initialize(ctx);
    expect(config(ctx)).toEqual({ ...initial, port: 9123, apns: { key_id: "keep" }, custom: { value: "keep" } });
    expect(statSync(ctx.home).mode & 0o777).toBe(0o700);
    expect(statSync(join(ctx.home, "config.json")).mode & 0o777).toBe(0o600);
  });
  test("Firebase import selects matching Android client and preserves existing SDK and APNs", () => {
    const ctx = fixture(); initialize(ctx);
    const before = config(ctx);
    writeFileSync(join(ctx.home, "config.json"), JSON.stringify({ ...before, apns: { key_id: "keep" } }));
    writeFileSync(join(ctx.root, "android/local.properties"), "# local SDK\nsdk.dir=/my/sdk\ncustom=value\n");
    const [meta, sa] = firebaseFiles(ctx);
    configureFirebase(ctx, meta, sa); configureFirebase(ctx, meta, sa);
    expect(config(ctx).agent_token).toBe(before.agent_token);
    expect(config(ctx).apns.key_id).toBe("keep");
    const imported = config(ctx).fcm.service_account_path;
    expect(json(imported).private_key).toBe(rsa);
    expect(statSync(imported).mode & 0o777).toBe(0o600);
    expect(statSync(join(ctx.home, "keys")).mode & 0o777).toBe(0o700);
    const props = readFileSync(join(ctx.root, "android/local.properties"), "utf8");
    expect(props).toContain("# local SDK\nsdk.dir=/my/sdk\ncustom=value\n");
    expect(props).toContain("oyobidashi.firebase.applicationId=1\\:123456\\:android\\:abcdef\n");
    expect(props.match(/oyobidashi.firebase.projectId/g)).toHaveLength(1);
  });
  test("mismatched project rejects before creating local config or copying keys", () => {
    const ctx = fixture(); const [meta, sa] = firebaseFiles(ctx, "target-project", "other-project");
    expect(() => configureFirebase(ctx, meta, sa)).toThrow("一致しません");
    expect(existsSync(ctx.home)).toBe(false);
    expect(existsSync(join(ctx.root, "android/local.properties"))).toBe(false);
  });
  test("an invalid existing config is never partially repaired or overwritten", () => {
    const ctx = fixture(); mkdirSync(ctx.home);
    const path = join(ctx.home, "config.json");
    const original = '{"port":0,"agent_token":"","custom":"keep"}';
    writeFileSync(path, original);
    const [meta, sa] = firebaseFiles(ctx);
    expect(() => configureFirebase(ctx, meta, sa)).toThrow("上書きしません");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(existsSync(join(ctx.home, "keys"))).toBe(false);
  });
  test("invalid key or untrusted OAuth endpoint never reaches relay", () => {
    const ctx = fixture(); const [meta, sa] = firebaseFiles(ctx);
    const account = json(sa);
    writeFileSync(sa, JSON.stringify({ ...account, private_key: ec }));
    expect(() => configureFirebase(ctx, meta, sa)).toThrow("RSA");
    writeFileSync(sa, JSON.stringify({ ...account, token_uri: "https://untrusted.invalid/token" }));
    expect(() => configureFirebase(ctx, meta, sa)).toThrow("token_uri");
    expect(existsSync(ctx.home)).toBe(false);
  });
  test("gcloud alternative replaces key auth and preserves APNs", () => {
    const ctx = fixture(); const [meta, sa] = firebaseFiles(ctx);
    configureFirebase(ctx, meta, sa);
    configureFirebase(ctx, meta, undefined, "gcloud");
    expect(config(ctx).fcm).toEqual({ auth: "gcloud", project_id: "example-dev" });
    expect(() => configureFirebase(ctx, meta, sa, "gcloud")).toThrow("どちらか1つ");
  });
  test("Apple imports EC key and generates both local bundle IDs for the selected team", () => {
    const ctx = fixture(); const [meta, sa] = firebaseFiles(ctx); configureFirebase(ctx, meta, sa);
    const before = config(ctx);
    const file = join(ctx.root, "download.p8"); writeFileSync(file, ec);
    configureApple(ctx, "TESTTEAM01", "TESTKEY001", file, "dev.example.oyobidashi");
    const saved = config(ctx);
    expect(saved.fcm).toEqual(before.fcm); expect(saved.agent_token).toBe(before.agent_token);
    expect(saved.apns.bundle_id).toBe("dev.example.oyobidashi");
    expect(readFileSync(saved.apns.key_path, "utf8")).toBe(ec);
    expect(statSync(saved.apns.key_path).mode & 0o777).toBe(0o600);
    const spec = json(join(ctx.root, "ios/project.local.yml"));
    expect(spec.settings.base.DEVELOPMENT_TEAM).toBe("TESTTEAM01");
    expect(spec.targets.OyobidashiNotificationService.settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe("dev.example.oyobidashi.NotificationService");
  });
  test("Apple rejects RSA and wildcard IDs before modifying any local files", () => {
    const ctx = fixture(); const file = join(ctx.root, "bad.p8"); writeFileSync(file, rsa);
    expect(() => configureApple(ctx, "TESTTEAM01", "TESTKEY001", file, "dev.example.app")).toThrow("P-256");
    expect(() => iosSpec("TESTTEAM01", "dev.example.*")).toThrow("Bundle ID");
    expect(existsSync(ctx.home)).toBe(false);
  });
  test("legacy PEM containers that relay WebCrypto cannot import are rejected", () => {
    const ctx = fixture(); const [meta, sa] = firebaseFiles(ctx);
    writeFileSync(sa, JSON.stringify({ ...json(sa), private_key: createPrivateKey(rsa).export({ type: "pkcs1", format: "pem" }) }));
    expect(() => configureFirebase(ctx, meta, sa)).toThrow("PKCS#8");
    const file = join(ctx.root, "sec1.p8");
    writeFileSync(file, createPrivateKey(ec).export({ type: "sec1", format: "pem" }));
    expect(() => configureApple(ctx, "TESTTEAM01", "TESTKEY001", file, "dev.example.app")).toThrow("PKCS#8");
    expect(existsSync(ctx.home)).toBe(false);
  });
  test("MCP adds both clients with paths containing spaces and keeps unrelated settings", () => {
    const ctx = fixture();
    writeFileSync(join(ctx.root, ".mcp.json"), JSON.stringify({ custom: true, mcpServers: { existing: { command: "other" } } }));
    mkdirSync(join(ctx.root, ".codex"));
    writeFileSync(join(ctx.root, ".codex/config.toml"), '# retained\nmodel = "test"\n[mcp_servers.other]\ncommand = "other"\n');
    configureMCP(ctx, "both");
    const claude = json(join(ctx.root, ".mcp.json"));
    expect(claude.custom).toBe(true); expect(claude.mcpServers.existing.command).toBe("other");
    expect(claude.mcpServers.oyobidashi.command).toBe(join(ctx.root, "scripts/mcp.sh"));
    const path = join(ctx.root, ".codex/config.toml");
    const text = readFileSync(path, "utf8"); const codex = Bun.TOML.parse(text) as any;
    expect(codex.model).toBe("test"); expect(codex.mcp_servers.other.command).toBe("other");
    expect(codex.mcp_servers.oyobidashi.env.OYOBIDASHI_HOME).toBe(ctx.home);
    configureMCP(ctx, "both"); expect(readFileSync(path, "utf8")).toBe(text);
  });
  test("MCP conflicts abort both writes so an existing connection is never silently replaced", () => {
    const ctx = fixture(); mkdirSync(join(ctx.root, ".codex"));
    const path = join(ctx.root, ".codex/config.toml");
    const original = '[mcp_servers.oyobidashi]\ncommand = "another-clone"\n'; writeFileSync(path, original);
    expect(() => configureMCP(ctx, "both")).toThrow("競合");
    expect(existsSync(join(ctx.root, ".mcp.json"))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);
  });
  test("doctor is read only and redacts all sensitive config", () => {
    const ctx = fixture();
    doctor(ctx); expect(existsSync(ctx.home)).toBe(false);
    const [meta, sa] = firebaseFiles(ctx); configureFirebase(ctx, meta, sa);
    const output = doctor(ctx).join("\n");
    expect(output).not.toContain(config(ctx).agent_token);
    expect(output).not.toContain(rsa); expect(output).not.toContain("TEST_ONLY_VALUE");
    expect(output).toContain("設定あり: JSON");
  });
  test("property updates remove duplicate managed keys while preserving comments and custom keys", () => {
    const text = "# sdk\nsdk.dir=/old\ncustom: keep\nsdk.dir=/duplicate\n";
    expect(mergeProperties(text, { "sdk.dir": "/new path/sdk" })).toBe("# sdk\nsdk.dir=/new path/sdk\ncustom: keep\n");
  });
  test("CLI parsing errors cannot print a malformed downloaded secret", () => {
    const ctx = fixture(); const bad = join(ctx.root, "bad.json"); const marker = "PRIVATE_CONTENT_MUST_NOT_APPEAR";
    writeFileSync(bad, `{${marker}`);
    const cli = resolve(import.meta.dir, "setup-local.ts");
    const result = Bun.spawnSync([process.execPath, cli, "firebase", "--android-config", bad, "--auth", "gcloud"], { env: { ...process.env, OYOBIDASHI_HOME: ctx.home } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("設定JSON");
    expect(result.stderr.toString() + result.stdout.toString()).not.toContain(marker);
  });
});
