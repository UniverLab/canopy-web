// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's drawn units: the geometry of nodes and ensemble groups —
 * member chips, group outlines, label extents — and the horizontal handler
 * band, which places the units that end a failure below the main flow.
 * `layout.js` re-exports the shared geometry, so its importers keep one
 * address for it.
 */
import {
  shapeOf,
  type EnsembleView,
  type NodeView,
  type ParsedGraph,
  type Strategy,
} from "./document.js";
import type { Handler, Handlers } from "./handlers.js";
import {
  MARK_DX,
  MARK_STACK,
  bandLayout,
  type BandBounds,
  type BandItem,
  type BandSpot,
  type Extent,
  type Lane,
  type MarkSpot,
} from "./lane.js";
import { GEOM, TYPE, nodeBox, num, type Kind } from "./vocabulary.js";

/** Vertical step between member chips inside a group. */
export const MEMBER_DY = 7;
/** Member chip size. */
const MEMBER_W = 14;
const MEMBER_H = 4;
/** The member chip geometry, shared with the renderer. */
export const MEMBER_GEOM = { w: MEMBER_W, h: MEMBER_H } as const;
/** Head room (two label lines) and foot room inside a group outline. */
export const GROUP_HEAD = 9;
export const GROUP_FOOT = 4;
/** Widest a group outline may grow: it must clear the neighbouring ranks. */
const GROUP_W_MAX = 38;
/** Ensemble names longer than this are truncated in the group label. */
const GROUP_NAME_MAX = 20;
/** Mono advance at the group/member type size, in viewBox units. */
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

/** The lowest point of a node: its harness line when it has one, else its label. */
export function nodeBottom(y: number, harness: string | null): number {
  return harness === null
    ? y + TYPE.labelDy + TYPE.label / 2
    : y + TYPE.harnessDy + TYPE.harness / 2;
}

/** One unit the handler band places, with the drawn half extents it needs. */
export interface BandUnit {
  handler: Handler;
  node: NodeView | null;
  group: EnsembleView | null;
  hw: number;
  hh: number;
  /** From the centre to the label or box bottom. */
  bottom: number;
}

/** What the handler band needs from the horizontal plate to place itself. */
export interface BandPlacementInput {
  handlers: Handlers;
  parsed: ParsedGraph;
  entry: NodeView | null;
  rankOf: Map<string, number>;
  /** A handler's fallback x when it has no placed source: its rank step. */
  rankX: (id: string) => number;
  bounds: BandBounds;
  /** The plate's placed units: the band appends its handlers here. */
  nodes: PlacedNode[];
  groups: PlacedGroup[];
  atX: Map<string, number>;
  atY: Map<string, number>;
}

/** The handler band's placement: the band, its units and the main extents. */
export interface BandPlacement {
  band: BandSpot | null;
  units: BandUnit[];
  mainExtent: Map<string, Extent>;
}

/**
 * Place the handler band: a horizontal band below the main flow, between
 * the main flow and the infra lane, its units in document order. Buses
 * drop from the sources straight down; lane edges return outside the
 * flow. Null band when there is nothing to lay.
 */
export function placeHandlerBand(input: BandPlacementInput): BandPlacement {
  const { handlers, parsed, entry, rankOf } = input;
  const units: BandUnit[] = [];
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
      units.push({ handler, node, group: null, ...box, bottom: nodeBottom(0, node.harness) });
    } else {
      const ensemble = parsed.ensembles.find((candidate) => `ensemble:${candidate.name}` === handler.id);
      if (ensemble === undefined) {
        continue;
      }
      const title = groupTitle(ensemble.name);
      const subtitle = groupSubtitle(ensemble.strategy, ensemble.minPass, ensemble.members.length);
      const w = num(groupWidth(title, subtitle, ensemble.members));
      const h = num(GROUP_HEAD + ensemble.members.length * MEMBER_DY + GROUP_FOOT);
      units.push({ handler, node: null, group: ensemble, hw: w / 2, hh: h / 2, bottom: h / 2 });
    }
  }
  const mainExtent = new Map<string, Extent>();
  for (const node of input.nodes) {
    mainExtent.set(node.name, {
      x: node.x,
      y: node.y,
      ...nodeBox(node),
      bottom: nodeBottom(0, node.harness),
    });
  }
  for (const group of input.groups) {
    mainExtent.set(group.name, {
      x: group.x,
      y: group.y,
      hw: group.w / 2,
      hh: group.h / 2,
      bottom: group.h / 2,
    });
  }
  const items: BandItem[] = units.map((unit) => ({
    handler: unit.handler,
    hw: unit.hw,
    hh: unit.hh,
    bottom: unit.bottom,
  }));
  const band: BandSpot | null = bandLayout(items, mainExtent, input.bounds, input.rankX);
  if (band !== null) {
    for (const unit of units) {
      const x = band.x.get(unit.handler.id);
      if (x === undefined) {
        continue;
      }
      const y = band.y;
      const rank = rankOf.get(unit.handler.id) ?? 0;
      input.atX.set(unit.handler.id, x);
      input.atY.set(unit.handler.id, y);
      if (unit.node !== null) {
        const shape = shapeOf(
          unit.node.docKind,
          unit.node.name,
          unit.node.commitRights,
          entry !== null && unit.node.name === entry.name,
        );
        input.nodes.push({
          name: unit.node.name,
          shape,
          docKind: unit.node.docKind,
          harness: unit.node.harness,
          x,
          y,
          w: GEOM[shape].w,
          h: GEOM[shape].h,
          rank,
          lane: "handler",
        });
      } else if (unit.group !== null) {
        const ensemble = unit.group;
        const title = groupTitle(ensemble.name);
        const subtitle = groupSubtitle(ensemble.strategy, ensemble.minPass, ensemble.members.length);
        const w = num(groupWidth(title, subtitle, ensemble.members));
        const h = num(GROUP_HEAD + ensemble.members.length * MEMBER_DY + GROUP_FOOT);
        const members = ensemble.members.map((label, memberIndex) => ({
          label,
          harness: ensemble.memberHarness[memberIndex] ?? null,
          x,
          y: num(y - h / 2 + GROUP_HEAD + memberIndex * MEMBER_DY + MEMBER_DY / 2),
        }));
        input.groups.push({ name: ensemble.name, title, subtitle, x, y, w, h, rank, members });
      }
    }
  }
  return { band, units, mainExtent };
}

/**
 * Mark the band's infra sources unbussed: they feed from below the band,
 * so no drop draws up through the band to the rail above it.
 */
export function markBandInfraSources(input: {
  units: BandUnit[];
  extent: Map<string, Extent>;
  mainExtent: Map<string, Extent>;
  band: BandSpot;
  /** The band's marks: the infra marks are appended here. */
  marks: MarkSpot[];
}): void {
  const classes = new Map<string, Set<"error" | "fail">>();
  for (const unit of input.units) {
    for (const group of unit.handler.groups) {
      for (const source of group.sources) {
        const seen = classes.get(source) ?? new Set<"error" | "fail">();
        seen.add(group.cls);
        classes.set(source, seen);
      }
    }
  }
  for (const unit of input.units) {
    for (const group of unit.handler.groups) {
      for (const source of group.sources) {
        const spot = input.extent.get(drawnName(source));
        if (spot === undefined) {
          continue;
        }
        if (input.mainExtent.has(drawnName(source))) {
          continue;
        }
        if (input.band.x.has(source)) {
          continue;
        }
        const both = (classes.get(source)?.size ?? 0) > 1;
        const base = spot.y + (spot.bottom ?? spot.hh) + MARK_DX;
        input.marks.push({
          source: drawnName(source),
          cls: group.cls,
          x: num(spot.x),
          y: num(base + (both ? (group.cls === "error" ? -MARK_STACK : MARK_STACK) : 0)),
        });
      }
    }
  }
}
