// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's handler lane arithmetic: where each grouped input's short
 * mark sits, where its bus starts and ends, and the routes that reach the
 * lane without crossing a node. The vertical orientation keeps the side
 * lane; the horizontal orientation lays the handlers in a band below the
 * flow. The `✓ done` terminals are the same arithmetic either way, so they
 * live here once.
 */
import type { Handler, Handlers } from "./handlers.js";
import { num, smooth, type Pt } from "./vocabulary.js";

/** Distance from a lane band's outer edge to its bus lines, per class. */
export const BUS_GAP: Record<"error" | "fail", number> = { error: 5, fail: 9 };
/** Extra bus offset per handler, so two buses in one lane never overlap. */
export const BUS_STACK = 8;
/** How far above a lane's highest mark its bus starts. */
export const BUS_HEAD = 3;
/** A source's mark sits this far outside its edge: left in the side lane, below in the band. */
export const MARK_DX = 2.2;
/** Two marks on one source part by this much, the bolt above the dash. */
export const MARK_STACK = 1.4;
/** How far above the main flow a lane edge returning to it runs before it crosses. */
export const LANE_RISE = 8;
/** Baseline drop of a `✓ done` terminal under its node. */
export const DONE_DY = 3.4;
/** Half the width of the `✓ done` terminal, for the bounds. */
export const DONE_HALF = 3.6;
/** How far a mark's glyph reaches past its anchor. */
export const MARK_HALF = 1.6;

/** Which lane a placed unit draws in: the flow, the infra row, or the handler band. */
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
  /** From the centre to the label or box bottom, for marks below the flow. */
  bottom?: number;
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

/** The main flow's bounds the horizontal band measures itself against. */
export interface BandBounds {
  mainLeft: number;
  mainRight: number;
  mainTop: number;
  mainBottom: number;
  /** Minimum edge-to-edge gap between two handlers: the main lane's node gap. */
  gap: number;
  /** Gap between the main flow and the band, and the band and the infra lane. */
  laneGap: number;
}

/** The horizontal band's own lines, in design coordinates. */
export interface BandSpan {
  /** The height below the flow where into-routes and out-routes run across. */
  channel: number;
  /** The x outside the flow where an out-route rises back above it. */
  gutter: number;
  /** The height above the flow an out-route crosses at. */
  corridor: number;
  /** The height below the band where handler-to-handler routes run across. */
  under: number;
}

/** One unit the horizontal band places, with the drawn half extents it needs. */
export interface BandItem {
  handler: Handler;
  hw: number;
  hh: number;
  /** From the centre to the label or box bottom. */
  bottom: number;
}

/** Where one band bus drops and runs, in design coordinates. */
export interface BandBusSpot {
  to: string;
  cls: "error" | "fail";
  /** One drop per main source: from the mark straight down to the rail. */
  drops: Array<{ x: number; y: number }>;
  /** The height of the bus rail. */
  rail: number;
  /** The handler's centre x, where the bus drops into its top. */
  dropX: number;
  /** The handler's top edge, where the bus ends. */
  top: number;
}

/** The horizontal band's marks, buses, placement and lines, in design coordinates. */
export interface BandSpot {
  marks: MarkSpot[];
  buses: BandBusSpot[];
  /** Each handler's centre x, by unit id. */
  x: Map<string, number>;
  /** The band's shared centre y. */
  y: number;
  /** The top of the tallest handler shape. */
  top: number;
  /** The bottom of the lowest handler label or box. */
  bottom: number;
  span: BandSpan;
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

/** The classes each grouped source carries, for the bolt-above-dash parting. */
function classesOf(items: BandItem[]): Map<string, Set<"error" | "fail">> {
  const classes = new Map<string, Set<"error" | "fail">>();
  for (const item of items) {
    for (const group of item.handler.groups) {
      for (const source of group.sources) {
        const seen = classes.get(source) ?? new Set<"error" | "fail">();
        seen.add(group.cls);
        classes.set(source, seen);
      }
    }
  }
  return classes;
}

/** One band bus before its rail is measured: the handler, class and drops. */
interface TempBus {
  to: string;
  cls: "error" | "fail";
  drops: Array<{ x: number; y: number }>;
}

/**
 * The horizontal band's marks and buses: one mark below each main source —
 * the bolt above the dash when a source carries both — and one bus per
 * handler and class, with a drop per main source down to its rail. Handler
 * sources are marked after the band is placed, unbussed, so their marks
 * stay without drawing a drop through the band.
 */
function bandMarks(
  items: BandItem[],
  extent: Map<string, Extent>,
  classes: Map<string, Set<"error" | "fail">>,
): { marks: MarkSpot[]; temp: TempBus[] } {
  const marks: MarkSpot[] = [];
  const temp: TempBus[] = [];
  for (const item of items) {
    for (const group of item.handler.groups) {
      const drops: Array<{ x: number; y: number }> = [];
      for (const source of group.sources) {
        const spot = extent.get(drawn(source));
        if (spot === undefined) {
          continue;
        }
        const both = (classes.get(source)?.size ?? 0) > 1;
        const base = spot.y + (spot.bottom ?? spot.hh) + MARK_DX;
        const y = num(base + (both ? (group.cls === "error" ? -MARK_STACK : MARK_STACK) : 0));
        const x = num(spot.x);
        marks.push({ source: drawn(source), cls: group.cls, x, y });
        drops.push({ x, y });
      }
      if (drops.length > 0) {
        temp.push({ to: drawn(item.handler.id), cls: group.cls, drops });
      }
    }
  }
  return { marks, temp };
}

/** Clamp a handler's mean x so its left edge never leaves the main flow. */
function clampBandX(mean: number, hw: number, bounds: BandBounds): number {
  const low = bounds.mainLeft + hw;
  const high = Math.max(bounds.mainRight - hw, low);
  return num(Math.min(Math.max(mean, low), high));
}

/** Push handlers right in band order so no two overlap. */
function pushBandX(items: BandItem[], xs: Map<string, number>, bounds: BandBounds): Map<string, number> {
  const out = new Map<string, number>();
  let prevX: number | null = null;
  let prevHw = 0;
  for (const item of items) {
    let x = xs.get(item.handler.id) ?? bounds.mainLeft + item.hw;
    if (prevX !== null) {
      const need = prevX + prevHw + bounds.gap + item.hw;
      if (x < need) {
        x = num(need);
      }
    }
    out.set(item.handler.id, x);
    prevX = x;
    prevHw = item.hw;
  }
  return out;
}

/** The mean x of a handler's unique grouped sources, or null when it has none placed. */
function meanSourceX(
  handler: Handler,
  extent: Map<string, Extent>,
  passA: Map<string, number>,
  withHandlers: boolean,
): number | null {
  const xs: number[] = [];
  for (const source of new Set(handler.groups.flatMap((group) => group.sources))) {
    const spot = extent.get(drawn(source));
    if (spot !== undefined) {
      xs.push(spot.x);
      continue;
    }
    if (withHandlers) {
      const hx = passA.get(source);
      if (hx !== undefined) {
        xs.push(hx);
      }
    }
  }
  return xs.length === 0 ? null : xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/**
 * Lay the horizontal band below the main flow: marks under the sources,
 * one bus rail per handler and class, the band top below the last rail,
 * and each handler at the mean x of its sources, clamped to the plate and
 * pushed right so handlers never overlap. Two X passes — main sources,
 * then main plus pass-A handler positions — break handler-to-handler
 * cycles. Null when there is nothing to lay.
 */
export function bandLayout(
  items: BandItem[],
  extent: Map<string, Extent>,
  bounds: BandBounds,
  rankX: (id: string) => number,
): BandSpot | null {
  if (items.length === 0) {
    return null;
  }
  const classes = classesOf(items);
  const { marks, temp } = bandMarks(items, extent, classes);
  const maxMarkY = marks.length === 0 ? null : Math.max(...marks.map((mark) => mark.y));
  const railBase = num(
    Math.max(
      maxMarkY === null ? Number.NEGATIVE_INFINITY : maxMarkY + MARK_HALF + BUS_HEAD,
      bounds.mainBottom + bounds.laneGap / 2,
    ),
  );
  const buses: BandBusSpot[] = temp.map((bus, index) => ({
    ...bus,
    rail: num(railBase + BUS_STACK * index),
    dropX: 0,
    top: 0,
  }));
  const lastRail = buses.length === 0 ? null : Math.max(...buses.map((bus) => bus.rail));
  const bandTop = num(
    Math.max(
      lastRail === null ? Number.NEGATIVE_INFINITY : lastRail + BUS_HEAD,
      bounds.mainBottom + bounds.laneGap,
    ),
  );
  const maxHh = Math.max(...items.map((item) => item.hh));
  const maxBottom = Math.max(...items.map((item) => item.bottom));
  const y = num(bandTop + maxHh);
  const bottom = num(y + maxBottom);

  const passARaw = new Map<string, number>();
  for (const item of items) {
    const mean = meanSourceX(item.handler, extent, new Map(), false);
    passARaw.set(item.handler.id, clampBandX(mean ?? rankX(item.handler.id), item.hw, bounds));
  }
  const passA = pushBandX(items, passARaw, bounds);
  const passBRaw = new Map<string, number>();
  for (const item of items) {
    const mean = meanSourceX(item.handler, extent, passA, true);
    passBRaw.set(item.handler.id, clampBandX(mean ?? rankX(item.handler.id), item.hw, bounds));
  }
  const xs = pushBandX(items, passBRaw, bounds);

  for (const bus of buses) {
    const item = items.find((candidate) => drawn(candidate.handler.id) === bus.to);
    const id = item?.handler.id ?? bus.to;
    bus.dropX = num(xs.get(id) ?? 0);
    bus.top = num(y - (item?.hh ?? 0));
  }

  const span: BandSpan = {
    channel: num(
      lastRail === null ? (bounds.mainBottom + bandTop) / 2 : (lastRail + bandTop) / 2,
    ),
    gutter: num(bounds.mainRight + bounds.laneGap / 2),
    corridor: num(bounds.mainTop - LANE_RISE),
    under: num(bottom + bounds.laneGap / 2),
  };

  const byId = new Map(items.map((item) => [item.handler.id, item]));
  for (const item of items) {
    for (const group of item.handler.groups) {
      for (const source of group.sources) {
        if (extent.has(drawn(source))) {
          continue;
        }
        const srcItem = byId.get(source);
        const hx = xs.get(source);
        if (srcItem === undefined || hx === undefined) {
          continue;
        }
        const both = (classes.get(source)?.size ?? 0) > 1;
        const base = y + srcItem.bottom + MARK_DX;
        marks.push({
          source: drawn(source),
          cls: group.cls,
          x: num(hx),
          y: num(base + (both ? (group.cls === "error" ? -MARK_STACK : MARK_STACK) : 0)),
        });
      }
    }
  }
  return { marks, buses, x: xs, y, top: bandTop, bottom, span };
}

/**
 * The band route of one lane edge, never through a main-lane node: into the
 * band the edge drops from the source bottom to the channel, across, and
 * into the handler top; out of the band it rises from the handler top to
 * the channel, out past the flow, above it, and down into the target top;
 * between two handlers it dips below the band and back up.
 */
export function bandRoute(
  route: { from: string; to: string; fromLane: boolean; toLane: boolean },
  extent: Map<string, Extent>,
  span: BandSpan,
): Pt[] | null {
  const from = extent.get(route.from);
  const to = extent.get(route.to);
  if (from === undefined || to === undefined) {
    return null;
  }
  if (route.fromLane && route.toLane) {
    return [
      { x: from.x, y: num(from.y + (from.bottom ?? from.hh)) },
      { x: from.x, y: span.under },
      { x: to.x, y: span.under },
      { x: to.x, y: num(to.y + (to.bottom ?? to.hh)) },
    ];
  }
  if (route.toLane) {
    return [
      { x: from.x, y: num(from.y + (from.bottom ?? from.hh)) },
      { x: from.x, y: span.channel },
      { x: to.x, y: span.channel },
      { x: to.x, y: num(to.y - to.hh) },
    ];
  }
  if (route.fromLane) {
    return [
      { x: from.x, y: num(from.y - from.hh) },
      { x: from.x, y: span.channel },
      { x: span.gutter, y: span.channel },
      { x: span.gutter, y: span.corridor },
      { x: to.x, y: span.corridor },
      { x: to.x, y: num(to.y - to.hh) },
    ];
  }
  return null;
}

/** Slide the band's marks, buses and done terminals into the padded viewBox. */
export function shiftedBand(
  spots: { marks: MarkSpot[]; buses: BandBusSpot[]; dones: DoneSpot[] },
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
    // A bus is one line per handler and class: a drop per main source down
    // to the rail, the rail across, and a drop into the handler top.
    buses: spots.buses.map((bus) => {
      const rail = round(bus.rail + dy);
      const dropX = round(bus.dropX + dx);
      const top = round(bus.top + dy);
      const parts: string[] = [];
      for (const drop of bus.drops) {
        const x = round(drop.x + dx);
        parts.push(`M${x} ${round(drop.y + dy)} L${x} ${rail}`);
      }
      const xs = [...bus.drops.map((drop) => drop.x), bus.dropX];
      const railStart = round(Math.min(...xs) + dx);
      const railEnd = round(Math.max(...xs) + dx);
      parts.push(`M${railStart} ${rail} L${railEnd} ${rail}`);
      parts.push(`M${dropX} ${rail} L${dropX} ${top}`);
      return { to: bus.to, cls: bus.cls, d: smooth(parts.join(" ")) };
    }),
    dones: spots.dones.map((done) => ({
      name: done.name,
      x: round(done.x + dx),
      y: round(done.y + dy),
    })),
  };
}
