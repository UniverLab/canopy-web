// SPDX-License-Identifier: Apache-2.0
/**
 * Document fixtures the tests serve as GitHub would: a valid graph, a valid
 * node and a broken one, straight from `test/fixtures/` (the published
 * examples are the contract) plus a hand-broken neighbour.
 */
import validGraphJson from "./fixtures/graphs/hello-graph/graph.json" with { type: "json" };
import validNodeJson from "./fixtures/nodes/hello-node/node.json" with { type: "json" };

/** The example hello-graph document, as GitHub would answer it serialized. */
export const VALID_GRAPH_TEXT = JSON.stringify(validGraphJson);

/** The example hello-node document, likewise. */
export const VALID_NODE_TEXT = JSON.stringify(validNodeJson);

/** A structurally valid document with an unknown extra field: schema-invalid. */
export const INVALID_GRAPH_TEXT = JSON.stringify({
  ...validGraphJson,
  definitely_not_in_schema: 1,
});

/** A node missing its required description and config: schema-invalid. */
export const BROKEN_NODE_TEXT = JSON.stringify({
  format_version: 1,
  name: "broken-node",
  kind: "agent",
});
