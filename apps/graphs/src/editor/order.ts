// SPDX-License-Identifier: Apache-2.0
/**
 * The orderings the editor derives from the canvas, both pure:
 *
 * - `positionsOf` answers the exported `position` of every node: its rank
 *   in a topological order over the edges it is given (the caller leaves
 *   `fail` edges out — they may point backwards), with ties broken by
 *   canvas x, then y. It is Kahn's algorithm over a ready set sorted that
 *   way; when a cycle stalls the sweep, the same order picks the next
 *   node from what remains, so every node is placed exactly once.
 * - `levelsOf` answers longest-path levels over the same edges, for
 *   laying an imported document out in columns (rank 0 in the first).
 *
 * Neither touches the DOM, the clock or a global: the tests call them
 * with plain objects, and so does the export path on every change.
 */

/** One node as an ordering sees it: an id and its canvas point. */
export interface OrderNode {
  id: string;
  x: number;
  y: number;
}

/** One edge as an ordering sees it: endpoints by node id. */
export interface OrderEdge {
  from: string;
  to: string;
}

/** Canvas order, fully deterministic: x, then y, then id as the last resort. */
function byCanvas(a: OrderNode, b: OrderNode): number {
  if (a.x !== b.x) {
    return a.x - b.x;
  }
  if (a.y !== b.y) {
    return a.y - b.y;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The adjacency of edges that name two known, distinct nodes. */
function adjacency(
  nodes: OrderNode[],
  edges: OrderEdge[],
): { indegree: Map<string, number>; out: Map<string, string[]> } {
  const known = new Set(nodes.map((node) => node.id));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const out = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (edge.from === edge.to || !known.has(edge.from) || !known.has(edge.to)) {
      continue;
    }
    out.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  return { indegree, out };
}

/**
 * Positions 1..n: repeatedly take the ready node (every incoming edge
 * processed) with the smallest canvas x, then y; when none is ready the
 * cycle fallback takes the same first node of what remains — so a cycle
 * still yields a complete, deterministic order instead of dropping nodes.
 */
export function positionsOf(nodes: OrderNode[], edges: OrderEdge[]): Map<string, number> {
  const { indegree, out } = adjacency(nodes, edges);
  const remaining = [...nodes].sort(byCanvas);
  const positions = new Map<string, number>();
  let next = 1;
  while (positions.size < nodes.length && remaining.length > 0) {
    const ready = remaining.filter((node) => (indegree.get(node.id) ?? 0) === 0);
    const pick = (ready[0] ?? remaining[0]) as OrderNode;
    remaining.splice(remaining.indexOf(pick), 1);
    positions.set(pick.id, next);
    next += 1;
    for (const to of out.get(pick.id) ?? []) {
      indegree.set(to, (indegree.get(to) ?? 0) - 1);
    }
  }
  return positions;
}

/**
 * Longest-path levels: a node sits one level past its deepest processed
 * predecessor; the cycle fallback advances the same way (it takes the
 * first remaining node, whose level is simply kept). The caller's node
 * order decides ties only where the edges leave a node undecided — pass
 * nodes in document (or canvas) order.
 */
export function levelsOf(nodes: OrderNode[], edges: OrderEdge[]): Map<string, number> {
  const { indegree, out } = adjacency(nodes, edges);
  const level = new Map(nodes.map((node) => [node.id, 0]));
  const remaining = [...nodes];
  const done = new Set<string>();
  while (done.size < nodes.length && remaining.length > 0) {
    const readyIndex = remaining.findIndex((node) => (indegree.get(node.id) ?? 0) === 0);
    const pick = remaining[readyIndex === -1 ? 0 : readyIndex] as OrderNode;
    remaining.splice(remaining.indexOf(pick), 1);
    done.add(pick.id);
    for (const to of out.get(pick.id) ?? []) {
      indegree.set(to, (indegree.get(to) ?? 0) - 1);
      if (!done.has(to)) {
        const deeper = (level.get(pick.id) ?? 0) + 1;
        if (deeper > (level.get(to) ?? 0)) {
          level.set(to, deeper);
        }
      }
    }
  }
  return level;
}
