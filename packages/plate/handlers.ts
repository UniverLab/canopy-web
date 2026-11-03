// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's handler lane: which units end a failure instead of carrying
 * the flow, what feeds them, and where the flow's own end node sits.
 *
 * A unit is a handler when one of these two rules holds over its inputs —
 * the node edges plus the ensemble wiring it is fed by and feeds:
 *
 *   (a) it is an `error` destination: some input is an error edge;
 *   (b) it is a sink of failure: every input is fail or error and it has no
 *       pass edge out, so nothing downstream continues the flow.
 *
 * Rule (a) reads "the platform broke"; rule (b) reads "the flow stopped
 * here". Both belong outside the working column: drawn inside it, their
 * long incoming edges fuse over the axis and read as the main path, which
 * is exactly the lie this lane removes. Rule (b) needs at least one input,
 * so a lone node in a one-node plate never becomes a handler.
 *
 * The inputs each handler groups are `error` sources always, and `fail`
 * sources only when rule (b) alone holds — a handler that still continues
 * the flow keeps its fail edges drawn, so only the terminal ones collapse
 * into one bus.
 *
 * Everything here is total and deterministic: the same document yields the
 * same handlers in document order, so plates and their snapshots stay
 * stable byte for byte.
 */
import { classOf, type EdgeClass, type ParsedGraph } from "./document.js";

/** One drawn wiring of a graph, by unit id — the nodes and the ensemble wiring. */
export interface Wire {
  from: string;
  to: string;
  cls: EdgeClass;
}

/**
 * Every drawn flow wiring of a parsed graph, by unit id: node edges, each
 * ensemble's entry and extra entries, and its pass and fail exits. Order
 * edges (member chips inside a group) are not wiring and never appear.
 */
export function wiringOf(
  parsed: ParsedGraph,
  unitId: (name: string) => string | null,
): Wire[] {
  const wires: Wire[] = [];
  const add = (fromName: string | null, toName: string | null, cls: EdgeClass): void => {
    const from = fromName === null ? null : unitId(fromName);
    const to = toName === null ? null : unitId(toName);
    if (from !== null && to !== null && from !== to) {
      wires.push({ from, to, cls });
    }
  };
  for (const edge of parsed.edges) {
    add(edge.from, edge.to, classOf(edge.condition));
  }
  for (const ensemble of parsed.ensembles) {
    const id = `ensemble:${ensemble.name}`;
    if (ensemble.entryFrom !== null) {
      add(ensemble.entryFrom, id, classOf(ensemble.entryCondition));
    }
    for (const extra of ensemble.extraEntries) {
      add(extra.from, id, classOf(extra.condition));
    }
    if (ensemble.onPassTo !== null) {
      add(id, ensemble.onPassTo, "pass");
    }
    if (ensemble.onFailTo !== null) {
      add(id, ensemble.onFailTo, "fail");
    }
  }
  return wires;
}

/** One class of input a handler groups: the error marks or the fail marks. */
export interface HandlerGroup {
  cls: "error" | "fail";
  /** Source unit ids, in document order, each source once. */
  sources: string[];
}

/** A unit laid out in the side lane, with the inputs it groups. */
export interface Handler {
  /** The unit id: a node name, or `ensemble:<name>`. */
  id: string;
  /** The unit's document order, which orders the lane. */
  order: number;
  /** The grouped inputs: errors first, then the sink's fails. */
  groups: HandlerGroup[];
}

/** The handlers of one graph, in document order. */
export interface Handlers {
  list: Handler[];
  has: (id: string) => boolean;
  get: (id: string) => Handler | undefined;
}

/** One source once, in the order the wiring names it. */
function sourcesOf(wires: Wire[], cls: EdgeClass): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const wire of wires) {
    if (wire.cls === cls && !seen.has(wire.from)) {
      seen.add(wire.from);
      sources.push(wire.from);
    }
  }
  return sources;
}

/**
 * Read the handlers of a parsed graph: the units that are an error
 * destination, or a sink fed only by fail and error edges with no pass exit.
 * Passed `unitOrder`, the result comes back in document order.
 */
export function handlersOf(
  parsed: ParsedGraph,
  unitId: (name: string) => string | null,
  unitOrder: (id: string) => number,
): Handlers {
  const wires = wiringOf(parsed, unitId);
  const inputs = new Map<string, Wire[]>();
  const passOut = new Set<string>();
  for (const wire of wires) {
    inputs.set(wire.to, [...(inputs.get(wire.to) ?? []), wire]);
    if (wire.cls === "pass") {
      passOut.add(wire.from);
    }
  }
  const list: Handler[] = [];
  for (const [id, feeding] of inputs) {
    const errors = sourcesOf(feeding, "error");
    const fails = sourcesOf(feeding, "fail");
    const errorFed = errors.length > 0;
    const failSink =
      fails.length > 0 && feeding.every((wire) => wire.cls !== "pass") && !passOut.has(id);
    if (!errorFed && !failSink) {
      continue;
    }
    const groups: HandlerGroup[] = [];
    if (errorFed) {
      groups.push({ cls: "error", sources: errors });
    }
    if (failSink) {
      groups.push({ cls: "fail", sources: fails });
    }
    list.push({ id, order: unitOrder(id), groups });
  }
  list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map(list.map((handler) => [handler.id, handler]));
  return {
    list,
    has: (id) => byId.has(id),
    get: (id) => byId.get(id),
  };
}

/** A happy-path unit's end: its id and its document order. */
export interface DoneUnit {
  id: string;
  order: number;
}

/**
 * The units the flow ends on: a unit fed by the flow — at least one input —
 * with no pass edge out. A lone node in a one-node plate is fed by nothing,
 * so a node plate draws no end; a chain's last node, or a sink that only
 * fails back, does. Handlers are their lane's business and are never done.
 */
export function doneUnitsOf(
  parsed: ParsedGraph,
  unitId: (name: string) => string | null,
  unitOrder: (id: string) => number,
  handlers: Handlers,
): DoneUnit[] {
  const wires = wiringOf(parsed, unitId);
  const fed = new Set(wires.map((wire) => wire.to));
  const passOut = new Set(wires.filter((wire) => wire.cls === "pass").map((wire) => wire.from));
  const done = new Map<string, DoneUnit>();
  for (const id of fed) {
    if (passOut.has(id) || handlers.has(id)) {
      continue;
    }
    done.set(id, { id, order: unitOrder(id) });
  }
  return [...done.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}
