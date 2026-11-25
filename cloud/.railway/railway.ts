import {
  defineRailway,
  github,
  postgres,
  project,
  redis,
  service,
  volume,
  type BuildConfig,
} from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "asia-southeast1-eqsg3a" });
  Postgres.deploy = {
    limitOverride: { containers: { cpu: 0.5, memoryBytes: 1_000_000_000 } },
  };
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const Redis = redis("Redis", { region: "asia-southeast1-eqsg3a" });
  Redis.deploy = {
    limitOverride: { containers: { cpu: 1, memoryBytes: 4_000_000_000 } },
    startCommand:
      '/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"',
  };
  Redis.networking = { privateNetworkEndpoint: "redis" };
  const redisVolume = volume("redis-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "asia-southeast1-eqsg3a",
    sizeMB: 5000,
  });
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "asia-southeast1-eqsg3a",
    sizeMB: 5000,
  });
  const cloudSource = github("YusukeIwaki/oyobidashi", { branch: "main" });
  // APIとworkerは同じイメージを使い、Dockerfileが取り込む変更で再ビルドする。
  const cloudBuild: BuildConfig = {
    buildEnvironment: "V3",
    builder: "DOCKERFILE",
    dockerfilePath: "Dockerfile.cloud",
    watchPatterns: [
      "cloud/src/**",
      "cloud/package.json",
      "cloud/bun.lock",
      "mcp/src/**",
      "mcp/package.json",
      "mcp/bun.lock",
      "relay/src/**",
      "Dockerfile.cloud",
      ".dockerignore",
    ],
  };
  const api = service("api", {
    source: cloudSource,
    build: cloudBuild,
    start: "bun run cloud/src/main.ts api",
    healthcheck: "/readyz",
    healthcheckTimeout: 120,
    preDeploy: "bun run cloud/src/main.ts migrate",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 2_000_000_000 } },
      sleepApplication: true,
      drainingSeconds: 60,
      overlapSeconds: 5,
      restartPolicyMaxRetries: 5,
    },
  });
  const worker = service("worker", {
    source: cloudSource,
    build: cloudBuild,
    start: "bun run cloud/src/main.ts worker",
    healthcheck: "/readyz",
    healthcheckTimeout: 120,
    preDeploy: "bun run cloud/src/main.ts migrate",
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: {
      limitOverride: { containers: { cpu: 2, memoryBytes: 2_000_000_000 } },
      drainingSeconds: 60,
      overlapSeconds: 5,
      restartPolicyMaxRetries: 5,
    },
  });
  // 製品サイト (site/)。Astroの静的出力をCaddyで配信する。秘密の変数は不要。
  // mainへのpushでRailwayが自動デプロイする。サイトに関係する変更だけを対象にする。
  const site = service("site", {
    source: github("YusukeIwaki/oyobidashi", { branch: "main" }),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile.site",
      watchPatterns: ["site/**", "Dockerfile.site", ".dockerignore"],
    },
    healthcheck: "/",
    healthcheckTimeout: 60,
    replicas: { "asia-southeast1-eqsg3a": 1 },
    deploy: {
      restartPolicyMaxRetries: 5,
    },
  });

  // CLI 5.74 supports variable ownership; SDK 3.17 has not typed it yet.
  const configuration: Parameters<typeof project>[1] & {
    variables: { managed: false };
  } = {
    variables: { managed: false },
    resources: [Postgres, Redis, api, worker, site, redisVolume, postgresVolume],
  };
  return project("oyobidashi", configuration);
});
