// SPDX-License-Identifier: Apache-2.0
// The shelf controller: one object the shell, the frame router and both
// entry points share. It owns the item lists, the transfer queue and the
// blob URL cache (shelf-store.ts) plus the sheet (shelf.ts), and it
// stays completely silent until hello.features carries "shelf" — no
// request out, no surface up. Session-row counts are prefetched from the
// session store, once per connection.

import { newReqId } from "./protocol.js";
import type { FilePart, ReplyError, ShelfItem, ShelfList } from "./protocol.js";
import {
  BlobLru,
  LRU_MAX_BYTES,
  ShelfFetcher,
  ShelfStore,
  shelfListRequest,
} from "./shelf-store.js";
import type { ShelfKey } from "./shelf-store.js";
import { ShelfSheet } from "./shelf.js";
import type { SessionStore } from "./sessions.js";
import { UploadQueue } from "./upload.js";
import type { ShelfPutAck, ShelfPutReady, UploadAttachment, UploadTaskView } from "./upload.js";

/** What the shell needs to render counts and open the sheet. */
export interface ShelfHandle {
  subscribe: (listener: () => void) => () => void;
  enabled: () => boolean;
  count: (key: ShelfKey) => number;
  unseen: (sessionId: string) => number;
  /** True while the Files sheet is up (the Files button's folder opens). */
  isOpen: () => boolean;
  open: (parent: HTMLElement, key: ShelfKey) => void;
  close: () => void;
  /** hello.features carried shelf_upload: the attach UI may exist. */
  uploadEnabled: () => boolean;
  uploads: () => UploadTaskView[];
  startUploads: (files: File[], target: string | null) => void;
  cancelUpload: (id: string) => void;
  takeAttachment: (id: string) => UploadAttachment | null;
}

/** What the frame router pushes into the shelf. */
export interface ShelfFrames {
  handleHello: (features: string[]) => void;
  handleList: (list: ShelfList) => void;
  handleAdded: (item: ShelfItem) => void;
  handleRemoved: (fileId: string) => void;
  handlePart: (part: FilePart) => boolean;
  handleError: (error: ReplyError) => boolean;
  handlePutReady: (frame: ShelfPutReady) => void;
  handlePutAck: (frame: ShelfPutAck) => void;
}

export interface ShelfDeps {
  /** False when the frame could not be sent (no connection yet). */
  send: (data: string) => boolean;
  /** The session list the row counts are prefetched for. */
  sessions?: SessionStore;
  /** Blob byte cap; tests use a small one to reach eviction fast. */
  lruBytes?: number;
}

export class ShelfController implements ShelfHandle, ShelfFrames {
  private readonly store = new ShelfStore();
  private readonly lru: BlobLru;
  private readonly fetcher: ShelfFetcher;
  private readonly queue: UploadQueue;
  private readonly send: (data: string) => boolean;
  private readonly sessions: SessionStore | null;
  private readonly requested = new Set<string>();
  /** Files this device uploaded on this connection: the Yours section. */
  private readonly uploaded = new Set<string>();
  private uploadsEnabled = false;
  private readonly stopSessions: (() => void) | null;
  private stopStore: (() => void) | null = null;
  private sheet: ShelfSheet | null = null;
  /** The shell's listeners: store changes plus the sheet opening/closing. */
  private readonly uiListeners = new Set<() => void>();

  constructor(deps: ShelfDeps) {
    this.send = deps.send;
    this.sessions = deps.sessions ?? null;
    this.lru = new BlobLru(deps.lruBytes ?? LRU_MAX_BYTES);
    this.queue = new UploadQueue({
      send: deps.send,
      notify: () => this.notifyUi(),
    });
    this.fetcher = new ShelfFetcher({
      send: deps.send,
      lru: this.lru,
      onBlob: (fileId, url) => this.sheet?.applyBlob(fileId, url),
    });
    this.stopStore = this.store.subscribe(() => {
      if (!this.store.enabled) {
        this.close();
        return;
      }
      const sheet = this.sheet;
      if (sheet?.isOpen) {
        sheet.refresh(this.store.items(sheet.key));
      }
    });
    this.stopSessions = deps.sessions?.subscribe(() => this.sync()) ?? null;
  }

  subscribe(listener: () => void): () => void {
    const stopStore = this.store.subscribe(listener);
    this.uiListeners.add(listener);
    return () => {
      stopStore();
      this.uiListeners.delete(listener);
    };
  }

  private notifyUi(): void {
    for (const listener of this.uiListeners) {
      listener();
    }
  }

  enabled(): boolean {
    return this.store.enabled;
  }

  isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  count(key: ShelfKey): number {
    return this.store.enabled ? this.store.count(key) : 0;
  }

  unseen(sessionId: string): number {
    return this.store.enabled ? this.store.unseen(sessionId) : 0;
  }

  uploadEnabled(): boolean {
    return this.uploadsEnabled && this.store.enabled;
  }

  uploads(): UploadTaskView[] {
    return this.uploadEnabled() ? this.queue.views() : [];
  }

  startUploads(files: File[], target: string | null): void {
    if (this.uploadEnabled()) {
      this.queue.add(files, target);
    }
  }

  cancelUpload(id: string): void {
    this.queue.cancel(id);
  }

  takeAttachment(id: string): UploadAttachment | null {
    return this.queue.takeAttachment(id);
  }

  open(parent: HTMLElement, key: ShelfKey): void {
    if (!this.store.enabled) {
      return;
    }
    this.close();
    const sheet = new ShelfSheet({
      items: (shelfKey) => this.store.items(shelfKey),
      ensure: (item) => this.fetcher.ensure(item),
      requestList: (shelfKey) => this.requestList(shelfKey, false),
      markSeen: (shelfKey) => this.store.markSeen(shelfKey),
      blobUrl: (fileId) => this.lru.get(fileId),
      blob: (fileId) => this.lru.blob(fileId),
      isYours: (item) =>
        this.uploaded.has(item.file_id) || item.origin === "device" || item.origin === "upload",
      onClosed: () => {
        if (this.sheet === sheet) {
          this.sheet = null;
        }
        this.notifyUi();
      },
    });
    this.sheet = sheet;
    sheet.open(parent, key, key === null ? "Host shelf" : "Files");
    this.notifyUi();
  }

  close(): void {
    this.sheet?.close();
    this.sheet = null;
  }

  // --- frame handlers -------------------------------------------------

  handleHello(features: string[]): void {
    const on = features.includes("shelf");
    this.uploadsEnabled = features.includes("shelf_upload");
    // Everything below belonged to the previous connection.
    this.fetcher.reset();
    this.queue.reset();
    this.uploaded.clear();
    this.requested.clear();
    this.store.reset();
    if (!on) {
      this.close();
      this.lru.clear();
    }
    this.store.setEnabled(on);
    if (on) {
      this.sync();
    }
  }

  handleList(list: ShelfList): void {
    if (!this.store.enabled) {
      return;
    }
    this.store.replace(list);
    // A reply proves the link is up: anything queued may go now.
    this.fetcher.pump();
  }

  handleAdded(item: ShelfItem): void {
    if (!this.store.enabled) {
      return;
    }
    const viewing = this.sheet?.isOpen === true && this.sheet.key === item.session_id;
    if (this.queue.confirmAdded(item) || item.origin === "device" || item.origin === "upload") {
      this.uploaded.add(item.file_id);
    }
    this.store.add(item, viewing);
  }

  handleRemoved(fileId: string): void {
    if (!this.store.enabled) {
      return;
    }
    this.store.remove(fileId);
    // Those bytes belonged to a file the host took back: a future file
    // wearing the same id must be fetched again, never served stale.
    this.lru.evict(fileId);
  }

  handlePart(part: FilePart): boolean {
    if (!this.store.enabled) {
      return false;
    }
    return this.fetcher.handlePart(part);
  }

  handleError(error: ReplyError): boolean {
    if (!this.store.enabled) {
      return false;
    }
    if (this.queue.handleError(error)) {
      return true;
    }
    return this.fetcher.handleError(error);
  }

  handlePutReady(frame: ShelfPutReady): void {
    this.queue.handleReady(frame);
  }

  handlePutAck(frame: ShelfPutAck): void {
    this.queue.handleAck(frame);
  }

  /** Leaving or switching hosts: nothing of this host's shelf stays. */
  reset(): void {
    this.handleHello([]);
  }

  dispose(): void {
    this.close();
    this.fetcher.reset();
    this.queue.reset();
    this.lru.clear();
    this.stopStore?.();
    this.stopStore = null;
    this.stopSessions?.();
    this.store.reset();
  }

  // --- outbound -------------------------------------------------------

  /** Ask for every shelf the row counts need, once per connection. */
  private sync(): void {
    if (!this.store.enabled) {
      return;
    }
    this.requestList(null, true);
    for (const session of this.sessions?.list() ?? []) {
      this.requestList(session.id, true);
    }
  }

  private requestList(key: ShelfKey, once: boolean): void {
    const marker = key === null ? "\u0000host" : key;
    if (once && this.requested.has(marker)) {
      return;
    }
    if (!this.send(shelfListRequest(newReqId(), key))) {
      return;
    }
    this.requested.add(marker);
  }
}
