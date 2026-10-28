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
 * everything. Fail edges between units of one column arc LEFT of the pair
 * (labels sit right of nodes). The viewBox padding is symmetric, so the
 * drawing stays centred — a single node sits at its viewBox centre.
 *
 * Everything here is total and deterministic, like the horizontal engine:
 * the same input places the same way, byte for byte.
 */
import {
  classOf,
  parseDocument,
  shapeOf,
  type EdgeClass,
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
  forceArcOf,
  groupSubtitle,
  groupTitle,
  groupWidth,
  num,
  passChain,
  passWalk,
  smooth,
  type PlacedEdge,
  type PlacedGroup,
  type PlacedNode,
  type PlateLayout,
} from "./layout.js";
import { rankUnits } from "./rank.js";
import { GEOM, TYPE, type Pt } from "./vocabulary.js";

/** Gap between two units side by side in one rank (viewBox units). */
const UNIT_GAP = 8;
/** Gap between two rank rows. */
const RANK_GAP = 10;
/** Vertical slot one node occupies in a rank row. */
const NODE_SLOT_V = 12;
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

export function layoutPlateVertical(document: unknown): PlateLayout | null {
  const parsed = parseDocument(document);
  if (parsed === null) {
    return null;
  }
  const { byRank, entry, rankOf, unitId } = rankUnits(parsed);

  // Geometry in design coordinates: ranks accumulate downward, units within
  // a rank run left to right, the infra node waits for its own last row.
  const atX = new Map<string, number>();
  const atY = new Map<string, number>();
  const nodes: PlacedNode[] = [];
  const groups: PlacedGroup[] = [];
  let cursor = 0;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const row = (byRank.get(rank) ?? []).filter(
      (unit) => unit.node === null || unit.node.name !== parsed.infra,
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
        nodes.push({
          name: unit.node.name,
          shape,
          docKind: unit.node.docKind,
          harness: unit.node.harness,
          x,
          y,
          w,
          h: GEOM[shape].h,
          rank,
          infra: false,
        });
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
      }
    }
  }
  if (parsed.infra !== null) {
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
        infra: true,
      });
    }
  }

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
    const a = pointOf(fromId, "bottom");
    const b = pointOf(toId, "top");
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
      const a = fromId === null ? null : pointOf(fromId, "bottom");
      const b = pointOf(id, "top");
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
      const a = fromId === null ? null : pointOf(fromId, "bottom");
      const b = pointOf(id, "top");
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
      const a = pointOf(id, "bottom");
      const b = toId === null ? null : pointOf(toId, "top");
      if (toId !== null && a !== null && b !== null) {
        raw.push({ from: ensemble.name, to: displayName(toId), cls: "pass", a, b, forceArc: false });
      }
    }
    if (ensemble.onFailTo !== null) {
      const toId = unitId(ensemble.onFailTo);
      const a = pointOf(id, "bottom");
      const b = toId === null ? null : pointOf(toId, "top");
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

  /** Whether an edge draws as an arc left of the column: forced, or a same-column fail. */
  const arcs = (edge: RawEdge): boolean =>
    edge.forceArc || (edge.cls === "fail" && Math.abs(edge.b.x - edge.a.x) <= 6);

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

  // Bounds: shapes, right-side labels, group outlines and fail-arc lefts —
  // the viewBox grows around all of them, then everything shifts into
  // positive space with symmetric padding, centred on the drawing.
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
  const edges: PlacedEdge[] = raw.map((edge) => ({
    from: edge.from,
    to: edge.to,
    cls: edge.cls,
    d: smooth(
      edgePathV(shift(edge.a), shift(edge.b), edge.cls === "fail", lifts.get(edge) ?? 0, edge.forceArc),
    ),
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
    (a, b) => edgePathV(a, b, false),
  );

  const order = [...nodes]
    .sort((a, b) => a.rank - b.rank || a.x - b.x || (a.name < b.name ? -1 : 1))
    .map((node) => node.name);

  return {
    name: parsed.name,
    orientation: "vertical",
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
