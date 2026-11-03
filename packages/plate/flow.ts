// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's wiring, read once for both orientations: which edges draw
 * through the column, which belong to the handler lane (routed outside it or
 * grouped away into marks and buses), and in what order they arrive. The
 * orientations turn these into their own endpoints and curves.
 */
import type { EdgeClass, ParsedGraph } from "./document.js";
import { wiringOf, type Handlers } from "./handlers.js";

/** One edge the column draws itself, by unit id. */
export interface FlowEdge {
  from: string;
  to: string;
  cls: EdgeClass;
}

/** One edge that belongs to the lane, by unit id. */
export interface LaneEdge extends FlowEdge {
  fromLane: boolean;
  toLane: boolean;
}

/** A graph's drawn wiring: the column's edges and the lane's, in document order. */
export interface Flow {
  drawn: FlowEdge[];
  lane: LaneEdge[];
}

/**
 * Split a graph's wiring: an input the destination groups draws as a mark
 * and a bus instead of an edge, and any other edge touching the lane is
 * routed outside the column. Everything else draws as it always has.
 */
export function flowOf(
  parsed: ParsedGraph,
  unitId: (name: string) => string | null,
  handlers: Handlers,
): Flow {
  const drawn: FlowEdge[] = [];
  const lane: LaneEdge[] = [];
  for (const wire of wiringOf(parsed, unitId)) {
    const grouped =
      handlers.get(wire.to)?.groups.some((group) => group.cls === wire.cls) ?? false;
    if (wire.cls !== "order" && grouped) {
      continue;
    }
    const fromLane = handlers.has(wire.from);
    const toLane = handlers.has(wire.to);
    if (!fromLane && !toLane) {
      drawn.push(wire);
    } else {
      lane.push({ ...wire, fromLane, toLane });
    }
  }
  return { drawn, lane };
}
