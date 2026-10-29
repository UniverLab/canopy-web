// SPDX-License-Identifier: Apache-2.0
// Host system metrics over the data channel: the `host.metrics` frame the
// host pushes while watched, the watch/unwatch builders, the TUI SysInfo
// panel's alert thresholds, and the inline-SVG sparklines the SysInfo view
// draws. Pure module: no DOM, no network. Absent values are null.

export interface MetricsGpu {
  /** GPU load percent, or null when the host does not report it. */
  usage: number | null;
  /** GPU temperature in Celsius, or null when unknown. */
  temperature_c: number | null;
  name: string | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
}

export interface MetricsPower {
  watts: number | null;
  limit_watts: number | null;
  /** Where the draw was read: "gpu", "battery", or null. */
  source: string | null;
}

export interface HostMetrics {
  cpu_usage: number | null;
  cpu_temperature_c: number | null;
  /** The sensor behind the CPU temperature, or null when unknown. */
  cpu_temp_source: string | null;
  memory_used_mb: number | null;
  memory_total_mb: number | null;
  gpu: MetricsGpu | null;
  power: MetricsPower | null;
}

export interface HostMetricsFrame {
  metrics: HostMetrics;
  /** When the host sampled the frame, epoch milliseconds. */
  sampled_at: number;
}

// The TUI's alert lines (system_dashboard.rs): CPU temperature warns at
// 70 °C and is critical at 85 °C; GPU at 75/90 °C; usages at 70/90 %.
export const CPU_TEMP_WARN = 70;
export const CPU_TEMP_CRIT = 85;
export const GPU_TEMP_WARN = 75;
export const GPU_TEMP_CRIT = 90;
export const USAGE_WARN = 70;
export const USAGE_CRIT = 90;

export type MetricLevel = "ok" | "warn" | "crit" | "na";

/** The alert level of one reading; the bounds are inclusive, like the TUI. */
export function levelOf(value: number | null, warn: number, crit: number): MetricLevel {
  if (value === null || !Number.isFinite(value)) {
    return "na";
  }
  if (value >= crit) {
    return "crit";
  }
  if (value >= warn) {
    return "warn";
  }
  return "ok";
}

export function cpuTempLevel(celsius: number | null): MetricLevel {
  return levelOf(celsius, CPU_TEMP_WARN, CPU_TEMP_CRIT);
}

export function gpuTempLevel(celsius: number | null): MetricLevel {
  return levelOf(celsius, GPU_TEMP_WARN, GPU_TEMP_CRIT);
}

export function usageLevel(pct: number | null): MetricLevel {
  return levelOf(pct, USAGE_WARN, USAGE_CRIT);
}

/** Memory pressure in percent, or null when either side is missing. */
export function memPct(usedMb: number | null, totalMb: number | null): number | null {
  if (usedMb === null || totalMb === null || !Number.isFinite(usedMb) || !Number.isFinite(totalMb)) {
    return null;
  }
  if (totalMb <= 0) {
    return null;
  }
  return (usedMb / totalMb) * 100;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// sampled_at arrives as unix seconds, unix milliseconds or an ISO string;
// a frame without one reads as sampled now, so its age starts at zero.
function parseSampledAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value !== "") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function parseGpu(value: unknown): MetricsGpu | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  return {
    usage: num(value.usage),
    temperature_c: num(value.temperature_c),
    name: str(value.name),
    vram_used_mb: num(value.vram_used_mb),
    vram_total_mb: num(value.vram_total_mb),
  };
}

function parsePower(value: unknown): MetricsPower | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  return { watts: num(value.watts), limit_watts: num(value.limit_watts), source: str(value.source) };
}

export function parseHostMetrics(frame: unknown): HostMetricsFrame | null {
  if (!isRecord(frame) || frame.t !== "host.metrics") {
    return null;
  }
  if (!isRecord(frame.metrics)) {
    return null;
  }
  const row = frame.metrics;
  return {
    metrics: {
      cpu_usage: num(row.cpu_usage),
      cpu_temperature_c: num(row.cpu_temperature_c),
      cpu_temp_source: str(row.cpu_temp_source),
      memory_used_mb: num(row.memory_used_mb),
      memory_total_mb: num(row.memory_total_mb),
      gpu: parseGpu(row.gpu),
      power: parsePower(row.power),
    },
    sampled_at: parseSampledAt(frame.sampled_at ?? row.sampled_at),
  };
}

// The host clamps the watch interval to 5..60 s; clamp here too, so what
// the app sends is always what the host understands.
export function buildMetricsWatch(intervalSec = 10): string {
  const interval = Math.min(60, Math.max(5, Math.floor(intervalSec)));
  return JSON.stringify({ t: "host.metrics.watch", interval });
}

export function buildMetricsUnwatch(): string {
  return JSON.stringify({ t: "host.metrics.unwatch" });
}

export function formatPct(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : `${Math.round(value)}%`;
}

/** The strip's compact degrees; the view spells out °C. */
export function formatTempShort(celsius: number | null): string {
  return celsius === null || !Number.isFinite(celsius) ? "n/a" : `${Math.round(celsius)}°`;
}

export function formatTemp(celsius: number | null): string {
  return celsius === null || !Number.isFinite(celsius) ? "n/a" : `${Math.round(celsius)}°C`;
}

// Like the TUI's megabytes formatter: megabytes below a gigabyte, two
// decimals of gigabytes above it.
export function formatMem(mb: number | null): string {
  if (mb === null || !Number.isFinite(mb)) {
    return "n/a";
  }
  if (mb < 1024) {
    return `${Math.round(mb)}MB`;
  }
  return `${(mb / 1024).toFixed(2)}GB`;
}

/** How long ago the sample was taken: "3s ago", "2min ago", "1h ago". */
export function formatAge(nowMs: number, sampledMs: number): string {
  const elapsed = Math.max(0, Math.floor((nowMs - sampledMs) / 1000));
  if (elapsed < 60) {
    return `${elapsed}s ago`;
  }
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) {
    return `${minutes}min ago`;
  }
  return `${Math.floor(minutes / 60)}h ago`;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SparkOpts {
  min?: number;
  max?: number;
  label?: string;
}

// One history line as inline SVG: no dependencies, no style attributes
// (the relay's CSP governs those), sized by the `.spark` rule. Nulls split
// the line; a run of one draws a dot; all null draws an empty frame.
export function sparklineSvg(values: (number | null)[], opts?: SparkOpts): string {
  const width = 120;
  const height = 28;
  const label = esc(opts?.label ?? "history");
  const open = `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">`;
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) {
    return `${open}</svg>`;
  }
  const lo = opts?.min ?? Math.min(...present);
  let hi = opts?.max ?? Math.max(...present);
  if (!(hi > lo)) {
    hi = lo + 1;
  }
  const x = (index: number): number =>
    values.length < 2 ? width / 2 : (index / (values.length - 1)) * width;
  const y = (value: number): number => height - 2 - ((value - lo) / (hi - lo)) * (height - 4);
  const point = (index: number, value: number): string => `${x(index).toFixed(1)},${y(value).toFixed(1)}`;
  const shapes: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length === 1 && run[0] !== undefined) {
      const [cx, cy] = run[0].split(",");
      shapes.push(`<circle cx="${cx}" cy="${cy}" r="1.5" fill="currentColor"/>`);
    } else if (run.length > 1) {
      shapes.push(
        `<polyline points="${run.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
      );
    }
    run = [];
  };
  for (const [index, value] of values.entries()) {
    if (value === null || !Number.isFinite(value)) {
      flush();
    } else {
      run.push(point(index, value));
    }
  }
  flush();
  return `${open}${shapes.join("")}</svg>`;
}
