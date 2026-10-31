// SPDX-License-Identifier: Apache-2.0
// Relay keepalive: the browser pings, the room pongs, and a silent socket
// is closed and reopened with backoff. Browsers cannot send protocol pings,
// so the ping is an app frame to the relay address; any frame back — pong
// or otherwise — proves the link is alive.

import type { RelaySocket } from "./relay.js";

/** How often a connected socket pings, in milliseconds. */
export const PING_INTERVAL_MS = 20000;

/** How long without any frame before the socket is presumed dead. */
export const SILENCE_LIMIT_MS = 45000;

/** The single tick that drives pings and reconnects, in milliseconds. */
export const TICK_MS = 5000;

/** Reconnect backoff ladder, in seconds, before jitter. Mirrors reconnect.ts. */
export const KEEPALIVE_BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30];

/** One reconnect delay: the ladder at `failures`, jittered, clamped to [1s, 30s]. */
export function jitteredBackoffMs(failures: number, randomValue: number): number {
  const base =
    KEEPALIVE_BACKOFF_SECONDS[Math.min(failures, KEEPALIVE_BACKOFF_SECONDS.length - 1)] ?? 30;
  const jittered = base * 1000 * (0.5 + randomValue);
  return Math.round(Math.min(30000, Math.max(1000, jittered)));
}

export interface KeepaliveDeps {
  relay: RelaySocket;
  /** Injected clock; defaults to Date.now. */
  nowMs?: () => number;
  /** Injected randomness in [0, 1); defaults to Math.random. */
  random?: () => number;
}

export class RelayKeepalive {
  private readonly relay: RelaySocket;
  private readonly now: () => number;
  private readonly random: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastFrameAt = 0;
  private lastPingAt = 0;
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(deps: KeepaliveDeps) {
    this.relay = deps.relay;
    this.now = deps.nowMs ?? (() => Date.now());
    this.random = deps.random ?? (() => Math.random());
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    const now = this.now();
    this.lastFrameAt = now;
    this.lastPingAt = now;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.unsubscribe = this.relay.onFrame(() => {
      this.lastFrameAt = this.now();
      this.failures = 0;
      this.nextAttemptAt = 0;
    });
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private tick(): void {
    const now = this.now();
    if (!this.relay.connected) {
      if (now < this.nextAttemptAt) {
        return;
      }
      this.reconnect(now);
      return;
    }
    if (now - this.lastPingAt >= PING_INTERVAL_MS) {
      this.relay.trySend("relay", { t: "ping" });
      this.lastPingAt = now;
    }
    if (now - this.lastFrameAt >= SILENCE_LIMIT_MS) {
      if (now < this.nextAttemptAt) {
        return;
      }
      this.reconnect(now);
    }
  }

  /** Close the dead socket and open a fresh one, paced by backoff. */
  private reconnect(now: number): void {
    this.nextAttemptAt = now + this.backoffMs();
    this.failures += 1;
    this.relay.close();
    void this.relay
      .connect()
      .then(() => {
        // The new socket gets a full silence budget to prove itself;
        // the failures stand until a frame actually arrives.
        this.lastFrameAt = this.now();
      })
      .catch(() => {
        // The next tick retries with a larger backoff.
      });
  }

  /** The next reconnect delay, jittered and clamped to [1s, 30s]. */
  private backoffMs(): number {
    return jitteredBackoffMs(this.failures, this.random());
  }
}
