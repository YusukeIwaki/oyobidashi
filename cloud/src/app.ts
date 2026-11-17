import { authenticate, requireRole } from "./auth.ts";
import {
  CloudError,
  integer,
  invalid,
  json,
  missing,
  readBody,
  unavailable,
  unauthorized,
} from "./errors.ts";
import { CloudService, hash, type Principal } from "./service.ts";
import type { IdentityVerifier } from "./types.ts";
import {
  AUTH_PAGE,
  authPageHeaders,
  type AccountAuth,
} from "./account-auth.ts";
import { MCP_PATH, OAuthServer, type OAuthStore } from "./oauth.ts";
import { serveMcp } from "./mcp-http.ts";

/** Enables the hosted MCP endpoint and its OAuth authorization server. */
export interface RemoteMcpOptions {
  store: OAuthStore;
  script?: () => Promise<string>;
  publicUrl?: string;
}

export const MAX_WS_BUFFER_BYTES = 256 * 1024;
// A legal full hello can contain 200 requests and one bounded transcript. Allow
// that single frame; subsequent queued traffic still uses the small soft limit.
export const MAX_WS_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export interface SocketData {
  principal: Extract<Principal, { role: "device" }>;
  seen: Map<string, number>;
  ready: boolean;
  closed: boolean;
}
export interface Socket {
  data: SocketData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
  ping(): number;
  getBufferedAmount?(): number;
}
export interface GatewayServer {
  upgrade(req: Request, options: { data: SocketData }): boolean;
}

export class CloudApp {
  private sockets = new Set<Socket>();
  private owners = new Map<string, Set<Socket>>();
  private digests = new Map<string, string>();
  private versions = new Map<string, string>();
  private upgrades = new Map<SocketData, number>();
  private refreshing = new Set<string>();
  private dirty = new Set<string>();
  private closed = false;
  private pairInFlight = 0;
  private waiters = new Map<string, Set<() => void>>();
  private readonly oauth?: OAuthServer;
  constructor(
    readonly service: CloudService,
    readonly verifier: IdentityVerifier,
    readonly maxSockets = 10_000,
    readonly accountAuth?: AccountAuth,
    readonly authScript?: () => Promise<string>,
    remote?: RemoteMcpOptions,
  ) {
    // The consent page signs the human in with Firebase, so it needs the web configuration.
    if (remote && accountAuth)
      this.oauth = new OAuthServer({ ...remote, service, verifier });
  }
  fetch(req: Request, server?: GatewayServer): Promise<Response | undefined> {
    return this.route(req, server);
  }
  /**
   * `internal` is the already authenticated owner of a hosted MCP call. It is set
   * only by this process, never derived from the request.
   */
  private async route(
    req: Request,
    server?: GatewayServer,
    internal?: Principal,
  ): Promise<Response | undefined> {
    try {
      if (this.closed) throw unavailable();
      const u = new URL(req.url),
        path = u.pathname,
        method = req.method;
      if (path === "/healthz" && method === "GET")
        return json(200, {
          ok: true,
          version: "0.3.0",
          capabilities: { async_turns: true, turn_idempotency: true },
        });
      if (path === "/readyz" && method === "GET") {
        await this.service.db.health();
        return json(200, { ok: true });
      }
      if (path === "/v1/auth/config" && method === "GET") {
        if (!this.accountAuth) throw unavailable();
        return json(200, this.accountAuth.publicConfig);
      }
      if (path === "/auth" && method === "GET") {
        if (!this.accountAuth) throw unavailable();
        return new Response(AUTH_PAGE, {
          headers: authPageHeaders("text/html; charset=utf-8"),
        });
      }
      if (path === "/auth.js" && method === "GET") {
        if (!this.accountAuth || !this.authScript) throw unavailable();
        return new Response(await this.authScript(), {
          headers: authPageHeaders("text/javascript; charset=utf-8"),
        });
      }
      if (path.startsWith("/v1/previews/") && method === "GET") {
        const token = /^Bearer (kp_[A-Za-z0-9_-]{43})$/.exec(
          req.headers.get("authorization") ?? "",
        )?.[1];
        if (!token) throw unauthorized();
        const key = hash(token),
          uid = await this.service.db.findPreview(key);
        if (!uid) throw unauthorized();
        return await this.service.db.transaction(uid, async (tx) => {
          await this.service.reconcile(tx);
          const preview = await tx.get("preview", key);
          if (
            !preview ||
            preview.expires <= this.service.now() ||
            path !== `/v1/previews/${preview.requestId}`
          )
            throw unauthorized();
          const device = await tx.get("device", preview.deviceId);
          if (!device || !(await tx.ownsPush(device, preview.field)))
            throw unauthorized();
          return json(200, {
            request: await this.service.request(tx, preview.requestId),
            recipient_device_id: device.id,
          });
        });
      }
      if (this.oauth && !internal) {
        const handled = await this.oauth.handle(req, u);
        if (handled) return handled;
        if (path === MCP_PATH)
          return await serveMcp(
            req,
            this.oauth,
            (principal) => async (url, init) =>
              (await this.route(new Request(url, init), undefined, principal))!,
          );
      }
      if (path === "/v1/pair" && method === "POST") {
        if (this.pairInFlight >= 32)
          throw new CloudError(
            429,
            "rate_limited",
            "please try pairing again shortly",
          );
        this.pairInFlight++;
        try {
          return json(201, await this.service.pair(await readBody(req)));
        } finally {
          this.pairInFlight--;
        }
      }
      // A hosted MCP call may ask and notify; it never mints account or device credentials.
      if (
        internal &&
        (path === "/v1/auth/link-token" ||
          path === "/v1/pairing-codes" ||
          path === "/v1/events")
      )
        throw new CloudError(403, "forbidden", "not available to MCP clients");
      const p =
        internal ?? (await authenticate(req, this.service.db, this.verifier));
      if (path === "/v1/auth/link-token" && method === "POST") {
        requireRole(p, "agent");
        if (!this.accountAuth?.publicConfig.canLinkExisting)
          throw unavailable();
        const input = await readBody(req);
        if (Object.keys(input).length)
          throw invalid(
            "account link does not accept another user's identifier",
          );
        await this.service.run(p, (tx) => this.service.accountLinkAttempt(tx));
        return json(200, {
          uid: p.uid,
          custom_token: await this.accountAuth.issueLinkToken(p.uid),
        });
      }
      if (path === "/v1/events" && method === "GET") {
        requireRole(p, "device");
        if (this.sockets.size + this.upgrades.size >= this.maxSockets)
          throw new CloudError(
            429,
            "rate_limited",
            "connection capacity reached; reconnect shortly",
          );
        const data: SocketData = {
          principal: p as Extract<Principal, { role: "device" }>,
          seen: new Map(),
          ready: false,
          closed: false,
        };
        this.upgrades.set(data, Date.now() + 10_000);
        try {
          if (!server?.upgrade(req, { data }))
            throw invalid("websocket upgrade required");
        } catch (e) {
          this.upgrades.delete(data);
          throw e;
        }
        return;
      }
      // Body reading and all external I/O happen outside the brief owner lock.
      const body =
        method === "POST" || method === "PATCH" || method === "PUT"
          ? await readBodyForRoute(req)
          : {};
      const response = await this.service.run(p, async (tx) => {
        const deviceId = p.role === "device" ? p.deviceId : "";
        if (path === "/v1/pairing-codes" && method === "POST") {
          requireRole(p, "agent");
          return json(201, await this.service.issuePairing(tx));
        }
        if (path === "/v1/requests") {
          if (method === "POST") {
            requireRole(p, "agent");
            return json(
              201,
              await this.service.create(
                tx,
                body,
                req.headers.get("idempotency-key"),
              ),
            );
          }
          if (method === "GET") {
            requireRole(p, "device");
            const status = u.searchParams.get("status");
            if (
              status &&
              ![
                "pending",
                "answered",
                "cancelled",
                "expired",
                "notified",
              ].includes(status)
            )
              throw invalid("invalid status");
            const raw = u.searchParams.get("limit"),
              limit =
                raw === null
                  ? 50
                  : integer(/^\d+$/.test(raw) ? Number(raw) : NaN, 1, 200, 50);
            return json(200, {
              requests: await tx.list(
                "request",
                status ? { status } : {},
                limit,
              ),
            });
          }
        }
        const match =
          /^\/v1\/requests\/([^/]+)(?:\/(answer|cancel|call|turns)(?:\/([^/]+))?)?$/.exec(
            path,
          );
        if (match) {
          const id = decodeURIComponent(match[1]!);
          if (id.length > 200) throw invalid("invalid request ID");
          if (!match[2]) {
            if (method === "GET")
              return json(200, { request: await this.service.request(tx, id) });
            if (method === "PATCH") {
              requireRole(p, "agent");
              return json(200, await this.service.update(tx, id, body));
            }
          }
          if (match[2] === "cancel" && method === "POST") {
            requireRole(p, "agent");
            return json(200, await this.service.cancel(tx, id));
          }
          if (match[2] === "answer" && method === "POST") {
            requireRole(p, "device");
            return json(200, await this.service.answer(tx, id, deviceId, body));
          }
          if (match[2] === "call" && method === "POST") {
            requireRole(p, "device");
            const r = await this.service.call(tx, id, deviceId, body);
            return json(r.status, r.body);
          }
          if (match[2] === "turns" && match[3] && method === "GET") {
            requireRole(p, "device");
            return json(
              200,
              await this.service.getTurn(tx, id, match[3], deviceId),
            );
          }
        }
        if (path === "/v1/presence") {
          if (method === "GET")
            return json(200, await this.service.presence(tx, p));
          if (method === "PUT") {
            requireRole(p, "device");
            return json(
              200,
              await this.service.putPresence(tx, deviceId, body),
            );
          }
        }
        if (path === "/v1/devices/me") {
          requireRole(p, "device");
          if (method === "PUT")
            return json(
              200,
              await this.service.updateDevice(tx, deviceId, body),
            );
          if (method === "DELETE") {
            // Revocation invalidates owned active calls, retaining the question.
            for (const r of await tx.list(
              "request",
              { status: "pending" },
              201,
            ))
              if (r.call?.device_id === deviceId && r.call.state === "active") {
                await this.service.endCall(tx, r, "failed", true);
                await this.service.save(tx, r, "fallback");
              }
            await tx.releasePush(deviceId);
            await tx.remove("device", deviceId);
            await tx.remove("presence", deviceId);
            return new Response(null, { status: 204 });
          }
        }
        throw missing();
      });
      if (method !== "GET") {
        this.notify(p.uid);
        void this.service.wake(p.uid);
        void this.refresh(p.uid);
      }
      if (
        method === "GET" &&
        p.role === "agent" &&
        /^\/v1\/requests\/[^/]+$/.test(path) &&
        u.searchParams.has("wait")
      ) {
        const raw = u.searchParams.get("wait")!;
        const seconds = integer(
          /^\d+$/.test(raw) ? Number(raw) : NaN,
          0,
          300,
          0,
        );
        if (seconds > 0) {
          const initial = (await response.clone().json()) as {
            request: { status: string };
          };
          if (initial.request.status === "pending")
            return await this.waitRequest(
              p,
              decodeURIComponent(path.split("/").pop()!),
              Math.min(seconds * 1000, 25_000),
              req.signal,
              response,
            );
        }
      }
      return response;
    } catch (e) {
      const err = e instanceof CloudError ? e : unavailable();
      return json(err.status, {
        error: { code: err.code, message: err.message },
      });
    }
  }
  private notify(uid: string) {
    for (const fn of [...(this.waiters.get(uid) ?? [])]) fn();
  }
  private async waitRequest(
    p: Principal,
    id: string,
    ms: number,
    signal: AbortSignal,
    initial: Response,
  ) {
    const deadline = Date.now() + ms;
    let latest = initial;
    if (
      [...this.waiters.values()].reduce((n, v) => n + v.size, 0) >=
      this.maxSockets
    )
      throw new CloudError(
        429,
        "rate_limited",
        "waiting capacity reached; retry shortly",
      );
    while (!this.closed && !signal.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          const set = this.waiters.get(p.uid);
          set?.delete(done);
          if (set?.size === 0) this.waiters.delete(p.uid);
          this.forget(p.uid);
          resolve();
        };
        const set = this.waiters.get(p.uid) ?? new Set<() => void>();
        this.waiters.set(p.uid, set);
        this.digests.set(hash(p.uid), p.uid);
        set.add(done);
        signal.addEventListener("abort", done, { once: true });
        timer = setTimeout(
          done,
          Math.min(2000, Math.max(1, deadline - Date.now())),
        );
        if (signal.aborted || this.closed) done();
      });
      if (this.closed || signal.aborted) break;
      const r = await this.service.run(p, (tx) => this.service.request(tx, id));
      latest = json(200, { request: r });
      if (r.status !== "pending") break;
    }
    return latest;
  }
  private send(ws: Socket, value: unknown) {
    if (ws.data.closed) return;
    try {
      if (
        (ws.getBufferedAmount?.() ?? 0) > MAX_WS_BUFFER_BYTES ||
        ws.send(JSON.stringify(value)) === 0
      ) {
        this.closeSocket(ws);
        ws.close(1013, "reconnect to resume");
      }
    } catch {
      this.closeSocket(ws);
      try {
        ws.close(1013, "reconnect to resume");
      } catch {}
    }
  }
  async open(ws: Socket) {
    this.upgrades.delete(ws.data);
    if (this.closed) {
      ws.close(1012, "reconnect to resume");
      return;
    }
    if (ws.data.closed) {
      ws.close(1013, "reconnect to resume");
      return;
    }
    if (this.sockets.size >= this.maxSockets) {
      ws.close(1013, "connection capacity reached");
      return;
    }
    this.sockets.add(ws);
    const uid = ws.data.principal.uid;
    const group = this.owners.get(uid) ?? new Set<Socket>();
    this.owners.set(uid, group);
    group.add(ws);
    this.digests.set(hash(uid), uid);
    await this.refresh(uid);
  }
  private forget(uid: string) {
    if (!this.owners.has(uid) && !this.waiters.has(uid)) {
      this.digests.delete(hash(uid));
      this.versions.delete(uid);
    }
  }
  closeSocket(ws: Socket) {
    this.upgrades.delete(ws.data);
    ws.data.closed = true;
    this.sockets.delete(ws);
    const uid = ws.data.principal.uid;
    const group = this.owners.get(uid);
    group?.delete(ws);
    if (group?.size === 0) this.owners.delete(uid);
    this.forget(uid);
  }
  async refresh(uid: string) {
    if (this.closed) return;
    if (this.refreshing.has(uid)) {
      this.dirty.add(uid);
      return;
    }
    this.refreshing.add(uid);
    try {
      do {
        this.dirty.delete(uid);
        const targets = [...(this.owners.get(uid) ?? [])].filter(
          (ws) => !ws.data.closed,
        );
        if (!targets.length) return;
        const snapshot = await this.service.db.transaction(uid, async (tx) => {
          await this.service.reconcile(tx);
          const devices = await tx.list("device", {}, 33);
          for (const target of targets) {
            if (target.data.ready) continue;
            const device = devices.find(
              (d) => d.id === target.data.principal.deviceId,
            );
            if (device && this.service.now() - device.lastSeen > 30_000) {
              device.lastSeen = this.service.now();
              await tx.put("device", device.id, device);
            }
          }
          const requests = await tx.list("request", {}, 200),
            pending = await tx.list("request", { status: "pending" }, 200);
          const map = new Map(requests.map((r) => [r.id, r]));
          for (const r of pending) map.set(r.id, r);
          // Include any previously seen pending request even when history moved
          // outside the list window, so its terminal update cannot disappear.
          for (const ws of targets)
            for (const id of ws.data.seen.keys())
              if (!map.has(id)) {
                const r = await tx.get("request", id);
                if (r) map.set(id, r);
              }
          return {
            devices,
            requests: [...map.values()],
            revision: await tx.revision(),
          };
        });
        if (this.closed) return;
        this.versions.set(uid, snapshot.revision);
        for (const ws of targets) {
          if (ws.data.closed) continue;
          const p = ws.data.principal;
          if (
            !snapshot.devices.some(
              (d) => d.id === p.deviceId && d.tokenHash === p.tokenHash,
            )
          ) {
            ws.close(4001, "unpaired");
            this.closeSocket(ws);
            continue;
          }
          if (!ws.data.ready) {
            const pending = snapshot.requests.filter(
              (r) => r.status === "pending",
            );
            for (const r of pending) ws.data.seen.set(r.id, r.version);
            this.send(ws, { type: "hello", pending });
            ws.data.ready = true;
          } else
            for (const r of snapshot.requests) {
              const seen = ws.data.seen.get(r.id);
              if ((seen ?? 0) >= r.version) continue;
              if (
                seen === undefined &&
                !["pending", "notified"].includes(r.status)
              )
                continue;
              this.send(ws, {
                type:
                  seen === undefined ? "request.created" : "request.updated",
                request: r,
              });
              ws.data.seen.set(r.id, r.version);
              if (ws.data.seen.size > 400)
                ws.data.seen.delete(ws.data.seen.keys().next().value!);
            }
        }
      } while (this.dirty.has(uid));
    } catch {
      // Close instead of pretending a stale snapshot is current. Existing client
      // reconnect/backoff and text drafts retain the user's work during outage.
      for (const ws of [...(this.owners.get(uid) ?? [])]) {
        try {
          ws.close(1013, "temporarily unavailable");
        } catch {}
        this.closeSocket(ws);
      }
    } finally {
      this.refreshing.delete(uid);
      this.dirty.delete(uid);
    }
  }
  onWake(digest: string) {
    const uid = this.digests.get(digest);
    if (uid) {
      this.notify(uid);
      void this.refresh(uid);
    }
  }
  async reconcileSockets() {
    for (const [data, deadline] of this.upgrades)
      if (deadline <= Date.now()) {
        data.closed = true;
        this.upgrades.delete(data);
      }
    const owners = [...this.owners.keys()];
    try {
      for (let i = 0; i < owners.length; i += 500) {
        const batch = owners.slice(i, i + 500),
          versions = await this.service.db.revisions(batch);
        const changed = batch.filter(
          (uid) => (versions.get(uid) ?? "0") !== this.versions.get(uid),
        );
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, changed.length) }, async () => {
            while (next < changed.length) await this.refresh(changed[next++]!);
          }),
        );
      }
    } catch {
      for (const ws of [...this.sockets]) {
        try {
          ws.close(1013, "temporarily unavailable");
        } catch {}
        this.closeSocket(ws);
      }
    }
  }
  message(ws: Socket, message: string | Buffer) {
    if (typeof message === "string" && message.length < 256) {
      try {
        if (JSON.parse(message)?.type === "ping")
          this.send(ws, { type: "pong" });
      } catch {}
    }
  }
  ping() {
    for (const ws of this.sockets)
      try {
        ws.ping();
      } catch {
        this.closeSocket(ws);
      }
  }
  close() {
    this.closed = true;
    for (const uid of this.waiters.keys()) this.notify(uid);
    for (const data of this.upgrades.keys()) data.closed = true;
    this.upgrades.clear();
    for (const ws of [...this.sockets]) {
      this.closeSocket(ws);
      try {
        ws.close(1012, "reconnect to resume");
      } catch {}
    }
    this.sockets.clear();
    this.owners.clear();
    this.digests.clear();
    this.versions.clear();
  }
  get socketCount() {
    return this.sockets.size;
  }
  get waiterCount() {
    return [...this.waiters.values()].reduce((n, v) => n + v.size, 0);
  }
}

async function readBodyForRoute(req: Request) {
  // cancel and pairing-code issuance historically have no body.
  if (!req.body) return {};
  return readBody(req);
}
