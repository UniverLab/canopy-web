// SPDX-License-Identifier: Apache-2.0
// The upload half of the shelf: the client end of the shelf_put_* frames
// the host spec defines. A file is hashed, offered with shelf_put_begin,
// and once the host answers shelf_put_ready it travels in 12 KiB base64
// parts, at most eight unacked at a time (the host acks every eighth),
// closed by shelf_put_end; completion arrives as the ordinary
// shelf_added event. At most three uploads run at once. Pure module: no
// DOM, no network beyond the injected send.

import { b64encode, sha256Hex } from "./crypto.js";
import { newReqId } from "./protocol.js";

export const UPLOAD_CHUNK_BYTES = 12 * 1024;
export const UPLOAD_WINDOW = 8;
export const MAX_ACTIVE_UPLOADS = 3;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * The chip both attach sources type into the terminal: an uploaded file and
 * a file picked off the shelf produce this one string, byte for byte.
 */
export function attachmentText(path: string): string {
  return `Attachment: ${path}`;
}

export type UploadStatus = "queued" | "hashing" | "waiting" | "uploading" | "done" | "error";

/** One upload as the tray and the attach chips read it. */
export interface UploadTaskView {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  progress: number;
  error: string | null;
  fileId: string | null;
  path: string | null;
  taken: boolean;
}

export interface UploadAttachment {
  fileId: string;
  name: string;
  path: string;
}

export interface ShelfPutReady {
  req: string;
  file_id: string;
}

export interface ShelfPutAck {
  file_id: string;
  part: number;
}

export interface UploadDeps {
  /** False when the frame could not be sent. */
  send: (data: string) => boolean;
  /** A task changed; the tray repaints. */
  notify: () => void;
  /** Tests inject a cheap digest; production hashes with SHA-256. */
  hash?: (bytes: Uint8Array) => Promise<string>;
  maxActive?: number;
}

interface UploadTask {
  id: string;
  file: File;
  sessionId: string | null;
  name: string;
  size: number;
  mime: string;
  bytes: Uint8Array;
  sha256: string;
  parts: number;
  sent: number;
  acked: number;
  req: string;
  fileId: string | null;
  status: UploadStatus;
  error: string | null;
  path: string | null;
  taken: boolean;
  ended: boolean;
}

export function buildShelfPutBegin(
  req: string,
  sessionId: string | null,
  name: string,
  size: number,
  mime: string,
  sha256: string,
): string {
  const frame: Record<string, unknown> = { t: "shelf_put_begin", req, name, size, sha256 };
  if (sessionId !== null) {
    frame.id = sessionId;
  }
  if (mime !== "") {
    frame.mime = mime;
  }
  return JSON.stringify(frame);
}

export function buildShelfPutPart(fileId: string, part: number, data: string): string {
  return JSON.stringify({ t: "shelf_put_part", file_id: fileId, part, data });
}

export function buildShelfPutEnd(fileId: string): string {
  return JSON.stringify({ t: "shelf_put_end", file_id: fileId });
}

export function buildShelfPutAbort(fileId: string): string {
  return JSON.stringify({ t: "shelf_put_abort", file_id: fileId });
}

function isRecord(frame: unknown): frame is Record<string, unknown> {
  return typeof frame === "object" && frame !== null;
}

export function parseShelfPutReady(frame: unknown): ShelfPutReady | null {
  if (!isRecord(frame) || frame.t !== "shelf_put_ready") {
    return null;
  }
  if (typeof frame.req !== "string" || typeof frame.file_id !== "string" || frame.file_id === "") {
    return null;
  }
  return { req: frame.req, file_id: frame.file_id };
}

export function parseShelfPutAck(frame: unknown): ShelfPutAck | null {
  if (!isRecord(frame) || frame.t !== "shelf_put_ack") {
    return null;
  }
  if (typeof frame.file_id !== "string" || typeof frame.part !== "number") {
    return null;
  }
  return { file_id: frame.file_id, part: frame.part };
}

function partCount(size: number): number {
  return size === 0 ? 0 : Math.ceil(size / UPLOAD_CHUNK_BYTES);
}

function uploadId(): string {
  return newReqId();
}

export class UploadQueue {
  private readonly deps: UploadDeps;
  private readonly maxActive: number;
  private tasks: UploadTask[] = [];

  constructor(deps: UploadDeps) {
    this.deps = deps;
    this.maxActive = deps.maxActive ?? MAX_ACTIVE_UPLOADS;
  }

  add(files: File[], sessionId: string | null): void {
    for (const file of files) {
      this.tasks.push({
        id: uploadId(),
        file,
        sessionId,
        name: file.name,
        size: file.size,
        mime: file.type,
        bytes: new Uint8Array(0),
        sha256: "",
        parts: 0,
        sent: 0,
        acked: -1,
        req: "",
        fileId: null,
        status: "queued",
        error: null,
        path: null,
        taken: false,
        ended: false,
      });
    }
    this.deps.notify();
    this.pump();
  }

  views(): UploadTaskView[] {
    return this.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      size: task.size,
      status: task.status,
      progress: this.progressOf(task),
      error: task.error,
      fileId: task.fileId,
      path: task.path,
      taken: task.taken,
    }));
  }

  /** A begin reply: parts may flow. */
  handleReady(frame: ShelfPutReady): boolean {
    const task = this.tasks.find((row) => row.req === frame.req && row.status === "waiting");
    if (!task) {
      return false;
    }
    task.fileId = frame.file_id;
    task.status = "uploading";
    this.deps.notify();
    this.pumpTask(task);
    return true;
  }

  /** The host's every-eighth ack: the next window may go out. */
  handleAck(frame: ShelfPutAck): boolean {
    const task = this.tasks.find((row) => row.fileId === frame.file_id);
    if (!task || task.status !== "uploading") {
      return false;
    }
    if (frame.part > task.acked) {
      task.acked = frame.part;
    }
    this.pumpTask(task);
    return true;
  }

  /** True when the error answered this queue rather than another request. */
  handleError(error: { req: string | null; code: string; message: string; file_id?: string | null }): boolean {
    const byReq = error.req === null ? undefined : this.tasks.find((row) => row.req === error.req);
    const byFile =
      error.file_id === undefined || error.file_id === null
        ? undefined
        : this.tasks.find((row) => row.fileId === error.file_id);
    const task = byReq ?? byFile;
    if (!task || task.status === "done" || task.status === "error") {
      return false;
    }
    task.status = "error";
    task.error = error.code;
    this.deps.notify();
    this.pump();
    return true;
  }

  /** The matching shelf_added: the upload finished host-side. */
  confirmAdded(item: { file_id: string; path?: string; name?: string }): boolean {
    const task = this.tasks.find(
      (row) => row.fileId === item.file_id && (row.status === "uploading" || row.status === "waiting"),
    );
    if (!task) {
      return false;
    }
    task.status = "done";
    task.path = item.path ?? item.name ?? task.name;
    task.fileId = item.file_id;
    this.deps.notify();
    this.pump();
    return true;
  }

  /** Cancel sends shelf_put_abort once the host has named the file. */
  cancel(id: string): void {
    const task = this.tasks.find((row) => row.id === id);
    if (!task) {
      return;
    }
    if (task.fileId !== null && (task.status === "uploading" || task.status === "waiting")) {
      this.deps.send(buildShelfPutAbort(task.fileId));
    }
    this.tasks = this.tasks.filter((row) => row.id !== id);
    this.deps.notify();
    this.pump();
  }

  /** The chip was tapped: its text is about to be typed, then it goes. */
  takeAttachment(id: string): UploadAttachment | null {
    const task = this.tasks.find((row) => row.id === id && row.status === "done" && !row.taken);
    if (!task) {
      return null;
    }
    task.taken = true;
    this.deps.notify();
    return { fileId: task.fileId ?? "", name: task.name, path: task.path ?? task.name };
  }

  /** A new connection: every in-flight upload belonged to the old one. */
  reset(): void {
    this.tasks = [];
    this.deps.notify();
  }

  private progressOf(task: UploadTask): number {
    if (task.status === "done") {
      return 1;
    }
    if (task.status === "uploading" && task.parts === 0) {
      return 1;
    }
    if (task.parts > 0) {
      return Math.min(1, task.sent / task.parts);
    }
    return 0;
  }

  private activeCount(): number {
    return this.tasks.filter(
      (task) => task.status === "hashing" || task.status === "waiting" || task.status === "uploading",
    ).length;
  }

  private pump(): void {
    let slots = this.maxActive - this.activeCount();
    for (const task of this.tasks) {
      if (slots <= 0) {
        return;
      }
      if (task.status !== "queued") {
        continue;
      }
      slots -= 1;
      void this.start(task);
    }
  }

  private async start(task: UploadTask): Promise<void> {
    task.status = "hashing";
    this.deps.notify();
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await task.file.arrayBuffer());
    } catch {
      this.fail(task, "unreadable");
      return;
    }
    let digest: string;
    try {
      digest = await (this.deps.hash ?? sha256Hex)(bytes);
    } catch {
      this.fail(task, "unreadable");
      return;
    }
    if (!this.tasks.includes(task)) {
      return;
    }
    task.bytes = bytes;
    task.sha256 = digest;
    task.parts = partCount(bytes.length);
    task.req = newReqId();
    task.status = "waiting";
    this.deps.notify();
    const sent = this.deps.send(
      buildShelfPutBegin(task.req, task.sessionId, task.name, task.size, task.mime, digest),
    );
    if (!sent) {
      this.fail(task, "not_connected");
    }
  }

  private fail(task: UploadTask, code: string): void {
    task.status = "error";
    task.error = code;
    this.deps.notify();
    this.pump();
  }

  private pumpTask(task: UploadTask): void {
    const fileId = task.fileId;
    if (task.status !== "uploading" || fileId === null || task.ended) {
      return;
    }
    while (task.sent < task.parts && task.sent - (task.acked + 1) < UPLOAD_WINDOW) {
      const part = task.sent;
      const start = part * UPLOAD_CHUNK_BYTES;
      const chunk = task.bytes.subarray(start, Math.min(task.bytes.length, start + UPLOAD_CHUNK_BYTES));
      // Counted before the send: a host that acks synchronously re-enters
      // pumpTask, and the next window must start after this part, not on it.
      task.sent = part + 1;
      if (!this.deps.send(buildShelfPutPart(fileId, part, b64encode(chunk)))) {
        this.fail(task, "not_connected");
        return;
      }
    }
    if (task.sent >= task.parts && !task.ended) {
      task.ended = true;
      if (!this.deps.send(buildShelfPutEnd(fileId))) {
        this.fail(task, "not_connected");
        return;
      }
    }
    this.deps.notify();
  }
}
