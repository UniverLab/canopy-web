// SPDX-License-Identifier: Apache-2.0
// The metrics store: the latest host.metrics frame plus the last 30
// samples per charted metric, kept client-side for the SysInfo sparklines.
// The shell subscribes to paint the strip and the view, the frame router
// pushes into it, and both entry points drive watch/unwatch — the same
// shape the graph store uses.

import { buildMetricsUnwatch, buildMetricsWatch, memPct } from "./metrics.js";
import type { HostMetricsFrame } from "./metrics.js";

/** What the app asks the host for: a frame every 10 s while watched. */
export const METRICS_WATCH_INTERVAL = 10;
/** Samples per sparkline: the last 30 the host pushed. */
export const METRICS_HISTORY = 30;

export interface MetricsHistory {
  cpu: (number | null)[];
  cpuTemp: (number | null)[];
  /** Memory pressure in percent, used over total. */
  mem: (number | null)[];
  gpu: (number | null)[];
  gpuTemp: (number | null)[];
}

export interface MetricsStoreDeps {
  /** False when the frame could not be sent (no connection yet). */
  send: (data: string) => boolean;
}

const emptyHistory = (): MetricsHistory => ({ cpu: [], cpuTemp: [], mem: [], gpu: [], gpuTemp: [] });

export class MetricsStore {
  private readonly send: (data: string) => boolean;
  private readonly listeners = new Set<() => void>();
  private watching = false;
  private frame: HostMetricsFrame | null = null;
  private receivedAt: number | null = null;
  private rings: MetricsHistory = emptyHistory();

  constructor(deps: MetricsStoreDeps) {
    this.send = deps.send;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // --- outbound -------------------------------------------------------

  // Idempotent: re-rendering a watched route re-sends nothing; only a
  // fresh watch (or a rewatch after reconnect) puts a frame on the wire.
  // False when the link is down.
  watch(interval: number = METRICS_WATCH_INTERVAL): boolean {
    if (this.watching) {
      return true;
    }
    this.watching = true;
    return this.send(buildMetricsWatch(interval));
  }

  /** Stop watching; the last frame stays for the next watch. */
  unwatch(): boolean {
    if (!this.watching) {
      return true;
    }
    this.watching = false;
    return this.send(buildMetricsUnwatch());
  }

  /** Re-send the watch after a reconnect, only while a watch is open. */
  rewatch(): boolean {
    return this.watching ? this.send(buildMetricsWatch(METRICS_WATCH_INTERVAL)) : true;
  }

  isWatching(): boolean {
    return this.watching;
  }

  // --- inbound --------------------------------------------------------

  handleFrame(frame: HostMetricsFrame): void {
    this.frame = frame;
    this.receivedAt = Date.now();
    const metrics = frame.metrics;
    this.rings.cpu.push(metrics.cpu_usage);
    this.rings.cpuTemp.push(metrics.cpu_temperature_c);
    this.rings.mem.push(memPct(metrics.memory_used_mb, metrics.memory_total_mb));
    this.rings.gpu.push(metrics.gpu?.usage ?? null);
    this.rings.gpuTemp.push(metrics.gpu?.temperature_c ?? null);
    for (const ring of [this.rings.cpu, this.rings.cpuTemp, this.rings.mem, this.rings.gpu, this.rings.gpuTemp]) {
      if (ring.length > METRICS_HISTORY) {
        ring.splice(0, ring.length - METRICS_HISTORY);
      }
    }
    this.notify();
  }

  /** Leaving the host or pairing again: nothing of its metrics stays. */
  reset(): void {
    this.watching = false;
    this.frame = null;
    this.receivedAt = null;
    this.rings = emptyHistory();
    this.notify();
  }

  // --- reads ----------------------------------------------------------

  current(): HostMetricsFrame | null {
    return this.frame;
  }

  /** When the last frame arrived locally (epoch ms), or null yet. */
  lastReceivedAt(): number | null {
    return this.receivedAt;
  }

  history(): MetricsHistory {
    return {
      cpu: [...this.rings.cpu],
      cpuTemp: [...this.rings.cpuTemp],
      mem: [...this.rings.mem],
      gpu: [...this.rings.gpu],
      gpuTemp: [...this.rings.gpuTemp],
    };
  }
}
