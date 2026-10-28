// SPDX-License-Identifier: Apache-2.0
/**
 * The four node kinds a graph document (and therefore the editor) holds,
 * and how each one draws in the plate vocabulary.
 *
 * Pure and dependency-light on purpose: the server-rendered shell
 * (pages/editor.ts) imports it to draw the palette's kind glyphs, the
 * browser bundle imports it to draw the canvas, and neither pulls the
 * other side in.
 */
import { type Kind } from "../../../../packages/plate/vocabulary.js";

/** The node kinds the schema allows in a graph document. */
export type NodeKind = "agent" | "check" | "gate" | "router";

/** Every node kind, in palette order. */
export const NODE_KINDS: readonly NodeKind[] = ["agent", "check", "gate", "router"];

/** True when the value names a graph node kind. */
export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && (NODE_KINDS as readonly string[]).includes(value);
}

/**
 * The plate shape a kind draws as: agents are agents, checks are checks,
 * and gates and routers are both gates — the same mapping the plate's own
 * `shapeOf` reaches for these kinds (routers read as gates).
 */
export function shapeOfKind(kind: string): Kind {
  if (kind === "agent") {
    return "agent";
  }
  if (kind === "gate" || kind === "router") {
    return "gate";
  }
  return "check";
}
