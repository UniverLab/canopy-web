// SPDX-License-Identifier: Apache-2.0
/**
 * The plate layout engine: a validated graph document (format v6) becomes
 * placed nodes, ensemble groups and edge paths in the Canopy vocabulary.
 *
 * Units arrive ranked from `./rank.js` — longest paths over the rank edges,
 * fail-only targets lifted into their own rank after the unit that fails
 * into them, one barycenter sweep within each rank — and this module places
 * them: rank spacing is cumulative — each rank sits past the widest half
 * extent of its neighbours, so wide groups never overlap; the viewBox grows
 * instead. The infra node keeps its rank but is drawn once, in a separate
 * lower lane. The handlers — units that end a failure rather than carry the
 * flow (`./handlers.js`) — leave it for a horizontal band below the main
 * flow and above the infra lane, where each handler's inputs form one bus.
 *
 * Edges never cut through the column: a fail or error edge, or a pass edge
 * that does not advance a rank, runs along its own channel above the
 * flow, and every drawn edge that touches the lane runs outside the column
 * and enters through the gutter.
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
  lanePath,
  shiftedBand,
  shiftedLane,
  type BandBounds,
  type BandBusSpot,
  type BandSpan,
  type Extent,
  type DoneSpot,
  type MarkSpot,
  type PlacedBus,
  type PlacedDone,
  type PlacedMark,
} from "./lane.js";
import { rankUnits, type Unit } from "./rank.js";
import {
  generateWalk,
  happyRandom,
  plateWalk,
  type WalkFail,
  type WalkStep,
} from "./walk.js";
import { GEOM, edgePath, num, nodeBox, smooth, type Pt } from "./vocabulary.js";
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

/** Constant horizontal step between ranks (viewBox units). */
export const RANK_DX = 26;
/** Minimum edge-to-edge gap between two neighbouring rank columns. */
export const RANK_GAP = 4;
/** Vertical slot one main-lane node occupies. */
const NODE_SLOT = 16;
/** Gap between the main lane and the infra lane. */
export const LANE_GAP = 20;
/** ViewBox padding. */
export const PAD_X = 10;
export const PAD_TOP = 10;
export const PAD_BOTTOM = 10;
/** Extra channel height per channel edge into the drawing: every channel edge gets its own. */
export const LIFT_STEP = 4;
/** Node labels longer than this are truncated; the shape keeps the full name. */
export const LABEL_MAX = 16;
/** Pixels per viewBox unit for the svg width/height attributes. */
export const PLATE_SCALE = 5;
/** Mono advance at the node-label type size, in viewBox units. */
export const LABEL_CHAR = 2.3 * 0.6;
export interface PlacedEdge {
  from: string;
  to: string;
  cls: EdgeClass;
  d: string;
}

export interface PlateLayout {
  name: string;
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
  /** The walk's steps — the renderer lights each unit on the legs that touch it. */
  walkSteps: WalkStep[];
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

/** A unit's full width on the flow axis: a group's outline, a node's doubled label half-width. */
function rankWidthOf(unit: Unit): number {
  if (unit.ensemble !== null) {
    const title = groupTitle(unit.ensemble.name);
    const subtitle = groupSubtitle(
      unit.ensemble.strategy,
      unit.ensemble.minPass,
      unit.ensemble.members.length,
    );
    return num(groupWidth(title, subtitle, unit.ensemble.members));
  }
  if (unit.node !== null) {
    return num(2 * labelHalfOf(unit.node.name, unit.node.harness));
  }
  return 0;
}

/** One x per rank, cumulative: rank zero opens at 0, later ranks clear their neighbours by RANK_GAP, never closer than RANK_DX. */
function rankXOf(byRank: Map<number, Unit[]>): Map<number, number> {
  const at = new Map<number, number>();
  let prevX = 0;
  let prevHalf = 0;
  let first = true;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const units = byRank.get(rank) ?? [];
    const half = units.length === 0 ? 0 : Math.max(...units.map((unit) => rankWidthOf(unit) / 2));
    at.set(rank, first ? 0 : num(prevX + Math.max(RANK_DX, prevHalf + RANK_GAP + half)));
    first = false;
    prevX = at.get(rank) ?? 0;
    prevHalf = half;
  }
  return at;
}

/**
 * Whether an edge arcs whatever the gap: a fail or error edge leaving or
 * entering an ensemble group — such an edge never S-curves through the row.
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
  const rankPos = rankXOf(byRank);
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const x = rankPos.get(rank) ?? 0;
    // The rank's main-lane units stack around the shared axis: the rank's
    // total height is centred on y = 0, so a one-unit rank sits on the axis.
    const mains = (byRank.get(rank) ?? []).filter(
      (unit) => !handlers.has(unit.id) && !(unit.node !== null && unit.node.name === parsed.infra),
    );
    let total = 0;
    for (const unit of mains) {
      total +=
        unit.node !== null
          ? NODE_SLOT
          : num(GROUP_HEAD + (unit.ensemble?.members.length ?? 0) * MEMBER_DY + GROUP_FOOT) + 4;
    }
    if (mains.length > 0 && mains[mains.length - 1]?.ensemble !== null) {
      total -= 4;
    }
    let used = -total / 2;
    for (const unit of byRank.get(rank) ?? []) {
      atX.set(unit.id, x);
      if (handlers.has(unit.id)) {
        continue;
      }
      if (unit.node !== null && unit.node.name === parsed.infra) {
        continue;
      }
      if (unit.node !== null) {
        const y = num(used + NODE_SLOT / 2);
        used += NODE_SLOT;
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
        const y = num(used + h / 2);
        used += h + 4;
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
    rankX: (id) => rankPos.get(rankOf.get(id) ?? 0) ?? 0,
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
      const x = rankPos.get(rank) ?? 0;
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
  let busSpots: BandBusSpot[] = [];
  if (band !== null) {
    markSpots = [...band.marks];
    busSpots = band.buses;
    markBandInfraSources({ units: laneItems, extent, mainExtent, band, marks: markSpots });
  }
  const doneSpots: DoneSpot[] = doneUnits.flatMap((done) => {
    const node = nodes.find((placed) => placed.name === done.id);
    return node === undefined
      ? []
      : [{ name: node.name, x: node.x, y: num(nodeBottom(node.y, node.harness) + DONE_DY) }];
  });

  // A unit's rank, by drawn name, for edges that skip a rank or walk back.
  const rankByName = new Map<string, number>();
  for (const node of nodes) {
    rankByName.set(node.name, node.rank);
  }
  for (const group of groups) {
    rankByName.set(group.name, group.rank);
  }
  // Edge endpoints on the unit borders, by drawn name. A forward edge leaves
  // the source border facing its target at the source height and enters the
  // target border facing its source at the target height, so the bend sits
  // at the midpoint of the rank gap. A channel edge leaves the source's top
  // corner facing its target and enters the target's top corner facing its
  // source, clearing the units stacked above.
  const groupByName = new Map(groups.map((group) => [group.name, group]));
  const displayName = drawnName;
  /** Whether an edge draws along a channel above the flow. */
  const channelOf = (cls: EdgeClass, from: string, to: string): boolean => {
    if (cls === "fail" || cls === "error") {
      return true;
    }
    if (cls === "order") {
      return false;
    }
    const fromRank = rankByName.get(from);
    const toRank = rankByName.get(to);
    return fromRank !== undefined && toRank !== undefined && toRank - fromRank <= 0;
  };
  const forwardEnds = (from: Extent, to: Extent): { a: Pt; b: Pt } =>
    from.x <= to.x
      ? {
          a: { x: num(from.x + from.hw), y: from.y },
          b: { x: num(to.x - to.hw), y: to.y },
        }
      : {
          a: { x: num(from.x - from.hw), y: from.y },
          b: { x: num(to.x + to.hw), y: to.y },
        };
  const channelEnds = (from: Extent, to: Extent): { a: Pt; b: Pt } => {
    const dir = to.x < from.x ? -1 : 1;
    return {
      a: { x: num(from.x + dir * from.hw), y: num(from.y - from.hh) },
      b: { x: num(to.x - dir * to.hw), y: num(to.y - to.hh) },
    };
  };

  interface RawEdge {
    from: string;
    to: string;
    cls: EdgeClass;
    a: Pt;
    b: Pt;
    channel: boolean;
  }
  const flow = flowOf(parsed, unitId, handlers);
  const raw: RawEdge[] = [];
  for (const edge of flow.drawn) {
    const from = displayName(edge.from);
    const to = displayName(edge.to);
    const fromBox = extent.get(from);
    const toBox = extent.get(to);
    if (fromBox === undefined || toBox === undefined) {
      continue;
    }
    const channel = channelOf(edge.cls, from, to);
    const ends = channel ? channelEnds(fromBox, toBox) : forwardEnds(fromBox, toBox);
    raw.push({ from, to, cls: edge.cls, ...ends, channel });
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
          channel: false,
        });
      }
    }
  }

  // One channel per channel edge, in from/to order, stacked above the flow.
  raw.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );
  let channelCount = 0;
  const channelY = new Map<RawEdge, number>();
  for (const edge of raw) {
    if (edge.channel) {
      channelY.set(edge, num(mainTop - 8 - channelCount * LIFT_STEP));
      channelCount += 1;
    }
  }

  // Bounds: shapes, group outlines, labels, channel tops, marks, buses,
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
  // An edge bounds by the line it draws, in the same design coordinates
  // as everything else here. A channel edge also spans its channel above
  // the flow down to the higher of its two top corners.
  for (const edge of raw) {
    span(
      Math.min(edge.a.x, edge.b.x),
      Math.max(edge.a.x, edge.b.x),
      Math.min(edge.a.y, edge.b.y),
      Math.max(edge.a.y, edge.b.y),
    );
    const top = channelY.get(edge);
    if (top !== undefined) {
      span(
        Math.min(edge.a.x, edge.b.x),
        Math.max(edge.a.x, edge.b.x),
        top,
        Math.max(edge.a.y, edge.b.y),
      );
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
      ? { ...shiftedLane({ dones: doneSpots }, dx, dy), marks: [] as PlacedMark[], buses: [] as PlacedBus[] }
      : shiftedBand({ marks: markSpots, buses: busSpots, dones: doneSpots }, dx, dy);
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
  // The channel heights are measured in design coordinates, against
  // mainTop; the paths are drawn after the shift, so the heights shift with
  // them. Unshifted, they put every channel's top `dy` above the bounds,
  // outside the viewBox.
  const edges: PlacedEdge[] = [
    ...raw.map((edge) => {
      const a = shift(edge.a);
      const b = shift(edge.b);
      const top = channelY.get(edge);
      return {
        from: edge.from,
        to: edge.to,
        cls: edge.cls,
        d: smooth(
          edge.channel ? edgePath(a, b, true, 0, true, (top ?? 0) + dy) : edgePath(a, b),
        ),
      };
    }),
    ...laneEdges,
  ];

  // The token walks the walk — the pass chain with its fail detours — along
  // the drawn edges, joining consecutive legs straight through the unit
  // between them. A leg with no drawn edge, a mark or a bus, walks straight
  // to the unit's centre.
  const centres = new Map<string, Pt>();
  for (const node of nodes) {
    centres.set(node.name, { x: node.x, y: node.y });
  }
  for (const group of groups) {
    centres.set(group.name, { x: group.x, y: group.y });
  }
  const steps = generateWalk(parsed, entry === null ? null : entry.name, new Set(centres.keys()), random);
  const edgeD = new Map<string, string>();
  for (const edge of edges) {
    edgeD.set(`${edge.cls}:${edge.from}→${edge.to}`, edge.d);
  }
  const walked = plateWalk(
    steps,
    centres,
    (step) => edgeD.get(`${step.fail ? "fail" : "pass"}:${step.from}→${step.to}`) ?? null,
  );

  const order = [...nodes]
    .sort((a, b) => a.rank - b.rank || a.y - b.y || (a.name < b.name ? -1 : 1))
    .map((node) => node.name);

  return {
    name: parsed.name,
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
    walkSteps: steps,
    order,
  };
}

/** Truncate a node label the way the plate draws it. */
export function plateLabel(name: string): string {
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}
