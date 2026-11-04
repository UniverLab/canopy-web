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
  /** The host's session kind: "agent" or "terminal". */
  kind: string;
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
  /** Some errors (an upload's checksum, say) name the file, not a req. */
  file_id?: string;
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
    kind: asString(item.kind),
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

export interface ResizedFrame {
  id: string;
  cols: number;
  rows: number;
}

// The host's size_field bounds: integers 1..=65535.
function isPtySize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

// `resized{id,cols,rows}`: a session's PTY size changed on the host —
// another device asserted its size, or the local TUI resized it. Older
// hosts never send it; anything malformed is dropped like an unknown frame.
export function parseResized(frame: unknown): ResizedFrame | null {
  if (frameType(frame) !== "resized" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.id !== "string" || frame.id === "" || !isPtySize(frame.cols) || !isPtySize(frame.rows)) {
    return null;
  }
  return { id: frame.id, cols: frame.cols, rows: frame.rows };
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
  const error: ReplyError = {
    req: typeof frame.req === "string" ? frame.req : null,
    code: frame.code,
    message: frame.message,
  };
  if (typeof frame.file_id === "string" && frame.file_id !== "") {
    error.file_id = frame.file_id;
  }
  return error;
}

// A denied guest attach: the hub answers the grant check with the session
// id the guest may not join. The message is optional — the id alone fails
// closed — so this parses what parseError would reject.
export function parseForbidden(frame: unknown): { id: string | null } | null {
  if (frameType(frame) !== "error" || !isRecord(frame)) {
    return null;
  }
  if (frame.code !== "forbidden") {
    return null;
  }
  return { id: typeof frame.id === "string" && frame.id !== "" ? frame.id : null };
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

// A prompt scheduled for later delivery to one session: the host fires it
// at fire_at (RFC 3339 UTC) and the preview is user text, up to 120 chars.
export interface ScheduledItem {
  id: string;
  fireAt: string;
  preview: string;
}

function parseScheduledItem(value: unknown): ScheduledItem | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || value.id === "") {
    return null;
  }
  if (typeof value.fire_at !== "string" || value.fire_at === "") {
    return null;
  }
  if (typeof value.preview !== "string") {
    return null;
  }
  return { id: value.id, fireAt: value.fire_at, preview: value.preview };
}

export function parseScheduled(frame: unknown): { req: string; item: ScheduledItem } | null {
  if (frameType(frame) !== "scheduled" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.req !== "string") {
    return null;
  }
  const item = parseScheduledItem(frame.item);
  if (!item) {
    return null;
  }
  return { req: frame.req, item };
}

// The session's pending schedules, fire_at ascending. Malformed entries
// are dropped like a catalog frame's, so one bad row never empties the list.
export function parseScheduledList(
  frame: unknown,
): { req: string; id: string; items: ScheduledItem[] } | null {
  if (frameType(frame) !== "scheduled_list" || !isRecord(frame)) {
    return null;
  }
  if (typeof frame.req !== "string" || typeof frame.id !== "string" || frame.id === "") {
    return null;
  }
  if (!Array.isArray(frame.items)) {
    return null;
  }
  const items: ScheduledItem[] = [];
  for (const value of frame.items) {
    const item = parseScheduledItem(value);
    if (item) {
      items.push(item);
    }
  }
  return { req: frame.req, id: frame.id, items };
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
  /** Where the host put the file, when it shares one (the Attach chip). */
  path?: string;
  /** Who produced it; a device upload says so when the ledger is cold. */
  origin?: string;
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

// The host's greeting: the features it speaks, plus the harness ids
// installed on it. A hello without harnesses (or with a malformed list)
// says nothing about presence — null, unknown — so the New dialog keeps
// offering every catalog harness against an old host; an explicit []
// means the host knows it has none.
export interface Hello {
  features: string[];
  harnesses: string[] | null;
}

// A hello without features (or with a malformed list) advertises nothing,
// so it parses to an empty feature set and the shelf stays hidden.
export function parseHello(frame: unknown): Hello | null {
  if (frameType(frame) !== "hello" || !isRecord(frame)) {
    return null;
  }
  const features = Array.isArray(frame.features)
    ? frame.features.filter((feature): feature is string => typeof feature === "string")
    : [];
  const harnesses = Array.isArray(frame.harnesses)
    ? frame.harnesses.filter((harness): harness is string => typeof harness === "string" && harness !== "")
    : null;
  return { features, harnesses };
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
    ...(typeof value.path === "string" && value.path !== "" ? { path: value.path } : {}),
    ...(typeof value.origin === "string" && value.origin !== "" ? { origin: value.origin } : {}),
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

export function buildPromptSchedule(req: string, id: string, draft: PromptDraft, fireAt: string): string {
  return JSON.stringify({ t: "prompt_schedule", req, id, draft, fire_at: fireAt });
}

export function buildScheduledList(req: string, id: string): string {
  return JSON.stringify({ t: "scheduled_list", req, id });
}

export function buildScheduledCancel(req: string, id: string, scheduleId: string): string {
  return JSON.stringify({ t: "scheduled_cancel", req, id, schedule_id: scheduleId });
}

export function buildAttach(id: string): string {
  return JSON.stringify({ t: "attach", id });
}

// `resize{id,cols,rows}`: the device asserts one session's PTY size. Shape
// verified against the host protocol (harness-canopy
// src/sessions/protocol.rs `resize_frame`, parsed on /sessions/ws): note
// the remote bridge answers it `forbidden` today (harness-canopy
// src/remote/bridge.rs "resize is not available to remote devices"), so
// the control-size toggle defaults off and the browser sends nothing
// until the user opts in per session.
export function buildResize(id: string, cols: number, rows: number): string {
  // The host's size_field takes integers 1..=65535 and rejects anything
  // else — including the null JSON.stringify writes for NaN/Infinity — so
  // anything non-finite clamps to one instead of emitting a bad frame.
  const safeCols = Number.isFinite(cols) ? Math.max(1, Math.floor(cols)) : 1;
  const safeRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 1;
  return JSON.stringify({ t: "resize", id, cols: safeCols, rows: safeRows });
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

export function buildShelfDelete(req: string, fileId: string): string {
  return JSON.stringify({ t: "shelf_delete", req, file_id: fileId });
}

// --- Graph watching (additive to v1) --------------------------------
// The host lets a remote client watch one graph's drawing, active node
// and spec checklist live: ask with `graphs`, then `graph_watch {id}` —
// the host answers one `graph` and pushes `graph_state` until
// `graph_unwatch {id}`. The frames live in graphs-protocol.ts (this file
// is at the gate's size limit); the re-export keeps every importer —
// the router, the stores, the views — on this module.
export {
  buildGraphs,
  buildGraphUnwatch,
  buildGraphWatch,
  parseGraph,
  parseGraphState,
  parseGraphSummary,
  parseGraphs,
} from "./graphs-protocol.js";
export type {
  GraphSpecRow,
  GraphState,
  GraphSummary,
  GraphWatchReply,
  NodeStatus,
  SpecStatus,
} from "./graphs-protocol.js";

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
