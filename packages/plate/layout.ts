// SPDX-License-Identifier: Apache-2.0
/**
 * The plate layout engine: a validated graph document (format v6) becomes
 * placed nodes, ensemble groups and edge paths in the Canopy vocabulary.
 *
 * Ranks are longest paths from the entry over `pass`/`always`/route edges
 * and ensemble `on_pass_to` exits — an ensemble is one layout unit, fail
 * and error edges never rank — with a Kahn sweep that breaks cycles
 * deterministically at the lowest document order. Within a rank one
 * barycenter sweep orders units by their predecessors. Rank spacing is
 * constant; the viewBox grows with ranks and rows instead. The infra node
 * keeps its rank but is drawn once, in a separate lower lane.
 *
 * Everything here is total and deterministic: unknown shapes are skipped,
 * every sort has a full tiebreak, and there is no randomness — so plates
 * and their snapshots are stable byte for byte.
 */
import {
  classOf,
  isRankCondition,
  parseDocument,
  shapeOf,
  type EdgeClass,
  type EnsembleView,
  type NodeView,
  type ParsedGraph,
  type Strategy,
} from "./document.js";
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

/** One layout unit: a node or an ensemble, with its document order. */
export interface Unit {
  id: string;
  order: number;
  node: NodeView | null;
  ensemble: EnsembleView | null;
}

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
  /** The token's path along the main pass chain, null when there is none. */
  walk: string | null;
  walkSeconds: number;
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
 * Longest-path ranks over the rank edges: a Kahn sweep assigns each unit
 * one rank past its deepest processed predecessor, and when a cycle stalls
 * the sweep the lowest-order unprocessed unit breaks the deadlock — every
 * unit is placed exactly once, deterministically.
 */
function ranksOf(units: Unit[], rankEdges: Array<{ from: string; to: string }>): Map<string, number> {
  const rank = new Map<string, number>(units.map((unit) => [unit.id, 0]));
  const sources = new Map<string, Set<string>>(units.map((unit) => [unit.id, new Set()]));
  for (const edge of rankEdges) {
    if (edge.from !== edge.to && rank.has(edge.from) && rank.has(edge.to)) {
      sources.get(edge.to)?.add(edge.from);
    }
  }
  const done = new Set<string>();
  const ordered = [...units].sort((a, b) => a.order - b.order);
  while (done.size < units.length) {
    const next = ordered.find((unit) => !done.has(unit.id) && (sources.get(unit.id)?.size ?? 0) === 0) ??
      ordered.find((unit) => !done.has(unit.id));
    if (next === undefined) {
      break;
    }
    done.add(next.id);
    for (const edge of rankEdges) {
      if (edge.from !== next.id || !rank.has(edge.to) || done.has(edge.to)) {
        continue;
      }
      sources.get(edge.to)?.delete(edge.from);
      const deeper = (rank.get(next.id) ?? 0) + 1;
      if (deeper > (rank.get(edge.to) ?? 0)) {
        rank.set(edge.to, deeper);
      }
    }
  }
  return rank;
}

/** One rank edge: the forward step from one layout unit to the next. */
export interface RankEdge {
  from: string;
  to: string;
}

/**
 * A parsed graph ranked for layout: its units, the rank edges between them,
 * each unit's rank, the barycenter-ordered units per rank, the entry node
 * and the name-to-unit resolver. Both orientations rank identically; only
 * the geometry after this differs.
 */
export interface RankedGraph {
  units: Unit[];
  rankEdges: RankEdge[];
  rankOf: Map<string, number>;
  byRank: Map<number, Unit[]>;
  entry: NodeView | null;
  unitId: (name: string) => string | null;
}

/**
 * Rank a parsed graph: units in document order, longest-path ranks over the
 * rank edges, one barycenter sweep within each rank. Deterministic and
 * total — the same input ranks the same way for both orientations.
 */
export function rankUnits(parsed: ParsedGraph): RankedGraph {
  const nodeNames = new Set(parsed.nodes.map((node) => node.name));
  const ensembleNames = new Set(parsed.ensembles.map((ensemble) => ensemble.name));
  const unitId = (name: string): string | null => {
    if (nodeNames.has(name)) {
      return name;
    }
    if (name.startsWith("ensemble:") && ensembleNames.has(name.slice("ensemble:".length))) {
      return name;
    }
    return null;
  };

  // Layout units in document order: nodes by position, then ensembles.
  const sortedNodes = [...parsed.nodes].sort(
    (a, b) => a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const units: Unit[] = [
    ...sortedNodes.map((node, index) => ({ id: node.name, order: index, node, ensemble: null })),
    ...parsed.ensembles.map((ensemble, index) => ({
      id: `ensemble:${ensemble.name}`,
      order: sortedNodes.length + index,
      node: null,
      ensemble,
    })),
  ];
  // Rank edges: node pass/always/route edges, ensemble entries of those
  // classes, and every ensemble on_pass_to exit. Fail and error never rank.
  const rankEdges: RankEdge[] = [];
  for (const edge of parsed.edges) {
    if (!isRankCondition(edge.condition)) {
      continue;
    }
    const from = unitId(edge.from);
    const to = unitId(edge.to);
    if (from !== null && to !== null) {
      rankEdges.push({ from, to });
    }
  }
  for (const ensemble of parsed.ensembles) {
    const id = `ensemble:${ensemble.name}`;
    const entries = [
      ...(ensemble.entryFrom === null
        ? []
        : [{ from: ensemble.entryFrom, condition: ensemble.entryCondition }]),
      ...ensemble.extraEntries,
    ];
    for (const entry of entries) {
      if (!isRankCondition(entry.condition)) {
        continue;
      }
      const from = unitId(entry.from);
      if (from !== null) {
        rankEdges.push({ from, to: id });
      }
    }
    if (ensemble.onPassTo !== null) {
      const to = unitId(ensemble.onPassTo);
      if (to !== null) {
        rankEdges.push({ from: id, to });
      }
    }
  }

  // The entry is the main lane's start: a node with no incoming rank edge,
  // lowest position first. The infra lane never holds the entry.
  const targeted = new Set(rankEdges.map((edge) => edge.to));
  const candidates = sortedNodes.filter(
    (node) => node.name !== parsed.infra && !targeted.has(node.name),
  );
  const fallback = sortedNodes.filter((node) => node.name !== parsed.infra);
  const entry = candidates[0] ?? fallback[0] ?? sortedNodes[0] ?? null;

  const rankOf = ranksOf(units, rankEdges);

  // Within a rank, one barycenter sweep orders units by the mean order
  // index of their earlier-rank predecessors; rank zero and units without
  // predecessors keep document order.
  const byRank = new Map<number, Unit[]>();
  for (const unit of units) {
    const rank = rankOf.get(unit.id) ?? 0;
    byRank.set(rank, [...(byRank.get(rank) ?? []), unit]);
  }
  const predsOf = new Map<string, string[]>();
  for (const edge of rankEdges) {
    predsOf.set(edge.to, [...(predsOf.get(edge.to) ?? []), edge.from]);
  }
  const indexOf = new Map<string, number>();
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const list = (byRank.get(rank) ?? []).sort((a, b) => a.order - b.order);
    if (rank > 0) {
      const mean = new Map<string, number>();
      for (const unit of list) {
        const preds = (predsOf.get(unit.id) ?? []).filter(
          (pred) => (rankOf.get(pred) ?? 0) < rank && indexOf.has(pred),
        );
        mean.set(
          unit.id,
          preds.length === 0
            ? Number.POSITIVE_INFINITY
            : preds.reduce((sum, pred) => sum + (indexOf.get(pred) ?? 0), 0) / preds.length,
        );
      }
      list.sort(
        (a, b) => (mean.get(a.id) ?? 0) - (mean.get(b.id) ?? 0) || a.order - b.order,
      );
    }
    list.forEach((unit, index) => indexOf.set(unit.id, index));
    byRank.set(rank, list);
  }
  return { units, rankEdges, rankOf, byRank, entry, unitId };
}

/**
 * The token's chain: from the entry, the first outgoing pass edge in
 * document order, until it dead-ends or loops back. Centres come from the
 * placed layout, so both orientations walk the same chain.
 */
export function passChain(
  parsed: ParsedGraph,
  entry: NodeView | null,
  centres: Map<string, Pt>,
): Pt[] {
  if (entry === null) {
    return [];
  }
  const nodeNames = new Set(parsed.nodes.map((node) => node.name));
  const chain: Pt[] = [];
  const seen = new Set<string>();
  let current: string | null = entry.name;
  const first = centres.get(current);
  if (first !== undefined) {
    chain.push(first);
    seen.add(current);
  }
  const passOut = new Map<string, string>();
  for (const edge of parsed.edges) {
    if ((edge.condition === "pass" || edge.condition === "always" || isRankCondition(edge.condition)) &&
      !passOut.has(edge.from) && nodeNames.has(edge.from) && nodeNames.has(edge.to)) {
      passOut.set(edge.from, edge.to);
    }
  }
  for (const ensemble of parsed.ensembles) {
    if (ensemble.entryFrom !== null && !ensemble.entryFrom.startsWith("ensemble:") &&
      !passOut.has(ensemble.entryFrom) && isRankCondition(ensemble.entryCondition)) {
      passOut.set(ensemble.entryFrom, ensemble.name);
    }
    if (ensemble.onPassTo !== null && !ensemble.onPassTo.startsWith("ensemble:") &&
      nodeNames.has(ensemble.onPassTo)) {
      passOut.set(ensemble.name, ensemble.onPassTo);
    }
  }
  while (current !== null) {
    const next: string | null = passOut.get(current) ?? null;
    if (next === null || seen.has(next)) {
      break;
    }
    const point = centres.get(next);
    if (point === undefined) {
      break;
    }
    chain.push(point);
    seen.add(next);
    current = next;
  }
  return chain;
}

/**
 * The token's path along a chain: one leg per step through the
 * orientation's own edge curve, at 0.9 seconds a step. Null when the chain
 * is too short to walk.
 */
export function passWalk(
  chain: Pt[],
  leg: (a: Pt, b: Pt) => string,
): { walk: string; seconds: number } | null {
  if (chain.length < 2) {
    return null;
  }
  const legs = chain.slice(1).map((point, index) =>
    smooth(leg(chain[index] as Pt, point)).replace(/^M[^C]+/, "")
  );
  return {
    walk: `M${chain[0]?.x} ${chain[0]?.y}${legs.join("")}`,
    seconds: num((chain.length - 1) * 0.9),
  };
}

export function layoutPlate(document: unknown): PlateLayout | null {
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
    raw.push({ from: displayName(fromId), to: displayName(toId), cls: classOf(edge.condition), a, b });
  }
  for (const ensemble of parsed.ensembles) {
    const id = `ensemble:${ensemble.name}`;
    if (ensemble.entryFrom !== null) {
      const fromId = unitId(ensemble.entryFrom);
      const a = fromId === null ? null : pointOf(fromId, "right");
      const b = pointOf(id, "left");
      if (fromId !== null && a !== null && b !== null) {
        raw.push({
          from: displayName(fromId),
          to: ensemble.name,
          cls: classOf(ensemble.entryCondition),
          a,
          b,
        });
      }
    }
    for (const extra of ensemble.extraEntries) {
      const fromId = unitId(extra.from);
      const a = fromId === null ? null : pointOf(fromId, "right");
      const b = pointOf(id, "left");
      if (fromId !== null && a !== null && b !== null) {
        raw.push({ from: displayName(fromId), to: ensemble.name, cls: classOf(extra.condition), a, b });
      }
    }
    if (ensemble.onPassTo !== null) {
      const toId = unitId(ensemble.onPassTo);
      const a = pointOf(id, "right");
      const b = toId === null ? null : pointOf(toId, "left");
      if (toId !== null && a !== null && b !== null) {
        raw.push({ from: ensemble.name, to: displayName(toId), cls: "pass", a, b });
      }
    }
    if (ensemble.onFailTo !== null) {
      const toId = unitId(ensemble.onFailTo);
      const a = pointOf(id, "right");
      const b = toId === null ? null : pointOf(toId, "left");
      if (toId !== null && a !== null && b !== null) {
        raw.push({ from: ensemble.name, to: displayName(toId), cls: "fail", a, b });
      }
    }
    const group = groupByName.get(ensemble.name);
    if (group !== undefined) {
      for (let index = 0; index + 1 < group.members.length; index += 1) {
        const a = group.members[index];
        const b = group.members[index + 1];
        if (a !== undefined && b !== undefined) {
          raw.push({ from: ensemble.name, to: ensemble.name, cls: "order", a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
        }
      }
    }
  }

  // Fail arcs above the row lift further per back edge into one target.
  const arcIndex = new Map<string, number>();
  const liftOf = (edge: RawEdge): number => {
    if (edge.cls !== "fail" || Math.abs(edge.b.y - edge.a.y) > 6) {
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
    if (edge.cls === "fail" && Math.abs(edge.b.y - edge.a.y) <= 6) {
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
    d: smooth(edgePath(shift(edge.a), shift(edge.b), edge.cls === "fail", lifts.get(edge) ?? 0)),
  }));

  // The token walks the main pass chain through this orientation's curves.
  const centres = new Map<string, Pt>();
  for (const node of nodes) {
    centres.set(node.name, { x: node.x, y: node.y });
  }
  for (const group of groups) {
    centres.set(group.name, { x: group.x, y: group.y });
  }
  const walked = passWalk(
    passChain(parsed, entry, centres),
    (a, b) => edgePath(a, b, false),
  );

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
    walk: walked?.walk ?? null,
    walkSeconds: walked?.seconds ?? 0,
    order,
  };
}

/** Truncate a node label the way the plate draws it. */
export function plateLabel(name: string): string {
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}

/** The member chip geometry, shared with the renderer. */
export const MEMBER_GEOM = { w: MEMBER_W, h: MEMBER_H } as const;
