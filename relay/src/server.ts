import type { App, WsData } from "./app.ts";

export interface StartServerOptions {
  hostname: string;
  port: number;
  sweepIntervalMs?: number;
  pingIntervalMs?: number;
}

export interface RunningServer {
  hostname: string;
  port: number;
  url: string;
  stop(): Promise<void>;
}

/** Binds the app to a real Bun.serve socket and runs the periodic sweep / WebSocket ping timers. */
export function startServer(app: App, opts: StartServerOptions): RunningServer {
  const server = Bun.serve<WsData>({
    hostname: opts.hostname,
    port: opts.port,
    // The app enforces the 64KB contract limit itself (with the contract's error body); this is a backstop.
    maxRequestBodySize: 1024 * 1024,
    fetch: (req, srv) => app.fetch(req, srv),
    websocket: {
      open: (ws) => app.websocket.open(ws),
      message: (ws, message) => app.websocket.message(ws, message),
      close: (ws) => app.websocket.close(ws),
      maxPayloadLength: 64 * 1024,
      // We send our own ping frames every 30s; a peer that stops answering is dropped after 120s.
      sendPings: false,
      idleTimeout: 120,
    },
    error() {
      return new Response(JSON.stringify({ error: { code: "internal", message: "internal server error" } }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  const sweepTimer = setInterval(() => app.sweep(), opts.sweepIntervalMs ?? 5_000);
  const pingTimer = setInterval(() => app.pingAll(), opts.pingIntervalMs ?? 30_000);
  const port = server.port ?? opts.port;
  const urlHost = opts.hostname.includes(":") ? `[${opts.hostname}]` : opts.hostname;

  return {
    hostname: opts.hostname,
    port,
    url: `http://${urlHost}:${port}`,
    async stop() {
      clearInterval(sweepTimer);
      clearInterval(pingTimer);
      app.close();
      await server.stop(true);
    },
  };
}
