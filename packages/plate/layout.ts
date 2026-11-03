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
 * lower lane. The handlers — units that end a failure rather than carry the
 * flow (`./handlers.js`) — leave the column for a side lane at mid height,
 * where their grouped inputs collapse into one bus per class.
 *
 * Edges never cut through the column: a range-skipping or back edge arcs
 * outside the flow the way a fail edge does, and every drawn edge that
 * touches the lane runs outside the column and enters through the gutter.
 *
 * Everything here is total and deterministic: unknown shapes are skipped,
 * every sort has a full tiebreak, and the only randomness is the walk's
 * own injected `random()` — whose default never fails a unit — so plates
 * and their snapshots stay stable byte for byte.
 */
import { parseDocument, shapeOf, type EdgeClass, type EnsembleView, type NodeView, type Strategy } from "./document.js";
import { flowOf, type LaneEdge } from "./flow.js";
import { doneUnitsOf, handlersOf, type Handler } from "./handlers.js";
import {
  DONE_DY,
  DONE_HALF,
  LANE_RISE,
  MARK_HALF,
  horizontalRoute,
  laneGroups,
  lanePath,
  shiftedLane,
  type Extent,
  type Lane,
  type LaneSpan,
  type DoneSpot,
  type PlacedBus,
  type PlacedDone,
  type PlacedMark,
} from "./lane.js";
import { rankUnits } from "./rank.js";
import { generateWalk, happyRandom, plateWalk, type WalkFail } from "./walk.js";
import { GEOM, TYPE, edgePath, num, nodeBox, shortenEdgeEnd, smooth, type Kind, type Pt } from "./vocabulary.js";

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
  lane: Lane;
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
  /** The short marks the grouped inputs carry, one per source and class. */
  marks: PlacedMark[];
  /** One bus per handler and class, entering the handler from the lane side. */
  buses: PlacedBus[];
  /** The `✓ done` terminals under the units the flow ends on. */
  dones: PlacedDone[];
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

/** A unit id as the plate draws it: ensembles lose the `ensemble:` prefix. */
export function drawnName(id: string): string {
  return id.startsWith("ensemble:") ? id.slice("ensemble:".length) : id;
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

/** One unit the handler lane places, with the drawn half extents it needs. */
interface LaneItem {
  handler: Handler;
  node: NodeView | null;
  group: EnsembleView | null;
  hw: number;
  hh: number;
}

export function layoutPlate(document: unknown, random: () => number = happyRandom): PlateLayout | null {
  const parsed = parseDocument(document);
  if (parsed === null) {
    return null;
  }
  const { byRank, entry, rankOf, unitId, units } = rankUnits(parsed);
  const orderOf = new Map(units.map((unit) => [unit.id, unit.order]));
  const unitOrder = (id: string): number => orderOf.get(id) ?? Number.MAX_SAFE_INTEGER;
  const handlers = handlersOf(parsed, unitId, unitOrder);
  const doneUnits = doneUnitsOf(parsed, unitId, unitOrder, handlers);

  // Geometry in design coordinates: constant rank spacing, stacked ranks,
  // the infra node skipped in the main lane, members stacked in the group.
  const atX = new Map<string, number>();
  const atY = new Map<string, number>();
  const nodes: PlacedNode[] = [];
  const groups: PlacedGroup[] = [];
  let mainBottom = 0;
  let mainTop = Number.POSITIVE_INFINITY;
  let mainLeft = Number.POSITIVE_INFINITY;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const x = num(rank * RANK_DX);
    let cursor = 0;
    for (const unit of byRank.get(rank) ?? []) {
      atX.set(unit.id, x);
      if (handlers.has(unit.id)) {
        continue;
      }
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
        const placed: PlacedNode = {
          name: unit.node.name,
          shape,
          docKind: unit.node.docKind,
          harness: unit.node.harness,
          x,
          y,
          w: GEOM[shape].w,
          h: GEOM[shape].h,
          rank,
          lane: "main",
        };
        nodes.push(placed);
        mainBottom = Math.max(mainBottom, nodeBottom(y, unit.node.harness));
        const box = nodeBox(placed);
        mainTop = Math.min(mainTop, y - box.hh);
        mainLeft = Math.min(mainLeft, x - box.hw);
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
        mainTop = Math.min(mainTop, y - h / 2);
        mainLeft = Math.min(mainLeft, x - w / 2);
      }
    }
  }
  if (!Number.isFinite(mainTop)) {
    mainTop = 0;
  }
  if (!Number.isFinite(mainLeft)) {
    mainLeft = 0;
  }
  if (parsed.infra !== null && !handlers.has(parsed.infra)) {
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
        lane: "infra",
      });
    }
  }

  // The handler lane: one legend-free column left of the flow, at mid
  // height, its units stacked in document order. Each lane edge and bus
  // runs in the channel beside it, so nothing crosses the column.
  const laneItems: LaneItem[] = [];
  for (const handler of handlers.list) {
    const node = parsed.nodes.find((candidate) => candidate.name === handler.id);
    if (node !== undefined) {
      const shape = shapeOf(
        node.docKind,
        node.name,
        node.commitRights,
        entry !== null && node.name === entry.name,
      );
      const box = nodeBox({ shape, w: GEOM[shape].w, h: GEOM[shape].h });
      laneItems.push({ handler, node, group: null, ...box });
    } else {
      const ensemble = parsed.ensembles.find((candidate) => `ensemble:${candidate.name}` === handler.id);
      if (ensemble === undefined) {
        continue;
      }
      const title = groupTitle(ensemble.name);
      const subtitle = groupSubtitle(ensemble.strategy, ensemble.minPass, ensemble.members.length);
      const w = num(groupWidth(title, subtitle, ensemble.members));
      const h = num(GROUP_HEAD + ensemble.members.length * MEMBER_DY + GROUP_FOOT);
      laneItems.push({ handler, node: null, group: ensemble, hw: w / 2, hh: h / 2 });
    }
  }
  let lane: LaneSpan | null = null;
  if (laneItems.length > 0) {
    const maxHalf = Math.max(...laneItems.map((item) => item.hw));
    const laneX = num(mainLeft - LANE_GAP - maxHalf);
    const mid = num((mainTop + mainBottom) / 2);
    const slots = laneItems.map((item) => Math.max(NODE_SLOT, item.hh * 2 + 4));
    const total = slots.reduce((sum, slot) => sum + slot, 0);
    let cursor = mid - total / 2;
    for (const [index, item] of laneItems.entries()) {
      const slot = slots[index] ?? NODE_SLOT;
      const y = num(cursor + slot / 2);
      cursor += slot;
      const { handler } = item;
      const rank = rankOf.get(handler.id) ?? 0;
      atX.set(handler.id, laneX);
      atY.set(handler.id, y);
      if (item.node !== null) {
        const shape = shapeOf(
          item.node.docKind,
          item.node.name,
          item.node.commitRights,
          entry !== null && item.node.name === entry.name,
        );
        nodes.push({
          name: item.node.name,
          shape,
          docKind: item.node.docKind,
          harness: item.node.harness,
          x: laneX,
          y,
          w: GEOM[shape].w,
          h: GEOM[shape].h,
          rank,
          lane: "handler",
        });
      } else if (item.group !== null) {
        const ensemble = item.group;
        const title = groupTitle(ensemble.name);
        const subtitle = groupSubtitle(ensemble.strategy, ensemble.minPass, ensemble.members.length);
        const w = num(groupWidth(title, subtitle, ensemble.members));
        const h = num(GROUP_HEAD + ensemble.members.length * MEMBER_DY + GROUP_FOOT);
        const members = ensemble.members.map((label, memberIndex) => ({
          label,
          harness: ensemble.memberHarness[memberIndex] ?? null,
          x: laneX,
          y: num(y - h / 2 + GROUP_HEAD + memberIndex * MEMBER_DY + MEMBER_DY / 2),
        }));
        groups.push({ name: ensemble.name, title, subtitle, x: laneX, y, w, h, rank, members });
      }
    }
    lane = {
      left: num(laneX - maxHalf),
      right: num(laneX + maxHalf),
      gutter: num(laneX + maxHalf + LANE_GAP / 2),
      corridor: num(mainTop - LANE_RISE),
    };
  }

  // Every placed unit's drawn extent, by drawn name: marks sit outside the
  // left edge, lane routes measure their way in and out of the column.
  const extent = new Map<string, Extent>();
  for (const node of nodes) {
    extent.set(node.name, { x: node.x, y: node.y, ...nodeBox(node) });
  }
  for (const group of groups) {
    extent.set(group.name, { x: group.x, y: group.y, hw: group.w / 2, hh: group.h / 2 });
  }

  // Grouped inputs: one short mark on each source, one bus per handler and
  // class, measured in design coordinates and shifted with the drawing.
  const { marks: markSpots, buses: busSpots } = laneGroups(
    handlers,
    extent,
    lane === null ? 0 : lane.left,
  );
  const doneSpots: DoneSpot[] = doneUnits.flatMap((done) => {
    const node = nodes.find((placed) => placed.name === done.id);
    return node === undefined
      ? []
      : [{ name: node.name, x: node.x, y: num(nodeBottom(node.y, node.harness) + DONE_DY) }];
  });

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
  const displayName = drawnName;
  /** Whether an arc's vertical rise at `point` misses every other drawn unit. */
  const riseClear = (fromId: string, toId: string, point: Pt, target: Pt): boolean => {
    const rise = mainTop - 8 - Math.abs(point.x - target.x) * 0.1;
    const top = Math.min(point.y, rise);
    const bottom = Math.max(point.y, rise);
    for (const [name, box] of extent) {
      if (name === drawnName(fromId) || name === drawnName(toId)) {
        continue;
      }
      if (Math.abs(point.x - box.x) >= box.hw) {
        continue;
      }
      if (box.y + box.hh > top && box.y - box.hh < bottom) {
        return false;
      }
    }
    return true;
  };
  /**
   * The flank an edge leaves from: the side its target lies on, unless the
   * arc's rise there would pass through a neighbour — wide group boxes
   * overlap the next rank's x band, so a flank is not always outside.
   */
  const fromPoint = (fromId: string, toId: string, target: Pt): Pt | null => {
    const centre = atX.get(fromId) ?? 0;
    const preferred = target.x < centre ? "left" : "right";
    const first = pointOf(fromId, preferred);
    const second = pointOf(fromId, preferred === "left" ? "right" : "left");
    if (first === null) {
      return null;
    }
    if (second === null || riseClear(fromId, toId, first, target)) {
      return first;
    }
    return riseClear(fromId, toId, second, target) ? second : first;
  };

  interface RawEdge {
    from: string;
    to: string;
    cls: EdgeClass;
    a: Pt;
    b: Pt;
    forceArc: boolean;
  }
  const flow = flowOf(parsed, unitId, handlers);
  const raw: RawEdge[] = [];
  for (const edge of flow.drawn) {
    const b = pointOf(edge.to, "left");
    const a = b === null ? null : fromPoint(edge.from, edge.to, b);
    if (a === null || b === null) {
      continue;
    }
    raw.push({
      from: displayName(edge.from),
      to: displayName(edge.to),
      cls: edge.cls,
      a,
      b,
      forceArc: forceArcOf(edge.cls, edge.from, edge.to),
    });
  }
  const laneRoutes: LaneEdge[] =
    lane === null
      ? []
      : flow.lane.map((edge) => ({
          ...edge,
          from: displayName(edge.from),
          to: displayName(edge.to),
        }));
  for (const ensemble of parsed.ensembles) {
    const group = groupByName.get(ensemble.name);
    if (group === undefined) {
      continue;
    }
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

  // A unit's rank, by drawn name: an edge that skips a rank or walks back
  // one never crosses the column, it curves outside like a fail edge.
  const rankByName = new Map<string, number>();
  for (const node of nodes) {
    rankByName.set(node.name, node.rank);
  }
  for (const group of groups) {
    rankByName.set(group.name, group.rank);
  }
  const outside = (edge: RawEdge): boolean => {
    const from = rankByName.get(edge.from);
    const to = rankByName.get(edge.to);
    return edge.cls !== "order" && from !== undefined && to !== undefined && to - from !== 1;
  };

  /**
   * Whether an edge draws as an arc above the row: forced, a same-row fail,
   * or a range-skipping or back edge — never straight over the axis.
   */
  const arcs = (edge: RawEdge): boolean =>
    edge.forceArc || (edge.cls === "fail" && Math.abs(edge.b.y - edge.a.y) <= 6) || outside(edge);

  /**
   * Where an arc crosses above the row: over every drawn unit, so a long
   * back edge shoots its corner above the tall group boxes instead of
   * through them.
   */
  const arcRise = (a: Pt, b: Pt, lift: number): number =>
    mainTop - 8 - Math.abs(a.x - b.x) * 0.1 - lift;

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

  // Bounds: shapes, group outlines, labels, fail-arc tops, marks, buses,
  // done terminals and lane routes — the viewBox grows around all of them,
  // then everything shifts into positive space.
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
  for (const spot of markSpots) {
    span(spot.x - MARK_HALF, spot.x + MARK_HALF, spot.y - MARK_HALF, spot.y + MARK_HALF);
  }
  for (const spot of busSpots) {
    span(spot.x, spot.hx, spot.top, spot.hy);
  }
  for (const spot of doneSpots) {
    span(spot.x - DONE_HALF, spot.x + DONE_HALF, spot.y - 2, spot.y + 0.6);
  }
  if (lane !== null) {
    for (const route of laneRoutes) {
      const points = horizontalRoute(route, extent, lane);
      for (const point of points ?? []) {
        span(point.x, point.x, point.y, point.y);
      }
    }
  }
  for (const edge of raw) {
    if (arcs(edge)) {
      const rise = arcRise(edge.a, edge.b, lifts.get(edge) ?? 0);
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
  const shiftedExtent = new Map<string, Extent>();
  for (const node of nodes) {
    shiftedExtent.set(node.name, { x: node.x, y: node.y, ...nodeBox(node) });
  }
  for (const group of groups) {
    shiftedExtent.set(group.name, { x: group.x, y: group.y, hw: group.w / 2, hh: group.h / 2 });
  }
  const shiftedSpan: LaneSpan | null =
    lane === null
      ? null
      : {
          left: num(lane.left + dx),
          right: num(lane.right + dx),
          gutter: num(lane.gutter + dx),
          corridor: num(lane.corridor + dy),
        };
  const { marks, buses, dones } = shiftedLane({ marks: markSpots, buses: busSpots, dones: doneSpots }, dx, dy);
  const laneEdges: PlacedEdge[] = [];
  if (shiftedSpan !== null) {
    for (const route of laneRoutes) {
      const points = horizontalRoute(route, shiftedExtent, shiftedSpan);
      if (points === null || points.length < 2) {
        continue;
      }
      laneEdges.push({ from: route.from, to: route.to, cls: route.cls, d: smooth(lanePath(points)) });
    }
  }
  const targetOf = new Map<string, { hx: number; hy: number; group: boolean }>();
  for (const node of nodes) {
    const rot = GEOM[node.shape].rot !== 0;
    targetOf.set(node.name, {
      hx: ((rot ? node.w * Math.SQRT2 : node.w) / 2),
      hy: ((rot ? node.h * Math.SQRT2 : node.h) / 2),
      group: false,
    });
  }
  for (const group of groups) {
    targetOf.set(group.name, { hx: group.w / 2, hy: group.h / 2, group: true });
  }
  const edges: PlacedEdge[] = [
    ...raw.map((edge) => {
      const a = shift(edge.a);
      const b = shift(edge.b);
      // Arrowhead tips land on the target border: node endpoints sit on
      // centres, so both branches shorten; group endpoints already sit on
      // the box border, except arcs, whose -3 end dives inside the box.
      const target = edge.cls === "order" ? undefined : targetOf.get(edge.to);
      const arc = arcs(edge);
      let end = b;
      if (target !== undefined && (!target.group || arc)) {
        end = arc
          ? shortenEdgeEnd(a, b, target.hy, "y", 1, 3)
          : shortenEdgeEnd(a, b, target.hx, "x", null, 0);
      }
      return {
        from: edge.from,
        to: edge.to,
        cls: edge.cls,
        d: smooth(
          edgePath(
            a,
            end,
            edge.cls === "fail",
            lifts.get(edge) ?? 0,
            arc,
            arc ? arcRise(edge.a, edge.b, lifts.get(edge) ?? 0) : undefined,
          ),
        ),
      };
    }),
    ...laneEdges,
  ];

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
  const failStyle = new Map<string, { lift: number; forceArc: boolean; rise?: number }>();
  for (const edge of raw) {
    if (edge.cls !== "fail") {
      continue;
    }
    const key = `${edge.from}→${edge.to}`;
    if (!failStyle.has(key)) {
      const lift = lifts.get(edge) ?? 0;
      failStyle.set(key, {
        lift,
        forceArc: edge.forceArc,
        rise: arcs(edge) ? arcRise(edge.a, edge.b, lift) : undefined,
      });
    }
  }
  const walked = plateWalk(steps, centres, (a, b, step) => {
    const style = step.fail === true ? failStyle.get(`${step.from}→${step.to}`) : undefined;
    return edgePath(a, b, step.fail, style?.lift ?? 0, style?.forceArc ?? false, style?.rise);
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
    marks,
    buses,
    dones,
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
