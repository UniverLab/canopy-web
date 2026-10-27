// SPDX-License-Identifier: Apache-2.0
// The session shelf's data half: the per-shelf item lists behind the
// Files sheet (with the per-session unseen badge), the blob URL cache
// that keeps the shelf inside 50 MB of memory, and the transfer queue
// behind shelf_get — at most two files in flight, parts reassembled in
// part order, a busy reply retried after 500 ms. No DOM here: the
// sheet, the viewer and the controller live in shelf.ts and
// shelf-controller.ts.

import { buildShelfGet, buildShelfList, newReqId } from "./protocol.js";
import type { FilePart, ReplyError, ShelfItem, ShelfList } from "./protocol.js";

/** A shelf to address: a session id, or null for the host's own shelf. */
export type ShelfKey = string | null;

/** Most blob bytes the shelf keeps alive before the oldest is revoked. */
export const LRU_MAX_BYTES = 50 * 1024 * 1024;
/** Most shelf_get transfers the browser runs at once. */
export const MAX_TRANSFERS = 2;
/** How long a busy reply waits before the file is requested again. */
export const BUSY_RETRY_MS = 500;

/** The item lists and the unseen badge, one notify per change. */
export class ShelfStore {
  private enabledFlag = false;
  private hostItems: ShelfItem[] = [];
  private readonly sessionItems = new Map<string, ShelfItem[]>();
  private readonly unseenFiles = new Map<string, Set<string>>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(on: boolean): void {
    if (this.enabledFlag === on) {
      return;
    }
    this.enabledFlag = on;
    this.notify();
  }

  /** A fresh hello: the lists and the badges were the old connection's. */
  reset(): void {
    this.hostItems = [];
    this.sessionItems.clear();
    this.unseenFiles.clear();
    this.notify();
  }

  /** A shelf reply replaces that shelf wholesale, newest first. */
  replace(list: ShelfList): void {
    if (list.id === null) {
      this.hostItems = list.items;
    } else {
      this.sessionItems.set(list.id, list.items);
    }
    this.notify();
  }

  /**
   * A pushed file lands on top of its shelf. `seen` is true while that
   * shelf's sheet is on screen: a file the person is already looking at
   * is not unseen, so the badge only counts arrivals nobody has seen.
   */
  add(item: ShelfItem, seen = false): void {
    if (item.session_id === null) {
      this.hostItems = [item, ...this.hostItems.filter((row) => row.file_id !== item.file_id)];
    } else {
      const key = item.session_id;
      const list = this.sessionItems.get(key) ?? [];
      this.sessionItems.set(key, [item, ...list.filter((row) => row.file_id !== item.file_id)]);
      if (!seen) {
        const files = this.unseenFiles.get(key) ?? new Set<string>();
        files.add(item.file_id);
        this.unseenFiles.set(key, files);
      }
    }
    this.notify();
  }

  /** Drops a file everywhere it appears, badge included. */
  remove(fileId: string): void {
    let changed = false;
    const keep = (rows: ShelfItem[]): ShelfItem[] => {
      const next = rows.filter((row) => row.file_id !== fileId);
      if (next.length !== rows.length) {
        changed = true;
      }
      return next;
    };
    this.hostItems = keep(this.hostItems);
    for (const [key, rows] of this.sessionItems) {
      this.sessionItems.set(key, keep(rows));
      const files = this.unseenFiles.get(key);
      if (files?.delete(fileId)) {
        changed = true;
        if (files.size === 0) {
          this.unseenFiles.delete(key);
        }
      }
    }
    if (changed) {
      this.notify();
    }
  }

  /** The sheet looked at this shelf: nothing on it is unseen any more. */
  markSeen(key: ShelfKey): void {
    if (key === null) {
      return;
    }
    if (this.unseenFiles.delete(key)) {
      this.notify();
    }
  }

  items(key: ShelfKey): ShelfItem[] {
    if (key === null) {
      return this.hostItems;
    }
    return this.sessionItems.get(key) ?? [];
  }

  count(key: ShelfKey): number {
    return this.items(key).length;
  }

  unseen(sessionId: string): number {
    return this.unseenFiles.get(sessionId)?.size ?? 0;
  }
}

interface BlobEntry {
  url: string;
  bytes: number;
}

/**
 * Blob URLs the shelf keeps alive, newest last. Crossing the cap revokes
 * the least recently used URL; a single file larger than the cap still
 * stays (evicting it would leave nothing to show).
 */
export class BlobLru {
  private readonly maxBytes: number;
  private readonly entries = new Map<string, BlobEntry>();
  private totalBytes = 0;

  constructor(maxBytes: number = LRU_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  get(fileId: string): string | null {
    const entry = this.entries.get(fileId);
    if (!entry) {
      return null;
    }
    // Re-queue it as the most recently used.
    this.entries.delete(fileId);
    this.entries.set(fileId, entry);
    return entry.url;
  }

  put(fileId: string, data: Uint8Array, mime: string): string {
    this.drop(fileId);
    // The copy keeps the blob on a plain ArrayBuffer (never a view into
    // somebody else's buffer) and gives the URL exactly these bytes.
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime }));
    this.entries.set(fileId, { url, bytes: data.byteLength });
    this.totalBytes += data.byteLength;
    while (this.totalBytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.drop(oldest);
    }
    return url;
  }

  clear(): void {
    for (const fileId of [...this.entries.keys()]) {
      this.drop(fileId);
    }
  }

  /**
   * One file's url goes now: a shelf_removed upstream makes those bytes
   * stale, so a later file wearing the same id must be fetched again
   * instead of being served from the cache.
   */
  evict(fileId: string): void {
    this.drop(fileId);
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private drop(fileId: string): void {
    const entry = this.entries.get(fileId);
    if (!entry) {
      return;
    }
    this.entries.delete(fileId);
    this.totalBytes -= entry.bytes;
    URL.revokeObjectURL(entry.url);
  }
}

interface FetchDeps {
  /** False when the frame could not be sent; the file is then retried. */
  send: (data: string) => boolean;
  lru: BlobLru;
  /** A finished file: its object URL and the bytes that made it. */
  onBlob: (fileId: string, url: string, bytes: Uint8Array) => void;
}

interface Transfer {
  item: ShelfItem;
  parts: { part: number; data: Uint8Array }[];
}

/**
 * Shelf_get as the sheet drives it: one request per file, at most
 * MAX_TRANSFERS of them at a time, the rest queued. Parts are joined in
 * part order (the channel is ordered, but the index decides anyway, so
 * one host that numbers from 1 or re-sends a part still assembles).
 */
export class ShelfFetcher {
  private readonly deps: FetchDeps;
  private readonly queue: ShelfItem[] = [];
  private readonly wanted = new Set<string>();
  private readonly inFlight = new Map<string, Transfer>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(deps: FetchDeps) {
    this.deps = deps;
  }

  ensure(item: ShelfItem): void {
    if (this.deps.lru.get(item.file_id) !== null || this.wanted.has(item.file_id)) {
      return;
    }
    this.wanted.add(item.file_id);
    this.queue.push(item);
    this.pump();
  }

  pump(): void {
    while (this.inFlight.size < MAX_TRANSFERS && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        return;
      }
      const req = newReqId();
      // Registered before sending: a host that answers inside the send
      // (the fake one does) would otherwise race its own registration.
      this.inFlight.set(req, { item, parts: [] });
      if (!this.deps.send(buildShelfGet(req, item.file_id))) {
        this.inFlight.delete(req);
        this.wanted.delete(item.file_id);
      }
    }
  }

  /** True when the frame belonged to a transfer here. */
  handlePart(part: FilePart): boolean {
    const transfer = this.inFlight.get(part.req);
    if (!transfer || transfer.item.file_id !== part.file_id) {
      return false;
    }
    transfer.parts.push({ part: part.part, data: part.data });
    if (!part.last) {
      return true;
    }
    this.inFlight.delete(part.req);
    this.wanted.delete(transfer.item.file_id);
    const bytes = joinParts(transfer.parts);
    const url = this.deps.lru.put(transfer.item.file_id, bytes, transfer.item.mime);
    this.deps.onBlob(transfer.item.file_id, url, bytes);
    this.pump();
    return true;
  }

  /** True when the error answered one of this fetcher's requests. */
  handleError(error: ReplyError): boolean {
    if (error.req === null) {
      return false;
    }
    const transfer = this.inFlight.get(error.req);
    if (!transfer) {
      return false;
    }
    this.inFlight.delete(error.req);
    if (error.code === "busy") {
      const timer = globalThis.setTimeout(() => {
        this.timers.delete(timer);
        this.queue.unshift(transfer.item);
        this.pump();
      }, BUSY_RETRY_MS);
      this.timers.add(timer);
    } else {
      // not_found and forbidden: asking again changes nothing.
      this.wanted.delete(transfer.item.file_id);
    }
    this.pump();
    return true;
  }

  /** A new connection (hello) invalidates every request in flight. */
  reset(): void {
    this.queue.length = 0;
    this.inFlight.clear();
    this.wanted.clear();
    for (const timer of this.timers) {
      globalThis.clearTimeout(timer);
    }
    this.timers.clear();
  }
}

/** Parts in part order, duplicates (a re-sent part) counted once. */
function joinParts(parts: Transfer["parts"]): Uint8Array {
  const ordered = [...parts].sort((a, b) => a.part - b.part);
  const chunks: Uint8Array[] = [];
  let lastIndex = Number.NaN;
  let total = 0;
  for (const entry of ordered) {
    if (entry.part === lastIndex) {
      continue;
    }
    lastIndex = entry.part;
    chunks.push(entry.data);
    total += entry.data.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The one request the shelf sends for a whole list. */
export function shelfListRequest(req: string, key: ShelfKey): string {
  return key === null ? buildShelfList(req) : buildShelfList(req, key);
}
