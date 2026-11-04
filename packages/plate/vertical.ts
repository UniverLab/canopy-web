// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's vertical orientation: the same ranked graph as layout.ts, with
 * ranks running top to bottom and labels to the right of nodes. The page
 * renders both orientations and CSS shows this one under 640 px, so a phone
 * never scrolls a plate sideways: ranks run single file, labels truncate as
 * in the horizontal plate, and the svg stays narrow by construction.
 *
 * Geometry mirrors layout.ts with the axes turned: rank pitch accumulates
 * downward (a rank is as tall as its tallest unit), units within a rank run
 * left to right in barycenter order, groups keep their horizontal shape
 * with members stacked, and the infra node sits in its own row below
 * everything. The handler lane — units that end a failure instead of
 * carrying the flow — runs down the left edge of the column at mid height,
 * its labels beneath the shapes so the channel between lane and column
 * stays clear for routes and buses. Fail edges between units of one column
 * arc LEFT of the pair (labels sit right of nodes). The viewBox padding is
 * symmetric, so the drawing stays centred — a single node sits at its
 * viewBox centre.
 *
 * Everything here is total and deterministic, like the horizontal engine:
 * the same input places the same way, byte for byte.
 */
import {
  parseDocument,
  shapeOf,
  type EdgeClass,
  type EnsembleView,
  type NodeView,
} from "./document.js";
import {
  GROUP_CHAR,
  GROUP_FOOT,
  GROUP_HEAD,
  LABEL_CHAR,
  LABEL_MAX,
  LANE_GAP,
  MEMBER_DY,
  PAD_BOTTOM,
  PAD_TOP,
  PAD_X,
  drawnName,
  forceArcOf,
  groupSubtitle,
  groupTitle,
  groupWidth,
  labelHalfOf,
  nodeBottom,
  type PlacedEdge,
  type PlacedGroup,
  type PlacedNode,
  type PlateLayout,
} from "./layout.js";
import {
  DONE_DY,
  DONE_HALF,
  MARK_HALF,
  laneGroups,
  lanePath,
  shiftedLane,
  verticalRoute,
  type DoneSpot,
  type Extent,
  type LaneSpan,
} from "./lane.js";
import { flowOf, type LaneEdge } from "./flow.js";
import { doneUnitsOf, handlersOf, type Handler } from "./handlers.js";
import { rankUnits } from "./rank.js";
import { generateWalk, happyRandom, plateWalk } from "./walk.js";
import { GEOM, TYPE, nodeBox, num, shortenEdgeEnd, smooth, type Pt } from "./vocabulary.js";

/** Gap between two units side by side in one rank (viewBox units). */
const UNIT_GAP = 8;
/** Gap between two rank rows. */
const RANK_GAP = 10;
/** Vertical slot one node occupies in a rank row. */
const NODE_SLOT_V = 12;
/** Gap between the column and the handler lane's right edge. Shared with the lane routes. */
const V_LANE_GAP = 12;
/** Where the lane's routes run inside that gap. */
const V_LANE_CHANNEL = 3;
/** Gap between a shape's right edge and its labels. Shared with render.ts. */
export const V_LABEL_DX = 2;
/** Baselines of the two right-side labels. Shared with render.ts. */
export const V_LABEL_DY = 0.8;
export const V_HARNESS_DY = 3.4;

/** Extra arc reach per same-column fail edge into one target. Shared with the lift below. */
const LIFT_STEP_V = 2;

/**
 * How far left a same-column fail arc reaches: the hero's 8 plus a capped
 * share of the span and of the lift, so a column-long back edge never
 * pushes the viewBox past a phone's width. Both the path and the bounds
 * read this one function.
 */
function arcFall(a: Pt, b: Pt, lift: number): number {
  const span = Math.min(Math.abs(a.y - b.y) * 0.1, 6);
  return Math.min(a.x, b.x) - 8 - span - Math.min(lift, 8);
}

/**
 * Edge path between two node centres, vertical: a smooth S-curve down the
 * column. A failure between units of one column arcs LEFT of the pair
 * (labels sit right of nodes). `lift` pushes such an arc further left, so
 * two back-edges into one node stay distinct. `forceArc` draws the arc
 * whatever the column gap — a fail or error edge touching an ensemble
 * group never S-curves through the column.
 */
export function edgePathV(a: Pt, b: Pt, fail: boolean, lift = 0, forceArc = false): string {
  if (!forceArc && (!fail || Math.abs(b.x - a.x) > 6)) {
    const my = (a.y + b.y) / 2;
    return `M${a.x} ${a.y} C${a.x} ${my} ${b.x} ${my} ${b.x} ${b.y}`;
  }
  const fall = arcFall(a, b, lift);
  return `M${a.x - 3} ${a.y} C${fall} ${a.y} ${fall} ${b.y} ${b.x - 3} ${b.y}`;
}

/** How far a node's right-side labels reach past its centre. */
function labelsWidth(name: string, w: number, harness: string | null): number {
  const nameWidth = Math.min(name.length, LABEL_MAX + 1) * LABEL_CHAR;
  const harnessWidth = harness === null ? 0 : harness.length * GROUP_CHAR;
  return w / 2 + V_LABEL_DX + Math.max(nameWidth, harnessWidth);
}

export function layoutPlateVertical(
  document: unknown,
  random: () => number = happyRandom,
): PlateLayout | null {
  const parsed = parseDocument(document);
  if (parsed === null) {
    return null;
  }
  const { byRank, entry, rankOf, unitId, units } = rankUnits(parsed);
  const orderOf = new Map(units.map((unit) => [unit.id, unit.order]));
  const unitOrder = (id: string): number => orderOf.get(id) ?? Number.MAX_SAFE_INTEGER;
  const handlers = handlersOf(parsed, unitId, unitOrder);
  const doneUnits = doneUnitsOf(parsed, unitId, unitOrder, handlers);

  // Geometry in design coordinates: ranks accumulate downward, units within
  // a rank run left to right, the infra node waits for its own last row.
  const atX = new Map<string, number>();
  const atY = new Map<string, number>();
  const nodes: PlacedNode[] = [];
  const groups: PlacedGroup[] = [];
  let cursor = 0;
  let columnLeft = Number.POSITIVE_INFINITY;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const row = (byRank.get(rank) ?? []).filter(
      (unit) =>
        !handlers.has(unit.id) && (unit.node === null || unit.node.name !== parsed.infra),
    );
    const heights = row.map((unit) =>
      unit.node !== null
        ? NODE_SLOT_V
        : GROUP_HEAD + (unit.ensemble?.members.length ?? 0) * MEMBER_DY + GROUP_FOOT,
    );
    const rowHeight = Math.max(0, ...heights);
    const y = num(cursor + rowHeight / 2);
    cursor += rowHeight + RANK_GAP;
    let left = 0;
    for (const unit of row) {
      if (unit.node !== null) {
        const shape = shapeOf(
          unit.node.docKind,
          unit.node.name,
          unit.node.commitRights,
          entry !== null && unit.node.name === entry.name,
        );
        const w = GEOM[shape].w;
        const x = num(left + w / 2);
        left += labelsWidth(unit.node.name, w, unit.node.harness) + UNIT_GAP;
        atX.set(unit.id, x);
        atY.set(unit.id, y);
        const placed: PlacedNode = {
          name: unit.node.name,
          shape,
          docKind: unit.node.docKind,
          harness: unit.node.harness,
          x,
          y,
          w,
          h: GEOM[shape].h,
          rank,
          lane: "main",
        };
        nodes.push(placed);
        columnLeft = Math.min(columnLeft, x - nodeBox(placed).hw);
      } else if (unit.ensemble !== null) {
        const title = groupTitle(unit.ensemble.name);
        const subtitle = groupSubtitle(
          unit.ensemble.strategy,
          unit.ensemble.minPass,
          unit.ensemble.members.length,
        );
        const w = num(groupWidth(title, subtitle, unit.ensemble.members));
        const h = num(GROUP_HEAD + unit.ensemble.members.length * MEMBER_DY + GROUP_FOOT);
        const x = num(left + w / 2);
        left += w + UNIT_GAP;
        atX.set(unit.id, x);
        atY.set(unit.id, y);
        const members = unit.ensemble.members.map((label, index) => ({
          label,
          harness: unit.ensemble?.memberHarness[index] ?? null,
          x,
          y: num(y - h / 2 + GROUP_HEAD + index * MEMBER_DY + MEMBER_DY / 2),
        }));
        groups.push({ name: unit.ensemble.name, title, subtitle, x, y, w, h, rank, members });
        columnLeft = Math.min(columnLeft, x - w / 2);
      }
    }
  }
  if (!Number.isFinite(columnLeft)) {
    columnLeft = 0;
  }
  const columnBottom = num(cursor - RANK_GAP);
  if (parsed.infra !== null && !handlers.has(parsed.infra)) {
    const node = parsed.nodes.find((candidate) => candidate.name === parsed.infra);
    const rank = rankOf.get(parsed.infra) ?? 0;
    if (node !== undefined) {
      const shape = shapeOf(node.docKind, node.name, node.commitRights, false);
      const x = num(GEOM[shape].w / 2);
      const y = num(cursor - RANK_GAP + LANE_GAP + NODE_SLOT_V / 2);
      atX.set(node.name, x);
      atY.set(node.name, y);
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

  // The handler lane: a column at the left edge of the flow, at mid height,
  // its units stacked in document order. Labels sit under the shapes, so
  // the channel between the lane and the column stays clear for routes.
  interface LaneEntry {
    handler: Handler;
    node: NodeView | null;
    group: EnsembleView | null;
    hw: number;
    hh: number;
  }
  const laneEntries: LaneEntry[] = [];
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
      laneEntries.push({ handler, node, group: null, ...box });
    } else {
      const ensemble = parsed.ensembles.find((candidate) => `ensemble:${candidate.name}` === handler.id);
      if (ensemble === undefined) {
        continue;
      }
      const title = groupTitle(ensemble.name);
      const subtitle = groupSubtitle(ensemble.strategy, ensemble.minPass, ensemble.members.length);
      const w = num(groupWidth(title, subtitle, ensemble.members));
      const h = num(GROUP_HEAD + ensemble.members.length * MEMBER_DY + GROUP_FOOT);
      laneEntries.push({ handler, node: null, group: ensemble, hw: w / 2, hh: h / 2 });
    }
  }
  let lane: LaneSpan | null = null;
  if (laneEntries.length > 0) {
    const maxHalf = Math.max(...laneEntries.map((entry) => entry.hw));
    const laneRight = num(columnLeft - V_LANE_GAP);
    const laneX = num(laneRight - maxHalf);
    const mid = num(columnBottom / 2);
    const slots = laneEntries.map((entry) => Math.max(NODE_SLOT_V, entry.hh * 2 + 6));
    const total = slots.reduce((sum, slot) => sum + slot, 0);
    let top = mid - total / 2;
    for (const [index, item] of laneEntries.entries()) {
      const slot = slots[index] ?? NODE_SLOT_V;
      const y = num(top + slot / 2);
      top += slot;
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
      right: laneRight,
      gutter: num(laneRight + V_LANE_CHANNEL),
      corridor: mid,
    };
  }

  // Every placed unit's drawn extent, by drawn name.
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

  // Edge endpoints: node centres, group tops and bottoms for ensemble wiring.
  const groupByName = new Map(groups.map((group) => [group.name, group]));
  const pointOf = (name: string, flank: "top" | "bottom" | "centre"): Pt | null => {
    if (name.startsWith("ensemble:")) {
      const group = groupByName.get(name.slice("ensemble:".length));
      if (group === undefined) {
        return null;
      }
      const y = flank === "top" ? group.y - group.h / 2 : flank === "bottom" ? group.y + group.h / 2 : group.y;
      return { x: group.x, y: num(y) };
    }
    const x = atX.get(name);
    const y = atY.get(name);
    return x === undefined || y === undefined ? null : { x, y };
  };
  const displayName = drawnName;

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
    const b = pointOf(edge.to, "top");
    const a = pointOf(edge.from, "bottom");
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
   * Whether an edge draws as an arc left of the column: forced, a
   * same-column fail, or a range-skipping or back edge.
   */
  const arcs = (edge: RawEdge): boolean =>
    edge.forceArc || (edge.cls === "fail" && Math.abs(edge.b.x - edge.a.x) <= 6) || outside(edge);

  // Fail arcs left of the column push further left per back edge into one target.
  const arcIndex = new Map<string, number>();
  const liftOf = (edge: RawEdge): number => {
    if (!arcs(edge)) {
      return 0;
    }
    const key = edge.to;
    const index = arcIndex.get(key) ?? 0;
    arcIndex.set(key, index + 1);
    return index * LIFT_STEP_V;
  };
  const orderedRaw = [...raw].sort(
    (a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );
  const lifts = new Map<RawEdge, number>(orderedRaw.map((edge) => [edge, liftOf(edge)]));

  // Bounds: shapes, right-side labels, group outlines, fail-arc lefts,
  // marks, buses, done terminals and lane routes — the viewBox grows around
  // all of them, then everything shifts into positive space with symmetric
  // padding, centred on the drawing.
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
    if (node.lane === "handler") {
      // The lane's labels sit under the shapes, keeping the channel clear.
      const labelHalf = labelHalfOf(node.name, node.harness);
      span(
        Math.min(node.x - node.w / 2, node.x - labelHalf),
        Math.max(node.x + node.w / 2, node.x + labelHalf),
        node.y - node.h / 2,
        nodeBottom(node.y, node.harness),
      );
      continue;
    }
    const bottom = node.harness === null
      ? Math.max(node.h / 2, V_LABEL_DY + TYPE.label / 2)
      : Math.max(node.h / 2, V_HARNESS_DY + TYPE.harness / 2);
    span(
      node.x - node.w / 2,
      node.x + labelsWidth(node.name, node.w, node.harness),
      node.y - node.h / 2,
      node.y + bottom,
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
      for (const point of verticalRoute(route, extent, lane) ?? []) {
        span(point.x, point.x, point.y, point.y);
      }
    }
  }
  for (const edge of raw) {
    if (arcs(edge)) {
      const lift = lifts.get(edge) ?? 0;
      minX = Math.min(minX, arcFall(edge.a, edge.b, lift), edge.a.x - 3, edge.b.x - 3);
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
      const points = verticalRoute(route, shiftedExtent, shiftedSpan);
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
      // Mirror of the horizontal plate: S-curves arrive along the column
      // (shorten nodes in y), arcs arrive from the left (shorten in x).
      const target = edge.cls === "order" ? undefined : targetOf.get(edge.to);
      const arc = arcs(edge);
      let end = b;
      if (target !== undefined && (!target.group || arc)) {
        end = arc
          ? shortenEdgeEnd(a, b, target.hx, "x", 1, 3)
          : shortenEdgeEnd(a, b, target.hy, "y", null, 0);
      }
      return {
        from: edge.from,
        to: edge.to,
        cls: edge.cls,
        d: smooth(edgePathV(a, end, edge.cls === "fail", lifts.get(edge) ?? 0, arc)),
      };
    }),
    ...laneEdges,
  ];

  // The token walks the walk — the pass chain with its fail detours —
  // through this orientation's curves. A fail leg rides the arc of the
  // drawn fail edge it took, at the same curve reach, centre to centre.
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
    return edgePathV(a, b, step.fail, style?.lift ?? 0, style?.forceArc ?? false);
  });

  const order = [...nodes]
    .sort((a, b) => a.rank - b.rank || a.x - b.x || (a.name < b.name ? -1 : 1))
    .map((node) => node.name);

  return {
    name: parsed.name,
    orientation: "vertical",
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
