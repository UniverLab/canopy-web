// SPDX-License-Identifier: Apache-2.0
// The host metrics strip and the SysInfo view: the strip rides the topbar
// beside the host chip (hidden until the first frame lands), and tapping
// it opens the view with every field, one sparkline per charted metric,
// and the sample age. Through a disconnect the view keeps the last frame
// with a "disconnected — last update" note. The shell owns the watches;
// this module only paints what the store holds.

import { signOutButtonHtml } from "./chrome.js";
import { icon } from "./icons-dom.js";
import {
  cpuTempLevel,
  formatAge,
  formatMem,
  formatPct,
  formatTemp,
  formatTempShort,
  gpuTempLevel,
  memPct,
  sparklineSvg,
  usageLevel,
} from "./metrics.js";
import type { HostMetrics, HostMetricsFrame, MetricLevel } from "./metrics.js";
import type { MetricsHistory } from "./metrics-store.js";

export interface MetricsViewArgs {
  /** The shell's topbar markup; the view rides below it. */
  header: string;
  /** The connection banner, "" while nothing is wrong. */
  banner: string;
  /** The signed-in login the direct button names, or null. */
  login: string | null;
  /** The last sign-out failure, shown inline, or null. */
  signOutError: string | null;
  frame: HostMetricsFrame | null;
  history: MetricsHistory | null;
  /** When the last frame arrived locally (epoch ms), or null. */
  receivedAt: number | null;
  connected: boolean;
  onBack: () => void;
  onSignOut: () => void;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function val(text: string, level: MetricLevel): string {
  return `<b data-level="${level}">${esc(text)}</b>`;
}

// The strip: CPU % and °C, memory used/total, GPU % and °C when the host
// reports a GPU. Nulls read "n/a"; the strip stays hidden until the first
// frame, so an older host shows no strip at all.
export function metricsStripHtml(frame: HostMetricsFrame | null): string {
  if (frame === null) {
    return "";
  }
  const metrics = frame.metrics;
  const mem = `${formatMem(metrics.memory_used_mb)}/${formatMem(metrics.memory_total_mb)}`;
  const gpu = metrics.gpu;
  const gpuSeg =
    gpu === null
      ? ""
      : `<span class="m-sep" aria-hidden="true">·</span><span class="m-seg">GPU ${val(formatPct(gpu.usage), usageLevel(gpu.usage))} ${val(formatTempShort(gpu.temperature_c), gpuTempLevel(gpu.temperature_c))}</span>`;
  const label =
    `CPU ${formatPct(metrics.cpu_usage)} ${formatTempShort(metrics.cpu_temperature_c)}, ` +
    `memory ${mem}` +
    (gpu === null
      ? ""
      : `, GPU ${formatPct(gpu.usage)} ${formatTempShort(gpu.temperature_c)}`);
  return (
    `<button type="button" id="metrics-strip" class="metrics-strip chip" aria-label="Host metrics: ${esc(label)}, open SysInfo">` +
    `<span class="m-seg">CPU ${val(formatPct(metrics.cpu_usage), usageLevel(metrics.cpu_usage))} ${val(formatTempShort(metrics.cpu_temperature_c), cpuTempLevel(metrics.cpu_temperature_c))}</span>` +
    `<span class="m-sep" aria-hidden="true">·</span>` +
    `<span class="m-seg">MEM ${val(mem, usageLevel(memPct(metrics.memory_used_mb, metrics.memory_total_mb)))}</span>` +
    gpuSeg +
    `</button>`
  );
}

function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function sparkRow(
  label: string,
  value: string,
  level: MetricLevel,
  samples: (number | null)[],
  fixedScale: boolean,
): string {
  const spark = fixedScale
    ? sparklineSvg(samples, { min: 0, max: 100, label: `${label} history` })
    : sparklineSvg(samples, { label: `${label} history` });
  return (
    `<div class="metric-row"><span class="metric-label">${esc(label)}</span>` +
    `<span class="metric-value">${val(value, level)}</span>${spark}</div>`
  );
}

function plainRow(label: string, value: string): string {
  return (
    `<div class="metric-row"><span class="metric-label">${esc(label)}</span>` +
    `<span class="metric-value">${esc(value)}</span></div>`
  );
}

// Every field the wire carries, in the TUI's order: CPU, memory, GPU,
// power. A null GPU or power section reads "n/a" instead of vanishing,
// so the view always shows the whole shape.
function bodyHtml(frame: HostMetricsFrame | null, history: MetricsHistory | null): string {
  if (frame === null) {
    return `<p class="metrics-wait">Waiting for the first sample…</p>`;
  }
  const metrics: HostMetrics = frame.metrics;
  const samples: MetricsHistory = history ?? { cpu: [], cpuTemp: [], mem: [], gpu: [], gpuTemp: [] };
  const tempHint =
    metrics.cpu_temperature_c === null
      ? `<p class="metrics-hint">CPU temperature unavailable — enable LibreHardwareMonitor on the host.</p>`
      : "";
  const mem = `${formatMem(metrics.memory_used_mb)}/${formatMem(metrics.memory_total_mb)}`;
  const gpu = metrics.gpu;
  const gpuSection =
    gpu === null
      ? `<section class="metric-section" aria-label="GPU"><h2>GPU</h2><p class="empty">n/a</p></section>`
      : `<section class="metric-section" aria-label="GPU"><h2>GPU</h2>` +
        sparkRow("Usage", formatPct(gpu.usage), usageLevel(gpu.usage), samples.gpu, true) +
        sparkRow("Temp", formatTemp(gpu.temperature_c), gpuTempLevel(gpu.temperature_c), samples.gpuTemp, false) +
        plainRow("Name", gpu.name ?? "n/a") +
        plainRow("VRAM", `${formatMem(gpu.vram_used_mb)}/${formatMem(gpu.vram_total_mb)}`) +
        `</section>`;
  const power = metrics.power;
  const powerSection =
    power === null
      ? `<section class="metric-section" aria-label="Power"><h2>Power</h2><p class="empty">n/a</p></section>`
      : `<section class="metric-section" aria-label="Power"><h2>Power</h2>` +
        plainRow("Draw", power.watts === null ? "n/a" : `${Math.round(power.watts)}W`) +
        plainRow("Limit", power.limit_watts === null ? "n/a" : `${Math.round(power.limit_watts)}W`) +
        plainRow("Source", power.source ?? "n/a") +
        `</section>`;
  return (
    `<section class="metric-section" aria-label="CPU"><h2>CPU</h2>` +
    sparkRow("Usage", formatPct(metrics.cpu_usage), usageLevel(metrics.cpu_usage), samples.cpu, true) +
    sparkRow("Temp", formatTemp(metrics.cpu_temperature_c), cpuTempLevel(metrics.cpu_temperature_c), samples.cpuTemp, false) +
    plainRow("Source", metrics.cpu_temp_source ?? "n/a") +
    tempHint +
    `</section>` +
    `<section class="metric-section" aria-label="Memory"><h2>Memory</h2>` +
    sparkRow("Used", `${mem} (${formatPct(memPct(metrics.memory_used_mb, metrics.memory_total_mb))})`, usageLevel(memPct(metrics.memory_used_mb, metrics.memory_total_mb)), samples.mem, true) +
    `</section>` +
    gpuSection +
    powerSection
  );
}

function paint(root: HTMLElement, args: MetricsViewArgs): void {
  const main = root.querySelector<HTMLElement>("main.metrics-view");
  if (main === null) {
    return;
  }
  const age = main.querySelector<HTMLElement>("#metrics-age");
  if (age) {
    age.textContent =
      args.frame === null ? "" : `sampled ${formatAge(Date.now(), args.frame.sampled_at)}`;
    age.hidden = args.frame === null;
  }
  const note = main.querySelector<HTMLElement>("#metrics-note");
  if (note) {
    const text =
      args.connected || args.receivedAt === null
        ? ""
        : `disconnected — last update ${clockOf(args.receivedAt)}`;
    note.hidden = text === "";
    note.textContent = text;
  }
  const body = main.querySelector<HTMLElement>("#metrics-body");
  if (body) {
    body.innerHTML = bodyHtml(args.frame, args.history);
  }
  const signOutError = main.querySelector<HTMLElement>("#signout-error");
  if (signOutError) {
    signOutError.textContent = args.signOutError ?? "";
  }
}

function viewHtml(args: MetricsViewArgs): string {
  return (
    `${args.header}` +
    `<main class="metrics-view">` +
    args.banner +
    `<div class="metrics-bar">` +
    `<button type="button" id="metrics-back" aria-label="Back">${icon("chevronLeft")}</button>` +
    `<span class="metrics-title">SysInfo</span>` +
    `<span class="metrics-age" id="metrics-age" hidden></span>` +
    `</div>` +
    `<p class="metrics-note" id="metrics-note" hidden></p>` +
    `<div id="metrics-body"></div>` +
    signOutButtonHtml(args.login, args.signOutError) +
    `</main>`
  );
}

/** Mount the SysInfo view (or update it in place when it is already up). */
export function renderMetricsView(root: HTMLElement, args: MetricsViewArgs): void {
  root.innerHTML = viewHtml(args);
  root.querySelector("#metrics-back")?.addEventListener("click", () => args.onBack());
  paint(root, args);
}

/** Repaint the mounted view; a no-op when the SysInfo view is not open. */
export function updateMetricsView(root: HTMLElement, args: MetricsViewArgs): void {
  paint(root, args);
}
