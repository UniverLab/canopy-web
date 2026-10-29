// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMetricsUnwatch,
  buildMetricsWatch,
  cpuTempLevel,
  formatAge,
  formatMem,
  formatPct,
  formatTemp,
  formatTempShort,
  gpuTempLevel,
  levelOf,
  memPct,
  parseHostMetrics,
  sparklineSvg,
  usageLevel,
} from "../src/metrics.js";
import { METRICS_HISTORY, MetricsStore } from "../src/metrics-store.js";
import type { HostMetricsFrame } from "../src/metrics.js";
import { metricsStripHtml } from "../src/metrics-view.js";

const fullFrame = (): unknown => ({
  t: "host.metrics",
  sampled_at: 1_791_979_200_000,
  metrics: {
    cpu_usage: 12.5,
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
  },
});

const frameWith = (metrics: Record<string, unknown>): HostMetricsFrame => {
  const parsed = parseHostMetrics({ t: "host.metrics", sampled_at: 1_791_979_200_000, metrics });
  if (parsed === null) {
    throw new Error("fixture does not parse");
  }
  return parsed;
};

describe("parseHostMetrics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
  });

  it("parses a full frame", () => {
    expect(parseHostMetrics(fullFrame())).toEqual({
      metrics: {
        cpu_usage: 12.5,
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
      },
      sampled_at: 1_791_979_200_000,
    });
  });

  it("reads absent values as null", () => {
    expect(
      parseHostMetrics({ t: "host.metrics", sampled_at: 1_791_979_200_000, metrics: {} })?.metrics,
    ).toEqual({
      cpu_usage: null,
      cpu_temperature_c: null,
      cpu_temp_source: null,
      memory_used_mb: null,
      memory_total_mb: null,
      gpu: null,
      power: null,
    });
  });

  it("rejects anything but a host.metrics frame with a metrics object", () => {
    expect(parseHostMetrics(null)).toBeNull();
    expect(parseHostMetrics({ t: "host.metrics" })).toBeNull();
    expect(parseHostMetrics({ t: "host.metrics", metrics: null })).toBeNull();
    expect(parseHostMetrics({ t: "sessions", metrics: {} })).toBeNull();
    expect(parseHostMetrics({ t: "host.metrics.watch", metrics: {} })).toBeNull();
  });

  it("reads unix seconds, milliseconds and ISO timestamps", () => {
    const metrics = {};
    expect(parseHostMetrics({ t: "host.metrics", sampled_at: 1_791_979_200, metrics })?.sampled_at).toBe(
      1_791_979_200_000,
    );
    expect(
      parseHostMetrics({ t: "host.metrics", sampled_at: 1_791_979_200_000, metrics })?.sampled_at,
    ).toBe(1_791_979_200_000);
    const iso = parseHostMetrics({
      t: "host.metrics",
      sampled_at: "2026-10-27T00:00:00.000Z",
      metrics,
    });
    expect(iso === null ? null : iso.sampled_at).toBe(Date.parse("2026-10-27T00:00:00.000Z"));
  });

  it("reads a frame without sampled_at as sampled now", () => {
    expect(parseHostMetrics({ t: "host.metrics", metrics: {} })?.sampled_at).toBe(Date.now());
  });

  it("drops a malformed gpu or power object instead of the frame", () => {
    const parsed = frameWith({ cpu_usage: 10, gpu: "nvidia", power: 42 });
    expect(parsed.metrics.cpu_usage).toBe(10);
    expect(parsed.metrics.gpu).toBeNull();
    expect(parsed.metrics.power).toBeNull();
  });

  it("drops malformed numbers and blank strings inside gpu and power", () => {
    const parsed = frameWith({
      gpu: { usage: "40", temperature_c: Number.NaN, name: "", vram_used_mb: 1024 },
      power: { watts: null, source: "" },
    });
    expect(parsed.metrics.gpu).toEqual({
      usage: null,
      temperature_c: null,
      name: null,
      vram_used_mb: 1024,
      vram_total_mb: null,
    });
    expect(parsed.metrics.power).toEqual({ watts: null, limit_watts: null, source: null });
  });
});

describe("the metrics builders", () => {
  it("watches every 10 s by default", () => {
    expect(JSON.parse(buildMetricsWatch())).toEqual({ t: "host.metrics.watch", interval: 10 });
  });

  it("clamps the watch interval to 5..60 s", () => {
    expect(JSON.parse(buildMetricsWatch(1))).toEqual({ t: "host.metrics.watch", interval: 5 });
    expect(JSON.parse(buildMetricsWatch(120))).toEqual({ t: "host.metrics.watch", interval: 60 });
  });

  it("unwatches with the exact t-string", () => {
    expect(JSON.parse(buildMetricsUnwatch())).toEqual({ t: "host.metrics.unwatch" });
  });
});

describe("the TUI thresholds", () => {
  it("warns CPU temperature at 70 °C and calls it critical at 85 °C", () => {
    expect(cpuTempLevel(69.9)).toBe("ok");
    expect(cpuTempLevel(70)).toBe("warn");
    expect(cpuTempLevel(84.9)).toBe("warn");
    expect(cpuTempLevel(85)).toBe("crit");
    expect(cpuTempLevel(null)).toBe("na");
    expect(cpuTempLevel(Number.NaN)).toBe("na");
  });

  it("warns GPU temperature at 75 °C and calls it critical at 90 °C", () => {
    expect(gpuTempLevel(74.9)).toBe("ok");
    expect(gpuTempLevel(75)).toBe("warn");
    expect(gpuTempLevel(89.9)).toBe("warn");
    expect(gpuTempLevel(90)).toBe("crit");
    expect(gpuTempLevel(null)).toBe("na");
  });

  it("warns usages at 70 % and calls them critical at 90 %", () => {
    expect(usageLevel(69.9)).toBe("ok");
    expect(usageLevel(70)).toBe("warn");
    expect(usageLevel(89.9)).toBe("warn");
    expect(usageLevel(90)).toBe("crit");
    expect(usageLevel(null)).toBe("na");
    expect(levelOf(Number.POSITIVE_INFINITY, 70, 90)).toBe("na");
  });

  it("derives memory pressure from used over total", () => {
    expect(memPct(3200, 8192)).toBeCloseTo(39.06, 1);
    expect(memPct(null, 8192)).toBeNull();
    expect(memPct(3200, null)).toBeNull();
    expect(memPct(3200, 0)).toBeNull();
  });

  it("paints the strip values with the threshold levels", () => {
    const hot = frameWith({ cpu_usage: 95, cpu_temperature_c: 91, memory_used_mb: 8000, memory_total_mb: 8192 });
    const html = metricsStripHtml(hot);
    expect(html).toContain('data-level="crit"');
    expect(html).not.toContain('data-level="warn"');
    const warm = frameWith({ cpu_usage: 10, cpu_temperature_c: 72, memory_used_mb: 100, memory_total_mb: 8192 });
    expect(metricsStripHtml(warm)).toContain('data-level="warn"');
    const cool = frameWith({ cpu_usage: 10, cpu_temperature_c: 50, memory_used_mb: 100, memory_total_mb: 8192 });
    expect(metricsStripHtml(cool)).toContain('data-level="ok"');
    expect(metricsStripHtml(cool)).not.toContain("crit");
  });
});

describe("metricsStripHtml", () => {
  it("stays hidden until the first frame lands", () => {
    expect(metricsStripHtml(null)).toBe("");
  });

  it("shows CPU, memory and GPU when the host reports a GPU", () => {
    const metrics = (fullFrame() as { metrics: Record<string, unknown> }).metrics;
    const html = metricsStripHtml(frameWith(metrics));
    expect(html).toContain("CPU");
    expect(html).toContain("MEM");
    expect(html).toContain("GPU");
  });

  it("omits the GPU segment and reads nulls as n/a without one", () => {
    const html = metricsStripHtml(frameWith({ cpu_temperature_c: null }));
    expect(html).toContain("n/a");
    expect(html).not.toContain("GPU");
    expect(html).toContain('data-level="na"');
  });
});

describe("the formatters", () => {
  it("formats percents and temperatures", () => {
    expect(formatPct(12.5)).toBe("13%");
    expect(formatPct(null)).toBe("n/a");
    expect(formatTempShort(54.4)).toBe("54°");
    expect(formatTemp(54.4)).toBe("54°C");
    expect(formatTemp(null)).toBe("n/a");
  });

  it("formats megabytes like the TUI", () => {
    expect(formatMem(512)).toBe("512MB");
    expect(formatMem(3200)).toBe("3.13GB");
    expect(formatMem(null)).toBe("n/a");
  });

  it("formats the sample age", () => {
    expect(formatAge(1_000_000, 999_000)).toBe("1s ago");
    expect(formatAge(1_000_000, 880_000)).toBe("2min ago");
    expect(formatAge(1_000_000, 0)).toBe("16min ago");
    expect(formatAge(10_000_000, 0)).toBe("2h ago");
  });
});

describe("sparklineSvg", () => {
  it("draws an empty frame for all-null histories", () => {
    const svg = sparklineSvg([null, null], { label: "CPU" });
    expect(svg).toContain("<svg");
    expect(svg).toContain('aria-label="CPU"');
    expect(svg).not.toContain("polyline");
    expect(svg).not.toContain("circle");
  });

  it("draws one line through the values", () => {
    const svg = sparklineSvg([0, 50, 100], { min: 0, max: 100, label: "CPU" });
    expect(svg).toContain("<polyline");
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).not.toContain("style=");
  });

  it("splits the line at nulls and dots lone samples", () => {
    const svg = sparklineSvg([10, null, 30]);
    expect(svg.match(/circle/g)?.length).toBe(2);
    expect(svg).not.toContain("polyline");
    const split = sparklineSvg([10, 20, null, 30, 40]);
    expect(split.match(/polyline/g)?.length).toBe(2);
  });

  it("escapes the label", () => {
    expect(sparklineSvg([1], { label: 'a"b<c' })).toContain('aria-label="a&quot;b&lt;c"');
  });
});

describe("MetricsStore", () => {
  it("watches, unwatches and rewatches like the graph store", () => {
    const sent: string[] = [];
    const store = new MetricsStore({ send: (data) => (sent.push(data), true) });
    expect(store.isWatching()).toBe(false);
    // Unwatching while nothing is watched sends nothing.
    expect(store.unwatch()).toBe(true);
    expect(sent).toHaveLength(0);
    expect(store.rewatch()).toBe(true);
    expect(sent).toHaveLength(0);
    store.watch();
    expect(store.isWatching()).toBe(true);
    expect(sent).toEqual([JSON.stringify({ t: "host.metrics.watch", interval: 10 })]);
    store.rewatch();
    expect(sent).toHaveLength(2);
    // Watching twice sends once: re-renders do not re-watch.
    store.watch();
    expect(sent).toHaveLength(2);
    store.unwatch();
    expect(store.isWatching()).toBe(false);
    expect(sent[2]).toBe(JSON.stringify({ t: "host.metrics.unwatch" }));
  });

  it("keeps the last 30 samples per metric", () => {
    const store = new MetricsStore({ send: () => true });
    for (let i = 0; i < METRICS_HISTORY + 5; i += 1) {
      store.handleFrame(
        frameWith({
          cpu_usage: i,
          cpu_temperature_c: 50,
          memory_used_mb: 100,
          memory_total_mb: 1000,
          gpu: { usage: i, temperature_c: 60, name: null, vram_used_mb: null, vram_total_mb: null },
        }),
      );
    }
    const history = store.history();
    expect(history.cpu).toHaveLength(METRICS_HISTORY);
    expect(history.cpu[0]).toBe(5);
    expect(history.cpuTemp).toHaveLength(METRICS_HISTORY);
    expect(history.mem).toHaveLength(METRICS_HISTORY);
    expect(history.mem[0]).toBeCloseTo(10, 5);
    expect(history.gpu).toHaveLength(METRICS_HISTORY);
    expect(history.gpuTemp).toHaveLength(METRICS_HISTORY);
    expect(store.current()?.metrics.cpu_usage).toBe(METRICS_HISTORY + 4);
    expect(store.lastReceivedAt()).not.toBeNull();
  });

  it("forgets everything on reset", () => {
    const seen: number[] = [];
    const store = new MetricsStore({ send: () => true });
    store.subscribe(() => seen.push(1));
    store.watch();
    store.handleFrame(frameWith({ cpu_usage: 10 }));
    store.reset();
    expect(store.isWatching()).toBe(false);
    expect(store.current()).toBeNull();
    expect(store.lastReceivedAt()).toBeNull();
    expect(store.history()).toEqual({ cpu: [], cpuTemp: [], mem: [], gpu: [], gpuTemp: [] });
    // The frame and the reset both notified.
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});
