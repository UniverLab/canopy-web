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
