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
 * flow (`./handlers.js`) — leave it for a horizontal band below the main
 * flow and above the infra lane, where each handler's inputs form one bus.
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
import { parseDocument, shapeOf, type EdgeClass } from "./document.js";
import { flowOf, type LaneEdge } from "./flow.js";
import { doneUnitsOf, handlersOf } from "./handlers.js";
import {
  DONE_DY,
  DONE_HALF,
  MARK_HALF,
  bandRoute,
  laneGroups,
  lanePath,
  shiftedBand,
  shiftedLane,
  type BandBounds,
  type BandBusSpot,
  type BandSpan,
  type BusSpot,
  type Extent,
  type DoneSpot,
  type MarkSpot,
  type PlacedBus,
  type PlacedDone,
  type PlacedMark,
} from "./lane.js";
import { rankUnits } from "./rank.js";
import { generateWalk, happyRandom, plateWalk, type WalkFail } from "./walk.js";
import { GEOM, edgePath, num, nodeBox, shortenEdgeEnd, smooth, type Pt } from "./vocabulary.js";
import {
  GROUP_CHAR,
  GROUP_FOOT,
  GROUP_HEAD,
  MEMBER_DY,
  drawnName,
  groupSubtitle,
  groupTitle,
  groupWidth,
  markBandInfraSources,
  nodeBottom,
  placeHandlerBand,
  type PlacedGroup,
  type PlacedNode,
} from "./units.js";

/** The shared unit geometry, re-exported so every importer keeps one address. */
export {
  GROUP_CHAR,
  GROUP_FOOT,
  GROUP_HEAD,
  MEMBER_DY,
  MEMBER_GEOM,
  drawnName,
  groupSubtitle,
  groupTitle,
  groupWidth,
  nodeBottom,
  type PlacedGroup,
  type PlacedMember,
  type PlacedNode,
} from "./units.js";

/** The plate's two orientations: ranks left to right, or top to bottom. */
export type Orientation = "horizontal" | "vertical";

/** Constant horizontal step between ranks (viewBox units). */
export const RANK_DX = 26;
/** Vertical slot one main-lane node occupies. */
const NODE_SLOT = 16;
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
/** Pixels per viewBox unit for the svg width/height attributes. */
export const PLATE_SCALE = 5;
/** Mono advance at the node-label type size, in viewBox units. Shared with vertical.ts. */
export const LABEL_CHAR = 2.3 * 0.6;
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
  let mainRight = Number.NEGATIVE_INFINITY;
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
        const labelHalf = labelHalfOf(unit.node.name, unit.node.harness);
        mainLeft = Math.min(mainLeft, x - box.hw, x - labelHalf);
        mainRight = Math.max(mainRight, x + box.hw, x + labelHalf);
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
        mainRight = Math.max(mainRight, x + w / 2);
      }
    }
  }
  if (!Number.isFinite(mainTop)) {
    mainTop = 0;
  }
  if (!Number.isFinite(mainLeft)) {
    mainLeft = 0;
  }
  if (!Number.isFinite(mainRight)) {
    mainRight = 0;
  }

  // The handler band: a horizontal band below the main flow, between the
  // main flow and the infra lane, its units in document order. Buses drop
  // from the sources straight down; lane edges return outside the flow.
  const bandBounds: BandBounds = {
    mainLeft,
    mainRight,
    mainTop,
    mainBottom,
    gap: RANK_DX,
    laneGap: LANE_GAP,
  };
  const { band, units: laneItems, mainExtent } = placeHandlerBand({
    handlers,
    parsed,
    entry,
    rankOf,
    rankX: (id) => (rankOf.get(id) ?? 0) * RANK_DX,
    bounds: bandBounds,
    nodes,
    groups,
    atX,
    atY,
  });
  if (parsed.infra !== null && !handlers.has(parsed.infra)) {
    const node = parsed.nodes.find((candidate) => candidate.name === parsed.infra);
    const rank = rankOf.get(parsed.infra) ?? 0;
    if (node !== undefined) {
      const x = num(rank * RANK_DX);
      const y = num((band === null ? mainBottom : band.bottom) + LANE_GAP);
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

  // Every placed unit's drawn extent, by drawn name: band marks sit below
  // the sources, band routes measure their way under and around the flow.
  const extent = new Map<string, Extent>();
  for (const node of nodes) {
    extent.set(node.name, {
      x: node.x,
      y: node.y,
      ...nodeBox(node),
      bottom: nodeBottom(0, node.harness),
    });
  }
  for (const group of groups) {
    extent.set(group.name, {
      x: group.x,
      y: group.y,
      hw: group.w / 2,
      hh: group.h / 2,
      bottom: group.h / 2,
    });
  }

  // Grouped inputs: one short mark on each source, one bus per handler and
  // class, measured in design coordinates and shifted with the drawing.
  // Without handlers the plate keeps its old drawing, byte for byte.
  let markSpots: MarkSpot[] = [];
  let busSpots: BusSpot[] = [];
  let bandBusSpots: BandBusSpot[] = [];
  if (band === null) {
    const grouped = laneGroups(handlers, extent, 0);
    markSpots = grouped.marks;
    busSpots = grouped.buses;
  } else {
    markSpots = [...band.marks];
    bandBusSpots = band.buses;
    markBandInfraSources({ units: laneItems, extent, mainExtent, band, marks: markSpots });
  }
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
    band === null
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
  for (const spot of bandBusSpots) {
    for (const drop of spot.drops) {
      span(drop.x, drop.x, Math.min(drop.y, spot.rail), Math.max(drop.y, spot.rail));
    }
    const xs = [...spot.drops.map((drop) => drop.x), spot.dropX];
    span(Math.min(...xs), Math.max(...xs), spot.rail, spot.rail);
    span(spot.dropX, spot.dropX, Math.min(spot.rail, spot.top), Math.max(spot.rail, spot.top));
  }
  for (const spot of doneSpots) {
    span(spot.x - DONE_HALF, spot.x + DONE_HALF, spot.y - 2, spot.y + 0.6);
  }
  if (band !== null) {
    for (const route of laneRoutes) {
      const points = bandRoute(route, extent, band.span);
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
    shiftedExtent.set(node.name, {
      x: node.x,
      y: node.y,
      ...nodeBox(node),
      bottom: nodeBottom(0, node.harness),
    });
  }
  for (const group of groups) {
    shiftedExtent.set(group.name, {
      x: group.x,
      y: group.y,
      hw: group.w / 2,
      hh: group.h / 2,
      bottom: group.h / 2,
    });
  }
  const shiftedSpan: BandSpan | null =
    band === null
      ? null
      : {
          channel: num(band.span.channel + dy),
          gutter: num(band.span.gutter + dx),
          corridor: num(band.span.corridor + dy),
          under: num(band.span.under + dy),
        };
  const { marks, buses, dones } =
    band === null
      ? shiftedLane({ marks: markSpots, buses: busSpots, dones: doneSpots }, dx, dy)
      : shiftedBand({ marks: markSpots, buses: bandBusSpots, dones: doneSpots }, dx, dy);
  const laneEdges: PlacedEdge[] = [];
  if (shiftedSpan !== null) {
    for (const route of laneRoutes) {
      const points = bandRoute(route, shiftedExtent, shiftedSpan);
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
