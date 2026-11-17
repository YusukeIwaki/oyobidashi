export type CloudConfig = ReturnType<typeof cloudConfig>;
export function cloudConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const required = (key: string) => {
    const v = env[key]?.trim();
    if (!v) throw new Error(`${key} is required`);
    return v;
  };
  const num = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max)
      throw new Error(`${key} must be between ${min} and ${max}`);
    return n;
  };
  const databaseUrl = required("DATABASE_URL");
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl))
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  const redisUrl = required("REDIS_URL");
  if (!/^rediss?:\/\//.test(redisUrl))
    throw new Error("REDIS_URL must be a Redis URL");
  let publicUrl: string | undefined;
  if (env.PUBLIC_URL) {
    try {
      const u = new URL(env.PUBLIC_URL);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/"
      )
        throw new Error();
      publicUrl = u.origin;
    } catch {
      throw new Error("PUBLIC_URL must be an HTTPS origin");
    }
  }
  return {
    databaseUrl,
    redisUrl,
    projectId: required("FIREBASE_PROJECT_ID"),
    port: num("PORT", 8787, 0, 65535),
    dbPool: num("DB_POOL_SIZE", 10, 2, 100),
    turnConcurrency: num("TURN_CONCURRENCY", 8, 1, 128),
    pushConcurrency: num("PUSH_CONCURRENCY", 4, 1, 64),
    maxSockets: num("MAX_SOCKETS", 10_000, 1, 100_000),
    ...(publicUrl ? { publicUrl } : {}),
  };
}
