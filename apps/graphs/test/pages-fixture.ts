// SPDX-License-Identifier: Apache-2.0
/**
 * Page fixtures: a five-node graph with exactly one fail edge (the SVG
 * drawing test's subject) and the READMEs the sanitizer and the markdown
 * twin are checked against — one well-formed markdown README, one carrying
 * every flavour of raw HTML the renderer must never let through.
 */

/** One node of the five-node fixture. */
function node(name: string, kind: string, position: number): Record<string, unknown> {
  return { name, kind, position, config: {} };
}

/** The five-node document: build → test → gate → triage → docs, one fail edge back. */
export const FIVE_NODE_GRAPH: Record<string, unknown> = {
  format_version: 6,
  name: "hello-graph",
  description: "Five nodes with one fail edge, for the drawing test.",
  nodes: [
    node("build", "agent", 1),
    node("test", "check", 2),
    node("gate", "gate", 3),
    node("triage", "router", 4),
    node("docs", "agent", 5),
  ],
  edges: [
    { from_node: "build", to_node: "test", condition: "pass" },
    { from_node: "test", to_node: "gate", condition: "always" },
    { from_node: "test", to_node: "build", condition: "fail" },
    { from_node: "gate", to_node: "triage", condition: "pass" },
    { from_node: "triage", to_node: "docs", condition: { route: "ship" } },
  ],
};

/** The five-node document as GitHub would answer it serialized. */
export const FIVE_NODE_GRAPH_TEXT = JSON.stringify(FIVE_NODE_GRAPH);

/** A well-formed markdown README: heading, paragraph, fence, link, code. */
export const PAGES_README_TEXT = [
  `# hello-graph`,
  ``,
  `A graph the page tests render, with **one fail edge**.`,
  ``,
  `## Install`,
  ``,
  "```sh",
  `canopy graph install hello-graph`,
  "```",
  ``,
  `Read the [docs](https://univerlab.org/canopy/) and run \`npm test\`.`,
  ``,
].join("\n");

/** A README carrying script, img-onerror, bold, and a javascript: link. */
export const EVIL_README_TEXT = [
  `# evil`,
  ``,
  `<script>alert(1)</script>`,
  ``,
  `<img src=x onerror="alert(2)">`,
  ``,
  `<b>bold</b> and [a link](https://example.com/page?a=1&b=2) plus [bad](javascript:alert(3))`,
  ``,
].join("\n");
