import { CloudApp, type SocketData } from "./app.ts";
import { firebaseVerifier } from "./auth.ts";
import { RedisWakeBus } from "./bus.ts";
import { cloudConfig, OFFICIAL_CLOUD_ORIGIN, requiresVoiceProof } from "./config.ts";
import { PostgresDatabase } from "./postgres.ts";
import { configuredConversations, voiceModels } from "./provider.ts";
import { CloudService } from "./service.ts";
import { JobWorker, WorkerPool } from "./worker.ts";
import { Maintenance } from "./maintenance.ts";
import { MAX_WS_SNAPSHOT_BYTES } from "./app.ts";
import { loadPushConfig } from "./push-config.ts";
import { createAccountAuth } from "./account-auth.ts";
import { PostgresOAuthStore } from "./oauth-postgres.ts";
import { loadMcpReviewAuth } from "./oauth-review.ts";
import { Billing, loadAppleSandboxReviewUids, loadBillingConfig, loadPlusGrantUids } from "./billing/service.ts";
import { ReviewPortal, loadAndroidReviewPortal, loadReviewPortal } from "./app-review.ts";
import { VoiceSecurity, loadVoiceConfig } from "./voice.ts";
import { createFcmProvider } from "../../relay/src/push/fcm.ts";
import {
  createApnsProvider,
  createHttp2ApnsTransport,
} from "../../relay/src/push/apns.ts";
import type { PushProviders } from "../../relay/src/push/types.ts";

async function providers(): Promise<PushProviders> {
  const push: PushProviders = {};
  const config = await loadPushConfig(process.env);
  if (config.fcm) {
    push.android = createFcmProvider({
      serviceAccount: config.fcm,
    });
    await (push.android as ReturnType<typeof createFcmProvider>).ready();
  }
  if (config.apns) {
    push.ios = createApnsProvider({
      ...config.apns,
      transport: createHttp2ApnsTransport(),
    });
    await (push.ios as ReturnType<typeof createApnsProvider>).ready();
  }
  return push;
}

export async function main(
  role = process.argv[2] ?? process.env.CLOUD_ROLE ?? "api",
) {
  if (!["api", "worker", "migrate"].includes(role))
    throw new Error("role must be api, worker or migrate");
  const config = cloudConfig();
  const official = config.publicUrl === OFFICIAL_CLOUD_ORIGIN;
  const mcpReview = role === "api" && official
    ? loadMcpReviewAuth(process.env.MCP_REVIEW_FIREBASE, config.projectId)
    : undefined;
  const models = voiceModels(process.env, official);
  const appleSandboxReviewUids = official ? loadAppleSandboxReviewUids(process.env) : null;
  const plusGrantUids = loadPlusGrantUids(process.env);
  const reviewPortal = role === "api" && appleSandboxReviewUids
    ? loadReviewPortal(process.env.APPLE_REVIEW_PORTAL, appleSandboxReviewUids)
    : undefined;
  const androidReviewPortal = role === "api" && official
    ? loadAndroidReviewPortal(process.env.ANDROID_REVIEW_PORTAL)
    : undefined;
  if (androidReviewPortal && appleSandboxReviewUids?.has(androidReviewPortal.uid))
    throw new Error("Android review must use its own dedicated UID");
  const voiceProofRequired = requiresVoiceProof(process.env, config.publicUrl);
  if (
    role === "worker" &&
    (process.env.APNS_KEY_PATH ||
      process.env.APNS_KEY_PEM ||
      process.env.FCM_SERVICE_ACCOUNT_PATH ||
      process.env.FCM_SERVICE_ACCOUNT_JSON) &&
    !config.publicUrl
  )
    throw new Error(
      "PUBLIC_URL is required for authenticated notification previews",
    );
  const db = new PostgresDatabase(config.databaseUrl, config.dbPool);
  await db.migrate();
  const oauthStore = new PostgresOAuthStore(db.sql);
  await oauthStore.migrate();
  if (role === "migrate") {
    await db.close();
    return;
  }
  const bus = new RedisWakeBus(config.redisUrl),
    service = new CloudService(db, bus);
  service.voiceTrainingPolicy = models.training;
  service.appleSandboxReviewUids = appleSandboxReviewUids;
  service.plusGrantUids = plusGrantUids;
  service.freeInputRestricted = models.freeInputRestricted;
  service.voiceProvider = models.provider;
  service.voiceProofRequired = voiceProofRequired;
  const timers: ReturnType<typeof setInterval>[] = [];
  let draining = false;
  const health = async () => {
    try {
      await db.health();
      return Response.json({ ok: true });
    } catch {
      return Response.json({ ok: false }, { status: 503 });
    }
  };
  const app =
    role === "api"
      ? new CloudApp(
          service,
          firebaseVerifier(config.projectId),
          config.maxSockets,
          await createAccountAuth(process.env),
          () => Bun.file(new URL("../public/auth.js", import.meta.url)).text(),
          {
            store: oauthStore,
            script: () =>
              Bun.file(new URL("../public/oauth.js", import.meta.url)).text(),
            ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
            ...(mcpReview ? { review: mcpReview } : {}),
            ...(official && process.env.OPENAI_APPS_CHALLENGE
              ? { openAiAppsChallenge: process.env.OPENAI_APPS_CHALLENGE }
              : {}),
          },
          official ? new Billing(service, loadBillingConfig(process.env)) : undefined,
          service.voiceProofRequired
            ? new VoiceSecurity(service, loadVoiceConfig(process.env))
            : undefined,
          reviewPortal ? new ReviewPortal(service, reviewPortal) : undefined,
          androidReviewPortal ? new ReviewPortal(service, androidReviewPortal, "android") : undefined,
        )
      : null;
  const conversations =
    role === "worker" ? configuredConversations(models) : undefined;
  const worker =
    role === "worker"
      ? new JobWorker(service, {
          ...(conversations ? { conversation: conversations.standard } : {}),
          ...(conversations?.free
            ? { freeConversation: conversations.free }
            : {}),
          push: await providers(),
          publicOrigin: config.publicUrl,
        })
      : null;
  if (role === "worker" && !conversations)
    console.warn(
      "[cloud] voice provider is unconfigured; text and notification delivery remain available",
    );
  const pool = worker
    ? new WorkerPool(worker, {
        turn: config.turnConcurrency,
        push: config.pushConcurrency,
      })
    : null;
  const server = Bun.serve<SocketData>({
    hostname: "0.0.0.0",
    port: config.port,
    // The handler returns the protocol's JSON 413 at 64KB; Bun is a larger backstop.
    maxRequestBodySize: 1024 * 1024,
    idleTimeout: 30,
    fetch: (req, srv) =>
      app
        ? app.fetch(req, srv)
        : new URL(req.url).pathname === "/readyz" ||
            new URL(req.url).pathname === "/healthz"
          ? health()
          : new Response(null, { status: 404 }),
    websocket: {
      open: (ws) => {
        void app?.open(ws);
      },
      message: (ws, m) => app?.message(ws, m),
      close: (ws) => app?.closeSocket(ws),
      maxPayloadLength: 1024,
      backpressureLimit: MAX_WS_SNAPSHOT_BYTES,
      closeOnBackpressureLimit: true,
      idleTimeout: 120,
      sendPings: false,
    },
    error: () =>
      Response.json(
        { error: { code: "temporarily_unavailable", message: "please retry" } },
        { status: 503 },
      ),
  });
  await bus
    .subscribe((digest) => {
      app?.onWake(digest);
      void pool?.tick().catch(() => {});
    })
    .catch(() => {
      console.warn("[cloud] Redis unavailable; database recovery is active");
    });
  if (app) {
    timers.push(
      setInterval(() => {
        void app.reconcileSockets();
      }, 5000),
    );
    timers.push(setInterval(() => app.ping(), 30_000));
  }
  if (pool) {
    timers.push(
      setInterval(() => {
        void pool.tick().catch(() => {});
      }, 1000),
    );
    await pool.tick();
  }
  const maintenance = new Maintenance(service);
  let cleanupAt = 0;
  timers.push(
    setInterval(() => {
      if (draining) return;
      void maintenance.tick().catch(() => {
        /* the next tick retries durable state */
      });
      if (Date.now() - cleanupAt >= 60_000) {
        cleanupAt = Date.now();
        void db.cleanup().catch(() => {});
        if (app) void oauthStore.cleanup(Date.now()).catch(() => {});
      }
    }, 1000),
  );
  const stop = async () => {
    if (draining) return;
    draining = true;
    for (const timer of timers) clearInterval(timer);
    app?.close();
    await server.stop(true);
    await pool?.stop();
    await maintenance.stop();
    bus.close();
    await db.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  console.info(`[cloud] ${role} ready on port ${server.port}`);
  return { server, app, pool, db, bus, stop };
}
if (import.meta.main)
  void main().catch(() => {
    console.error(
      "[cloud] startup failed; check configuration and infrastructure connectivity",
    );
    process.exit(1);
  });
