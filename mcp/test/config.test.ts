import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampWaitSeconds, ConfigError, defaultWaitSeconds, oyobidashiHome, resolveConnection } from "../src/config.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oyobidashi-mcp-test-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(content: unknown, dir = home): void {
  writeFileSync(join(dir, "config.json"), typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });
}

function expectConfigError(fn: () => unknown, code: string, pattern: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as ConfigError).code).toBe(code as ConfigError["code"]);
  expect((thrown as ConfigError).message).toMatch(pattern);
}

describe("resolveConnection", () => {
  test("reads port and agent_token from $OYOBIDASHI_HOME/config.json", () => {
    writeConfig({
      port: 9911,
      agent_token: "ka_from_file",
      apns: { key_path: "/x.p8", key_id: "K", team_id: "T", bundle_id: "io.github.yusukeiwaki.oyobidashi" },
      some_future_field: true,
    });
    const c = resolveConnection({ OYOBIDASHI_HOME: home });
    expect(c.baseUrl).toBe("http://127.0.0.1:9911");
    expect(c.agentToken).toBe("ka_from_file");
    expect(c.source).toEqual({ baseUrl: "config", agentToken: "config" });
    expect(c.configPath).toBe(join(home, "config.json"));
  });

  test("environment variables win over the config file", () => {
    writeConfig({ port: 9911, agent_token: "ka_from_file" });
    const c = resolveConnection({ OYOBIDASHI_HOME: home, OYOBIDASHI_RELAY_URL: "http://127.0.0.1:1234", OYOBIDASHI_AGENT_TOKEN: "ka_from_env" });
    expect(c.baseUrl).toBe("http://127.0.0.1:1234");
    expect(c.agentToken).toBe("ka_from_env");
    expect(c.source).toEqual({ baseUrl: "env", agentToken: "env" });
  });

  test("with both env vars set the config file is not needed (missing or even malformed)", () => {
    const env = { OYOBIDASHI_HOME: home, OYOBIDASHI_RELAY_URL: "http://localhost:1", OYOBIDASHI_AGENT_TOKEN: "ka_env" };
    expect(resolveConnection(env).agentToken).toBe("ka_env");
    writeConfig("{ this is not json");
    expect(resolveConnection(env).baseUrl).toBe("http://localhost:1");
  });

  test("only OYOBIDASHI_RELAY_URL set: token comes from the file", () => {
    writeConfig({ port: 9911, agent_token: "ka_from_file" });
    const c = resolveConnection({ OYOBIDASHI_HOME: home, OYOBIDASHI_RELAY_URL: "http://10.0.0.5:8787/" });
    expect(c.baseUrl).toBe("http://10.0.0.5:8787");
    expect(c.agentToken).toBe("ka_from_file");
    expect(c.source).toEqual({ baseUrl: "env", agentToken: "config" });
  });

  test("only OYOBIDASHI_AGENT_TOKEN set: URL comes from the file's port", () => {
    writeConfig({ port: 9911, agent_token: "ka_from_file" });
    const c = resolveConnection({ OYOBIDASHI_HOME: home, OYOBIDASHI_AGENT_TOKEN: "ka_env" });
    expect(c.baseUrl).toBe("http://127.0.0.1:9911");
    expect(c.agentToken).toBe("ka_env");
    expect(c.source).toEqual({ baseUrl: "config", agentToken: "env" });
  });

  test("only OYOBIDASHI_AGENT_TOKEN set and no file: default port 8787", () => {
    const c = resolveConnection({ OYOBIDASHI_HOME: home, OYOBIDASHI_AGENT_TOKEN: "ka_env" });
    expect(c.baseUrl).toBe("http://127.0.0.1:8787");
  });

  test("config without port falls back to 8787", () => {
    writeConfig({ agent_token: "ka_from_file" });
    expect(resolveConnection({ OYOBIDASHI_HOME: home }).baseUrl).toBe("http://127.0.0.1:8787");
  });

  test("empty / whitespace env vars count as unset", () => {
    writeConfig({ port: 9911, agent_token: "ka_from_file" });
    const c = resolveConnection({ OYOBIDASHI_HOME: home, OYOBIDASHI_RELAY_URL: "", OYOBIDASHI_AGENT_TOKEN: "   " });
    expect(c.baseUrl).toBe("http://127.0.0.1:9911");
    expect(c.agentToken).toBe("ka_from_file");
  });

  test("trailing slashes are stripped and a path prefix is kept", () => {
    const c = resolveConnection({ OYOBIDASHI_HOME: home, OYOBIDASHI_RELAY_URL: "http://127.0.0.1:8787/prefix//", OYOBIDASHI_AGENT_TOKEN: "t" });
    expect(c.baseUrl).toBe("http://127.0.0.1:8787/prefix");
  });

  test("default home is ~/.oyobidashi", () => {
    expect(oyobidashiHome({}, () => "/Users/someone")).toBe("/Users/someone/.oyobidashi");
    writeConfig({ port: 4321, agent_token: "ka_home" }, (mkdirSync(join(home, ".oyobidashi")), join(home, ".oyobidashi")));
    const c = resolveConnection({}, () => home);
    expect(c.baseUrl).toBe("http://127.0.0.1:4321");
    expect(c.agentToken).toBe("ka_home");
  });

  test("the file is re-read on every call (relay started later)", () => {
    const env = { OYOBIDASHI_HOME: home };
    expect(() => resolveConnection(env)).toThrow(ConfigError);
    writeConfig({ port: 5555, agent_token: "ka_late" });
    expect(resolveConnection(env).agentToken).toBe("ka_late");
    writeConfig({ port: 5556, agent_token: "ka_rotated" });
    expect(resolveConnection(env)).toMatchObject({ baseUrl: "http://127.0.0.1:5556", agentToken: "ka_rotated" });
  });

  describe("failures", () => {
    test("missing config file and no env → config_missing with how to fix it", () => {
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_missing", /does not exist/);
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_missing", /cd relay && bun run serve/);
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_missing", /OYOBIDASHI_AGENT_TOKEN/);
    });

    test("missing OYOBIDASHI_HOME directory entirely", () => {
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: join(home, "nope", "deeper") }), "config_missing", /does not exist/);
    });

    test("URL from env but no token anywhere", () => {
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home, OYOBIDASHI_RELAY_URL: "http://127.0.0.1:1" }), "config_missing", /agent token/);
    });

    test("config without agent_token", () => {
      writeConfig({ port: 8787 });
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_missing", /has no "agent_token"/);
      writeConfig({ port: 8787, agent_token: null });
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_missing", /has no "agent_token"/);
    });

    test.each([
      ["truncated JSON", '{ "port": 8787, "agent_'],
      ["empty file", ""],
      ["HTML", "<html></html>"],
    ])("malformed config (%s) → config_invalid", (_name, content) => {
      writeConfig(content);
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_invalid", /not valid JSON/);
    });

    test.each([
      ["array", "[]"],
      ["string", '"ka_x"'],
      ["null", "null"],
    ])("config that is JSON but not an object (%s) → config_invalid", (_name, content) => {
      writeConfig(content);
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_invalid", /must be a JSON object/);
    });

    test.each([["8787"], [0], [70000], [80.5], [-1]])("invalid port %p → config_invalid", (port) => {
      writeConfig({ port, agent_token: "ka_x" });
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_invalid", /invalid "port"/);
    });

    test.each([[123], [""], ["   "], [{}]])("invalid agent_token %p → config_invalid", (agent_token) => {
      writeConfig({ port: 8787, agent_token });
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_invalid", /invalid "agent_token"/);
    });

    test("config.json that is a directory → config_invalid", () => {
      mkdirSync(join(home, "config.json"));
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_invalid", /Cannot read/);
    });

    test("unreadable config.json → config_invalid mentioning permissions", () => {
      if (process.getuid?.() === 0) return; // root can read anything
      writeConfig({ port: 8787, agent_token: "ka_x" });
      chmodSync(join(home, "config.json"), 0o000);
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home }), "config_invalid", /permissions/);
    });

    test.each([["not a url"], ["127.0.0.1:8787"], ["ftp://127.0.0.1"], ["ws://127.0.0.1:8787"]])("invalid OYOBIDASHI_RELAY_URL %p → config_invalid", (url) => {
      expectConfigError(() => resolveConnection({ OYOBIDASHI_HOME: home, OYOBIDASHI_RELAY_URL: url, OYOBIDASHI_AGENT_TOKEN: "t" }), "config_invalid", /OYOBIDASHI_RELAY_URL/);
    });
  });
});

describe("wait seconds", () => {
  test("clampWaitSeconds keeps 0-3600, floors, clamps", () => {
    expect(clampWaitSeconds(0)).toBe(0);
    expect(clampWaitSeconds(50)).toBe(50);
    expect(clampWaitSeconds(3600)).toBe(3600);
    expect(clampWaitSeconds(3601)).toBe(3600);
    expect(clampWaitSeconds(1e12)).toBe(3600);
    expect(clampWaitSeconds(-1)).toBe(0);
    expect(clampWaitSeconds(12.9)).toBe(12);
    expect(clampWaitSeconds(Infinity)).toBe(3600);
    expect(clampWaitSeconds(-Infinity)).toBe(0);
    expect(clampWaitSeconds(NaN)).toBe(0);
  });

  test("defaultWaitSeconds: 50 unless OYOBIDASHI_DEFAULT_WAIT_SECONDS is a number", () => {
    expect(defaultWaitSeconds({})).toBe(50);
    expect(defaultWaitSeconds({ OYOBIDASHI_DEFAULT_WAIT_SECONDS: "" })).toBe(50);
    expect(defaultWaitSeconds({ OYOBIDASHI_DEFAULT_WAIT_SECONDS: "120" })).toBe(120);
    expect(defaultWaitSeconds({ OYOBIDASHI_DEFAULT_WAIT_SECONDS: "0" })).toBe(0);
    expect(defaultWaitSeconds({ OYOBIDASHI_DEFAULT_WAIT_SECONDS: "99999" })).toBe(3600);
    expect(defaultWaitSeconds({ OYOBIDASHI_DEFAULT_WAIT_SECONDS: "-5" })).toBe(0);
  });

  test("defaultWaitSeconds warns and falls back on garbage", () => {
    const warnings: string[] = [];
    expect(defaultWaitSeconds({ OYOBIDASHI_DEFAULT_WAIT_SECONDS: "soon" }, (m) => warnings.push(m))).toBe(50);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OYOBIDASHI_DEFAULT_WAIT_SECONDS");
  });
});
