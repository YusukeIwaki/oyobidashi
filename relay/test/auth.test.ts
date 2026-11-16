import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { Store } from "../src/db.ts";
import { AGENT_TOKEN, fixture, makeHarness, type Harness } from "./helpers.ts";

type Endpoint = [method: string, path: (id: string) => string, body?: unknown];

const AGENT_ONLY: Endpoint[] = [
  ["POST", () => "/v1/requests", { question: "q" }],
  ["POST", (id) => `/v1/requests/${id}/cancel`],
];
const DEVICE_ONLY: Endpoint[] = [
  ["GET", () => "/v1/requests"],
  ["POST", (id) => `/v1/requests/${id}/answer`, { text: "x" }],
  ["PUT", () => "/v1/devices/me", { device_name: "x" }],
  ["DELETE", () => "/v1/devices/me"],
  ["GET", () => "/v1/events"],
];
const SHARED: Endpoint[] = [["GET", (id) => `/v1/requests/${id}`]];
const AUTHENTICATED = [...AGENT_ONLY, ...DEVICE_ONLY, ...SHARED];
const PUBLIC: Endpoint[] = [
  ["GET", () => "/healthz"],
  ["POST", () => "/v1/pair", { code: "x", device_name: "d", platform: "ios" }],
];

async function setup(): Promise<{ h: Harness; id: string; deviceToken: string }> {
  const h = makeHarness();
  const { token } = await h.pair();
  const r = await h.ask();
  return { h, id: r.id, deviceToken: token };
}

describe("token authentication", () => {
  const badTokens: [string, Record<string, string>][] = [
    ["no Authorization header", {}],
    ["garbage token", { authorization: "Bearer garbage" }],
    ["empty bearer", { authorization: "Bearer " }],
    ["wrong scheme", { authorization: `Basic ${AGENT_TOKEN}` }],
    ["token without scheme", { authorization: AGENT_TOKEN }],
    ["token with trailing junk", { authorization: `Bearer ${AGENT_TOKEN} extra` }],
    ["prefix of the agent token", { authorization: `Bearer ${AGENT_TOKEN.slice(0, -1)}` }],
    ["well-formed but unknown device token", { authorization: "Bearer kd_Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4" }],
  ];
  for (const [name, headers] of badTokens) {
    for (const [method, path, body] of AUTHENTICATED) {
      test(`${name}: ${method} ${path("{id}")} → 401`, async () => {
        const { h, id } = await setup();
        const res = await h.json(method, path(id), { headers, body });
        expect(res.status).toBe(401);
        expect(res.body).toEqual(fixture("error_unauthorized.json"));
      });
    }
  }

  test("a token in the URL query is not accepted", async () => {
    const { h, id, deviceToken } = await setup();
    for (const t of [AGENT_TOKEN, deviceToken]) {
      const res = await h.json("GET", `/v1/requests/${id}?token=${t}&access_token=${t}`);
      expect(res.status).toBe(401);
    }
  });

  test("the Bearer scheme is case-insensitive", async () => {
    const { h, id } = await setup();
    const res = await h.json("GET", `/v1/requests/${id}`, { headers: { authorization: `bearer ${AGENT_TOKEN}` } });
    expect(res.status).toBe(200);
  });

  test("a revoked device token → 401 on every device endpoint", async () => {
    const { h, id, deviceToken } = await setup();
    expect((await h.call("DELETE", "/v1/devices/me", { token: deviceToken })).status).toBe(204);
    for (const [method, path, body] of [...DEVICE_ONLY, ...SHARED]) {
      const res = await h.json(method, path(id), { token: deviceToken, body });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(fixture("error_unauthorized.json"));
    }
  });

  test("a device revoked directly in the DB (CLI revoke) → 401", async () => {
    const h = makeHarness();
    const { token, device } = await h.pair();
    h.store.deleteDevice(device.id);
    expect((await h.json("GET", "/v1/requests", { token })).status).toBe(401);
  });
});

describe("roles", () => {
  for (const [method, path, body] of AGENT_ONLY) {
    test(`device token on agent API ${method} ${path("{id}")} → 403`, async () => {
      const { h, id, deviceToken } = await setup();
      const res = await h.json(method, path(id), { token: deviceToken, body });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      expect(h.store.getRequest(id)!.status).toBe("pending");
    });
  }
  for (const [method, path, body] of DEVICE_ONLY) {
    test(`agent token on device API ${method} ${path("{id}")} → 403`, async () => {
      const { h, id } = await setup();
      const res = await h.json(method, path(id), { token: AGENT_TOKEN, body });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      expect(h.store.getRequest(id)!.status).toBe("pending");
    });
  }
});

describe("forwarded headers (proxy / tunnel) are refused on every endpoint", () => {
  for (const header of ["x-forwarded-for", "X-Forwarded-Host"]) {
    for (const [method, path, body] of [...AUTHENTICATED, ...PUBLIC]) {
      test(`${header} on ${method} ${path("{id}")} → 403`, async () => {
        const { h, id, deviceToken } = await setup();
        for (const token of [AGENT_TOKEN, deviceToken, null]) {
          const res = await h.json(method, path(id), { token, body, headers: { [header]: "127.0.0.1" } });
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe("forbidden");
        }
        expect(h.store.listRequests(null, 10)).toHaveLength(1);
        expect(h.store.getRequest(id)!.status).toBe("pending");
      });
    }
  }

  test("an empty forwarded header still counts", async () => {
    const { h } = await setup();
    const res = await h.json("GET", "/healthz", { headers: { "x-forwarded-for": "" } });
    expect(res.status).toBe(403);
  });
});

describe("peer address", () => {
  const PUBLIC_PEERS = ["8.8.8.8", "203.0.113.7", "172.32.0.1", "11.0.0.1", "192.169.1.1", "100.64.0.1", "2001:db8::1", "::ffff:8.8.8.8"];
  const UNKNOWN_PEERS: (string | null)[] = [null, "", "garbage", "192.168.1", "192.168.1.5, 127.0.0.1"];
  const LAN_PEERS = ["192.168.1.5", "10.0.0.7", "172.16.0.9", "172.31.255.1", "169.254.3.4", "::ffff:192.168.1.5", "fe80::1c2d:3e4f:5a6b:7c8d", "fd00::5"];
  const LOOPBACK_PEERS = ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"];

  for (const peer of [...PUBLIC_PEERS, ...UNKNOWN_PEERS]) {
    test(`non-private peer ${JSON.stringify(peer)} → 403 on every endpoint incl. /healthz`, async () => {
      const { h, id, deviceToken } = await setup();
      h.peer = peer;
      for (const [method, path, body] of [...AUTHENTICATED, ...PUBLIC]) {
        for (const token of [AGENT_TOKEN, deviceToken, null]) {
          const res = await h.json(method, path(id), { token, body });
          expect(res.status, `${method} ${path(id)}`).toBe(403);
          expect(res.body.error.code).toBe("forbidden");
        }
      }
      expect(h.store.listRequests(null, 10)).toHaveLength(1);
      expect(h.store.listDevices()).toHaveLength(1);
    });
  }

  for (const peer of LAN_PEERS) {
    test(`LAN peer ${peer}: device API works, agent API → 403 even with the agent token`, async () => {
      const { h, id, deviceToken } = await setup();
      h.peer = peer;
      expect((await h.json("GET", "/healthz")).status).toBe(200);
      expect((await h.json("GET", "/v1/requests", { token: deviceToken })).status).toBe(200);
      expect((await h.json("GET", `/v1/requests/${id}`, { token: deviceToken })).status).toBe(200);

      const create = await h.json("POST", "/v1/requests", { token: AGENT_TOKEN, body: { question: "q" } });
      expect(create.status).toBe(403);
      expect(create.body.error.code).toBe("forbidden");
      const get = await h.json("GET", `/v1/requests/${id}?wait=5`, { token: AGENT_TOKEN });
      expect(get.status).toBe(403);
      const cancel = await h.json("POST", `/v1/requests/${id}/cancel`, { token: AGENT_TOKEN });
      expect(cancel.status).toBe(403);
      // the loopback check comes before the token check: nothing about the token leaks to the LAN
      expect((await h.json("POST", "/v1/requests", { token: "wrong", body: { question: "q" } })).status).toBe(403);
      expect((await h.json("POST", "/v1/requests", { body: { question: "q" } })).status).toBe(403);
      expect(h.app.waiterCount()).toBe(0);
      expect(h.store.listRequests(null, 10)).toHaveLength(1);

      const answer = await h.json("POST", `/v1/requests/${id}/answer`, { token: deviceToken, body: { text: "ok" } });
      expect(answer.status).toBe(200);
      const paired = await h.pair();
      expect(paired.token).toStartWith("kd_");
    });
  }

  for (const peer of LOOPBACK_PEERS) {
    test(`loopback peer ${peer}: agent API works`, async () => {
      const { h, id } = await setup();
      h.peer = peer;
      expect((await h.agent("POST", "/v1/requests", { question: "q" })).status).toBe(201);
      expect((await h.agent("GET", `/v1/requests/${id}`)).status).toBe(200);
      expect((await h.agent("POST", `/v1/requests/${id}/cancel`)).status).toBe(200);
    });
  }

  test("the default peer source is the socket address from the server, never a header", async () => {
    const store = new Store(":memory:");
    const app = createApp({ store, agentToken: AGENT_TOKEN, logger: { warn() {} } });
    const server = (address: string | null) => ({
      upgrade: () => false,
      timeout: () => {},
      requestIP: () => (address === null ? null : { address }),
    });
    const post = (headers: Record<string, string> = {}) =>
      new Request("http://relay.test/v1/requests", {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT_TOKEN}`, ...headers },
        body: JSON.stringify({ question: "q" }),
      });
    expect((await app.fetch(post(), server("127.0.0.1")))!.status).toBe(201);
    expect((await app.fetch(post(), server("::ffff:127.0.0.1")))!.status).toBe(201);
    expect((await app.fetch(post(), server("192.168.1.5")))!.status).toBe(403);
    expect((await app.fetch(post(), server("8.8.8.8")))!.status).toBe(403);
    expect((await app.fetch(post(), server(null)))!.status).toBe(403);
    // without a server there is no socket address at all → refused
    expect((await app.fetch(post()))!.status).toBe(403);
    // headers claiming to be local do not help a public peer
    const spoof = { "x-real-ip": "127.0.0.1", forwarded: "for=127.0.0.1", "x-client-ip": "127.0.0.1" };
    expect((await app.fetch(post(spoof), server("8.8.8.8")))!.status).toBe(403);
    expect((await app.fetch(post(spoof), server("192.168.1.5")))!.status).toBe(403);
    expect(store.listRequests(null, 10)).toHaveLength(2);
  });
});
