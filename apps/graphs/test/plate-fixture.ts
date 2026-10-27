// SPDX-License-Identifier: Apache-2.0
/**
 * Plate fixtures: a canopy-tui-polish-shaped graph with two ensembles, fail
 * back edges and an infra node — the shapes the four small official graphs
 * never show — plus a sixty-node chain for the render-time budget.
 */
import type { GraphDocument } from "../src/plate/document.js";

/** One node of the polish fixture. */
function node(name: string, kind: string, position: number): GraphDocument["nodes"][number] {
  return { name, kind, position, config: {} };
}

/**
 * The polish-shaped document: design drafts, three parallel proposers draft
 * beside it, implement builds, gates check, a cascade pair stands behind
 * review, Commit lands, and resilience catches infrastructure failures in
 * the lower lane. Fail edges route back to implement; the recovery edge
 * climbs back from resilience to design.
 */
export const TUI_POLISH_GRAPH: GraphDocument = {
  name: "canopy-tui-polish",
  nodes: [
    node("design", "agent", 1),
    node("implement", "agent", 2),
    { name: "gates", kind: "check", position: 3, config: { command: "npm test" } },
    node("review", "agent", 4),
    { name: "Commit", kind: "check", position: 5, config: { command: "git commit" } },
    node("resilience", "agent", 6),
  ],
  edges: [
    { from_node: "implement", to_node: "gates", condition: "pass" },
    { from_node: "gates", to_node: "implement", condition: "fail" },
    { from_node: "review", to_node: "Commit", condition: "pass" },
    { from_node: "review", to_node: "implement", condition: "fail" },
    { from_node: "implement", to_node: "resilience", condition: "error" },
    { from_node: "resilience", to_node: "design", condition: "pass" },
  ],
  ensembles: [
    {
      name: "proposers",
      kind: "parallel",
      min_pass: 2,
      members: [{ platform: "codex" }, { platform: "gemini" }, { platform: "copilot" }],
      entry_from_node: "design",
      entry_condition: "pass",
      on_pass_to: "implement",
    },
    {
      name: "fallbacks",
      kind: "cascade",
      min_pass: 1,
      members: [{ platform: "kiro" }, { platform: "mimo" }],
      entry_from_node: "gates",
      entry_condition: "pass",
      on_pass_to: "review",
      on_fail_to: "implement",
    },
  ],
  infra_node: "resilience",
};

/** A sixty-node pass chain: the render-time budget's subject. */
export function sixtyNodeGraph(): GraphDocument {
  const nodes: GraphDocument["nodes"] = [];
  const edges: GraphDocument["edges"] = [];
  for (let index = 0; index < 60; index += 1) {
    nodes.push(node(`node-${index}`, "agent", index + 1));
    if (index > 0) {
      edges.push({ from_node: `node-${index - 1}`, to_node: `node-${index}`, condition: "pass" });
    }
  }
  return { name: "sixty", nodes, edges };
}

/** One round-robin ensemble between two agents: the third subtitle shape. */
export const ROUND_ROBIN_GRAPH: GraphDocument = {
  name: "round-robin",
  nodes: [node("before", "agent", 1), node("after", "agent", 2)],
  edges: [],
  ensembles: [
    {
      name: "rotators",
      kind: "round_robin",
      min_pass: 1,
      members: [{}, {}],
      entry_from_node: "before",
      entry_condition: "pass",
      on_pass_to: "after",
    },
  ],
};
