// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's own model: the state the canvas, palette and panel all
 * read and mutate, plus the two pure codecs around it.
 *
 * Nodes carry canvas coordinates (world pixels at zoom 1) that live only
 * here — a graph document has no place for them, so they arrive only
 * through the localStorage snapshot and are dropped again on export.
 * Edges reference nodes by their stable client ids, not their names, so
 * renaming a node rewires nothing; the export resolves ids to the names
 * of the moment. `sections` holds everything an opened document carries
 * beyond the six fields the editor edits (`ensembles`, `hooks`,
 * `infra_node`, `presets`, …) — kept verbatim, written back verbatim.
 *
 * The serializer is total: any text that is not one of these snapshots
 * deserializes to `null`, and every storage access is wrapped in
 * try/catch, so a full disk or a private mode degrades to "no restore".
 */
import { SLUG_RE } from "../lib.js";
import { isArray, isNumber, isRecord, isString, type JsonValue } from "../json.js";
import { isNodeKind, type NodeKind } from "./kinds.js";

/** One node on the canvas: identity, document fields, canvas point. */
export interface CanvasNode {
  /** Stable client id; survives renames, never leaves this browser. */
  id: string;
  name: string;
  kind: NodeKind;
  config: Record<string, JsonValue>;
  /** Canvas x in world pixels (plate units × 12 at zoom 1). */
  x: number;
  y: number;
}

/** One edge: endpoints by node id, and the raw condition the schema takes. */
export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  condition: JsonValue;
}

/** The whole work in progress. */
export interface EditorState {
  name: string;
  description: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Verbatim sections of the opened document: ensembles, hooks, infra_node, presets. */
  sections: Record<string, JsonValue>;
}

/** One localStorage snapshot: format, the URL it was taken at, the state. */
export interface SavedEditor {
  v: 1;
  source: string;
  state: EditorState;
}

/** The one key the work in progress lives under. */
export const STORAGE_KEY = "canopy.editor.v1";

/** The graph name a brand-new canvas starts with (it satisfies the slug rule). */
export const BLANK_NAME = "untitled";

let idCounter = 0;

/** A fresh client id for a node or an edge: uuid where there is one, a counter otherwise. */
export function newNodeId(): string {
  const web = globalThis.crypto;
  if (web !== undefined && typeof web.randomUUID === "function") {
    return web.randomUUID();
  }
  idCounter += 1;
  return `n${idCounter}-${Date.now().toString(36)}`;
}

/**
 * A unique name under the slug rule: the base when it is free, else the
 * base suffixed `-2`, `-3`, … — trimmed to keep the result within the
 * 48 characters the slug allows.
 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
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

/** True when the text satisfies the slug rule the panel enforces. */
export function isSlugName(text: string): boolean {
  return SLUG_RE.test(text);
}

/** Every node name currently taken. */
export function takenNames(state: EditorState): Set<string> {
  return new Set(state.nodes.map((node) => node.name));
}

/** A brand-new, empty canvas. */
export function blankState(): EditorState {
  return { name: BLANK_NAME, description: "", nodes: [], edges: [], sections: {} };
}

/** The snapshot as JSON text. The only place the shape is spelled. */
export function serialize(state: EditorState, source: string): string {
  const snapshot: SavedEditor = { v: 1, source, state };
  return JSON.stringify(snapshot);
}

/** Read a snapshot back; any text that is not one answers `null`, never throws. */
export function deserialize(text: string): SavedEditor | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || value["v"] !== 1 || !isString(value["source"])) {
    return null;
  }
  const state = value["state"];
  if (!isRecord(state) || !isArray(state["nodes"]) || !isArray(state["edges"])) {
    return null;
  }
  const nodes: CanvasNode[] = [];
  for (const entry of state["nodes"]) {
    if (!isRecord(entry) || !isString(entry["id"]) || !isString(entry["name"]) ||
      !isNodeKind(entry["kind"]) || !isRecord(entry["config"]) ||
      !isNumber(entry["x"]) || !isNumber(entry["y"])) {
      return null;
    }
    nodes.push({
      id: entry["id"],
      name: entry["name"],
      kind: entry["kind"],
      config: entry["config"],
      x: entry["x"],
      y: entry["y"],
    });
  }
  const edges: CanvasEdge[] = [];
  for (const entry of state["edges"]) {
    if (!isRecord(entry) || !isString(entry["id"]) || !isString(entry["from"]) ||
      !isString(entry["to"]) || !("condition" in entry)) {
      return null;
    }
    edges.push({ id: entry["id"], from: entry["from"], to: entry["to"], condition: entry["condition"] });
  }
  const rawSections = state["sections"];
  const sections: Record<string, JsonValue> = {};
  if (rawSections !== undefined) {
    if (!isRecord(rawSections)) {
      return null;
    }
    for (const [key, section] of Object.entries(rawSections)) {
      sections[key] = section;
    }
  }
  return {
    v: 1,
    source: value["source"],
    state: {
      name: isString(state["name"]) ? state["name"] : BLANK_NAME,
      description: isString(state["description"]) ? state["description"] : "",
      nodes,
      edges,
      sections,
    },
  };
}

/** The smallest storage surface the editor needs (a stand-in in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The browser's storage when there is one; `null` keeps every access a no-op. */
export function browserStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage;
    return storage === undefined || storage === null ? null : storage;
  } catch {
    return null;
  }
}

/** The last snapshot under the key, or `null` — a throwing storage is `null`. */
export function loadSaved(storage: StorageLike | null): SavedEditor | null {
  if (storage === null) {
    return null;
  }
  try {
    const text = storage.getItem(STORAGE_KEY);
    return text === null ? null : deserialize(text);
  } catch {
    return null;
  }
}

/** Store the snapshot; a full or absent storage is silently tolerated. */
export function saveSaved(storage: StorageLike | null, state: EditorState, source: string): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, serialize(state, source));
  } catch {
    // Quota or private mode: the session simply stops autosaving.
  }
}

/** Clear the snapshot (New, after its confirm). A throwing storage is ignored. */
export function clearSaved(storage: StorageLike | null): void {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: the value expires with the browser profile anyway.
  }
}
