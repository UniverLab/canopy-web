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

/** What the shell needs to render counts and open the sheet. */
export interface ShelfHandle {
  subscribe: (listener: () => void) => () => void;
  enabled: () => boolean;
  count: (key: ShelfKey) => number;
  unseen: (sessionId: string) => number;
  open: (parent: HTMLElement, key: ShelfKey) => void;
  close: () => void;
}

/** What the frame router pushes into the shelf. */
export interface ShelfFrames {
  handleHello: (features: string[]) => void;
  handleList: (list: ShelfList) => void;
  handleAdded: (item: ShelfItem) => void;
  handleRemoved: (fileId: string) => void;
  handlePart: (part: FilePart) => boolean;
  handleError: (error: ReplyError) => boolean;
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
  private readonly send: (data: string) => boolean;
  private readonly sessions: SessionStore | null;
  private readonly requested = new Set<string>();
  private readonly stopSessions: (() => void) | null;
  private stopStore: (() => void) | null = null;
  private sheet: ShelfSheet | null = null;

  constructor(deps: ShelfDeps) {
    this.send = deps.send;
    this.sessions = deps.sessions ?? null;
    this.lru = new BlobLru(deps.lruBytes ?? LRU_MAX_BYTES);
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
    return this.store.subscribe(listener);
  }

  enabled(): boolean {
    return this.store.enabled;
  }

  count(key: ShelfKey): number {
    return this.store.enabled ? this.store.count(key) : 0;
  }

  unseen(sessionId: string): number {
    return this.store.enabled ? this.store.unseen(sessionId) : 0;
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
      onClosed: () => {
        if (this.sheet === sheet) {
          this.sheet = null;
        }
      },
    });
    this.sheet = sheet;
    sheet.open(parent, key, key === null ? "Host shelf" : "Files");
  }

  close(): void {
    this.sheet?.close();
    this.sheet = null;
  }

  // --- frame handlers -------------------------------------------------

  handleHello(features: string[]): void {
    const on = features.includes("shelf");
    // Everything below belonged to the previous connection.
    this.fetcher.reset();
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
    this.store.add(item, viewing);
  }

  handleRemoved(fileId: string): void {
    if (!this.store.enabled) {
      return;
    }
    this.store.remove(fileId);
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
    return this.fetcher.handleError(error);
  }

  /** Leaving or switching hosts: nothing of this host's shelf stays. */
  reset(): void {
    this.handleHello([]);
  }

  dispose(): void {
    this.close();
    this.fetcher.reset();
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
