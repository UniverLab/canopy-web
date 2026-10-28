// SPDX-License-Identifier: Apache-2.0
/**
 * The remote editor's own model: nodes with ports, edges by node id, and
 * editable ensembles — plus the two fixed nodes every graph carries.
 *
 * `spec` (output port only) is the fixed entry and `next` (input port
 * only) the fixed exit. They cannot be renamed or deleted, and Clear
 * keeps them. Coordinates are world pixels at zoom 1, like the catalogue
 * editor's; the document mapping in mapping.ts drops them on export.
 *
 * Ensemble members are agent nodes whose ids the ensemble lists. While
 * grouped they draw as chips inside the ensemble's dashed box and take
 * no individual edges: wiring attaches to the ensemble itself.
 */
import type { NodeKind } from "../../../../graphs/src/editor/kinds.js";
import type { JsonValue } from "../../../../../src/schema.js";

/** The stable client ids of the two fixed nodes. */
export const SPEC_ID = "spec";
export const NEXT_ID = "next";

/** Their drawn names, which the problems panel also speaks. */
export const SPEC_NAME = "spec";
export const NEXT_NAME = "next";

/** The graph name a cleared canvas starts with (it satisfies the slug rule). */
export const BLANK_NAME = "untitled";

/** How many agent nodes one ensemble holds. */
export const ENSEMBLE_MIN = 2;
export const ENSEMBLE_MAX = 8;

/** An ensemble's strategy, the schema's own words. */
export type EnsembleKind = "parallel" | "cascade" | "round_robin";

export const ENSEMBLE_KINDS: readonly EnsembleKind[] = ["parallel", "cascade", "round_robin"];

/** True when the value names an ensemble strategy. */
export function isEnsembleKind(value: unknown): value is EnsembleKind {
  return (
    value === "parallel" || value === "cascade" || value === "round_robin"
  );
}

/**
 * A node's kind on this canvas: the four document kinds plus the two
 * fixed endpoints, which never reach the document as nodes.
 */
export type EditorKind = NodeKind | "spec" | "next";

/** One node on the canvas: identity, document fields, canvas point. */
export interface EditorNode {
  /** Stable client id; `spec` and `next` for the fixed endpoints. */
  id: string;
  name: string;
  kind: EditorKind;
  config: Record<string, JsonValue>;
  /** Canvas x/y in world pixels. Members rest while grouped. */
  x: number;
  y: number;
}

/** One edge: endpoints by node or ensemble id, and the raw condition. */
export interface EditorEdge {
  id: string;
  from: string;
  to: string;
  condition: JsonValue;
}

/** One editable ensemble: strategy, prompts, and its member node ids. */
export interface EditorEnsemble {
  /** Stable client id; endpoints reference it the way they do nodes. */
  id: string;
  name: string;
  kind: EnsembleKind;
  min_pass: number;
  /** The shared prompt: the document's `prompt_template`. */
  prompt: string;
  /** Per member, the optional prompt override, by member node id. */
  overrides: Record<string, string>;
  /** Per member, a preserved `timeout_minutes`, by member node id. */
  memberTimeouts: Record<string, number>;
  /** Member node ids, in document order. */
  members: string[];
  /** Preserved document fields the inspector does not edit. */
  commit_rights: boolean;
  timeout_minutes: number;
  /** Other preserved ensemble keys (crew, grace windows, …). */
  extra: Record<string, JsonValue>;
  /** The box centre in world pixels. */
  x: number;
  y: number;
}

/** The whole work in progress. */
export interface EditorState {
  name: string;
  description: string;
  nodes: EditorNode[];
  edges: EditorEdge[];
  ensembles: EditorEnsemble[];
  /** Verbatim sections the editor does not edit: hooks, infra_node, presets. */
  sections: Record<string, JsonValue>;
}

let idCounter = 0;

/** A fresh client id for a node, edge or ensemble. */
export function newEditorId(): string {
  const web = globalThis.crypto;
  if (web !== undefined && typeof web.randomUUID === "function") {
    return web.randomUUID();
  }
  idCounter += 1;
  return `e${idCounter}-${Date.now().toString(36)}`;
}

/**
 * A unique name: the base when free, else the base suffixed `-2`, `-3`,
 * … — trimmed to keep a slug within its 48 characters.
 */
export function uniqueEditorName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return base.slice(0, 48);
}

/** The fixed entry node, at the canvas's left. */
export function specNode(): EditorNode {
  return { id: SPEC_ID, name: SPEC_NAME, kind: "spec", config: {}, x: 100, y: 260 };
}

/** The fixed exit node, at the canvas's right. */
export function nextNode(): EditorNode {
  return { id: NEXT_ID, name: NEXT_NAME, kind: "next", config: {}, x: 1060, y: 260 };
}

/** True when the id names one of the two fixed endpoints. */
export function isFixedId(id: string): boolean {
  return id === SPEC_ID || id === NEXT_ID;
}

/** A brand-new canvas: the name, the two fixed nodes, nothing else. */
export function blankEditorState(): EditorState {
  return {
    name: BLANK_NAME,
    description: "",
    nodes: [specNode(), nextNode()],
    edges: [],
    ensembles: [],
    sections: {},
  };
}

/** The ensemble holding this node id, or null when it stands alone. */
export function ensembleOf(state: EditorState, nodeId: string): EditorEnsemble | null {
  return state.ensembles.find((ensemble) => ensemble.members.includes(nodeId)) ?? null;
}

/** The node or ensemble this endpoint id names, for edge labels. */
export function endpointName(state: EditorState, id: string): string {
  const node = state.nodes.find((entry) => entry.id === id);
  if (node !== undefined) {
    return node.name;
  }
  return state.ensembles.find((entry) => entry.id === id)?.name ?? "?";
}
