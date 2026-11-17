import { describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { RedisWakeBus } from "../src/bus.ts";
import { hash } from "../src/service.ts";
import { harness } from "./helpers.ts";

async function until(check: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("bus did not recover in time");
    await Bun.sleep(20);
  }
}
describe.skipIf(!process.env.CLOUD_TEST_REDIS_URL)(
  "real Redis wake transport",
  () => {
    test("separate gateways receive only hashed routing hints, unsubscribe and close cleanly", async () => {
      const url = process.env.CLOUD_TEST_REDIS_URL!,
        a = new RedisWakeBus(url),
        b = new RedisWakeBus(url);
      const messages: string[] = [];
      try {
        const unsubscribe = await b.subscribe((v) => messages.push(v));
        await a.publish("synthetic-private-uid");
        await until(() => messages.length === 1);
        expect(messages).toEqual([hash("synthetic-private-uid")]);
        expect(messages[0]).not.toContain("private");
        unsubscribe();
        await a.publish("another-uid");
        await Bun.sleep(20);
        expect(messages).toHaveLength(1);
      } finally {
        a.close();
        b.close();
      }
    });
    test("a forcibly severed subscriber connection resubscribes and resumes delivery", async () => {
      const url = process.env.CLOUD_TEST_REDIS_URL!,
        publisher = new RedisWakeBus(url),
        subscriber = new RedisWakeBus(url),
        control = new RedisClient(url);
      const received: string[] = [];
      try {
        await subscriber.subscribe((v) => received.push(v));
        await publisher.publish("before-disconnect");
        await until(() => received.length === 1);
        // This URL is exclusively the disposable test Redis; kill subscriber TCP
        // sessions to reproduce restart/network loss, without stopping shared apps.
        await control.send("CLIENT", ["KILL", "TYPE", "PUBSUB"]);
        const end = Date.now() + 6000;
        while (
          !received.includes(hash("after-disconnect")) &&
          Date.now() < end
        ) {
          await Bun.sleep(250);
          await publisher.publish("after-disconnect");
        }
        expect(received).toContain(hash("after-disconnect"));
      } finally {
        publisher.close();
        subscriber.close();
        control.close();
      }
    }, 10_000);
  },
);
test("Redis unavailable cannot roll back an accepted question or retain a worker slot", async () => {
  const bus = new RedisWakeBus("redis://127.0.0.1:1"),
    h = harness();
  try {
    await bus.subscribe(() => {});
    h.service.bus.publish = (uid) => bus.publish(uid);
    const response = await h.call("POST", "/v1/requests", "agent-alice", {
      question: "durable despite Redis outage",
    });
    expect(response.status).toBe(201);
    await h.service.wake("alice");
    expect(
      (await h.call("GET", `/v1/requests/${response.body.request.id}`)).body
        .request.status,
    ).toBe("pending");
  } finally {
    bus.close();
    h.app.close();
  }
});
