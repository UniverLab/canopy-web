// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's handler lane arithmetic: where each grouped input's short
 * mark sits, where its bus starts and ends, and the routes that reach the
 * lane without crossing a node. Both orientations lay the lane out on their
 * own axes; the marks, the buses and the `✓ done` terminals are the same
 * arithmetic either way, so they live here once.
 */
import type { Handlers } from "./handlers.js";
import { num, smooth, type Pt } from "./vocabulary.js";

/** Distance from a lane band's outer edge to its bus lines, per class. */
export const BUS_GAP: Record<"error" | "fail", number> = { error: 5, fail: 9 };
/** Extra bus offset per handler, so two buses in one lane never overlap. */
export const BUS_STACK = 8;
/** How far above a lane's highest mark its bus starts. */
export const BUS_HEAD = 3;
/** A source's mark sits this far outside its left edge. */
export const MARK_DX = 2.2;
/** Two marks on one source part by this much, the bolt above the dash. */
export const MARK_STACK = 1.4;
/** How far above the main column a horizontal lane edge runs before it crosses. */
export const LANE_RISE = 8;
/** Baseline drop of a `✓ done` terminal under its node. */
export const DONE_DY = 3.4;
/** Half the width of the `✓ done` terminal, for the bounds. */
export const DONE_HALF = 3.6;
/** How far a mark's glyph reaches past its anchor. */
export const MARK_HALF = 1.6;

/** Which lane a placed unit draws in: the flow, the infra row, or a side lane. */
export type Lane = "main" | "infra" | "handler";

/** One short mark a source carries: the error bolt or the fail dash. */
export interface PlacedMark {
  source: string;
  cls: "error" | "fail";
  x: number;
  y: number;
}

/** One grouped-input bus: the single line that enters a handler per class. */
export interface PlacedBus {
  to: string;
  cls: "error" | "fail";
  d: string;
}

/** The flow's end: the `✓ done` terminal drawn beneath a node with no pass exit. */
export interface PlacedDone {
  name: string;
  x: number;
  y: number;
}

/** A drawn half extent of one placed unit, for marks and lane routes. */
export interface Extent {
  x: number;
  y: number;
  hw: number;
  hh: number;
}

/** The side lane's own lines, in design coordinates. */
export interface LaneSpan {
  left: number;
  right: number;
  /** The channel between the lane and the column, where routes run. */
  gutter: number;
  /** The height outside the column a horizontal route crosses at. */
  corridor: number;
}

/** Where one mark sits, in design coordinates, before the viewBox shift. */
export interface MarkSpot {
  source: string;
  cls: "error" | "fail";
  x: number;
  y: number;
}

/** Where one bus starts and ends, in design coordinates. */
export interface BusSpot {
  to: string;
  cls: "error" | "fail";
  x: number;
  top: number;
  hx: number;
  hy: number;
}

/** Where one done terminal sits, in design coordinates. */
export interface DoneSpot {
  name: string;
  x: number;
  y: number;
}

/** A unit id as the plate draws it: ensembles lose the `ensemble:` prefix. */
function drawn(id: string): string {
  return id.startsWith("ensemble:") ? id.slice("ensemble:".length) : id;
}

/**
 * The marks and buses of every grouped input: one mark per source and class
 * — the bolt above the dash when a source carries both — and one bus per
 * handler and class, running down the lane's outer side.
 */
export function laneGroups(
  handlers: Handlers,
  extent: Map<string, Extent>,
  laneLeft: number,
): { marks: MarkSpot[]; buses: BusSpot[] } {
  const classes = new Map<string, Set<"error" | "fail">>();
  for (const handler of handlers.list) {
    for (const group of handler.groups) {
      for (const source of group.sources) {
        const seen = classes.get(source) ?? new Set<"error" | "fail">();
        seen.add(group.cls);
        classes.set(source, seen);
      }
    }
  }
  const marks: MarkSpot[] = [];
  const buses: BusSpot[] = [];
  for (const [index, handler] of handlers.list.entries()) {
    const target = extent.get(drawn(handler.id));
    if (target === undefined) {
      continue;
    }
    for (const group of handler.groups) {
      const markYs: number[] = [];
      for (const source of group.sources) {
        const spot = extent.get(drawn(source));
        if (spot === undefined) {
          continue;
        }
        const both = (classes.get(source)?.size ?? 0) > 1;
        const y = num(spot.y + (both ? (group.cls === "error" ? -MARK_STACK : MARK_STACK) : 0));
        marks.push({
          source: drawn(source),
          cls: group.cls,
          x: num(spot.x - spot.hw - MARK_DX),
          y,
        });
        markYs.push(y);
      }
      if (markYs.length === 0) {
        continue;
      }
      buses.push({
        to: drawn(handler.id),
        cls: group.cls,
        x: num(laneLeft - BUS_GAP[group.cls] - BUS_STACK * index),
        top: num(Math.min(...markYs) - BUS_HEAD),
        hx: num(target.x - target.hw),
        hy: target.y,
      });
    }
  }
  return { marks, buses };
}

/** A polyline path through the given points. */
export function lanePath(points: Pt[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${num(point.x)} ${num(point.y)}`).join(" ");
}

/**
 * The horizontal route of one lane edge: out of the source, over the top of
 * the column (or straight into the channel when the source is in the lane),
 * down the channel, and once into the handler's near edge.
 */
export function horizontalRoute(
  route: { from: string; to: string; fromLane: boolean; toLane: boolean },
  extent: Map<string, Extent>,
  lane: LaneSpan,
): Pt[] | null {
  const from = extent.get(route.from);
  const to = extent.get(route.to);
  if (from === undefined || to === undefined) {
    return null;
  }
  if (route.toLane) {
    const points: Pt[] = [
      { x: route.fromLane ? from.x + from.hw : from.x - from.hw, y: from.y },
    ];
    if (!route.fromLane) {
      points.push({ x: points[0]?.x ?? from.x, y: lane.corridor });
      points.push({ x: lane.gutter, y: lane.corridor });
    } else {
      points.push({ x: lane.gutter, y: from.y });
    }
    points.push({ x: lane.gutter, y: to.y });
    points.push({ x: to.x + to.hw, y: to.y });
    return points.map((point) => ({ x: num(point.x), y: num(point.y) }));
  }
  return [
    { x: num(from.x + from.hw), y: from.y },
    { x: lane.gutter, y: from.y },
    { x: lane.gutter, y: lane.corridor },
    { x: to.x, y: lane.corridor },
    { x: to.x, y: num(to.y - to.hh) },
  ];
}

/**
 * The vertical route of one lane edge: out of the source into the channel
 * beside the lane, down it, and into the target's near edge — never across
 * the column.
 */
export function verticalRoute(
  route: { from: string; to: string; fromLane: boolean; toLane: boolean },
  extent: Map<string, Extent>,
  lane: LaneSpan,
): Pt[] | null {
  const from = extent.get(route.from);
  const to = extent.get(route.to);
  if (from === undefined || to === undefined) {
    return null;
  }
  return [
    { x: num(route.fromLane ? from.x + from.hw : from.x - from.hw), y: from.y },
    { x: lane.gutter, y: from.y },
    { x: lane.gutter, y: to.y },
    { x: num(route.toLane ? to.x + to.hw : to.x - to.hw), y: to.y },
  ];
}

/** Slide the lane's marks, buses and done terminals into the padded viewBox. */
export function shiftedLane(
  spots: { marks: MarkSpot[]; buses: BusSpot[]; dones: DoneSpot[] },
  dx: number,
  dy: number,
): { marks: PlacedMark[]; buses: PlacedBus[]; dones: PlacedDone[] } {
  const round = (value: number): number => num(value);
  return {
    marks: spots.marks.map((mark) => ({
      source: mark.source,
      cls: mark.cls,
      x: round(mark.x + dx),
      y: round(mark.y + dy),
    })),
    // A bus is one line per handler and class: from above its highest mark,
    // down the lane side, and once into the handler's near edge.
    buses: spots.buses.map((bus) => {
      const x = round(bus.x + dx);
      const top = round(bus.top + dy);
      const y = round(bus.hy + dy);
      return {
        to: bus.to,
        cls: bus.cls,
        d: smooth(`M${x} ${top} L${x} ${y} L${round(bus.hx + dx)} ${y}`),
      };
    }),
    dones: spots.dones.map((done) => ({
      name: done.name,
      x: round(done.x + dx),
      y: round(done.y + dy),
    })),
  };
}
