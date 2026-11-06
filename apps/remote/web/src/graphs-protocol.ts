// SPDX-License-Identifier: Apache-2.0
// Graph watching over the data channel: the `graphs` list, the `graph`
// watch reply (the summary rebuilt from the reply plus the graph document
// the plate draws) and the `graph_state` pushes, with the builders for
// the three frames out. Pure module: no DOM, no network. Split out of
// protocol.ts, which re-exports this module so the router, the stores
// and the views keep importing from there.
//
// The host contract below is quoted verbatim from harness-canopy's
// src/sessions/graphs.rs; the web side follows it, never the reverse.

// --- Graph watching (additive to v1) --------------------------------
// The host lets a remote client watch one graph's drawing, active node
// and spec checklist live: ask with `graphs`, then `graph_watch {id}` —
// the host answers one `graph` (the graph document the plate draws plus
// the first live state) and pushes `graph_state` until `graph_unwatch {id}`.

/** One graph as the list and the watch reply present it. */
export interface GraphSummary {
  id: string;
  name: string;
  /** draft | running | pausing | paused | completed | failed (host words). */
  status: string;
  workdir: string;
  /** The current spec's name, "" when the queue is empty. */
  current_spec: string;
  current_node: string;
  done: number;
  total: number;
  blocked: boolean;
  updated_at: number;
}

/** One queue row of the spec checklist. */
export interface GraphSpecRow {
  id: string;
  /** The spec's code, null when the host sent none. */
  code: string | null;
  name: string;
  status: SpecStatus;
  attempts: number;
}

/** The checklist's four row states, in the host's own words. */
export type SpecStatus = "pending" | "running" | "completed" | "failed";

/** The plate overlay's three node states, in the host's own words. */
export type NodeStatus = "running" | "pass" | "fail";

/** A watched graph's live state: the overlay, the blocker and the queue. */
export interface GraphState {
  status: string;
  blocked: boolean;
  blocker: string | null;
  current_spec_id: string | null;
  current_node: string | null;
  nodes: Record<string, NodeStatus>;
  specs: GraphSpecRow[];
  updated_at: number;
}

/** The `graph` watch reply: summary, document and first live state. */
export interface GraphWatchReply {
  summary: GraphSummary;
  /** The graph document (catalogue format) behind the plate, or null. */
  doc: unknown;
  /** The reply's initial state, applied exactly like a state push. */
  state: GraphState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function frameType(frame: unknown): string | null {
  if (!isRecord(frame) || typeof frame.t !== "string") {
    return null;
  }
  return frame.t;
}

// updated_at arrives as unix seconds (number), unix milliseconds, an
// RFC3339 string, or nothing at all; normalize to epoch ms.
function parseEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value !== "") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The host's GraphSpecStatus fallback is Pending for anything a newer
// binary wrote; unknown words read as pending here for the same reason —
// never as completed, which would tick a spec that never ran. Own keys
// only: a word like "constructor" must read pending, never fall through
// to a prototype member and break the checklist paint.
const SPEC_STATUS: Record<string, SpecStatus> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "pending",
  skipped: "pending",
};

function asSpecStatus(value: unknown): SpecStatus {
  return typeof value === "string" && Object.hasOwn(SPEC_STATUS, value)
    ? SPEC_STATUS[value]
    : "pending";
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

// One list row (graphs.rs:48-67): id, name, status, workdir, optional
// current_spec/current_node, done/total, blocked, RFC3339 updated_at.
export function parseGraphSummary(value: unknown): GraphSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return null;
  }
  if (typeof value.status !== "string" || value.status === "") {
    return null;
  }
  return {
    id: value.id,
    name: asString(value.name),
    status: value.status,
    workdir: asString(value.workdir),
    current_spec: asString(value.current_spec),
    current_node: asString(value.current_node),
    done: asCount(value.done),
    total: asCount(value.total),
    blocked: value.blocked === true,
    updated_at: parseEpochMs(value.updated_at) ?? 0,
  };
}

// One bad row never empties the list, exactly like the sessions frame.
// Host contract (graphs.rs:101-103): {"t": "graphs", "req": req, "graphs": graphs}.
export function parseGraphs(frame: unknown): GraphSummary[] | null {
  if (frameType(frame) !== "graphs" || !isRecord(frame) || !Array.isArray(frame.graphs)) {
    return null;
  }
  const items: GraphSummary[] = [];
  for (const item of frame.graphs) {
    const parsed = parseGraphSummary(item);
    if (parsed) {
      items.push(parsed);
    }
  }
  return items;
}

// The watch reply (graphs.rs:106-116): {"t": "graph", "req", "id",
// "document", "state"} — there is NO summary object. The summary is
// rebuilt here: the id from the frame, the name from the document, the
// rest from the reply's initial state.
export function parseGraph(frame: unknown): GraphWatchReply | null {
  if (frameType(frame) !== "graph" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.id !== "string" || frame.id === "") {
    return null;
  }
  const state = parseStatePayload(frame.state);
  if (state === null) {
    return null;
  }
  const raw = frame.document ?? frame.doc;
  const doc = isRecord(raw) ? raw : null;
  const current = state.specs.find((row) => row.id === state.current_spec_id);
  return {
    summary: {
      id: frame.id,
      name: doc !== null && typeof doc.name === "string" ? doc.name : "",
      status: state.status,
      // The reply carries no workdir, and the open view never shows one.
      workdir: "",
      current_spec: current === undefined ? "" : current.name,
      current_node: state.current_node ?? "",
      done: state.specs.filter((row) => row.status === "completed").length,
      total: state.specs.length,
      blocked: state.blocked,
      updated_at: state.updated_at,
    },
    doc,
    state,
  };
}

// Host contract (graphs.rs:119-121): {"t": "graph_state", "id": id,
// "state": state}. The frame id selects nothing (one watch per view
// today) and stays ignored.
export function parseGraphState(frame: unknown): GraphState | null {
  if (frameType(frame) !== "graph_state" || !isRecord(frame)) {
    return null;
  }
  return parseStatePayload(frame.state);
}

// The live-state payload (graphs.rs:71-86): status, blocked, optional
// blocker/current_spec_id/current_node, the nodes map, the specs rows,
// updated_at. Shared by the pushes and the watch reply's initial state.
function parseStatePayload(value: unknown): GraphState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.status !== "string" || value.status === "") {
    return null;
  }
  if (!isRecord(value.nodes) || !Array.isArray(value.specs)) {
    return null;
  }
  const nodes: Record<string, NodeStatus> = {};
  for (const [name, status] of Object.entries(value.nodes)) {
    if (name === "" || (status !== "running" && status !== "pass" && status !== "fail")) {
      continue;
    }
    nodes[name] = status;
  }
  const specs: GraphSpecRow[] = [];
  for (const row of value.specs) {
    if (!isRecord(row) || typeof row.id !== "string" || row.id === "") {
      continue;
    }
    specs.push({
      id: row.id,
      code: typeof row.code === "string" && row.code !== "" ? row.code : null,
      name: asString(row.name),
      status: asSpecStatus(row.status),
      attempts: asCount(row.attempts),
    });
  }
  const blocker = value.blocker;
  return {
    status: value.status,
    blocked: value.blocked === true,
    blocker: typeof blocker === "string" && blocker !== "" ? blocker : null,
    current_spec_id:
      typeof value.current_spec_id === "string" && value.current_spec_id !== ""
        ? value.current_spec_id
        : null,
    current_node:
      typeof value.current_node === "string" && value.current_node !== ""
        ? value.current_node
        : null,
    nodes,
    specs,
    updated_at: parseEpochMs(value.updated_at) ?? 0,
  };
}

// Client frame (graphs.rs): `graph_control{req, id, action}` with action
// `"pause"` or `"continue"`. The host answers `ok{req}` or
// `error{req, code, message}`, and the new status arrives through the
// existing `graph_state` push. `hello.features` carries `"graph_control"`
// only for the owner's devices on a new enough host.
/** Pause or continue a watched graph: the owner's remote control. */
export type GraphControlAction = "pause" | "continue";

export function buildGraphControl(req: string, id: string, action: GraphControlAction): string {
  return JSON.stringify({ t: "graph_control", req, id, action });
}

export function buildGraphs(req: string): string {
  return JSON.stringify({ t: "graphs", req });
}

export function buildGraphWatch(req: string, id: string): string {
  return JSON.stringify({ t: "graph_watch", req, id });
}

export function buildGraphUnwatch(id: string): string {
  return JSON.stringify({ t: "graph_unwatch", id });
}
