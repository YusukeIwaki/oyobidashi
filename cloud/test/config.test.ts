import { describe, expect, test } from "bun:test";
import { cloudConfig } from "../src/config.ts";

const base = () => ({
  DATABASE_URL: "postgres://test-user:test-password@localhost:5432/oyobidashi",
  REDIS_URL: "redis://localhost:6379",
  FIREBASE_PROJECT_ID: "test-project",
});

describe("cloud configuration", () => {
  test("defaults bound connection pools, worker concurrency and socket counts", () => {
    expect(cloudConfig(base())).toEqual({
      ...{
        databaseUrl: base().DATABASE_URL,
        redisUrl: base().REDIS_URL,
        projectId: base().FIREBASE_PROJECT_ID,
      },
      port: 8787,
      dbPool: 10,
      turnConcurrency: 8,
      pushConcurrency: 4,
      maxSockets: 10_000,
    });
  });
  test("supports explicit resource bounds and ephemeral local ports", () => {
    expect(
      cloudConfig({
        ...base(),
        PORT: "0",
        DB_POOL_SIZE: "2",
        TURN_CONCURRENCY: "1",
        PUSH_CONCURRENCY: "1",
        MAX_SOCKETS: "1",
      }),
    ).toMatchObject({
      port: 0,
      dbPool: 2,
      turnConcurrency: 1,
      pushConcurrency: 1,
      maxSockets: 1,
    });
    expect(
      cloudConfig({
        ...base(),
        PORT: "65535",
        DB_POOL_SIZE: "100",
        TURN_CONCURRENCY: "128",
        PUSH_CONCURRENCY: "64",
        MAX_SOCKETS: "100000",
      }),
    ).toMatchObject({
      port: 65535,
      dbPool: 100,
      turnConcurrency: 128,
      pushConcurrency: 64,
      maxSockets: 100_000,
    });
  });
  test("connection schemes support PostgreSQL aliases and TLS Redis", () => {
    expect(
      cloudConfig({
        ...base(),
        DATABASE_URL: "postgresql://localhost/db",
        REDIS_URL: "rediss://cache.example:6380",
      }),
    ).toMatchObject({
      databaseUrl: "postgresql://localhost/db",
      redisUrl: "rediss://cache.example:6380",
    });
  });
  test.each(["DATABASE_URL", "REDIS_URL", "FIREBASE_PROJECT_ID"])(
    "%s is required and cannot be blank",
    (key) => {
      for (const value of [undefined, "", " \t "]) {
        expect(() => cloudConfig({ ...base(), [key]: value })).toThrow(
          `${key} is required`,
        );
      }
    },
  );
  test.each(["http://host/db", "mysql://host/db", "not-a-url"])(
    "wrong database URL scheme is rejected: %s",
    (value) => {
      expect(() => cloudConfig({ ...base(), DATABASE_URL: value })).toThrow(
        "DATABASE_URL must be a PostgreSQL URL",
      );
    },
  );
  test.each(["http://cache", "postgres://cache", "not-a-url"])(
    "wrong Redis URL scheme is rejected: %s",
    (value) => {
      expect(() => cloudConfig({ ...base(), REDIS_URL: value })).toThrow(
        "REDIS_URL must be a Redis URL",
      );
    },
  );
  for (const [key, min, max] of [
    ["PORT", 0, 65535],
    ["DB_POOL_SIZE", 2, 100],
    ["TURN_CONCURRENCY", 1, 128],
    ["PUSH_CONCURRENCY", 1, 64],
    ["MAX_SOCKETS", 1, 100000],
  ] as const) {
    test.each([
      "",
      " ",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      "1e2",
      "0x10",
      "1_000",
      "9007199254740993",
      String(max + 1),
    ])(`${key} rejects invalid numeric value %s`, (value) => {
      expect(() => cloudConfig({ ...base(), [key]: value })).toThrow(
        `${key} must be between ${min} and ${max}`,
      );
    });
    if (min > 0)
      test(`${key} rejects below-minimum input`, () =>
        expect(() =>
          cloudConfig({ ...base(), [key]: String(min - 1) }),
        ).toThrow());
  }
  test("errors name configuration keys without including credential values", () => {
    for (const values of [
      { DATABASE_URL: "https://SECRET_PASSWORD@host" },
      { REDIS_URL: "https://SECRET_PASSWORD@host" },
    ]) {
      try {
        cloudConfig({ ...base(), ...values });
        throw new Error("expected configuration rejection");
      } catch (error) {
        expect((error as Error).message).not.toContain("SECRET");
      }
    }
  });
  test("required string values are trimmed", () => {
    expect(
      cloudConfig({
        ...base(),
        FIREBASE_PROJECT_ID: " test-project ",
        DATABASE_URL: ` ${base().DATABASE_URL} `,
        REDIS_URL: ` ${base().REDIS_URL} `,
      }),
    ).toMatchObject({
      projectId: "test-project",
      databaseUrl: base().DATABASE_URL,
      redisUrl: base().REDIS_URL,
    });
  });
});
