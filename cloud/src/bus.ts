import { RedisClient } from "bun";
import type { WakeBus } from "./types.ts";

const CHANNEL = "oyobidashi:cloud:wake:v1";
/** Redis is an optimization. Callers always have a durable DB/poll fallback. */
export class RedisWakeBus implements WakeBus {
  private pub: RedisClient;
  private sub: RedisClient;
  private listeners = new Set<(digest: string) => void>();
  private connecting: Promise<void> | null = null;
  private closed = false;
  private publishing = 0;
  private timer: ReturnType<typeof setInterval>;
  private onMessage = (message: string) => {
    if (/^[0-9a-f]{64}$/.test(message))
      for (const fn of this.listeners) fn(message);
  };
  constructor(private url: string) {
    this.pub = new RedisClient(url, {
      connectionTimeout: 1000,
      autoReconnect: true,
      maxRetries: 1,
      enableOfflineQueue: false,
    });
    this.sub = new RedisClient(url, {
      connectionTimeout: 1000,
      autoReconnect: true,
      maxRetries: 1,
      enableOfflineQueue: false,
    });
    this.pub.onclose = () => {};
    this.sub.onclose = () => {};
    this.timer = setInterval(() => {
      if (this.listeners.size) void this.connectSub().catch(() => {});
    }, 2000);
    this.timer.unref();
  }
  async publish(uid: string) {
    // Do not put UID/email/transcripts into Redis messages. The digest still
    // allows the gateway to match its connected owners without leaking identity.
    const digest = new Bun.CryptoHasher("sha256").update(uid).digest("hex");
    if (this.closed || this.publishing >= 64)
      throw new Error("wake hints temporarily unavailable");
    this.publishing++;
    const writer = this.pub;
    try {
      await this.bounded(
        (async () => {
          if (!writer.connected) await writer.connect();
          await writer.publish(CHANNEL, digest);
        })(),
        () => {
          if (this.pub === writer && !this.closed) {
            writer.close();
            this.pub = this.client();
          }
        },
      );
    } finally {
      this.publishing--;
    }
  }
  private client() {
    const client = new RedisClient(this.url, {
      connectionTimeout: 1000,
      autoReconnect: true,
      maxRetries: 1,
      enableOfflineQueue: false,
    });
    client.onclose = () => {};
    return client;
  }
  private async bounded<T>(promise: Promise<T>, reset: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reset();
        reject(new Error("wake transport timed out"));
      }, 1500);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
  private async connectSub() {
    if (this.closed) return;
    if (this.connecting) return this.connecting;
    // Reassert SUBSCRIBE periodically: a reconnect can restore TCP without
    // restoring the server's subscription. Reusing the same callback is bounded.
    const subscriber = this.sub;
    this.connecting = this.bounded(
      (async () => {
        if (!subscriber.connected) await subscriber.connect();
        await subscriber.subscribe(CHANNEL, this.onMessage);
      })(),
      () => {
        if (this.sub === subscriber && !this.closed) {
          subscriber.close();
          this.sub = this.client();
        }
      },
    ).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }
  async subscribe(listener: (digest: string) => void) {
    this.listeners.add(listener);
    await this.connectSub().catch(() => {});
    return () => {
      this.listeners.delete(listener);
    };
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.listeners.clear();
    this.pub.close();
    this.sub.close();
  }
}

/** Test/local fallback has the same hashed notification contract. */
export class LocalWakeBus implements WakeBus {
  private listeners = new Set<(uid: string) => void>();
  async publish(uid: string) {
    const digest = new Bun.CryptoHasher("sha256").update(uid).digest("hex");
    for (const fn of this.listeners) fn(digest);
  }
  async subscribe(fn: (uid: string) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  close() {
    this.listeners.clear();
  }
}
