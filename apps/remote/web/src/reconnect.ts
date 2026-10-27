// SPDX-License-Identifier: Apache-2.0
// Connection manager: one attempt after another with backoff, pausing while
// the page is hidden. States are plain strings the UI reads directly:
// "connecting", "connected", "retrying in Ns", "failed: <reason>".

import { HostPeer } from "./peer.js";
import type { PeerDeps, PeerEvent, PeerConnectionFactory, TurnFetcher } from "./peer.js";
import type { RelaySocket } from "./relay.js";
import type { DeviceKey } from "./crypto.js";
import type { HostRecord } from "./store.js";

export const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30];
const DISCONNECT_GRACE_MS = 5000;
const COUNTDOWN_TICK_MS = 1000;

export interface Visibility {
  isVisible: () => boolean;
  onChange: (callback: () => void) => () => void;
}

export function documentVisibility(): Visibility {
  return {
    isVisible: () => globalThis.document.visibilityState === "visible",
    onChange: (callback) => {
      const listener = () => callback();
      globalThis.document.addEventListener("visibilitychange", listener);
      return () => globalThis.document.removeEventListener("visibilitychange", listener);
    },
  };
}

export interface ManagerDeps {
  relay: RelaySocket;
  host: HostRecord;
  device: DeviceKey;
  fetchTurn?: TurnFetcher;
  createConnection?: PeerConnectionFactory;
  createPeer?: (deps: PeerDeps) => HostPeer;
  visibility?: Visibility;
}

type Phase = "idle" | "attempting" | "open" | "waiting" | "failed";

export class ConnectionManager {
  private readonly deps: ManagerDeps;
  private readonly visibility: Visibility;
  private readonly stateHandlers = new Set<(state: string) => void>();
  private readonly messageHandlers = new Set<(data: string) => void>();
  private phase: Phase = "idle";
  private failures = 0;
  private peer: HostPeer | null = null;
  private unsubscribePeer: (() => void) | null = null;
  private countdown: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopWatchingVisibility: (() => void) | null = null;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.visibility = deps.visibility ?? documentVisibility();
  }

  onState(handler: (state: string) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  // Raw data-channel text, for the frame assembler. Only fires while open.
  onMessage(handler: (data: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  private emit(state: string): void {
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }

  start(): void {
    if (this.phase === "attempting" || this.phase === "open" || this.phase === "waiting") {
      return;
    }
    this.failures = 0;
    void this.attempt();
  }

  retryNow(): void {
    if (this.phase !== "failed") {
      return;
    }
    this.failures = 0;
    void this.attempt();
  }

  stop(): void {
    this.clearTimers();
    this.unsubscribePeer?.();
    this.unsubscribePeer = null;
    this.peer?.close();
    this.peer = null;
    this.phase = "idle";
  }

  private async attempt(): Promise<void> {
    if (this.phase === "attempting" || this.phase === "open") {
      return;
    }
    this.clearTimers();
    this.phase = "attempting";
    this.emit("connecting");
    try {
      await this.deps.relay.connect();
    } catch {
      this.beginWait();
      return;
    }
    if (this.phase !== "attempting") {
      return;
    }
    const createPeer = this.deps.createPeer ?? ((peerDeps) => new HostPeer(peerDeps));
    const peer = createPeer({
      relay: this.deps.relay,
      host: this.deps.host,
      device: this.deps.device,
      fetchTurn: this.deps.fetchTurn,
      createConnection: this.deps.createConnection,
    });
    this.peer = peer;
    this.unsubscribePeer = peer.onEvent((ev) => this.onPeerEvent(ev));
    try {
      await peer.connect();
    } catch {
      if (this.phase === "attempting") {
        this.beginWait();
      }
    }
  }

  private onPeerEvent(ev: PeerEvent): void {
    if (ev.type === "open") {
      if (this.phase !== "attempting") {
        return;
      }
      this.phase = "open";
      this.failures = 0;
      this.emit("connected");
      return;
    }
    if (ev.type === "closed") {
      if (this.phase === "attempting" || this.phase === "open") {
        this.beginWait();
      }
      return;
    }
    if (ev.type === "failed") {
      if (this.phase === "attempting" || this.phase === "open") {
        this.detachPeer();
        this.phase = "failed";
        this.emit(`failed: ${ev.reason}`);
      }
      return;
    }
    if (ev.type === "ice") {
      this.onIceState(ev.state);
      return;
    }
    if (ev.type === "message" && this.phase === "open") {
      for (const handler of this.messageHandlers) {
        handler(ev.data);
      }
    }
  }

  private onIceState(state: string): void {
    if (this.phase !== "open" && this.phase !== "attempting") {
      return;
    }
    if (state === "failed") {
      this.beginWait();
      return;
    }
    if (state === "disconnected") {
      if (this.graceTimer !== null) {
        return;
      }
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.phase === "open" || this.phase === "attempting") {
          this.beginWait();
        }
      }, DISCONNECT_GRACE_MS);
      return;
    }
    if (state === "connected" || state === "completed") {
      if (this.graceTimer !== null) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
    }
  }

  private beginWait(): void {
    if (this.phase !== "attempting" && this.phase !== "open") {
      return;
    }
    this.detachPeer();
    this.phase = "waiting";
    const delay = BACKOFF_SECONDS[Math.min(this.failures, BACKOFF_SECONDS.length - 1)] ?? 30;
    this.failures += 1;
    let remaining = delay;
    this.emit(`retrying in ${remaining}s`);
    this.stopWatchingVisibility?.();
    this.stopWatchingVisibility = this.visibility.onChange(() => {
      if (this.phase === "waiting" && this.visibility.isVisible()) {
        void this.attempt();
      }
    });
    this.countdown = setInterval(() => {
      if (this.phase !== "waiting" || !this.visibility.isVisible()) {
        return;
      }
      remaining -= 1;
      if (remaining <= 0) {
        void this.attempt();
      } else {
        this.emit(`retrying in ${remaining}s`);
      }
    }, COUNTDOWN_TICK_MS);
  }

  private detachPeer(): void {
    this.unsubscribePeer?.();
    this.unsubscribePeer = null;
    this.peer?.close();
    this.peer = null;
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.countdown !== null) {
      clearInterval(this.countdown);
      this.countdown = null;
    }
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.stopWatchingVisibility?.();
    this.stopWatchingVisibility = null;
    this.detachPeer();
  }
}
