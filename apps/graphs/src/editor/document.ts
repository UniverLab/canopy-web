// SPDX-License-Identifier: Apache-2.0
/**
 * The document boundary: a graph document (format v6) becomes editor
 * state, and editor state becomes a graph document again — plus the one
 * door a catalogue node enters by.
 *
 * - `importGraph` reads a document into the state: `name`,
 *   `description`, `nodes`, `edges` become editable; every other top
 *   level section (`ensembles`, `hooks`, `infra_node`, `presets`, …)
 *   rides along in `sections` verbatim and is written back verbatim.
 *   Nodes are laid out in columns by topological level over the non-fail
 *   edges, so a failing edge that points backwards never drags its
 *   target left. A document that binds `platform`, `model` or `cli` — or
 *   does not match its schema — is refused with that reason.
 * - `exportGraph` writes the document back: `position` is the rank in a
 *   Kahn order over the non-fail edges with ties broken by canvas x then
 *   y (order.ts), edges resolve node ids to the names of the moment, and
 *   `sections` is spread in untouched.
 * - `importNodeDocument` + `addCatalogNode` copy a catalogue node onto
 *   the canvas — its `name`, `kind`, `config` and its `preset`, the
 *   preset landing in the graph's `presets` under its own name (an
 *   existing entry is never overwritten) and, for an agent that names no
 *   preset yet, referenced from `config.prompt_preset`.
 */
import { isArray, isRecord, isString, type JsonValue } from "../json.js";
import { documentProblems, harnessProblems, type DocumentProblem } from "../validate.js";
import { EDITOR_ENSEMBLE_NODE, EDITOR_IMPORT_BAD, EDITOR_IMPORT_HARNESS } from "../pages/copy.js";
import { isNodeKind, type NodeKind } from "./kinds.js";
import { levelsOf, positionsOf } from "./order.js";
import {
  blankState,
  newNodeId,
  uniqueName,
  type CanvasEdge,
  type CanvasNode,
  type EditorState,
} from "./state.js";

/** Column and row steps for an imported document's initial layout (world px). */
export const IMPORT_COL_DX = 260;
export const IMPORT_ROW_DY = 150;
export const IMPORT_PAD = 100;

/** A refusal: the head line, then each problem as `path: message`. */
function refusalText(head: string, problems: DocumentProblem[]): string {
  const detail = problems
    .slice(0, 3)
    .map((problem) => `${problem.path}: ${problem.message}`)
    .join(" · ");
  return detail === "" ? head : `${head} ${detail}`;
}

/** The top-level keys the editor edits itself; everything else is kept. */
const EDITED_KEYS = new Set(["format_version", "name", "description", "nodes", "edges"]);

/** True when the condition is `fail` — the one class that never ranks. */
export function isFailCondition(condition: JsonValue): boolean {
  return condition === "fail";
}

/**
 * Read a graph document into editor state. Schema problems and harness
 * bindings both refuse: the editor never holds a document whose output
 * could not be shared.
 */
export function importGraph(document: unknown): { state: EditorState } | { error: string } {
  if (!isRecord(document)) {
    return { error: EDITOR_IMPORT_BAD };
  }
  const harness = harnessProblems("graph", document);
  if (harness.length > 0) {
    return { error: refusalText(EDITOR_IMPORT_HARNESS, harness) };
  }
  const schema = documentProblems("graph", document);
  if (schema.length > 0) {
    return { error: refusalText(EDITOR_IMPORT_BAD, schema) };
  }

  const state = blankState();
  state.name = isString(document["name"]) ? document["name"] : state.name;
  state.description = isString(document["description"]) ? document["description"] : "";
  for (const [key, section] of Object.entries(document)) {
    if (!EDITED_KEYS.has(key)) {
      state.sections[key] = section;
    }
  }

  // Nodes, in document order (it breaks layout ties), names kept unique.
  const rawNodes = isArray(document["nodes"]) ? document["nodes"] : [];
  const idOf = new Map<string, string>();
  for (const entry of rawNodes) {
    if (!isRecord(entry)) {
      continue;
    }
    const kind = entry["kind"];
    const config = entry["config"];
    if (!isNodeKind(kind) || !isString(entry["name"]) || !isRecord(config)) {
      continue; // unreachable: the schema check above guarantees all three
    }
    const name = uniqueName(entry["name"], new Set(state.nodes.map((node) => node.name)));
    state.nodes.push({
      id: newNodeId(),
      name,
      kind,
      config: { ...config },
      x: 0,
      y: 0,
    });
    if (!idOf.has(entry["name"])) {
      idOf.set(entry["name"], state.nodes[state.nodes.length - 1]?.id ?? "");
    }
  }

  // Columns by level over the non-fail edges; rows stack within a column.
  const level = levelsOf(
    state.nodes.map((node, index) => ({ id: node.id, x: index, y: 0 })),
    rankEdges(state, idOf, isArray(document["edges"]) ? document["edges"] : []),
  );
  const rows = new Map<number, number>();
  for (const node of state.nodes) {
    const column = level.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    node.x = IMPORT_PAD + column * IMPORT_COL_DX;
    node.y = IMPORT_PAD + row * IMPORT_ROW_DY;
  }

  // Edges, resolved by name to ids; an endpoint the document lacks is dropped.
  for (const entry of isArray(document["edges"]) ? document["edges"] : []) {
    if (!isRecord(entry) || !isString(entry["from_node"]) || !isString(entry["to_node"])) {
      continue;
    }
    const from = idOf.get(entry["from_node"]);
    const to = idOf.get(entry["to_node"]);
    if (from === undefined || to === undefined) {
      continue;
    }
    state.edges.push({
      id: newNodeId(),
      from,
      to,
      condition: entry["condition"] ?? "pass",
    });
  }
  return { state };
}

/** The document's edges as an ordering sees them: endpoints by client id. */
function rankEdges(
  state: EditorState,
  idOf: ReadonlyMap<string, string>,
  rawEdges: JsonValue[],
): Array<{ from: string; to: string }> {
  const known = new Set(state.nodes.map((node) => node.id));
  const resolved: Array<{ from: string; to: string }> = [];
  for (const entry of rawEdges) {
    if (!isRecord(entry) || !isString(entry["from_node"]) || !isString(entry["to_node"])) {
      continue;
    }
    if (isFailCondition(entry["condition"] ?? null)) {
      continue;
    }
    const from = idOf.get(entry["from_node"]);
    const to = idOf.get(entry["to_node"]);
    if (from !== undefined && to !== undefined && known.has(from) && known.has(to)) {
      resolved.push({ from, to });
    }
  }
  return resolved;
}

/**
 * Write the state back as a graph document. `position` comes from
 * `positionsOf` over the non-fail edges; nodes print in that order, and
 * the kept sections follow the six edited fields untouched.
 */
export function exportGraph(state: EditorState): Record<string, JsonValue> {
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const positions = positionsOf(
    state.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
    state.edges
      .filter((edge) => !isFailCondition(edge.condition) && byId.has(edge.from) && byId.has(edge.to))
      .map((edge) => ({ from: edge.from, to: edge.to })),
  );
  const nodes: JsonValue[] = [...state.nodes]
    .sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0))
    .map((node) => ({
      name: node.name,
      kind: node.kind,
      position: positions.get(node.id) ?? 1,
      config: node.config,
    }));
  const edges: JsonValue[] = [];
  for (const edge of state.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from !== undefined && to !== undefined) {
      edges.push({ from_node: from.name, to_node: to.name, condition: edge.condition });
    }
  }
  return {
    format_version: 6,
    name: state.name,
    description: state.description,
    nodes,
    edges,
    ...state.sections,
  };
}

/**
 * Validate a node document the editor is about to take in — schema first,
 * then the harness rule that refuses `platform`, `model` and `cli` with
 * its own reason.
 */
export function importNodeDocument(document: unknown): { source: Record<string, JsonValue> } | { error: string } {
  if (!isRecord(document)) {
    return { error: EDITOR_IMPORT_BAD };
  }
  const harness = harnessProblems("node", document);
  if (harness.length > 0) {
    return { error: refusalText(EDITOR_IMPORT_HARNESS, harness) };
  }
  const schema = documentProblems("node", document);
  if (schema.length > 0) {
    return { error: refusalText(EDITOR_IMPORT_BAD, schema) };
  }
  return { source: document };
}

/**
 * Copy a catalogue node onto the canvas at `at`: its `name` (made
 * unique), `kind`, `config` and `preset`. The preset lands in the kept
 * `presets` map under its own name — an entry that is already there is
 * never overwritten, the opened document wins — and an agent that names
 * no preset yet gets `prompt_preset` pointing at it, which is how a
 * graph document carries a preset at all.
 */
export function addCatalogNode(
  state: EditorState,
  source: Record<string, JsonValue>,
  at: { x: number; y: number },
): { node: CanvasNode } | { error: string } {
  const kind = source["kind"];
  if (!isNodeKind(kind)) {
    // The node schema's only other kind is `ensemble`, which never draws.
    return { error: EDITOR_ENSEMBLE_NODE };
  }
  const rawConfig = source["config"];
  const config: Record<string, JsonValue> = isRecord(rawConfig) ? { ...rawConfig } : {};
  const name = uniqueName(
    isString(source["name"]) && source["name"] !== "" ? source["name"] : "node",
    new Set(state.nodes.map((node) => node.name)),
  );
  const node: CanvasNode = { id: newNodeId(), name, kind, config, x: at.x, y: at.y };
  mergePreset(state, node, source["preset"]);
  state.nodes.push(node);
  return { node };
}

/**
 * The preset merge rule: a catalogue node's `preset {name, content}` is
 * copied into the graph's `presets` under the preset's name (a key that
 * is already there keeps the opened document's content), and an agent
 * whose config names no `prompt_preset` gets one pointing at it. Other
 * kinds keep their config verbatim — only agents read prompt presets.
 */
function mergePreset(state: EditorState, node: CanvasNode, preset: JsonValue | undefined): void {
  if (!isRecord(preset) || !isString(preset["name"]) || preset["name"] === "") {
    return;
  }
  if (!("content" in preset)) {
    return;
  }
  const name = preset["name"];
  const existing = isRecord(state.sections["presets"]) ? { ...state.sections["presets"] } : {};
  if (!Object.hasOwn(existing, name)) {
    existing[name] = { content: preset["content"] ?? null };
  }
  state.sections["presets"] = existing;
  if (node.kind === "agent" && !Object.hasOwn(node.config, "prompt_preset")) {
    node.config = { ...node.config, prompt_preset: name };
  }
}

/**
 * True when a kept ensemble wires this node name — by entry, by exit or
 * by an extra source. Such a node cannot be deleted: the editor keeps
 * ensembles untouched, so it may not strand one either.
 */
export function ensembleBound(state: EditorState, name: string): boolean {
  const ensembles = state.sections["ensembles"];
  if (!isArray(ensembles)) {
    return false;
  }
  const points = (target: JsonValue | undefined): boolean =>
    isString(target) ? target === name : false;
  for (const entry of ensembles) {
    if (!isRecord(entry)) {
      continue;
    }
    if (
      points(entry["entry_from_node"]) ||
      points(entry["on_pass_to"]) ||
      points(entry["on_fail_to"])
    ) {
      return true;
    }
    const extra = entry["extra_entry_sources"];
    if (isArray(extra) && extra.some((source) => isRecord(source) && points(source["from_node"]))) {
      return true;
    }
  }
  return false;
}

/** A blank node of `kind` at `at`, named uniquely. */
export function addBlankNode(state: EditorState, kind: NodeKind, at: { x: number; y: number }): CanvasNode {
  const node: CanvasNode = {
    id: newNodeId(),
    name: uniqueName(kind, new Set(state.nodes.map((existing) => existing.name))),
    kind,
    config: {},
    x: at.x,
    y: at.y,
  };
  state.nodes.push(node);
  return node;
}

/** Connect two nodes with a condition; the edge is appended in creation order. */
export function connect(state: EditorState, from: string, to: string, condition: JsonValue): CanvasEdge {
  const edge: CanvasEdge = { id: newNodeId(), from, to, condition };
  state.edges.push(edge);
  return edge;
}

/** Remove a node and every edge that touched it. */
export function removeNode(state: EditorState, id: string): void {
  state.nodes = state.nodes.filter((node) => node.id !== id);
  state.edges = state.edges.filter((edge) => edge.from !== id && edge.to !== id);
}

/** Remove one edge. */
export function removeEdge(state: EditorState, id: string): void {
  state.edges = state.edges.filter((edge) => edge.id !== id);
}
