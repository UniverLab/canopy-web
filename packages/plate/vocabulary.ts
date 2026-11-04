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

/** Round to two decimals so paths print stably. */
export function num(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round every decimal in a path string: midpoints print without float noise. */
export function smooth(d: string): string {
  return d.replace(/-?\d+\.\d+/g, (match) => String(num(Number(match))));
}

/**
 * Edge path between two node centres: a smooth S-curve. A failure that drops to
 * another row is the same curve; one that routes back along the same row arcs
 * ABOVE the pair (labels sit below nodes). `lift` raises such an arc further, so
 * two back-edges into one node stay distinct (0 = the hero's drawing).
 * `forceArc` draws the arc whatever the row gap — a fail or error edge
 * touching an ensemble group never S-curves through the row. An explicit
 * `rise` places the arc's top exactly, for a plate that has measured the
 * height every unit's box needs to stay clear.
 */
export function edgePath(a: Pt, b: Pt, fail: boolean, lift = 0, forceArc = false, rise?: number): string {
  if (!forceArc && (!fail || Math.abs(b.y - a.y) > 6)) {
    const mx = (a.x + b.x) / 2;
    return `M${a.x} ${a.y} C${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`;
  }
  const top = rise ?? Math.min(a.y, b.y) - 8 - Math.abs(a.x - b.x) * 0.1 - lift;
  return `M${a.x} ${a.y - 3} C${a.x} ${top} ${b.x} ${top} ${b.x} ${b.y - 3}`;
}

/**
 * The extent one axis of a cubic Bézier actually reaches, from its four
 * coordinates on that axis: the endpoints and any interior turning point.
 * A curve stays inside its control hull but rarely touches it, so bounds
 * read this instead of the control points — an arc's apex sits a quarter
 * of its height below its controls.
 */
export function cubicExtent(p0: number, p1: number, p2: number, p3: number): { min: number; max: number } {
  let min = Math.min(p0, p3);
  let max = Math.max(p0, p3);
  const at = (t: number): number => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  };
  const take = (t: number): void => {
    if (t > 0 && t < 1) {
      const value = at(t);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  };
  // The derivative over 3: a t² + b t + c.
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) {
      take(-c / b);
    }
    return { min, max };
  }
  const disc = b * b - 4 * a * c;
  if (disc >= 0) {
    const root = Math.sqrt(disc);
    take((-b + root) / (2 * a));
    take((-b - root) / (2 * a));
  }
  return { min, max };
}

/** A node's drawn half extents: a rotated gate's bounding box is the wider one. */
export function nodeBox(node: { shape: Kind; w: number; h: number }): { hw: number; hh: number } {
  const rot = GEOM[node.shape].rot !== 0;
  return {
    hw: rot ? (node.w * Math.SQRT2) / 2 : node.w / 2,
    hh: rot ? (node.h * Math.SQRT2) / 2 : node.h / 2,
  };
}

/** Gap between an arrowhead tip and the target border, in plate units. */
export const ARROW_MARGIN = 0.8;

/**
 * Pull an edge endpoint back so an arrowhead tip lands on the target's
 * border instead of hiding under its shape. `half` is the target's
 * half-extent along the arrival `axis`, `arrive` the arrival direction
 * (+1/-1; null follows the endpoint delta, for S-curves), and `bias` the
 * offset the path builder already applies on that axis (arcs end 3 short
 * of b). Returns b unchanged when the bias already covers the pullback
 * or the endpoints overlap with no room to shorten.
 */
export function shortenEdgeEnd(
  a: Pt,
  b: Pt,
  half: number,
  axis: "x" | "y",
  arrive: 1 | -1 | null,
  bias = 0,
  margin = ARROW_MARGIN,
): Pt {
  const pull = half + margin - bias;
  if (pull <= 0) {
    return b;
  }
  const delta = axis === "x" ? b.x - a.x : b.y - a.y;
  const dir = arrive ?? (delta === 0 ? 1 : Math.sign(delta));
  if (arrive === null && Math.abs(delta) < pull + 1.5) {
    return b;
  }
  return axis === "x" ? { x: b.x - dir * pull, y: b.y } : { x: b.x, y: b.y - dir * pull };
}
