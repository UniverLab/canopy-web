// SPDX-License-Identifier: Apache-2.0
// Test-only host metrics fixture behind fake.html (served by vite dev,
// never built): a watch is answered with a frame at once and then every
// interval, until unwatch. ?metrics=silent never answers, so the
// strip-hiding path has a host of its own. Split out of fake-host.ts,
// which sits at the gate's size limit.

interface FakeMetricsDeps {
  deliver: (frame: unknown) => void;
}

interface MetricsFrame {
  t: string;
  interval?: number;
}

export function createFakeMetrics(deps: FakeMetricsDeps): {
  handle: (frame: MetricsFrame) => boolean;
  pushMetrics: (patch: Record<string, unknown>) => void;
} {
  const metricsSilent = new URLSearchParams(globalThis.location.search).get("metrics") === "silent";
  let metricsCount = 0;
  let metricsTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  const metricsFrame = (patch: Record<string, unknown> = {}): unknown => {
    metricsCount += 1;
    return {
      t: "host.metrics",
      sampled_at: Date.now(),
      metrics: {
        cpu_usage: 10 + ((metricsCount * 7) % 60),
        cpu_temperature_c: 54,
        cpu_temp_source: "coretemp",
        memory_used_mb: 3200,
        memory_total_mb: 8192,
        gpu: {
          usage: 40,
          temperature_c: 62,
          name: "GeForce GTX",
          vram_used_mb: 1024,
          vram_total_mb: 8192,
        },
        power: { watts: 65, limit_watts: 120, source: "gpu" },
        ...patch,
      },
    };
  };

  const stopMetrics = (): void => {
    if (metricsTimer !== null) {
      globalThis.clearInterval(metricsTimer);
      metricsTimer = null;
    }
  };

  const startMetrics = (intervalSec: number): void => {
    // A watch while already pushing changes nothing: the subscription is
    // idempotent, so a duplicate watch never resets the pushed samples.
    if (metricsTimer !== null) {
      return;
    }
    if (metricsSilent) {
      return;
    }
    deps.deliver(metricsFrame());
    const interval = Math.min(60, Math.max(5, Math.floor(intervalSec)));
    metricsTimer = globalThis.setInterval(() => deps.deliver(metricsFrame()), interval * 1000);
  };

  return {
    handle(frame: MetricsFrame): boolean {
      if (frame.t === "host.metrics.watch") {
        startMetrics(typeof frame.interval === "number" ? frame.interval : 10);
      } else if (frame.t === "host.metrics.unwatch") {
        stopMetrics();
      } else {
        return false;
      }
      return true;
    },
    pushMetrics(patch: Record<string, unknown>): void {
      deps.deliver(metricsFrame(patch));
    },
  };
}
