// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's walk generator: the edges one animated walk rides, decided
 * by an injected `random()` — the layout turns the steps into curves, the
 * tests into plain arrays, and neither needs a DOM.
 *
 * A walk starts at the entry and steps along each unit's first outgoing
 * pass edge in document order, exactly like the token's happy path. At a
 * unit carrying an outgoing fail edge — a node's `fail` edge or an
 * ensemble's `on_fail_to` exit — the walk first draws `random()`: below
 * FAIL_CHANCE it rides a fail edge instead (uniformly, when several),
 * but only when the landing can return to the main flow, looping back
 * along the red curve before the unit finally gets through. Fail edges
 * into terminal units are never ridden: the dot stays on the happy path.
 * One walk rides at most FAIL_CAP fail edges; after the third every unit
 * passes, so every walk reaches the end and the animation restarts.
 *
 * A fail landing clears the visited set: the loop-back walks familiar
 * ground on purpose, and the pass steps after it may not dead-end on a
 * revisit — the seen-break guards each pass segment alone, so termination
 * never depends on the draws. Everything here is pure and total: the
 * default random fails nothing, and the walk it returns is the happy path
 * the plate drew before, step for step.
 */
import { classOf, isRankCondition, type ParsedGraph } from "./document.js";

/** The chance a fail-carrying unit takes a fail edge on any one step. */
export const FAIL_CHANCE = 0.2;

/** The most fail edges one walk rides; after the third every unit passes. */
export const FAIL_CAP = 3;

/** Nominal seconds one leg of the walk takes, fail or pass alike. */
export const STEP_SECONDS = 0.9;

/** One walk step: the unit it leaves, the unit it reaches, whether it rode a fail edge. */
export interface WalkStep {
  from: string;
  to: string;
  fail: boolean;
}

/** The draw that never fails a unit: the happy path, the plates' byte-identical default. */
export const happyRandom = (): number => 1;

/** mulberry32: a tiny seeded PRNG — the same seed replays the same walk. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The unit id of a wiring name: nodes plain, ensembles prefixed — null when it names neither. */
function unitOf(parsed: ParsedGraph, name: string | null): string | null {
  if (name === null) {
    return null;
  }
  if (parsed.nodes.some((node) => node.name === name)) {
    return name;
  }
  if (
    name.startsWith("ensemble:") &&
    parsed.ensembles.some((ensemble) => ensemble.name === name.slice("ensemble:".length))
  ) {
    return name;
  }
  return null;
}

/** A unit's drawn name: ensembles lose the `ensemble:` prefix, as the plate labels them. */
function drawnName(id: string): string {
  return id.startsWith("ensemble:") ? id.slice("ensemble:".length) : id;
}

/** Every unit a plate draws: the nodes and the ensembles, by drawn name. */
export function walkUnits(parsed: ParsedGraph): Set<string> {
  return new Set([
    ...parsed.nodes.map((node) => node.name),
    ...parsed.ensembles.map((ensemble) => ensemble.name),
  ]);
}

/**
 * Whether a fail landing can return to the main flow: true when the
 * destination itself is on it, or the pass chain from it reaches the
 * flow before a revisit or a dead end. Cycles and terminal units fail.
 */
export function canReturnToFlow(
  pass: ReadonlyMap<string, string>,
  flow: ReadonlySet<string>,
  destination: string,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = destination;
  while (current !== undefined && !seen.has(current)) {
    if (flow.has(current)) {
      return true;
    }
    seen.add(current);
    current = pass.get(current);
  }
  return false;
}

/** The main flow: the pass chain from the entry, bounded by a revisit. */
function mainFlowOf(pass: ReadonlyMap<string, string>, entry: string | null): Set<string> {
  const flow = new Set<string>();
  let current: string | null | undefined = entry;
  while (current !== null && current !== undefined && !flow.has(current)) {
    flow.add(current);
    current = pass.get(current) ?? null;
  }
  return flow;
}

/**
 * Each unit's outgoing edges for the walk: its first pass edge in
 * document order — node pass/always/route edges, an ensemble's entry and
 * `on_pass_to` exits, the happy path exactly — and its fail edges in
 * document order — node `fail` edges and `on_fail_to` exits whose target
 * is drawn. Keys and targets carry drawn names.
 */
function outgoing(parsed: ParsedGraph, drawn: ReadonlySet<string>): {
  pass: Map<string, string>;
  fail: Map<string, string[]>;
} {
  const nodeNames = new Set(parsed.nodes.map((node) => node.name));
  const pass = new Map<string, string>();
  const fail = new Map<string, string[]>();
  const addFail = (from: string, to: string): void => {
    fail.set(from, [...(fail.get(from) ?? []), to]);
  };
  const passTarget = (target: string | null): string | null => {
    const id = unitOf(parsed, target);
    if (id === null) {
      return null;
    }
    const name = drawnName(id);
    return drawn.has(name) ? name : null;
  };
  for (const edge of parsed.edges) {
    const from = unitOf(parsed, edge.from);
    const to = unitOf(parsed, edge.to);
    if (from === null || to === null) {
      continue;
    }
    if (classOf(edge.condition) === "fail") {
      if (from !== to && drawn.has(drawnName(to))) {
        addFail(drawnName(from), drawnName(to));
      }
    } else if (
      isRankCondition(edge.condition) &&
      !pass.has(edge.from) &&
      nodeNames.has(edge.from) &&
      nodeNames.has(edge.to)
    ) {
      pass.set(edge.from, edge.to);
    }
  }
  for (const ensemble of parsed.ensembles) {
    const entryId = passTarget(ensemble.entryFrom);
    if (
      entryId !== null &&
      entryId !== ensemble.name &&
      !pass.has(entryId) &&
      isRankCondition(ensemble.entryCondition)
    ) {
      pass.set(entryId, ensemble.name);
    }
    const passId = passTarget(ensemble.onPassTo);
    if (passId !== null && passId !== ensemble.name) {
      pass.set(ensemble.name, passId);
    }
    const onFail = unitOf(parsed, ensemble.onFailTo);
    if (onFail !== null && onFail !== `ensemble:${ensemble.name}` && drawn.has(drawnName(onFail))) {
      addFail(ensemble.name, drawnName(onFail));
    }
  }
  return { pass, fail };
}

/**
 * One walk of the graph: from the entry, each unit's pass edge, with one
 * draw at every unit whose fail edges can return to the main flow while
 * the walk still has fail edges left to spend — below FAIL_CHANCE it
 * rides one instead. A fail landing clears the visited set, so the
 * loop-back re-walks ground and still gets through; a pass landing stops
 * the walk at a revisit, which bounds every segment. Fail edges into
 * terminal units are never ridden and consume no draw. Empty without a
 * drawn entry.
 */
export function generateWalk(
  parsed: ParsedGraph,
  entry: string | null,
  drawn: ReadonlySet<string>,
  random: () => number,
): WalkStep[] {
  if (entry === null || !drawn.has(entry)) {
    return [];
  }
  const { pass, fail } = outgoing(parsed, drawn);
  const flow = mainFlowOf(pass, entry);
  const steps: WalkStep[] = [];
  const seen = new Set<string>([entry]);
  let current = entry;
  let fails = 0;
  for (;;) {
    const targets =
      fails < FAIL_CAP ? (fail.get(current) ?? []).filter((to) => canReturnToFlow(pass, flow, to)) : [];
    if (targets.length > 0 && random() < FAIL_CHANCE) {
      const pick =
        targets.length > 1 ? Math.min(targets.length - 1, Math.floor(random() * targets.length)) : 0;
      const to = targets[pick] ?? current;
      steps.push({ from: current, to, fail: true });
      fails += 1;
      seen.clear();
      seen.add(to);
      current = to;
      continue;
    }
    const next = pass.get(current) ?? null;
    if (next === null || !drawn.has(next) || seen.has(next)) {
      break;
    }
    steps.push({ from: current, to: next, fail: false });
    seen.add(next);
    current = next;
  }
  return steps;
}
