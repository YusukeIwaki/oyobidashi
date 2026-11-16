import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { runCli, startServe, type CliDeps, type ServeHandle } from "../src/cli.ts";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  configIsTooOpen,
  configPath,
  dbPath,
  loadOrCreateConfig,
  readConfig,
  resolveHome,
  updateConfigPort,
} from "../src/config.ts";
import { Store } from "../src/db.ts";
import { buildPairingUri, detectDefaultInterface, detectLanIPv4, normalizeBaseUrl, resolvePublicUrl, type Interfaces } from "../src/pairing.ts";
import { fixtureText } from "./helpers.ts";

const temps: string[] = [];
const handles: ServeHandle[] = [];
function tempHome(create = true): string {
  const dir = mkdtempSync(join(tmpdir(), "oyobidashi-cli-"));
  temps.push(dir);
  return create ? dir : join(dir, "nested", "home");
}
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const v4 = (address: string, internal = false) => ({ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` });
const v6 = (address: string, internal = false) => ({ address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6" as const, mac: "00:00:00:00:00:00", internal, cidr: `${address}/64`, scopeid: 0 });
const LOOPBACK = { lo0: [v4("127.0.0.1", true), v6("::1", true)] };
const WIFI: Interfaces = { ...LOOPBACK, en0: [v6("fe80::1"), v4("192.168.1.10")] };

function cli(home: string, extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    env: { OYOBIDASHI_HOME: home },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    interfaces: WIFI,
    defaultInterface: () => "en0",
    qr: (text) => `[QR:${text}]`,
    ...extra,
  };
  return { out, err, deps, run: (...argv: string[]) => runCli(argv, deps) };
}

describe("config", () => {
  test("first start creates config.json with mode 600 and a generated agent token", () => {
    const home = tempHome(false);
    const { config, created } = loadOrCreateConfig(home);
    expect(created).toBe(true);
    expect(config.port).toBe(8787);
    expect(DEFAULT_PORT).toBe(8787);
    expect(config.agent_token).toMatch(/^ka_[A-Za-z0-9_-]{43}$/);
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(configIsTooOpen(home)).toBe(false);
    const onDisk = JSON.parse(readFileSync(configPath(home), "utf8"));
    expect(onDisk).toEqual({ port: 8787, agent_token: config.agent_token });
    expect(config.apns).toBeUndefined();
    expect(config.fcm).toBeUndefined();
  });

  test("each home gets its own token; an existing config is loaded unchanged", () => {
    const a = loadOrCreateConfig(tempHome());
    const home = tempHome();
    const b = loadOrCreateConfig(home);
    expect(a.config.agent_token).not.toBe(b.config.agent_token);
    const before = readFileSync(configPath(home), "utf8");
    const again = loadOrCreateConfig(home);
    expect(again.created).toBe(false);
    expect(again.config).toEqual(b.config);
    expect(readFileSync(configPath(home), "utf8")).toBe(before);
  });

  test("apns / fcm sections are read; unknown keys survive rewrites", () => {
    const home = tempHome();
    const raw = {
      port: 9000,
      agent_token: "ka_existing",
      apns: { key_path: "/path/AuthKey_XXXX.p8", key_id: "XXXX", team_id: "YYYY", bundle_id: "io.github.yusukeiwaki.oyobidashi" },
      fcm: { service_account_path: "/path/service-account.json" },
      future: { keep: true },
    };
    writeFileSync(configPath(home), JSON.stringify(raw));
    const { config } = loadOrCreateConfig(home);
    expect(config).toEqual({ port: 9000, agent_token: "ka_existing", apns: raw.apns, fcm: raw.fcm });
    updateConfigPort(home, 9100);
    expect(JSON.parse(readFileSync(configPath(home), "utf8"))).toEqual({ ...raw, port: 9100 });
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
  });

  test("a config without an agent token gets one, keeping everything else", () => {
    const home = tempHome();
    writeFileSync(configPath(home), JSON.stringify({ fcm: { service_account_path: "/sa.json" } }), { mode: 0o644 });
    const { config, created } = loadOrCreateConfig(home);
    expect(created).toBe(false);
    expect(config.agent_token).toMatch(/^ka_/);
    expect(config.port).toBe(8787);
    expect(config.fcm).toEqual({ service_account_path: "/sa.json" });
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    expect(loadOrCreateConfig(home).config.agent_token).toBe(config.agent_token);
  });

  test("a world-readable config is detected", () => {
    const home = tempHome();
    loadOrCreateConfig(home);
    chmodSync(configPath(home), 0o644);
    expect(configIsTooOpen(home)).toBe(true);
  });

  test("broken config files are reported, not overwritten", () => {
    const home = tempHome();
    for (const content of ["{ nope", "[]", '"str"', '{"port":"8787","agent_token":"ka_x"}', '{"port":70000,"agent_token":"ka_x"}', '{"port":0,"agent_token":"ka_x"}']) {
      writeFileSync(configPath(home), content);
      expect(() => loadOrCreateConfig(home)).toThrow("config.json");
      expect(readFileSync(configPath(home), "utf8")).toBe(content);
    }
  });

  test("readConfig never creates anything", () => {
    const home = tempHome(false);
    expect(readConfig(home)).toBeNull();
    expect(existsSync(home)).toBe(false);
  });

  test("OYOBIDASHI_HOME overrides the default ~/.oyobidashi", () => {
    expect(resolveHome({ OYOBIDASHI_HOME: "/tmp/custom" })).toBe("/tmp/custom");
    expect(resolveHome({})).toBe(join(homedir(), ".oyobidashi"));
    expect(resolveHome({ OYOBIDASHI_HOME: "" })).toBe(join(homedir(), ".oyobidashi"));
    expect(dbPath("/h")).toBe("/h/oyobidashi.db");
    expect(configPath("/h")).toBe("/h/config.json");
  });

  test("the relay binds 0.0.0.0 by default", () => {
    expect(DEFAULT_HOST).toBe("0.0.0.0");
  });
});

describe("pairing URL", () => {
  test("URI format matches the fixture", () => {
    const expected = fixtureText("pairing_uri.txt").trim();
    expect(buildPairingUri("http://192.168.1.10:8787", "3f9a1c0e7b2d4a6f8c1e0b9d7a5f3c21")).toBe(expected);
    expect(buildPairingUri("http://192.168.1.10:8787/", "3f9a1c0e7b2d4a6f8c1e0b9d7a5f3c21")).toBe(expected);
    const parsed = new URL(expected);
    expect(parsed.protocol).toBe("oyobidashi:");
    expect(parsed.searchParams.get("url")).toBe("http://192.168.1.10:8787");
  });

  test("mDNS names and https URLs are encoded", () => {
    expect(buildPairingUri("http://my-mac.local:8787", "abc")).toBe("oyobidashi://pair?url=http%3A%2F%2Fmy-mac.local%3A8787&code=abc");
    expect(normalizeBaseUrl(" https://example.test/base// ")).toBe("https://example.test/base");
    for (const bad of ["ftp://x", "oyobidashi://pair", "192.168.1.10:8787", "", "not a url"]) {
      expect(() => normalizeBaseUrl(bad)).toThrow();
    }
  });

  test("single LAN address", () => {
    expect(detectLanIPv4(WIFI, "en0")).toBe("192.168.1.10");
    expect(detectLanIPv4(WIFI, null)).toBe("192.168.1.10");
    expect(detectLanIPv4({ en0: [v4("10.0.0.5")] }, "en0")).toBe("10.0.0.5");
    expect(detectLanIPv4({ en0: [v4("172.16.4.2")] }, "en0")).toBe("172.16.4.2");
  });

  test("multiple interfaces: the default-route interface wins", () => {
    const multi: Interfaces = {
      ...LOOPBACK,
      bridge100: [v4("192.168.64.1")],
      en0: [v4("192.168.1.10")],
      en7: [v4("10.20.30.40")],
      utun4: [v4("100.96.1.2")],
    };
    expect(detectLanIPv4(multi, "en0")).toBe("192.168.1.10");
    expect(detectLanIPv4(multi, "en7")).toBe("10.20.30.40");
    // unknown default route → first private address in enumeration order
    expect(detectLanIPv4(multi, null)).toBe("192.168.64.1");
    expect(detectLanIPv4(multi, "en99")).toBe("192.168.64.1");
    // default route through a VPN without a private address → fall back to a LAN interface
    expect(detectLanIPv4(multi, "utun4")).toBe("192.168.64.1");
  });

  test("an interface with several addresses: the private IPv4 is picked", () => {
    expect(detectLanIPv4({ en0: [v6("2001:db8::5"), v4("203.0.113.9"), v4("169.254.7.7"), v4("192.168.0.2")] }, "en0")).toBe("192.168.0.2");
  });

  test("only loopback → none", () => {
    expect(detectLanIPv4(LOOPBACK, null)).toBeNull();
    expect(detectLanIPv4(LOOPBACK, "lo0")).toBeNull();
    expect(detectLanIPv4({}, "en0")).toBeNull();
    // an address flagged internal is never used, whatever it looks like
    expect(detectLanIPv4({ lo0: [v4("192.168.1.10", true)] }, "lo0")).toBeNull();
  });

  test("only public / VPN-style / link-local / IPv6 addresses → none", () => {
    const none: Interfaces = {
      ...LOOPBACK,
      en0: [v4("203.0.113.9"), v6("2001:db8::1"), v6("fe80::1"), v6("fd00::1")],
      utun3: [v4("100.64.0.2")],
      utun5: [v4("172.32.0.1")],
      en5: [v4("169.254.10.20")],
      en6: [v4("192.169.0.1"), v4("11.0.0.1"), v4("172.15.255.255")],
    };
    expect(detectLanIPv4(none, "en0")).toBeNull();
    expect(detectLanIPv4(none, null)).toBeNull();
  });

  test("resolution order: --public-url, then serve's --public-url, then the LAN address", () => {
    const base = { port: 8787, interfaces: WIFI, defaultInterface: () => "en0" };
    expect(resolvePublicUrl({ ...base, explicit: "http://my-mac.local:8787/", fromServe: "http://other:1" })).toEqual({ url: "http://my-mac.local:8787", source: "flag" });
    expect(resolvePublicUrl({ ...base, fromServe: "http://other.local:8787" })).toEqual({ url: "http://other.local:8787", source: "serve" });
    expect(resolvePublicUrl(base)).toEqual({ url: "http://192.168.1.10:8787", source: "lan" });
    expect(resolvePublicUrl({ ...base, port: 9000 })).toEqual({ url: "http://192.168.1.10:9000", source: "lan" });
    expect(() => resolvePublicUrl({ ...base, explicit: "ftp://x" })).toThrow();
  });

  test("no private IPv4 → an error that tells the user to pass --public-url", () => {
    for (const interfaces of [LOOPBACK, { utun3: [v4("100.64.0.2")], en0: [v4("203.0.113.9")] }]) {
      expect(() => resolvePublicUrl({ port: 8787, interfaces, defaultInterface: () => "en0" })).toThrow("--public-url");
    }
    // …and --public-url then works without any interface
    expect(resolvePublicUrl({ port: 8787, interfaces: LOOPBACK, defaultInterface: () => null, explicit: "http://mac.local:8787" }).url).toBe("http://mac.local:8787");
  });

  test("the OS default-route lookup returns an interface name or null, never throws", () => {
    const name = detectDefaultInterface();
    expect(name === null || /^[A-Za-z0-9_.-]+$/.test(name)).toBe(true);
  });
});

describe("CLI", () => {
  test("pair prints the URI, a QR code and issues a code that works against the same DB", async () => {
    const home = tempHome();
    const { out, run } = cli(home);
    expect(await run("pair")).toBe(0);
    const uriLine = out.find((l) => l.includes("oyobidashi://pair?") && !l.startsWith("[QR:"))!;
    const uri = uriLine.slice(uriLine.indexOf("oyobidashi://"));
    expect(uri).toMatch(/^oyobidashi:\/\/pair\?url=http%3A%2F%2F192\.168\.1\.10%3A8787&code=[0-9a-f]{32}$/);
    // identical to the fixture except for the code
    expect(uri.replace(/code=.*/, "")).toBe(fixtureText("pairing_uri.txt").trim().replace(/code=.*/, ""));
    expect(out[0]).toBe(`[QR:${uri}]`);

    const code = new URL(uri).searchParams.get("code")!;
    const { config } = loadOrCreateConfig(home);
    const store = new Store(dbPath(home));
    const app = createApp({ store, agentToken: config.agent_token, peerAddress: () => "192.168.1.77" });
    const pair = () => app.fetch(new Request("http://x/v1/pair", { method: "POST", body: JSON.stringify({ code, device_name: "iPhone", platform: "ios" }) }));
    expect((await pair())!.status).toBe(201);
    expect((await pair())!.status).toBe(401);
    store.close();
  });

  test("pair renders a real QR code by default", async () => {
    const home = tempHome();
    const { out, run } = cli(home, { qr: undefined });
    expect(await run("pair")).toBe(0);
    expect(out[0]!.split("\n").length).toBeGreaterThan(10);
    expect(out[0]).toMatch(/[▄▀█]/);
  });

  test("pair --public-url and --port", async () => {
    const home = tempHome();
    const a = cli(home);
    expect(await a.run("pair", "--public-url", "http://my-mac.local:8787/")).toBe(0);
    expect(a.out.join("\n")).toContain("oyobidashi://pair?url=http%3A%2F%2Fmy-mac.local%3A8787&code=");
    const b = cli(home);
    expect(await b.run("pair", "--port", "9999")).toBe(0);
    expect(b.out.join("\n")).toContain("url=http%3A%2F%2F192.168.1.10%3A9999&code=");
  });

  test("pair uses the port from config.json", async () => {
    const home = tempHome();
    loadOrCreateConfig(home);
    updateConfigPort(home, 8123);
    const { out, run } = cli(home);
    expect(await run("pair")).toBe(0);
    expect(out.join("\n")).toContain("url=http%3A%2F%2F192.168.1.10%3A8123&code=");
  });

  test("pair fails without a private IPv4 unless --public-url is given, and issues no code", async () => {
    const home = tempHome();
    const { out, err, run } = cli(home, { interfaces: { ...LOOPBACK, utun3: [v4("100.64.0.2")] }, defaultInterface: () => "utun3" });
    expect(await run("pair")).toBe(1);
    expect(err.join("\n")).toContain("--public-url");
    expect(out.join("\n")).not.toContain("oyobidashi://");
    if (existsSync(dbPath(home))) {
      const store = new Store(dbPath(home));
      expect(store.db.query("SELECT COUNT(*) AS n FROM pairing_codes").get()).toEqual({ n: 0 });
      store.close();
    }
    expect(await run("pair", "--public-url", "http://my-mac.local:8787")).toBe(0);
    expect(out.join("\n")).toContain("oyobidashi://pair?url=http%3A%2F%2Fmy-mac.local%3A8787");
  });

  test("pair warns when the relay is not running", async () => {
    const home = tempHome();
    const { err, run } = cli(home, { fetch: async () => { throw new Error("ECONNREFUSED"); } });
    expect(await run("pair")).toBe(0);
    expect(err.join("\n")).toContain("bun run serve");
  });

  test("devices and revoke", async () => {
    const home = tempHome();
    const empty = cli(home);
    expect(await empty.run("devices")).toBe(0);
    expect(empty.out.join("\n")).toContain("ありません");
    expect(await empty.run("revoke", "dev_nope")).toBe(1);

    const store = new Store(dbPath(home));
    store.insertDevice({ id: "dev_A", name: "iPhone 16", platform: "ios", token_hash: "h1", push_token: "secret-push-token", push_environment: "development", created_at: Date.parse("2026-11-15T13:59:00.000Z") });
    store.insertDevice({ id: "dev_B", name: "Pixel 9", platform: "android", token_hash: "h2", push_token: null, push_environment: null, created_at: Date.parse("2026-11-15T14:00:00.000Z") });
    store.close();

    const list = cli(home);
    expect(await list.run("devices")).toBe(0);
    expect(list.out).toHaveLength(2);
    expect(list.out[0]).toContain("dev_A");
    expect(list.out[0]).toContain("iPhone 16");
    expect(list.out[0]).toContain("2026-11-15T13:59:00.000Z");
    expect(list.out[1]).toContain("dev_B");
    expect(list.out.join("\n")).not.toContain("secret-push-token");
    expect(list.out.join("\n")).not.toContain("h1");

    const revoke = cli(home);
    expect(await revoke.run("revoke", "dev_A")).toBe(0);
    expect(await revoke.run("revoke", "dev_A")).toBe(1);
    expect(revoke.err.join("\n")).toContain("dev_A");
    const after = cli(home);
    await after.run("devices");
    expect(after.out).toHaveLength(1);
    expect(after.out[0]).toContain("dev_B");
  });

  test("status before and after the first start", async () => {
    const home = tempHome();
    const fresh = cli(home);
    expect(await fresh.run("status")).toBe(0);
    expect(fresh.out.join("\n")).toContain("未作成");
    expect(existsSync(configPath(home))).toBe(false);

    const { config } = loadOrCreateConfig(home);
    const stopped = cli(home, { fetch: async () => { throw new Error("ECONNREFUSED"); } });
    expect(await stopped.run("status")).toBe(0);
    const text = stopped.out.join("\n");
    expect(text).toContain("停止中");
    expect(text).toContain("http://192.168.1.10:8787");
    expect(text).toMatch(/APNs\s*: 未設定/);
    expect(text).toMatch(/FCM\s*: 未設定/);
    expect(text).not.toContain(config.agent_token);
  });

  test("usage errors exit with 2; help exits with 0", async () => {
    const home = tempHome();
    for (const argv of [["bogus"], ["pair", "--nope"], ["revoke"], ["serve", "--port", "abc"], ["pair", "--port", "99999"], []]) {
      const c = cli(home);
      expect(await c.run(...argv)).toBe(2);
    }
    const help = cli(home);
    expect(await help.run("--help")).toBe(0);
    expect(help.out.join("\n")).toContain("serve");
    expect(existsSync(configPath(home))).toBe(false);
  });
});

describe("serve", () => {
  async function serve(home: string, options = {}) {
    const c = cli(home);
    const handle = await startServe({ host: "127.0.0.1", port: 0, ...options }, c.deps);
    handles.push(handle);
    return { ...c, handle };
  }

  test("first start creates the config, serves the API and records the port for mcp", async () => {
    const home = tempHome(false);
    const { handle, out } = await serve(home);
    const config = readConfig(home)!;
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    expect(config.port).toBe(handle.port);
    expect(out.join("\n")).toContain("設定ファイルを作成しました");
    expect(out.join("\n")).toContain(`http://192.168.1.10:${handle.port}`);
    expect(out.join("\n")).not.toContain(config.agent_token);
    expect(existsSync(dbPath(home))).toBe(true);

    expect(await (await fetch(`${handle.url}/healthz`)).json()).toEqual({ ok: true, version: "0.2.0" });
    const created = await fetch(`${handle.url}/v1/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.agent_token}` },
      body: JSON.stringify({ question: "q" }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).delivery).toEqual({ paired_devices: 0, websocket_delivered: 0, push_attempted: 0 });
    const wrong = await fetch(`${handle.url}/v1/requests`, { method: "POST", headers: { authorization: "Bearer ka_wrong" }, body: "{}" });
    expect(wrong.status).toBe(401);
  });

  test("pair / devices / revoke / status work while serve is running", async () => {
    const home = tempHome();
    const { handle } = await serve(home);
    const pairing = cli(home, { fetch });
    expect(await pairing.run("pair")).toBe(0);
    // the test server is bound to loopback, which a phone cannot reach: pair says so (and nothing else)
    expect(pairing.err).toHaveLength(1);
    expect(pairing.err[0]).toContain("127.0.0.1 にバインド");
    const uri = pairing.out.find((l) => l.startsWith("ペアリングURI"))!.split(": ")[1]!;
    expect(uri).toContain(`url=http%3A%2F%2F192.168.1.10%3A${handle.port}&code=`);
    const code = new URL(uri).searchParams.get("code")!;

    const paired = await fetch(`${handle.url}/v1/pair`, { method: "POST", body: JSON.stringify({ code, device_name: "iPhone 16", platform: "ios" }) });
    expect(paired.status).toBe(201);
    const { device, device_token } = (await paired.json()) as any;
    const auth = { authorization: `Bearer ${device_token}` };
    expect((await fetch(`${handle.url}/v1/requests`, { headers: auth })).status).toBe(200);

    const list = cli(home);
    await list.run("devices");
    expect(list.out.join("\n")).toContain(device.id);

    const status = cli(home, { fetch });
    await status.run("status");
    expect(status.out.join("\n")).toContain("起動中");
    expect(status.out.join("\n")).toMatch(/devices\s*: 1 台/);

    const revoke = cli(home);
    expect(await revoke.run("revoke", device.id)).toBe(0);
    expect((await fetch(`${handle.url}/v1/requests`, { headers: auth })).status).toBe(401);
  });

  test("serve --public-url is what pair hands out", async () => {
    const home = tempHome();
    await serve(home, { publicUrl: "http://my-mac.local:8787/" });
    const pairing = cli(home, { fetch });
    await pairing.run("pair");
    expect(pairing.out.join("\n")).toContain("url=http%3A%2F%2Fmy-mac.local%3A8787&code=");
    const explicit = cli(home, { fetch });
    await explicit.run("pair", "--public-url", "http://10.1.2.3:8787");
    expect(explicit.out.join("\n")).toContain("url=http%3A%2F%2F10.1.2.3%3A8787&code=");
  });

  test("stop shuts the server down and removes serve.json", async () => {
    const home = tempHome();
    const { handle } = await serve(home);
    expect(existsSync(join(home, "serve.json"))).toBe(true);
    handles.splice(handles.indexOf(handle), 1);
    await handle.stop();
    expect(existsSync(join(home, "serve.json"))).toBe(false);
    await expect(fetch(`${handle.url}/healthz`)).rejects.toThrow();
  });

  test("a port that is already in use is reported", async () => {
    const home = tempHome();
    const { handle } = await serve(home);
    const other = cli(tempHome());
    await expect(startServe({ host: "127.0.0.1", port: handle.port }, other.deps)).rejects.toThrow("サーバーを起動できませんでした");
  });

  test("push credentials in config.json enable push; broken ones only warn", async () => {
    const home = tempHome();
    loadOrCreateConfig(home);
    const raw = JSON.parse(readFileSync(configPath(home), "utf8"));
    writeFileSync(configPath(home), JSON.stringify({ ...raw, apns: { key_path: join(home, "missing.p8"), key_id: "K", team_id: "T" } }));
    const { out, err, handle } = await serve(home);
    expect(err.join("\n")).toContain("APNs disabled");
    expect(out.join("\n")).toContain("APNs 無効");
    expect((await fetch(`${handle.url}/healthz`)).status).toBe(200);
  });
});
