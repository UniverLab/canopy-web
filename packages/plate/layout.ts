// SPDX-License-Identifier: Apache-2.0
/**
 * The plate layout engine: a validated graph document (format v6) becomes
 * placed nodes, ensemble groups and edge paths in the Canopy vocabulary.
 *
 * Units arrive ranked from `./rank.js` — longest paths over the rank edges,
 * fail-only targets lifted into their own rank after the unit that fails
 * into them, one barycenter sweep within each rank — and this module places
 * them: rank spacing is constant; the viewBox grows with ranks and rows
 * instead. The infra node keeps its rank but is drawn once, in a separate
 * lower lane.
 *
 * Everything here is total and deterministic: unknown shapes are skipped,
 * every sort has a full tiebreak, and the only randomness is the walk's
 * own injected `random()` — whose default never fails a unit — so plates
 * and their snapshots stay stable byte for byte.
 */
import { classOf, parseDocument, shapeOf, type EdgeClass, type Strategy } from "./document.js";
import { rankUnits } from "./rank.js";
import { generateWalk, happyRandom, STEP_SECONDS, type WalkStep } from "./walk.js";
import { GEOM, TYPE, edgePath, type Kind, type Pt } from "./vocabulary.js";

/** The plate's two orientations: ranks left to right, or top to bottom. */
export type Orientation = "horizontal" | "vertical";

/** Constant horizontal step between ranks (viewBox units). */
export const RANK_DX = 26;
/** Vertical slot one main-lane node occupies. */
const NODE_SLOT = 16;
/** Vertical step between member chips inside a group. Shared with vertical.ts. */
export const MEMBER_DY = 7;
/** Member chip size. */
const MEMBER_W = 14;
const MEMBER_H = 4;
/** Head room (two label lines) and foot room inside a group outline. Shared with vertical.ts. */
export const GROUP_HEAD = 9;
export const GROUP_FOOT = 4;
/** Widest a group outline may grow: it must clear the neighbouring ranks. */
const GROUP_W_MAX = 38;
/** Gap between the main lane and the infra lane. Shared with vertical.ts. */
export const LANE_GAP = 20;
/** ViewBox padding. Shared with vertical.ts. */
export const PAD_X = 10;
export const PAD_TOP = 10;
export const PAD_BOTTOM = 10;
/** Extra arc height per same-row fail edge into one target. Shared with vertical.ts. */
export const LIFT_STEP = 4;
/** Node labels longer than this are truncated; the shape keeps the full name. */
export const LABEL_MAX = 16;
/** Ensemble names longer than this are truncated in the group label. */
const GROUP_NAME_MAX = 20;
/** Pixels per viewBox unit for the svg width/height attributes. */
export const PLATE_SCALE = 5;
/** Mono advance at the node-label type size, in viewBox units. Shared with vertical.ts. */
export const LABEL_CHAR = 2.3 * 0.6;
/** Mono advance at the group/member type size, in viewBox units. Shared with vertical.ts. */
export const GROUP_CHAR = TYPE.harness * 0.6;

export interface PlacedNode {
  name: string;
  shape: Kind;
  docKind: string;
  /** The node's harness stem for `--nc` and the harness label, if it names one. */
  harness: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rank: number;
  infra: boolean;
}

export interface PlacedMember {
  label: string;
  /** The member's harness stem for `--nc` and the harness label, if known. */
  harness: string | null;
  x: number;
  y: number;
}

export interface PlacedGroup {
  name: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rank: number;
  members: PlacedMember[];
}

export interface PlacedEdge {
  from: string;
  to: string;
  cls: EdgeClass;
  d: string;
}

export interface PlateLayout {
  name: string;
  orientation: Orientation;
  nodes: PlacedNode[];
  groups: PlacedGroup[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  /** The token's path along the walk, null when there is none. */
  walk: string | null;
  walkSeconds: number;
  /** The walk's fail legs, by the drawn edge they rode — the renderer lights these. */
  walkFails: WalkFail[];
  /** Node names in drawn order, for the svg `<desc>`. */
  order: string[];
}

/** Round to two decimals so paths print stably. */
export function num(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Round every decimal in a path string: midpoints print without float noise. */
export function smooth(d: string): string {
  return d.replace(/-?\d+\.\d+/g, (match) => String(num(Number(match))));
}

export function groupSubtitle(strategy: Strategy, minPass: number, count: number): string {
  if (strategy === "cascade") {
    return `CASCADE · ${count}`;
  }
  if (strategy === "round_robin") {
    return `ROUND ROBIN · ${count} members`;
  }
  return `PARALLEL · ${minPass}/${count}`;
}

export function groupTitle(name: string): string {
  const clipped = name.length > GROUP_NAME_MAX ? `${name.slice(0, GROUP_NAME_MAX - 1)}…` : name;
  return clipped.toUpperCase();
}

export function groupWidth(title: string, subtitle: string, members: string[]): number {
  const chars = Math.max(title.length, subtitle.length, ...members.map((m) => m.length));
  return Math.min(GROUP_W_MAX, Math.max(MEMBER_W + 4, chars * GROUP_CHAR + 6));
}

/**
 * Half the width of a node's drawn labels: the name below the shape, or the
 * harness line under it when that runs wider. Both centre on the node, so
 * the viewBox padding stays symmetric and the drawing centred.
 */
export function labelHalfOf(name: string, harness: string | null): number {
  const nameHalf = (Math.min(name.length, LABEL_MAX + 1) * LABEL_CHAR) / 2;
  const harnessHalf = harness === null ? 0 : (harness.length * GROUP_CHAR) / 2;
  return Math.max(nameHalf, harnessHalf);
}

/** The lowest point of a node: its harness line when it has one, else its label. */
export function nodeBottom(y: number, harness: string | null): number {
  return harness === null
    ? y + TYPE.labelDy + TYPE.label / 2
    : y + TYPE.harnessDy + TYPE.harness / 2;
}

/**
 * One drawn fail edge the walk rode, and the legs — zero-based indices
 * into the walk — it rode them on: the renderer lights exactly these.
 */
export interface WalkFail {
  from: string;
  to: string;
  legs: number[];
}

/**
 * The token's path over the walk's steps: one leg per step through the
 * orientation's own edge curve, at STEP_SECONDS a leg — fail legs alike,
 * at the same speed as pass ones. Each ridden fail edge is reported back
 * with the legs it carried, so the renderer can light it. Null when the
 * walk has no legs.
 */
export function plateWalk(
  steps: WalkStep[],
  centres: Map<string, Pt>,
  curve: (a: Pt, b: Pt, step: WalkStep) => string,
): { walk: string | null; seconds: number; fails: WalkFail[] } {
  const first = steps[0];
  const start = first === undefined ? undefined : centres.get(first.from);
  const legs: string[] = [];
  const fails = new Map<string, WalkFail>();
  if (start === undefined) {
    return { walk: null, seconds: 0, fails: [] };
  }
  for (const [index, step] of steps.entries()) {
    const a = centres.get(step.from);
    const b = centres.get(step.to);
    if (a === undefined || b === undefined) {
      break;
    }
    legs.push(smooth(curve(a, b, step)).replace(/^M[^C]+/, ""));
    if (step.fail) {
      const key = `${step.from}→${step.to}`;
      const ridden = fails.get(key) ?? { from: step.from, to: step.to, legs: [] };
      ridden.legs.push(index);
      fails.set(key, ridden);
    }
  }
  if (legs.length === 0) {
    return { walk: null, seconds: 0, fails: [] };
  }
  return {
    walk: `M${start.x} ${start.y}${legs.join("")}`,
    seconds: num(legs.length * STEP_SECONDS),
    fails: [...fails.values()],
  };
}

/**
 * Whether an edge arcs whatever the gap: a fail or error edge leaving or
 * entering an ensemble group. Both orientations read this one predicate —
 * such an edge never S-curves through the row or column.
 */
export function forceArcOf(cls: EdgeClass, fromId: string, toId: string): boolean {
  return (
    (cls === "fail" || cls === "error") &&
    (fromId.startsWith("ensemble:") || toId.startsWith("ensemble:"))
  );
}

export function layoutPlate(document: unknown, random: () => number = happyRandom): PlateLayout | null {
  const parsed = parseDocument(document);
  if (parsed === null) {
    return null;
  }
  const { byRank, entry, rankOf, unitId } = rankUnits(parsed);

  // Geometry in design coordinates: constant rank spacing, stacked ranks,
  // the infra node skipped in the main lane, members stacked in the group.
  const atX = new Map<string, number>();
  const atY = new Map<string, number>();
  const nodes: PlacedNode[] = [];
  const groups: PlacedGroup[] = [];
  let mainBottom = 0;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const x = num(rank * RANK_DX);
    let cursor = 0;
    for (const unit of byRank.get(rank) ?? []) {
      atX.set(unit.id, x);
      if (unit.node !== null && unit.node.name === parsed.infra) {
        continue;
      }
      if (unit.node !== null) {
        const y = num(cursor + NODE_SLOT / 2);
        cursor += NODE_SLOT;
        atY.set(unit.id, y);
        const shape = shapeOf(
          unit.node.docKind,
          unit.node.name,
          unit.node.commitRights,
          entry !== null && unit.node.name === entry.name,
        );
        nodes.push({
          name: unit.node.name,
          shape,
          docKind: unit.node.docKind,
          harness: unit.node.harness,
          x,
          y,
          w: GEOM[shape].w,
          h: GEOM[shape].h,
          rank,
          infra: false,
        });
        mainBottom = Math.max(mainBottom, nodeBottom(y, unit.node.harness));
      } else if (unit.ensemble !== null) {
        const title = groupTitle(unit.ensemble.name);
        const subtitle = groupSubtitle(
          unit.ensemble.strategy,
          unit.ensemble.minPass,
          unit.ensemble.members.length,
        );
        const w = num(groupWidth(title, subtitle, unit.ensemble.members));
        const h = num(GROUP_HEAD + unit.ensemble.members.length * MEMBER_DY + GROUP_FOOT);
        const y = num(cursor + h / 2);
        cursor += h + 4;
        atY.set(unit.id, y);
        const members = unit.ensemble.members.map((label, index) => ({
          label,
          harness: unit.ensemble?.memberHarness[index] ?? null,
          x,
          y: num(y - h / 2 + GROUP_HEAD + index * MEMBER_DY + MEMBER_DY / 2),
        }));
        groups.push({ name: unit.ensemble.name, title, subtitle, x, y, w, h, rank, members });
        mainBottom = Math.max(mainBottom, y + h / 2);
      }
    }
  }
  if (parsed.infra !== null) {
    const node = parsed.nodes.find((candidate) => candidate.name === parsed.infra);
    const rank = rankOf.get(parsed.infra) ?? 0;
    if (node !== undefined) {
      const x = num(rank * RANK_DX);
      const y = num(mainBottom + LANE_GAP);
      atX.set(node.name, x);
      atY.set(node.name, y);
      const shape = shapeOf(node.docKind, node.name, node.commitRights, false);
      nodes.push({
        name: node.name,
        shape,
        docKind: node.docKind,
        harness: node.harness,
        x,
        y,
        w: GEOM[shape].w,
        h: GEOM[shape].h,
        rank,
        infra: true,
      });
    }
  }

  // Edge endpoints: node centres, group flanks for ensemble wiring.
  const groupByName = new Map(groups.map((group) => [group.name, group]));
  const pointOf = (name: string, flank: "left" | "right" | "centre"): Pt | null => {
    if (name.startsWith("ensemble:")) {
      const group = groupByName.get(name.slice("ensemble:".length));
      if (group === undefined) {
        return null;
      }
      const x = flank === "left" ? group.x - group.w / 2 : flank === "right" ? group.x + group.w / 2 : group.x;
      return { x: num(x), y: group.y };
    }
    const x = atX.get(name);
    const y = atY.get(name);
    return x === undefined || y === undefined ? null : { x, y };
  };
  const displayName = (name: string): string =>
    name.startsWith("ensemble:") ? name.slice("ensemble:".length) : name;

  interface RawEdge {
    from: string;
    to: string;
    cls: EdgeClass;
    a: Pt;
    b: Pt;
    forceArc: boolean;
  }
  const raw: RawEdge[] = [];
  for (const edge of parsed.edges) {
    const fromId = unitId(edge.from);
    const toId = unitId(edge.to);
    if (fromId === null || toId === null) {
      continue;
    }
    const a = pointOf(fromId, "right");
    const b = pointOf(toId, "left");
    if (a === null || b === null) {
      continue;
    }
    const cls = classOf(edge.condition);
    raw.push({
      from: displayName(fromId),
      to: displayName(toId),
      cls,
      a,
      b,
      forceArc: forceArcOf(cls, fromId, toId),
    });
  }
  for (const ensemble of parsed.ensembles) {
    const id = `ensemble:${ensemble.name}`;
    if (ensemble.entryFrom !== null) {
      const fromId = unitId(ensemble.entryFrom);
      const a = fromId === null ? null : pointOf(fromId, "right");
      const b = pointOf(id, "left");
      if (fromId !== null && a !== null && b !== null) {
        const cls = classOf(ensemble.entryCondition);
        raw.push({
          from: displayName(fromId),
          to: ensemble.name,
          cls,
          a,
          b,
          forceArc: forceArcOf(cls, fromId, id),
        });
      }
    }
    for (const extra of ensemble.extraEntries) {
      const fromId = unitId(extra.from);
      const a = fromId === null ? null : pointOf(fromId, "right");
      const b = pointOf(id, "left");
      if (fromId !== null && a !== null && b !== null) {
        const cls = classOf(extra.condition);
        raw.push({
          from: displayName(fromId),
          to: ensemble.name,
          cls,
          a,
          b,
          forceArc: forceArcOf(cls, fromId, id),
        });
      }
    }
    if (ensemble.onPassTo !== null) {
      const toId = unitId(ensemble.onPassTo);
      const a = pointOf(id, "right");
      const b = toId === null ? null : pointOf(toId, "left");
      if (toId !== null && a !== null && b !== null) {
        raw.push({ from: ensemble.name, to: displayName(toId), cls: "pass", a, b, forceArc: false });
      }
    }
    if (ensemble.onFailTo !== null) {
      const toId = unitId(ensemble.onFailTo);
      const a = pointOf(id, "right");
      const b = toId === null ? null : pointOf(toId, "left");
      if (toId !== null && a !== null && b !== null) {
        raw.push({
          from: ensemble.name,
          to: displayName(toId),
          cls: "fail",
          a,
          b,
          forceArc: forceArcOf("fail", id, toId),
        });
      }
    }
    const group = groupByName.get(ensemble.name);
    if (group !== undefined) {
      for (let index = 0; index + 1 < group.members.length; index += 1) {
        const a = group.members[index];
        const b = group.members[index + 1];
        if (a !== undefined && b !== undefined) {
          raw.push({
            from: ensemble.name,
            to: ensemble.name,
            cls: "order",
            a: { x: a.x, y: a.y },
            b: { x: b.x, y: b.y },
            forceArc: false,
          });
        }
      }
    }
  }

  /** Whether an edge draws as an arc above the row: forced, or a same-row fail. */
  const arcs = (edge: RawEdge): boolean =>
    edge.forceArc || (edge.cls === "fail" && Math.abs(edge.b.y - edge.a.y) <= 6);

  // Fail arcs above the row lift further per back edge into one target.
  const arcIndex = new Map<string, number>();
  const liftOf = (edge: RawEdge): number => {
    if (!arcs(edge)) {
      return 0;
    }
    const key = edge.to;
    const index = arcIndex.get(key) ?? 0;
    arcIndex.set(key, index + 1);
    return index * LIFT_STEP;
  };
  const orderedRaw = [...raw].sort(
    (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );
  const lifts = new Map<RawEdge, number>(orderedRaw.map((edge) => [edge, liftOf(edge)]));

  // Bounds: shapes, group outlines, labels, and fail-arc tops — the viewBox
  // grows around all of them, then everything shifts into positive space.
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const span = (x0: number, x1: number, y0: number, y1: number): void => {
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
    minY = Math.min(minY, y0);
    maxY = Math.max(maxY, y1);
  };
  for (const node of nodes) {
    const labelHalf = labelHalfOf(node.name, node.harness);
    span(
      Math.min(node.x - node.w / 2, node.x - labelHalf),
      Math.max(node.x + node.w / 2, node.x + labelHalf),
      node.y - node.h / 2,
      nodeBottom(node.y, node.harness),
    );
  }
  for (const group of groups) {
    span(group.x - group.w / 2, group.x + group.w / 2, group.y - group.h / 2, group.y + group.h / 2);
  }
  for (const edge of raw) {
    if (arcs(edge)) {
      const lift = lifts.get(edge) ?? 0;
      const rise = Math.min(edge.a.y, edge.b.y) - 8 - Math.abs(edge.a.x - edge.b.x) * 0.1 - lift;
      minY = Math.min(minY, rise, edge.a.y - 3, edge.b.y - 3);
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 0;
    minY = 0;
    maxY = 0;
  }
  const dx = PAD_X - minX;
  const dy = PAD_TOP - minY;
  const shift = (point: Pt): Pt => ({ x: num(point.x + dx), y: num(point.y + dy) });
  for (const node of nodes) {
    node.x = num(node.x + dx);
    node.y = num(node.y + dy);
  }
  for (const group of groups) {
    group.x = num(group.x + dx);
    group.y = num(group.y + dy);
    for (const member of group.members) {
      member.x = num(member.x + dx);
      member.y = num(member.y + dy);
    }
  }
  const edges: PlacedEdge[] = raw.map((edge) => ({
    from: edge.from,
    to: edge.to,
    cls: edge.cls,
    d: smooth(
      edgePath(shift(edge.a), shift(edge.b), edge.cls === "fail", lifts.get(edge) ?? 0, edge.forceArc),
    ),
  }));

  // The token walks the walk — the pass chain with its fail detours —
  // through this orientation's curves. A fail leg rides the arc of the
  // drawn fail edge it took, at the same curve lift, centre to centre.
  const centres = new Map<string, Pt>();
  for (const node of nodes) {
    centres.set(node.name, { x: node.x, y: node.y });
  }
  for (const group of groups) {
    centres.set(group.name, { x: group.x, y: group.y });
  }
  const steps = generateWalk(parsed, entry === null ? null : entry.name, new Set(centres.keys()), random);
  const failStyle = new Map<string, { lift: number; forceArc: boolean }>();
  for (const edge of raw) {
    if (edge.cls !== "fail") {
      continue;
    }
    const key = `${edge.from}→${edge.to}`;
    if (!failStyle.has(key)) {
      failStyle.set(key, { lift: lifts.get(edge) ?? 0, forceArc: edge.forceArc });
    }
  }
  const walked = plateWalk(steps, centres, (a, b, step) => {
    const style = step.fail === true ? failStyle.get(`${step.from}→${step.to}`) : undefined;
    return edgePath(a, b, step.fail, style?.lift ?? 0, style?.forceArc ?? false);
  });

  const order = [...nodes]
    .sort((a, b) => a.rank - b.rank || a.y - b.y || (a.name < b.name ? -1 : 1))
    .map((node) => node.name);

  return {
    name: parsed.name,
    orientation: "horizontal",
    nodes,
    groups,
    edges,
    width: num(maxX - minX + PAD_X * 2),
    height: num(maxY - minY + PAD_TOP + PAD_BOTTOM),
    walk: walked.walk,
    walkSeconds: walked.seconds,
    walkFails: walked.fails,
    order,
  };
}

/** Truncate a node label the way the plate draws it. */
export function plateLabel(name: string): string {
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}

/** The member chip geometry, shared with the renderer. */
export const MEMBER_GEOM = { w: MEMBER_W, h: MEMBER_H } as const;
