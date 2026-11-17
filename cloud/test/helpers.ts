import { CloudApp } from "../src/app.ts";
import { LocalWakeBus } from "../src/bus.ts";
import { CloudService, hash, type Principal } from "../src/service.ts";
import { unauthorized } from "../src/errors.ts";
import type { Database, Turn } from "../src/types.ts";
import { MemoryDatabase } from "./memory.ts";

export function harness(database: Database = new MemoryDatabase()) {
  const clock = { now: Date.now() };
  const bus = new LocalWakeBus(),
    service = new CloudService(database, bus, () => clock.now);
  const verifier = {
    async verify(token: string) {
      if (!token.startsWith("agent-")) throw unauthorized();
      return token.slice(6);
    },
  };
  const app = new CloudApp(service, verifier);
  const call = async (
    method: string,
    path: string,
    token: string | null = "agent-alice",
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = (await app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    ))!;
    return {
      status: response.status,
      body: response.status === 204 ? null : ((await response.json()) as any),
    };
  };
  const pair = async (uid = "alice", platform = "ios") => {
    const code = await call("POST", "/v1/pairing-codes", `agent-${uid}`);
    return (
      await call("POST", "/v1/pair", null, {
        code: code.body.code,
        device_name: "phone",
        platform,
      })
    ).body as { device: { id: string }; device_token: string };
  };
  const setup = async (uid = "alice") => {
    const d = await pair(uid);
    const r = await call("POST", "/v1/requests", `agent-${uid}`, {
      question: "進めますか？",
      priority: "high",
      delivery_mode: "call",
    });
    const id = r.body.request.id as string;
    await call("POST", `/v1/requests/${id}/call`, d.device_token, {
      event: "answer",
    });
    return {
      id,
      d,
      turn: async (text = "はい", turnId = crypto.randomUUID()) => {
        const response = await call(
          "POST",
          `/v1/requests/${id}/call`,
          d.device_token,
          { event: "turn", text, turn_id: turnId, async: true },
        );
        return { ...response, turnId };
      },
    };
  };
  return {
    db: database,
    clock,
    bus,
    service,
    app,
    call,
    pair,
    setup,
    advance(ms: number) {
      clock.now += ms;
      if (database instanceof MemoryDatabase) database.now = clock.now;
    },
    principal(uid = "alice"): Principal {
      return { uid, role: "agent" };
    },
    async turn(id: string, uid = "alice") {
      return database.transaction(uid, (tx) =>
        tx.get("turn", id),
      ) as Promise<Turn | null>;
    },
    async devicePrincipal(token: string): Promise<Principal> {
      const found = await database.findDevice(hash(token));
      if (!found) throw unauthorized();
      return {
        uid: found.uid,
        role: "device",
        deviceId: found.device.id,
        tokenHash: hash(token),
      };
    },
  };
}
