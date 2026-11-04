// SPDX-License-Identifier: Apache-2.0
import graphSchema from "../schema/graph.schema.json" with { type: "json" };
import nodeSchema from "../schema/node.schema.json" with { type: "json" };
import { SLUG_PATTERN, SLUG_RE } from "./slug.js";

/**
 * The single contract the worker and Canopy's `graph validate` agree on.
 * Imported from `schema/`, never copied.
 */
export { graphSchema, nodeSchema };
export { SLUG_PATTERN, SLUG_RE };

export type DocumentKind = "graph" | "node";

/** JSON value helpers for schema-typed documents. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function schemaFor(kind: DocumentKind): unknown {
  return kind === "graph" ? graphSchema : nodeSchema;
}
