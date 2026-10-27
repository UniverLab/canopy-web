// SPDX-License-Identifier: Apache-2.0
// The session shelf's surfaces: the Files sheet (a thumbnail grid in the
// shared modal sheet, two columns on a phone and four from 900 px) and
// the full-screen viewer behind a cell — wheel/pinch zoom, swipe or
// arrow keys to step through the shelf, a download link and Esc. Every
// file is only ever shown as <img src="blob:…">; names and captions go
// in as text nodes, so no caption can become markup. The data half
// (lists, LRU, transfer queue) lives in shelf-store.ts; the controller
// that binds both halves to the protocol lives in shelf-controller.ts.

import type { ShelfItem } from "./protocol.js";
import type { ShelfKey } from "./shelf-store.js";
import { Sheet } from "./sheet.js";

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const SWIPE_PX = 60;

/** A short relative age for the cell's meta line. */
export function formatAge(nowMs: number, thenMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** The extension the loading placeholder shows under the thumb. */
function extensionLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
  return ext === "" ? "file" : ext;
}

interface ViewerDeps {
  ensure: (item: ShelfItem) => void;
  blobUrl: (fileId: string) => string | null;
  onClose: () => void;
}

/**
 * The full-screen viewer: one image, zoomed with the wheel or a pinch,
 * stepped with a swipe or the arrow keys, downloaded through an
 * <a download> that only ever carries a blob URL.
 */
class ShelfViewer {
  private readonly deps: ViewerDeps;
  private overlay: HTMLElement | null = null;
  private img: HTMLImageElement | null = null;
  private note: HTMLElement | null = null;
  private caption: HTMLElement | null = null;
  private counter: HTMLElement | null = null;
  private link: HTMLAnchorElement | null = null;
  private prev: HTMLButtonElement | null = null;
  private next: HTMLButtonElement | null = null;
  private items: ShelfItem[] = [];
  private index = 0;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private pinchScale = 1;
  private dragStart: { x: number; y: number; tx: number; ty: number } | null = null;
  private lastFocus: Element | null = null;

  constructor(deps: ViewerDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.overlay !== null && this.overlay.isConnected;
  }

  open(items: ShelfItem[], index: number, parent: HTMLElement): void {
    this.items = items;
    this.index = index;
    this.lastFocus = document.activeElement;

    const overlay = document.createElement("div");
    overlay.className = "shelf-viewer";
    overlay.id = "shelf-viewer";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "File viewer");

    const stage = document.createElement("div");
    stage.className = "viewer-stage";
    const img = document.createElement("img");
    img.className = "viewer-img";
    img.id = "shelf-viewer-img";
    img.alt = "";
    const note = document.createElement("p");
    note.className = "viewer-note";
    note.id = "shelf-viewer-note";
    stage.append(img, note);

    const bar = document.createElement("div");
    bar.className = "viewer-bar";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.id = "shelf-prev";
    prev.setAttribute("aria-label", "Previous file");
    prev.textContent = "‹";
    const caption = document.createElement("span");
    caption.className = "viewer-caption";
    caption.id = "shelf-caption";
    const counter = document.createElement("span");
    counter.className = "viewer-count";
    counter.id = "shelf-count";
    const next = document.createElement("button");
    next.type = "button";
    next.id = "shelf-next";
    next.setAttribute("aria-label", "Next file");
    next.textContent = "›";
    const link = document.createElement("a");
    link.className = "viewer-download";
    link.id = "shelf-download";
    link.textContent = "Download";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "viewer-close";
    close.id = "shelf-viewer-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "✕";
    bar.append(prev, caption, counter, next, link, close);

    overlay.append(stage, bar);
    parent.append(overlay);

    this.overlay = overlay;
    this.img = img;
    this.note = note;
    this.caption = caption;
    this.counter = counter;
    this.link = link;
    this.prev = prev;
    this.next = next;

    stage.addEventListener("wheel", this.onWheel, { passive: false });
    stage.addEventListener("pointerdown", this.onPointerDown);
    stage.addEventListener("pointermove", this.onPointerMove);
    stage.addEventListener("pointerup", this.onPointerUp);
    stage.addEventListener("pointercancel", this.onPointerUp);
    stage.addEventListener("dblclick", this.onReset);
    prev.addEventListener("click", () => this.go(-1));
    next.addEventListener("click", () => this.go(1));
    close.addEventListener("click", () => this.close());

    this.render();
    close.focus();
  }

  close(): void {
    const overlay = this.overlay;
    this.overlay = null;
    this.img = null;
    this.note = null;
    this.caption = null;
    this.counter = null;
    this.link = null;
    this.prev = null;
    this.next = null;
    this.pointers.clear();
    overlay?.remove();
    const focus = this.lastFocus as HTMLElement | null;
    this.lastFocus = null;
    if (focus && focus.isConnected) {
      focus.focus();
    }
    this.deps.onClose();
  }

  go(delta: number): void {
    if (this.items.length === 0) {
      return;
    }
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.render();
  }

  /** The shelf changed under the viewer: keep the same file when it can. */
  setItems(items: ShelfItem[]): void {
    if (items.length === 0) {
      this.close();
      return;
    }
    const current = this.items[this.index]?.file_id ?? "";
    this.items = items;
    const found = items.findIndex((item) => item.file_id === current);
    this.index = found >= 0 ? found : Math.min(this.index, items.length - 1);
    this.render();
  }

  /** A blob arrived: show it if the viewer is on that file. */
  applyBlob(fileId: string): void {
    if (this.items[this.index]?.file_id === fileId) {
      this.render();
    }
  }

  private render(): void {
    const item = this.items[this.index];
    if (!item || !this.overlay || !this.img || !this.note) {
      return;
    }
    const url = this.deps.blobUrl(item.file_id);
    if (url === null) {
      this.img.removeAttribute("src");
      this.img.hidden = true;
      this.note.hidden = false;
      this.note.textContent = "Loading…";
      this.deps.ensure(item);
    } else {
      this.img.src = url;
      this.img.hidden = false;
      this.note.hidden = true;
    }
    this.img.alt = item.caption ?? item.name;
    if (this.caption) {
      this.caption.textContent = item.caption ?? item.name;
    }
    if (this.counter) {
      this.counter.textContent = `${this.index + 1} / ${this.items.length}`;
    }
    if (this.link) {
      this.link.hidden = url === null;
      if (url === null) {
        this.link.removeAttribute("href");
      } else {
        this.link.href = url;
        this.link.download = item.name;
      }
    }
    const many = this.items.length > 1;
    if (this.prev) {
      this.prev.hidden = !many;
    }
    if (this.next) {
      this.next.hidden = !many;
    }
    this.applyTransform();
  }

  private applyTransform(): void {
    if (this.img) {
      this.img.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    }
  }

  private zoom(next: number): void {
    this.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (this.scale === 1) {
      this.tx = 0;
      this.ty = 0;
    }
    this.applyTransform();
  }

  private onReset = (): void => {
    this.zoom(1);
  };

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    this.zoom(this.scale * Math.exp(-ev.deltaY * 0.002));
  };

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.pointerType === "mouse" && ev.button !== 0) {
      return;
    }
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size === 2) {
      this.startPinch();
    } else {
      this.dragStart = { x: ev.clientX, y: ev.clientY, tx: this.tx, ty: this.ty };
    }
    ev.preventDefault();
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.pointers.has(ev.pointerId)) {
      return;
    }
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      if (a && b && this.pinchDist > 0) {
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoom(this.pinchScale * (dist / this.pinchDist));
      }
      return;
    }
    const start = this.dragStart;
    if (!start) {
      return;
    }
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (this.scale > 1) {
      this.tx = start.tx + dx;
      this.ty = start.ty + dy;
      this.applyTransform();
    } else {
      // At 1x the drag is a swipe: the image follows the finger and
      // snaps back on release unless it crossed the threshold.
      this.tx = dx;
      this.ty = 0;
      this.applyTransform();
    }
  };

  private onPointerUp = (ev: PointerEvent): void => {
    if (!this.pointers.delete(ev.pointerId)) {
      return;
    }
    if (this.pointers.size === 1) {
      const rest = [...this.pointers.values()][0];
      if (rest) {
        this.dragStart = { x: rest.x, y: rest.y, tx: this.tx, ty: this.ty };
      }
      this.pinchDist = 0;
      return;
    }
    if (this.pointers.size > 1) {
      this.startPinch();
      return;
    }
    const dx = this.tx;
    this.dragStart = null;
    this.pinchDist = 0;
    if (this.scale === 1) {
      this.tx = 0;
      this.ty = 0;
      if (Math.abs(dx) >= SWIPE_PX) {
        this.go(dx < 0 ? 1 : -1);
        return;
      }
    }
    this.applyTransform();
  };

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) {
      return;
    }
    this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchScale = this.scale;
    this.dragStart = null;
  }
}

interface SheetOwner {
  items: (key: ShelfKey) => ShelfItem[];
  ensure: (item: ShelfItem) => void;
  requestList: (key: ShelfKey) => void;
  markSeen: (key: ShelfKey) => void;
  blobUrl: (fileId: string) => string | null;
  onClosed: () => void;
}

/** The Files sheet: a thumbnail grid over one shelf, viewer behind it. */
export class ShelfSheet {
  private readonly owner: SheetOwner;
  private sheet: Sheet | null = null;
  private grid: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private ticker: ReturnType<typeof globalThis.setInterval> | null = null;
  private viewer: ShelfViewer | null = null;
  private items: ShelfItem[] = [];
  private sheetFocus: Element | null = null;
  private cellFocus: Element | null = null;
  /** The shelf this sheet shows; null is the host shelf. */
  key: ShelfKey = null;

  constructor(owner: SheetOwner) {
    this.owner = owner;
  }

  get isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  open(parent: HTMLElement, key: ShelfKey, title: string): void {
    this.closeSheet();
    this.key = key;
    this.sheetFocus = document.activeElement;
    const sheet = new Sheet({ kind: "shelf", title }, () => this.onSheetClose());
    const body = sheet.mount(parent);
    const empty = document.createElement("p");
    empty.className = "empty shelf-empty";
    empty.textContent = "No files on this shelf yet.";
    const grid = document.createElement("div");
    grid.className = "shelf-grid";
    body.append(empty, grid);
    this.sheet = sheet;
    this.empty = empty;
    this.grid = grid;
    this.items = this.owner.items(key);
    this.render();
    document.addEventListener("keydown", this.onKeydown);
    this.ticker = globalThis.setInterval(() => this.render(), 15000);
    this.owner.markSeen(key);
    this.owner.requestList(key);
  }

  close(): void {
    if (this.viewer) {
      this.viewer.close();
      this.viewer = null;
    }
    this.closeSheet();
  }

  /** A store change: the grid follows the list, badge or not. */
  refresh(items: ShelfItem[]): void {
    this.items = items;
    if (this.isOpen) {
      this.render();
    }
  }

  applyBlob(fileId: string, url: string): void {
    const grid = this.grid;
    if (grid) {
      for (const cell of grid.children) {
        const el = cell as HTMLElement;
        if (el.dataset.fileId !== fileId) {
          continue;
        }
        const img = el.querySelector("img");
        if (img) {
          img.src = url;
          img.hidden = false;
          el.classList.add("loaded");
        }
      }
    }
    this.viewer?.applyBlob(fileId);
  }

  private closeSheet(): void {
    const wasOpen = this.sheet !== null;
    document.removeEventListener("keydown", this.onKeydown);
    if (this.ticker !== null) {
      globalThis.clearInterval(this.ticker);
      this.ticker = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.sheet?.close();
    this.sheet = null;
    this.grid = null;
    this.empty = null;
    const focus = this.sheetFocus as HTMLElement | null;
    this.sheetFocus = null;
    if (focus && focus.isConnected) {
      focus.focus();
    }
    if (wasOpen) {
      this.owner.onClosed();
    }
  }

  // The sheet's own Esc and × : while the viewer is up they only take
  // the viewer down, so one Escape never closes both surfaces.
  private onSheetClose = (): void => {
    if (this.viewer) {
      this.viewer.close();
      return;
    }
    this.closeSheet();
  };

  private onKeydown = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented) {
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      if (this.viewer) {
        this.viewer.close();
      } else {
        this.closeSheet();
      }
      return;
    }
    if (this.viewer) {
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        this.viewer.go(-1);
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        this.viewer.go(1);
      }
    }
  };

  private render(): void {
    const grid = this.grid;
    if (!grid) {
      return;
    }
    if (this.empty) {
      this.empty.hidden = this.items.length > 0;
    }
    grid.replaceChildren();
    this.observer?.disconnect();
    this.observer = null;
    for (const item of this.items) {
      grid.append(this.cell(item));
    }
    this.viewer?.setItems(this.items);
    this.observe();
  }

  private cell(item: ShelfItem): HTMLElement {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "shelf-cell";
    cell.dataset.fileId = item.file_id;
    cell.title = item.name;

    const thumb = document.createElement("span");
    thumb.className = "shelf-thumb";
    const img = document.createElement("img");
    img.alt = "";
    const url = this.owner.blobUrl(item.file_id);
    if (url === null) {
      img.hidden = true;
    } else {
      img.src = url;
      cell.classList.add("loaded");
    }
    const mark = document.createElement("span");
    mark.className = "shelf-mark";
    mark.textContent = extensionLabel(item.name);
    thumb.append(img, mark);

    const caption = document.createElement("span");
    caption.className = "shelf-caption";
    caption.textContent = item.caption ?? item.name;

    const meta = document.createElement("span");
    meta.className = "shelf-meta";
    meta.textContent = [item.from, formatAge(Date.now(), item.created_at)]
      .filter((part) => part !== "")
      .join(" · ");

    cell.append(thumb, caption, meta);
    cell.addEventListener("click", () => this.openViewer(item));
    return cell;
  }

  /** Thumbnails arrive when a cell comes near the viewport. */
  private observe(): void {
    const grid = this.grid;
    if (!grid) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      for (const item of this.items) {
        this.owner.ensure(item);
      }
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          const cell = entry.target as HTMLElement;
          observer.unobserve(cell);
          const item = this.items.find((row) => row.file_id === cell.dataset.fileId);
          if (item) {
            this.owner.ensure(item);
          }
        }
      },
      { rootMargin: "240px" },
    );
    this.observer = observer;
    for (const cell of grid.children) {
      observer.observe(cell);
    }
  }

  private openViewer(item: ShelfItem): void {
    const index = this.items.findIndex((row) => row.file_id === item.file_id);
    if (index < 0) {
      return;
    }
    if (this.viewer) {
      this.viewer.close();
    }
    this.cellFocus = document.activeElement;
    const viewer = new ShelfViewer({
      ensure: this.owner.ensure,
      blobUrl: this.owner.blobUrl,
      onClose: () => {
        if (this.viewer === viewer) {
          this.viewer = null;
        }
        const focus = this.cellFocus as HTMLElement | null;
        this.cellFocus = null;
        if (focus && focus.isConnected) {
          focus.focus();
        }
      },
    });
    this.viewer = viewer;
    viewer.open(this.items, index, document.body);
  }
}
