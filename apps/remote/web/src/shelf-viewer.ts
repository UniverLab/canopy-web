// SPDX-License-Identifier: Apache-2.0
// The full-screen file viewer behind a Files sheet cell: wheel/pinch zoom,
// swipe or arrow keys to step through the shelf, a download link, a Delete
// button and Esc. What it shows follows the host's sniffed mime
// (preview.ts): images in <img src="blob:…">, text as text nodes,
// everything else (HTML included) as a download card — and every download
// carries a blob URL with download=, never a tab.

import type { ShelfItem } from "./protocol.js";
import { icon } from "./icons-dom.js";
import { formatBytes, previewKind } from "./preview.js";
import type { PreviewKind } from "./preview.js";
import { createViewerDelete, metaLine } from "./shelf-delete.js";

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const SWIPE_PX = 60;

interface ViewerDeps {
  ensure: (item: ShelfItem) => void;
  blobUrl: (fileId: string) => string | null;
  blob: (fileId: string) => Blob | null;
  onClose: () => void;
  onDelete: ((item: ShelfItem) => void) | null;
  isDeletePending: (fileId: string) => boolean;
}

/**
 * The full-screen viewer: one image, zoomed with the wheel or a pinch,
 * stepped with a swipe or the arrow keys, downloaded through an
 * <a download> that only ever carries a blob URL.
 */
export class ShelfViewer {
  private readonly deps: ViewerDeps;
  private overlay: HTMLElement | null = null;
  private stage: HTMLElement | null = null;
  private img: HTMLImageElement | null = null;
  private text: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private note: HTMLElement | null = null;
  private kind: PreviewKind = "image";
  private shownFileId = "";
  private caption: HTMLElement | null = null;
  private meta: HTMLElement | null = null;
  private counter: HTMLElement | null = null;
  private link: HTMLAnchorElement | null = null;
  private deleteBtn: HTMLButtonElement | null = null;
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
    const text = document.createElement("pre");
    text.className = "viewer-text";
    text.id = "shelf-viewer-text";
    text.hidden = true;
    const card = document.createElement("div");
    card.className = "viewer-card";
    card.id = "shelf-viewer-card";
    card.hidden = true;
    const note = document.createElement("p");
    note.className = "viewer-note";
    note.id = "shelf-viewer-note";
    stage.append(img, text, card, note);

    const bar = document.createElement("div");
    bar.className = "viewer-bar";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.id = "shelf-prev";
    prev.setAttribute("aria-label", "Previous file");
    prev.innerHTML = icon("chevronLeft");
    const captionBlock = document.createElement("div");
    captionBlock.className = "viewer-caption-block";
    const caption = document.createElement("span");
    caption.className = "viewer-caption";
    caption.id = "shelf-caption";
    const meta = document.createElement("span");
    meta.className = "viewer-meta";
    meta.id = "shelf-meta";
    captionBlock.append(caption, meta);
    const counter = document.createElement("span");
    counter.className = "viewer-count";
    counter.id = "shelf-count";
    const next = document.createElement("button");
    next.type = "button";
    next.id = "shelf-next";
    next.setAttribute("aria-label", "Next file");
    next.innerHTML = icon("chevronRight");
    const link = document.createElement("a");
    link.className = "viewer-download";
    link.id = "shelf-download";
    link.textContent = "Download";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "viewer-close";
    close.id = "shelf-viewer-close";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = icon("x");
    bar.append(prev, captionBlock, counter, next, link, close);
    this.deleteBtn = createViewerDelete(bar, close, () => this.items[this.index], this.deps.onDelete);

    overlay.append(stage, bar);
    parent.append(overlay);

    this.overlay = overlay;
    this.stage = stage;
    this.img = img;
    this.text = text;
    this.card = card;
    this.note = note;
    this.caption = caption;
    this.meta = meta;
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
    this.stage = null;
    this.img = null;
    this.text = null;
    this.card = null;
    this.note = null;
    this.shownFileId = "";
    this.caption = null;
    this.meta = null;
    this.counter = null;
    this.link = null;
    this.deleteBtn = null;
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

  setDeletePending(fileId: string, pending: boolean): void {
    if (this.deleteBtn && this.items[this.index]?.file_id === fileId) {
      this.deleteBtn.disabled = pending;
    }
  }

  private render(): void {
    const item = this.items[this.index];
    if (!item || !this.overlay || !this.stage || !this.img || !this.text || !this.card || !this.note) {
      return;
    }
    const kind = previewKind(item.mime);
    const url = this.deps.blobUrl(item.file_id);
    this.kind = kind;
    this.shownFileId = item.file_id;
    this.stage.dataset.kind = kind;
    this.img.alt = item.caption ?? item.name;
    if (url === null) {
      this.img.removeAttribute("src");
      this.img.hidden = true;
      this.text.hidden = true;
      this.card.hidden = true;
      this.note.hidden = false;
      this.note.textContent = "Loading…";
      this.deps.ensure(item);
    } else if (kind === "image") {
      this.img.src = url;
      this.img.hidden = false;
      this.text.hidden = true;
      this.card.hidden = true;
      this.note.hidden = true;
    } else if (kind === "text") {
      this.img.removeAttribute("src");
      this.img.hidden = true;
      this.text.hidden = false;
      this.card.hidden = true;
      this.note.hidden = true;
      this.fillText(item);
    } else {
      this.img.removeAttribute("src");
      this.img.hidden = true;
      this.text.hidden = true;
      this.note.hidden = true;
      this.fillCard(item, url);
    }
    if (this.caption) {
      this.caption.textContent = item.caption ?? item.name;
    }
    if (this.meta) {
      this.meta.textContent = metaLine(item);
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
    if (this.deleteBtn) {
      this.deleteBtn.disabled = this.deps.isDeletePending(item.file_id);
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

  /** Text and code: one text node, never HTML. */
  private fillText(item: ShelfItem): void {
    const text = this.text;
    if (!text) {
      return;
    }
    text.textContent = "";
    const blob = this.deps.blob(item.file_id);
    if (!blob) {
      return;
    }
    const fileId = item.file_id;
    void blob.text().then((value) => {
      if (this.text === text && this.shownFileId === fileId) {
        text.textContent = value;
      }
    });
  }

  /** Everything else: name, size, type and a blob download. */
  private fillCard(item: ShelfItem, url: string): void {
    const card = this.card;
    if (!card) {
      return;
    }
    const name = document.createElement("p");
    name.className = "viewer-card-name";
    name.textContent = item.name;
    const meta = document.createElement("p");
    meta.className = "viewer-card-meta";
    meta.textContent = `${formatBytes(item.size)} · ${item.mime === "" ? "unknown type" : item.mime}`;
    const link = document.createElement("a");
    link.className = "viewer-download";
    link.textContent = "Download";
    link.download = item.name;
    link.href = url;
    card.replaceChildren(name, meta, link);
    card.hidden = false;
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
    if (this.kind !== "image") {
      return;
    }
    this.zoom(1);
  };

  private onWheel = (ev: WheelEvent): void => {
    if (this.kind !== "image") {
      return;
    }
    ev.preventDefault();
    this.zoom(this.scale * Math.exp(-ev.deltaY * 0.002));
  };

  private onPointerDown = (ev: PointerEvent): void => {
    if (this.kind !== "image") {
      return;
    }
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
