// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's ranking phase, shared by both orientations: a parsed graph
 * becomes layout units in document order, longest-path ranks over the rank
 * edges, fail-only targets lifted right after the unit that fails into
 * them, and one barycenter sweep ordering the units within each rank.
 *
 * Ranks are longest paths from the entry over `pass`/`always`/route edges
 * and ensemble `on_pass_to` exits — an ensemble is one layout unit, fail
 * and error edges never rank — with a Kahn sweep that breaks cycles
 * deterministically at the lowest document order.
 *
 * Everything here is total and deterministic: every sort has a full
 * tiebreak, and there is no randomness — so plates and their snapshots are
 * stable byte for byte.
 */
import {
  classOf,
  isRankCondition,
  type EnsembleView,
  type NodeView,
  type ParsedGraph,
} from "./document.js";

/** One layout unit: a node or an ensemble, with its document order. */
export interface Unit {
  id: string;
  order: number;
  node: NodeView | null;
  ensemble: EnsembleView | null;
}

/**
 * Longest-path ranks over the rank edges: a Kahn sweep assigns each unit
 * one rank past its deepest processed predecessor, and when a cycle stalls
 * the sweep the lowest-order unprocessed unit breaks the deadlock — every
 * unit is placed exactly once, deterministically.
 */
function ranksOf(units: Unit[], rankEdges: Array<{ from: string; to: string }>): Map<string, number> {
  const rank = new Map<string, number>(units.map((unit) => [unit.id, 0]));
  const sources = new Map<string, Set<string>>(units.map((unit) => [unit.id, new Set()]));
  for (const edge of rankEdges) {
    if (edge.from !== edge.to && rank.has(edge.from) && rank.has(edge.to)) {
      sources.get(edge.to)?.add(edge.from);
    }
  }
  const done = new Set<string>();
  const ordered = [...units].sort((a, b) => a.order - b.order);
  while (done.size < units.length) {
    const next = ordered.find((unit) => !done.has(unit.id) && (sources.get(unit.id)?.size ?? 0) === 0) ??
      ordered.find((unit) => !done.has(unit.id));
    if (next === undefined) {
      break;
    }
    done.add(next.id);
    for (const edge of rankEdges) {
      if (edge.from !== next.id || !rank.has(edge.to) || done.has(edge.to)) {
        continue;
      }
      sources.get(edge.to)?.delete(edge.from);
      const deeper = (rank.get(next.id) ?? 0) + 1;
      if (deeper > (rank.get(edge.to) ?? 0)) {
        rank.set(edge.to, deeper);
      }
    }
  }
  return rank;
}

/** One rank edge: the forward step from one layout unit to the next. */
export interface RankEdge {
  from: string;
  to: string;
}

/**
 * A parsed graph ranked for layout: its units, the rank edges between them,
 * each unit's rank, the barycenter-ordered units per rank, the entry node
 * and the name-to-unit resolver. Both orientations rank identically; only
 * the geometry after this differs.
 */
export interface RankedGraph {
  units: Unit[];
  rankEdges: RankEdge[];
  rankOf: Map<string, number>;
  byRank: Map<number, Unit[]>;
  entry: NodeView | null;
  unitId: (name: string) => string | null;
}

/**
 * Lift fail-only nodes into a rank right after the unit that fails into
 * them: a node — never the infra node — whose incoming edges are all fail or
 * error (node edges or an ensemble's `on_fail_to`), with no incoming rank
 * edge, and every outgoing edge back to an earlier unit. Without the lift
 * such a node sits at rank 0 with long fail arcs crossing the whole plate;
 * later units shift right to open the rank. Nodes failed into from the same
 * rank share the opened rank, in document order, so their fail arcs never
 * leap over one another. Returns whether any rank moved; ranks only ever
 * rise, to a fixpoint, so the sweep always settles.
 */
function rerankFailOnly(
  parsed: ParsedGraph,
  units: Unit[],
  rankEdges: RankEdge[],
  rankOf: Map<string, number>,
  unitId: (name: string) => string | null,
): boolean {
  const orderOf = new Map(units.map((unit) => [unit.id, unit.order]));
  const rankTargeted = new Set(rankEdges.map((edge) => edge.to));
  const failSources = new Map<string, string[]>();
  const addFailSource = (from: string, to: string): void => {
    if (from !== to) {
      failSources.set(to, [...(failSources.get(to) ?? []), from]);
    }
  };
  for (const edge of parsed.edges) {
    const cls = classOf(edge.condition);
    if (cls !== "fail" && cls !== "error") {
      continue;
    }
    const from = unitId(edge.from);
    const to = unitId(edge.to);
    if (from !== null && to !== null) {
      addFailSource(from, to);
    }
  }
  for (const ensemble of parsed.ensembles) {
    if (ensemble.onFailTo !== null) {
      const to = unitId(ensemble.onFailTo);
      if (to !== null) {
        addFailSource(`ensemble:${ensemble.name}`, to);
      }
    }
  }
  const outgoingOf = new Map<string, string[]>();
  const addOutgoing = (from: string, to: string): void => {
    if (from !== to) {
      outgoingOf.set(from, [...(outgoingOf.get(from) ?? []), to]);
    }
  };
  for (const edge of parsed.edges) {
    const from = unitId(edge.from);
    const to = unitId(edge.to);
    if (from !== null && to !== null) {
      addOutgoing(from, to);
    }
  }
  for (const ensemble of parsed.ensembles) {
    const id = `ensemble:${ensemble.name}`;
    const entries = [
      ...(ensemble.entryFrom === null ? [] : [ensemble.entryFrom]),
      ...ensemble.extraEntries.map((entry) => entry.from),
    ];
    for (const from of entries) {
      const fromId = unitId(from);
      if (fromId !== null) {
        addOutgoing(fromId, id);
      }
    }
  }
  const candidates = [...parsed.nodes]
    .sort((a, b) => (orderOf.get(a.name) ?? 0) - (orderOf.get(b.name) ?? 0))
    .filter((node) => {
      if (node.name === parsed.infra || rankTargeted.has(node.name)) {
        return false;
      }
      if ((failSources.get(node.name) ?? []).length === 0) {
        return false;
      }
      const order = orderOf.get(node.name) ?? 0;
      return (outgoingOf.get(node.name) ?? []).every((target) => (orderOf.get(target) ?? 0) < order);
    });
  if (candidates.length === 0) {
    return false;
  }
  let changed = false;
  for (let pass = 0; pass <= units.length + candidates.length; pass += 1) {
    // Every slot is read from the ranks of this pass before any rank moves:
    // candidates failed into from the same rank therefore open one rank
    // together, and units at or after an opened slot shift right once per
    // opened slot. A source that is itself a candidate takes its own slot in
    // the same sweep, so the next pass re-reads the chain; ranks only rise,
    // which is why the sweep settles.
    const slots = new Map<string, number>();
    const opened = new Set<number>();
    for (const node of candidates) {
      const sources = failSources.get(node.name) ?? [];
      const slot = Math.max(...sources.map((source) => rankOf.get(source) ?? 0)) + 1;
      slots.set(node.name, slot);
      if (slot !== (rankOf.get(node.name) ?? 0)) {
        opened.add(slot);
      }
    }
    if (opened.size === 0) {
      break;
    }
    changed = true;
    const shift = (rank: number): number =>
      rank + [...opened].filter((slot) => slot <= rank).length;
    const next = new Map<string, number>();
    for (const [id, rank] of rankOf) {
      next.set(id, slots.get(id) ?? shift(rank));
    }
    for (const [id, rank] of next) {
      rankOf.set(id, rank);
    }
  }
  return changed;
}

/**
 * Rank a parsed graph: units in document order, longest-path ranks over the
 * rank edges, fail-only nodes lifted into their own rank after the unit
 * that fails into them, one barycenter sweep within each rank. Deterministic
 * and total — the same input ranks the same way for both orientations.
 */
export function rankUnits(parsed: ParsedGraph): RankedGraph {
  const nodeNames = new Set(parsed.nodes.map((node) => node.name));
  const ensembleNames = new Set(parsed.ensembles.map((ensemble) => ensemble.name));
  const unitId = (name: string): string | null => {
    if (nodeNames.has(name)) {
      return name;
    }
    if (name.startsWith("ensemble:") && ensembleNames.has(name.slice("ensemble:".length))) {
      return name;
    }
    return null;
  };

  // Layout units in document order: nodes by position, then ensembles.
  const sortedNodes = [...parsed.nodes].sort(
    (a, b) => a.position - b.position || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const units: Unit[] = [
    ...sortedNodes.map((node, index) => ({ id: node.name, order: index, node, ensemble: null })),
    ...parsed.ensembles.map((ensemble, index) => ({
      id: `ensemble:${ensemble.name}`,
      order: sortedNodes.length + index,
      node: null,
      ensemble,
    })),
  ];
  // Rank edges: node pass/always/route edges, ensemble entries of those
  // classes, and every ensemble on_pass_to exit. Fail and error never rank.
  const rankEdges: RankEdge[] = [];
  for (const edge of parsed.edges) {
    if (!isRankCondition(edge.condition)) {
      continue;
    }
    const from = unitId(edge.from);
    const to = unitId(edge.to);
    if (from !== null && to !== null) {
      rankEdges.push({ from, to });
    }
  }
  for (const ensemble of parsed.ensembles) {
    const id = `ensemble:${ensemble.name}`;
    const entries = [
      ...(ensemble.entryFrom === null
        ? []
        : [{ from: ensemble.entryFrom, condition: ensemble.entryCondition }]),
      ...ensemble.extraEntries,
    ];
    for (const entry of entries) {
      if (!isRankCondition(entry.condition)) {
        continue;
      }
      const from = unitId(entry.from);
      if (from !== null) {
        rankEdges.push({ from, to: id });
      }
    }
    if (ensemble.onPassTo !== null) {
      const to = unitId(ensemble.onPassTo);
      if (to !== null) {
        rankEdges.push({ from: id, to });
      }
    }
  }

  // The entry is the main lane's start: a node with no incoming rank edge,
  // lowest position first. The infra lane never holds the entry.
  const targeted = new Set(rankEdges.map((edge) => edge.to));
  const candidates = sortedNodes.filter(
    (node) => node.name !== parsed.infra && !targeted.has(node.name),
  );
  const fallback = sortedNodes.filter((node) => node.name !== parsed.infra);
  const entry = candidates[0] ?? fallback[0] ?? sortedNodes[0] ?? null;

  const rankOf = ranksOf(units, rankEdges);

  // Fail-only targets rank after the unit that fails into them, and the
  // lift can empty rank 0 — compact so the plate still opens at the entry.
  if (rerankFailOnly(parsed, units, rankEdges, rankOf, unitId)) {
    const levels = [...new Set(rankOf.values())].sort((a, b) => a - b);
    const dense = new Map(levels.map((level, index) => [level, index]));
    for (const [id, rank] of rankOf) {
      rankOf.set(id, dense.get(rank) ?? rank);
    }
  }

  // Within a rank, one barycenter sweep orders units by the mean order
  // index of their earlier-rank predecessors; rank zero and units without
  // predecessors keep document order.
  const byRank = new Map<number, Unit[]>();
  for (const unit of units) {
    const rank = rankOf.get(unit.id) ?? 0;
    byRank.set(rank, [...(byRank.get(rank) ?? []), unit]);
  }
  const predsOf = new Map<string, string[]>();
  for (const edge of rankEdges) {
    predsOf.set(edge.to, [...(predsOf.get(edge.to) ?? []), edge.from]);
  }
  const indexOf = new Map<string, number>();
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const list = (byRank.get(rank) ?? []).sort((a, b) => a.order - b.order);
    if (rank > 0) {
      const mean = new Map<string, number>();
      for (const unit of list) {
        const preds = (predsOf.get(unit.id) ?? []).filter(
          (pred) => (rankOf.get(pred) ?? 0) < rank && indexOf.has(pred),
        );
        mean.set(
          unit.id,
          preds.length === 0
            ? Number.POSITIVE_INFINITY
            : preds.reduce((sum, pred) => sum + (indexOf.get(pred) ?? 0), 0) / preds.length,
        );
      }
      list.sort(
        (a, b) => (mean.get(a.id) ?? 0) - (mean.get(b.id) ?? 0) || a.order - b.order,
      );
    }
    list.forEach((unit, index) => indexOf.set(unit.id, index));
    byRank.set(rank, list);
  }
  return { units, rankEdges, rankOf, byRank, entry, unitId };
}
