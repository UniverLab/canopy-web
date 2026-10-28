// SPDX-License-Identifier: Apache-2.0
// Session protocol v1 over the data channel: frame builders for the
// requests the session view sends, strict parsers for the frames it
// receives, and the display helpers the session list needs. Pure module:
// no DOM, no network. Payload bytes are base64 on the wire.

import { b64decode, b64encode } from "./crypto.js";

export interface SessionItem {
  id: string;
  name: string;
  cli: string;
  model: string;
  workdir: string;
  status: string;
  /** Last output time as epoch milliseconds, or null when unknown. */
  lastOutputAt: number | null;
}

export interface OutFrame {
  id: string;
  seq: number;
  data: Uint8Array;
}

export interface ReplyError {
  req: string | null;
  code: string;
  message: string;
}

// The host's catalog: everything the New dialog and the Prompt Builder
// offer. The host owns the values; the browser only renders them.
export interface CatalogCli {
  cli: string;
  label: string;
  models: string[];
  /** True when the harness accepts yolo spawns; missing means unsupported. */
  yolo?: boolean;
}

export interface CatalogProject {
  name: string;
  path: string;
}

export interface CatalogPreset {
  name: string;
  preview: string;
}

export interface CatalogSkill {
  name: string;
  label: string;
}

export interface Catalog {
  clis: CatalogCli[];
  projects: CatalogProject[];
  presets: CatalogPreset[];
  skills: CatalogSkill[];
}

// A prompt draft is what the Prompt Builder sends; the host turns it into
// text with the same function the TUI uses. The browser never composes.
export interface PromptDraftSection {
  title: string;
  content: string;
}

export interface PromptDraft {
  sections: PromptDraftSection[];
  preset?: string;
  skills: string[];
  project?: string;
}

// The New dialog's spawn: an agent runs a harness in a directory, a
// terminal runs the user's shell there. Kind defaults to agent; terminal
// spawns omit cli, prompt and yolo entirely.
export type SpawnKind = "agent" | "terminal";

export interface SpawnRequest {
  kind?: SpawnKind;
  cli?: string;
  workdir: string;
  name?: string;
  prompt?: string;
  yolo?: boolean;
}

function isRecord(frame: unknown): frame is Record<string, unknown> {
  return typeof frame === "object" && frame !== null;
}

function frameType(frame: unknown): string | null {
  if (!isRecord(frame) || typeof frame.t !== "string") {
    return null;
  }
  return frame.t;
}

// last_output_at and created_at arrive as unix seconds (number), unix
// milliseconds, an ISO string, or nothing at all; normalize to epoch ms.
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

export function parseSessionItem(item: unknown): SessionItem | null {
  if (!isRecord(item) || typeof item.id !== "string" || item.id === "") {
    return null;
  }
  return {
    id: item.id,
    name: asString(item.name),
    cli: asString(item.cli),
    model: asString(item.model),
    workdir: asString(item.workdir),
    status: asString(item.status),
    lastOutputAt: parseEpochMs(item.last_output_at),
  };
}

export function parseSessions(frame: unknown): SessionItem[] | null {
  if (frameType(frame) !== "sessions" || !isRecord(frame) || !Array.isArray(frame.items)) {
    return null;
  }
  const items: SessionItem[] = [];
  for (const item of frame.items) {
    const parsed = parseSessionItem(item);
    if (parsed) {
      items.push(parsed);
    }
  }
  return items;
}

export function parseSessionAdded(frame: unknown): SessionItem | null {
  if (frameType(frame) !== "session_added" || !isRecord(frame)) {
    return null;
  }
  return parseSessionItem(frame.item);
}

export function parseSessionRemoved(frame: unknown): string | null {
  if (frameType(frame) !== "session_removed" || !isRecord(frame)) {
    return null;
  }
  return typeof frame.id === "string" ? frame.id : null;
}

export function parseExited(frame: unknown): { id: string; code: number } | null {
  if (frameType(frame) !== "exited" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.id !== "string" || typeof frame.code !== "number") {
    return null;
  }
  return { id: frame.id, code: frame.code };
}

function b64Bytes(data: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
    return null;
  }
  try {
    return b64decode(data);
  } catch {
    return null;
  }
}

export function parseOut(frame: unknown): OutFrame | null {
  if (frameType(frame) !== "out" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.id !== "string" || typeof frame.seq !== "number" || typeof frame.data !== "string") {
    return null;
  }
  const data = b64Bytes(frame.data);
  if (!data) {
    return null;
  }
  return { id: frame.id, seq: frame.seq, data };
}

export function decodeSnapshotData(data: string): Uint8Array | null {
  return b64Bytes(data);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function parseOk(frame: unknown): string | null {
  if (frameType(frame) !== "ok" || !isRecord(frame)) {
    return null;
  }
  return typeof frame.req === "string" ? frame.req : null;
}

export function parseError(frame: unknown): ReplyError | null {
  if (frameType(frame) !== "error" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.code !== "string" || typeof frame.message !== "string") {
    return null;
  }
  return { req: typeof frame.req === "string" ? frame.req : null, code: frame.code, message: frame.message };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item !== "") {
      out.push(item);
    }
  }
  return out;
}

function parseCli(value: unknown): CatalogCli | null {
  if (!isRecord(value) || typeof value.cli !== "string" || value.cli === "") {
    return null;
  }
  const label = typeof value.label === "string" && value.label !== "" ? value.label : value.cli;
  // A host without the flag means unsupported: only an explicit true lands.
  const yolo = isRecord(value) && value.yolo === true ? { yolo: true as const } : {};
  return { cli: value.cli, label, models: stringList(value.models), ...yolo };
}

function parseProject(value: unknown): CatalogProject | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
    return null;
  }
  if (typeof value.path !== "string" || value.path === "") {
    return null;
  }
  return { name: value.name, path: value.path };
}

function parsePreset(value: unknown): CatalogPreset | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
    return null;
  }
  return { name: value.name, preview: asString(value.preview) };
}

function parseSkill(value: unknown): CatalogSkill | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
    return null;
  }
  const label = typeof value.label === "string" && value.label !== "" ? value.label : value.name;
  return { name: value.name, label };
}

function collect<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

// A catalog frame is best-effort: malformed entries are dropped instead of
// failing the whole reply, so one bad project never empties the pickers.
export function parseCatalog(frame: unknown): Catalog | null {
  if (frameType(frame) !== "catalog" || !isRecord(frame)) {
    return null;
  }
  return {
    clis: collect(frame.clis, parseCli),
    projects: collect(frame.projects, parseProject),
    presets: collect(frame.presets, parsePreset),
    skills: collect(frame.skills, parseSkill),
  };
}

export function parseSpawned(frame: unknown): { req: string; id: string } | null {
  if (frameType(frame) !== "spawned" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.req !== "string" || typeof frame.id !== "string" || frame.id === "") {
    return null;
  }
  return { req: frame.req, id: frame.id };
}

export function parseComposed(frame: unknown): { req: string; text: string } | null {
  if (frameType(frame) !== "composed" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.req !== "string" || typeof frame.text !== "string") {
    return null;
  }
  return { req: frame.req, text: frame.text };
}

// --- The session shelf (additive to v1) -------------------------------
// The host advertises the shelf in hello.features; without "shelf" in
// that list the browser sends no shelf frame and shows no shelf UI.

export interface ShelfItem {
  file_id: string;
  /** The owning session, or null for the host's own shelf. */
  session_id: string | null;
  name: string;
  mime: string;
  size: number;
  caption: string | null;
  from: string;
  created_at: number;
}

export interface ShelfList {
  req: string | null;
  /** The shelf the reply describes; null is the host shelf. */
  id: string | null;
  /** Newest first, as the host sends them. */
  items: ShelfItem[];
}

export interface FilePart {
  req: string;
  file_id: string;
  part: number;
  data: Uint8Array;
  last: boolean;
}

// A hello without features (or with a malformed list) advertises nothing,
// so it parses to an empty feature set and the shelf stays hidden.
export function parseHello(frame: unknown): string[] | null {
  if (frameType(frame) !== "hello" || !isRecord(frame)) {
    return null;
  }
  if (!Array.isArray(frame.features)) {
    return [];
  }
  return frame.features.filter((feature): feature is string => typeof feature === "string");
}

// One shelf entry is dropped when its file_id is missing or empty; the
// rest of the reply still renders, like a catalog frame.
function parseShelfItem(value: unknown): ShelfItem | null {
  if (!isRecord(value) || typeof value.file_id !== "string" || value.file_id === "") {
    return null;
  }
  const session = value.session_id;
  if (session !== null && session !== undefined && typeof session !== "string") {
    return null;
  }
  return {
    file_id: value.file_id,
    session_id: typeof session === "string" && session !== "" ? session : null,
    name: asString(value.name),
    mime: asString(value.mime),
    size: typeof value.size === "number" && Number.isFinite(value.size) ? value.size : 0,
    caption: typeof value.caption === "string" && value.caption !== "" ? value.caption : null,
    from: asString(value.from),
    created_at: parseEpochMs(value.created_at) ?? 0,
  };
}

export function parseShelf(frame: unknown): ShelfList | null {
  if (frameType(frame) !== "shelf" || !isRecord(frame) || !Array.isArray(frame.items)) {
    return null;
  }
  const items: ShelfItem[] = [];
  for (const value of frame.items) {
    const item = parseShelfItem(value);
    if (item) {
      items.push(item);
    }
  }
  // The host promises newest first; normalize so one clock skew or one
  // older host build never puts a stale file on top of the grid.
  items.sort((a, b) => b.created_at - a.created_at);
  return {
    req: typeof frame.req === "string" ? frame.req : null,
    id: typeof frame.id === "string" && frame.id !== "" ? frame.id : null,
    items,
  };
}

export function parseShelfAdded(frame: unknown): ShelfItem | null {
  if (frameType(frame) !== "shelf_added" || !isRecord(frame)) {
    return null;
  }
  return parseShelfItem(frame.item);
}

export function parseShelfRemoved(frame: unknown): string | null {
  if (frameType(frame) !== "shelf_removed" || !isRecord(frame)) {
    return null;
  }
  return typeof frame.file_id === "string" && frame.file_id !== "" ? frame.file_id : null;
}

export function parseFilePart(frame: unknown): FilePart | null {
  if (frameType(frame) !== "file" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.req !== "string" || typeof frame.file_id !== "string" || frame.file_id === "") {
    return null;
  }
  if (typeof frame.part !== "number" || typeof frame.data !== "string" || typeof frame.last !== "boolean") {
    return null;
  }
  const data = b64Bytes(frame.data);
  if (!data) {
    return null;
  }
  return { req: frame.req, file_id: frame.file_id, part: frame.part, data, last: frame.last };
}

export function buildList(req: string): string {
  return JSON.stringify({ t: "list", req });
}

export function buildCatalog(req: string): string {
  return JSON.stringify({ t: "catalog", req });
}

export function buildSpawn(req: string, spawn: SpawnRequest): string {
  // A terminal is the user's shell in a directory: no harness, no prompt,
  // no yolo, even when the caller left them on the request.
  if (spawn.kind === "terminal") {
    const frame: Record<string, unknown> = { t: "spawn", req, kind: "terminal" };
    frame.workdir = spawn.workdir;
    if (spawn.name !== undefined && spawn.name !== "") {
      frame.name = spawn.name;
    }
    return JSON.stringify(frame);
  }
  const frame: Record<string, unknown> = { t: "spawn", req, kind: "agent" };
  if (spawn.cli !== undefined && spawn.cli !== "") {
    frame.cli = spawn.cli;
  }
  frame.workdir = spawn.workdir;
  if (spawn.name !== undefined && spawn.name !== "") {
    frame.name = spawn.name;
  }
  if (spawn.prompt !== undefined && spawn.prompt !== "") {
    frame.prompt = spawn.prompt;
  }
  if (spawn.yolo === true) {
    frame.yolo = true;
  }
  return JSON.stringify(frame);
}

export function buildCompose(req: string, draft: PromptDraft): string {
  return JSON.stringify({ t: "compose", req, draft });
}

export function buildPromptDraft(req: string, id: string, draft: PromptDraft): string {
  return JSON.stringify({ t: "prompt", req, id, draft });
}

export function buildAttach(id: string): string {
  return JSON.stringify({ t: "attach", id });
}

export function buildDetach(id: string): string {
  return JSON.stringify({ t: "detach", id });
}

export function buildInput(id: string, bytes: Uint8Array): string {
  return JSON.stringify({ t: "input", id, data: b64encode(bytes) });
}

export function buildInputText(id: string, text: string): string {
  return buildInput(id, new TextEncoder().encode(text));
}

export function buildPrompt(req: string, id: string, text: string): string {
  return JSON.stringify({ t: "prompt", req, id, text });
}

// The shelf requests: a list carries the session id, absent for the
// host's own shelf; a get always names one file.
export function buildShelfList(req: string, id?: string): string {
  return id === undefined
    ? JSON.stringify({ t: "shelf_list", req })
    : JSON.stringify({ t: "shelf_list", req, id });
}

export function buildShelfGet(req: string, fileId: string): string {
  return JSON.stringify({ t: "shelf_get", req, file_id: fileId });
}

// --- Graph watching (additive to v1) --------------------------------
// The host lets a remote client watch one graph's drawing, active node
// and spec checklist live: ask with `graphs`, then `graph_watch {id}` —
// the host answers one `graph` (summary plus the graph document the
// plate draws) and pushes `graph_state` until `graph_unwatch {id}`.

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

/** The `graph` watch reply: the summary plus the document to draw. */
export interface GraphWatchReply {
  summary: GraphSummary;
  /** The graph document (catalogue format) behind the plate, or null. */
  doc: unknown;
}

// The host's GraphSpecStatus fallback is Pending for anything a newer
// binary wrote; unknown words read as pending here for the same reason —
// never as completed, which would tick a spec that never ran.
const SPEC_STATUS: Record<string, SpecStatus> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  interrupted: "pending",
  skipped: "pending",
};

function asSpecStatus(value: unknown): SpecStatus {
  return typeof value === "string" ? (SPEC_STATUS[value] ?? "pending") : "pending";
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

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
export function parseGraphs(frame: unknown): GraphSummary[] | null {
  if (frameType(frame) !== "graphs" || !isRecord(frame) || !Array.isArray(frame.items)) {
    return null;
  }
  const items: GraphSummary[] = [];
  for (const item of frame.items) {
    const parsed = parseGraphSummary(item);
    if (parsed) {
      items.push(parsed);
    }
  }
  return items;
}

export function parseGraph(frame: unknown): GraphWatchReply | null {
  if (frameType(frame) !== "graph" || !isRecord(frame)) {
    return null;
  }
  const payload = isRecord(frame.item) ? frame.item : frame;
  const summary = parseGraphSummary(payload);
  if (summary === null) {
    return null;
  }
  const raw = frame.doc ?? frame.document;
  return { summary, doc: isRecord(raw) ? raw : null };
}

export function parseGraphState(frame: unknown): GraphState | null {
  if (frameType(frame) !== "graph_state" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.status !== "string" || frame.status === "") {
    return null;
  }
  if (!isRecord(frame.nodes) || !Array.isArray(frame.specs)) {
    return null;
  }
  const nodes: Record<string, NodeStatus> = {};
  for (const [name, status] of Object.entries(frame.nodes)) {
    if (name === "" || (status !== "running" && status !== "pass" && status !== "fail")) {
      continue;
    }
    nodes[name] = status;
  }
  const specs: GraphSpecRow[] = [];
  for (const row of frame.specs) {
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
  const blocker = frame.blocker;
  return {
    status: frame.status,
    blocked: frame.blocked === true,
    blocker: typeof blocker === "string" && blocker !== "" ? blocker : null,
    current_spec_id:
      typeof frame.current_spec_id === "string" && frame.current_spec_id !== ""
        ? frame.current_spec_id
        : null,
    current_node:
      typeof frame.current_node === "string" && frame.current_node !== ""
        ? frame.current_node
        : null,
    nodes,
    specs,
    updated_at: parseEpochMs(frame.updated_at) ?? 0,
  };
}

export function buildGraphs(req: string): string {
  return JSON.stringify({ t: "graphs", req });
}

export function buildGraphWatch(id: string): string {
  return JSON.stringify({ t: "graph_watch", id });
}

export function buildGraphUnwatch(id: string): string {
  return JSON.stringify({ t: "graph_unwatch", id });
}

let reqCounter = 0;

export function newReqId(): string {
  reqCounter += 1;
  return `r${Date.now().toString(36)}-${reqCounter.toString(36)}`;
}

export function workdirBasename(workdir: string): string {
  const trimmed = workdir.replace(/\/+$/, "");
  if (trimmed === "") {
    return "";
  }
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

export function formatLastOutput(nowMs: number, lastMs: number | null): string {
  if (lastMs === null) {
    return "no output yet";
  }
  const elapsed = Math.max(0, Math.floor((nowMs - lastMs) / 1000));
  if (elapsed < 60) {
    return `last output ${elapsed}s ago`;
  }
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) {
    return `last output ${minutes}min ago`;
  }
  return `last output ${Math.floor(minutes / 60)}h ago`;
}

// The status dot: green while the session runs, amber while it idles,
// grey once it exited. Unknown statuses get the default dot.
const STATUS_DOT: Record<string, string> = {
  running: "run",
  busy: "run",
  idle: "idle",
  waiting: "idle",
  exited: "dead",
  dead: "dead",
};

export function statusDot(status: string): string {
  return STATUS_DOT[status] ?? "unknown";
}
