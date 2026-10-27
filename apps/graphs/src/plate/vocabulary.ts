// SPDX-License-Identifier: Apache-2.0
/**
 * The drawing vocabulary of the Canopy plates, copied from univerlab's
 * `src/lib/canopy-graph.ts` (the shared vocabulary of the Canopy page's
 * GraphMorph and its "Autonomous graph" section): the same node geometry,
 * the same palette and type sizes, the same edge curves — so a node kind,
 * an edge curve or a colour means the same thing here as on univerlab.org.
 */

export type Kind = "chip" | "agent" | "check" | "gate" | "commit";

// Geometry of each node kind, as an interpolatable rect (viewBox units).
export const GEOM: Record<Kind, { w: number; h: number; rx: number; rot: number }> = {
  chip: { w: 10, h: 5.2, rx: 1, rot: 0 },
  agent: { w: 6, h: 6, rx: 3, rot: 0 },
  check: { w: 5.6, h: 5.6, rx: 0.7, rot: 0 },
  gate: { w: 5, h: 5, rx: 0.5, rot: 45 },
  commit: { w: 6.4, h: 6.4, rx: 3.2, rot: 0 },
};

// Colours and type sizes of the drawing (the hero's CSS carries the same values).
export const PALETTE = {
  chipFill: "#0c1416",
  gateFill: "#0c1416",
  gateStroke: "#e8f6f1",
  label: "#e8f6f1",
  deep: "#04110f",
  red: "#ff6b6b",
  token: "#cbfffc",
};
export const TYPE = {
  label: 2.3,
  labelDy: 6.4,
  chipLabelDy: 0.8,
  harness: 1.9,
  harnessDy: 8.9,
};

/**
 * Harness accent colours by platform stem, copied from univerlab
 * `src/views/experiments/Canopy.astro` (the hero morph's fallback accents):
 * agents take their harness colour, everything else the Canopy teal.
 */
export const HARNESS_COLORS: Record<string, string> = {
  claude: "#d97757",
  opencode: "#5c9cf5",
  codex: "#57c7c3",
  gemini: "#c09ee4",
  copilot: "#aa00aa",
  kiro: "#9d7cf5",
  mimo: "#fb8147",
  qwen: "#615ced",
  deepseek: "#4d6bfe",
  muse: "#e7b04b",
};

/**
 * The canonical harness stem of a platform or model string, or null when it
 * names nothing known. Matching is case-insensitive: an exact stem wins,
 * then a stem prefix (`claude-opus` rides `claude`, `mimocode` rides
 * `mimo`), then a stem named anywhere inside. Anything else is unknown.
 */
export function harnessStem(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim().toLowerCase();
  if (text === "") {
    return null;
  }
  const stems = Object.keys(HARNESS_COLORS);
  if (text in HARNESS_COLORS) {
    return text;
  }
  const prefixed = stems.find((stem) => text.startsWith(stem));
  if (prefixed !== undefined) {
    return prefixed;
  }
  return stems.find((stem) => text.includes(stem)) ?? null;
}

/** The accent colour of a harness stem, or null when it is unknown. */
export function harnessColor(stem: string | null): string | null {
  return stem === null ? null : (HARNESS_COLORS[stem] ?? null);
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * Edge path between two node centres: a smooth S-curve. A failure that drops to
 * another row is the same curve; one that routes back along the same row arcs
 * ABOVE the pair (labels sit below nodes). `lift` raises such an arc further, so
 * two back-edges into one node stay distinct (0 = the hero's drawing).
 */
export function edgePath(a: Pt, b: Pt, fail: boolean, lift = 0): string {
  if (!fail || Math.abs(b.y - a.y) > 6) {
    const mx = (a.x + b.x) / 2;
    return `M${a.x} ${a.y} C${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`;
  }
  const rise = Math.min(a.y, b.y) - 8 - Math.abs(a.x - b.x) * 0.1 - lift;
  return `M${a.x} ${a.y - 3} C${a.x} ${rise} ${b.x} ${rise} ${b.x} ${b.y - 3}`;
}
