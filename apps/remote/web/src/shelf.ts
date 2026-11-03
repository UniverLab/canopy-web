// SPDX-License-Identifier: Apache-2.0
// The session shelf's Files sheet: a thumbnail grid over the union shelf in
// the shared modal sheet, two columns on a phone and four from 900 px. A
// cell opens the full-screen viewer (shelf-viewer.ts); a picker open shows
// the same grid as one flat union list and a tap attaches the file instead.
// Names and captions go in as text nodes, so no caption can become markup.
// The data half lives in shelf-store.ts, the controller in
// shelf-controller.ts and the delete controls in shelf-delete.ts.

import type { ShelfItem } from "./protocol.js";
import { Sheet } from "./sheet.js";
import { extensionLabel, previewKind } from "./preview.js";
import { ShelfDeleteUi, createCellDelete, metaLine } from "./shelf-delete.js";
import { ShelfViewer } from "./shelf-viewer.js";

interface SheetOwner {
  items: () => ShelfItem[];
  ensure: (item: ShelfItem) => void;
  requestAll: () => void;
  markSeen: () => void;
  blobUrl: (fileId: string) => string | null;
  blob: (fileId: string) => Blob | null;
  /** True for a file this device uploaded on this connection. */
  isYours: (item: ShelfItem) => boolean;
  onDelete: ((item: ShelfItem) => void) | null;
  onClosed: () => void;
}

/** The Files sheet: a thumbnail grid over the union shelf, viewer behind it. */
export class ShelfSheet {
  private readonly owner: SheetOwner;
  private sheet: Sheet | null = null;
  private grid: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private ticker: ReturnType<typeof globalThis.setInterval> | null = null;
  private viewer: ShelfViewer | null = null;
  private readonly deleteUi = new ShelfDeleteUi();
  private items: ShelfItem[] = [];
  private sheetFocus: Element | null = null;
  private cellFocus: Element | null = null;
  private readonly pending = new Set<string>();
  /** Set by a picker open: a cell taps to attach instead of viewing. */
  private pick: ((item: ShelfItem) => void) | null = null;

  constructor(owner: SheetOwner) {
    this.owner = owner;
  }

  get isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  open(parent: HTMLElement, pick: ((item: ShelfItem) => void) | null = null): void {
    this.closeSheet();
    this.pick = pick;
    this.sheetFocus = document.activeElement;
    const sheet = new Sheet({ kind: "shelf", title: "Shelf" }, () => this.onSheetClose());
    const body = sheet.mount(parent);
    const empty = document.createElement("p");
    empty.className = "empty shelf-empty";
    empty.textContent = "No files on this shelf yet.";
    const grid = document.createElement("div");
    grid.className = "shelf-sections";
    body.append(empty, grid);
    this.deleteUi.mount(body, grid);
    this.sheet = sheet;
    this.empty = empty;
    this.grid = grid;
    this.items = this.owner.items();
    this.render();
    document.addEventListener("keydown", this.onKeydown);
    this.ticker = globalThis.setInterval(() => this.render(), 15000);
    this.owner.markSeen();
    this.owner.requestAll();
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
    const item = this.items.find((row) => row.file_id === fileId);
    for (const el of this.grid?.querySelectorAll<HTMLElement>(".shelf-item") ?? []) {
      if (el.dataset.fileId !== fileId) {
        continue;
      }
      if (item && previewKind(item.mime) === "image") {
        const img = el.querySelector("img");
        if (img) {
          img.src = url;
          img.hidden = false;
          el.querySelector(".shelf-cell")?.classList.add("loaded");
        }
      }
      const link = el.querySelector<HTMLAnchorElement>(".shelf-download");
      if (link) {
        link.href = url;
        link.download = item?.name ?? link.download;
      }
    }
    if (this.pending.delete(fileId)) {
      for (const link of this.grid?.querySelectorAll<HTMLAnchorElement>(".shelf-download") ?? []) {
        if (link.dataset.fileId === fileId) {
          link.click();
          break;
        }
      }
    }
    this.viewer?.applyBlob(fileId);
  }

  /** A delete started, answered or failed: pending state plus error line. */
  deleteState(fileId: string, pending: boolean, error: string | null): void {
    this.deleteUi.setPending(fileId, pending, this.grid, this.viewer);
    this.deleteUi.showError(error);
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
    this.pick = null;
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
    if (this.items.length > 0) {
      if (this.pick) {
        // A picker shows the union as one list, in union order.
        grid.append(this.section(null, this.items));
      } else {
        const yours = this.items.filter((item) => this.owner.isYours(item));
        const agent = this.items.filter((item) => !this.owner.isYours(item));
        grid.append(this.section("From agent", agent), this.section("Yours", yours));
      }
    }
    this.viewer?.setItems(this.items);
    this.observe();
  }

  /** One direction of the transfer, with its own heading. */
  private section(title: string | null, items: ShelfItem[]): HTMLElement {
    const section = document.createElement("section");
    section.className = title === null ? "shelf-section shelf-pick" : "shelf-section";
    const heading = document.createElement("h3");
    heading.className = "shelf-section-title";
    heading.textContent = title ?? "";
    const grid = document.createElement("div");
    grid.className = "shelf-grid";
    for (const item of items) {
      grid.append(this.cell(item));
    }
    section.append(...(title === null ? [] : [heading]), grid);
    return section;
  }

  private download(item: ShelfItem, ev: Event): void {
    if (this.owner.blobUrl(item.file_id) !== null) {
      return;
    }
    ev.preventDefault();
    this.pending.add(item.file_id);
    this.owner.ensure(item);
  }

  private cell(item: ShelfItem): HTMLElement {
    const holder = document.createElement("div");
    holder.className = "shelf-item";
    holder.dataset.fileId = item.file_id;

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
    if (url === null || previewKind(item.mime) !== "image") {
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
    meta.textContent = metaLine(item);

    cell.append(thumb, caption, meta);
    cell.addEventListener("click", () =>
      this.pick ? this.pickCell(item) : this.openViewer(item),
    );
    holder.append(cell);
    // A picker needs no download link and no delete: the tap attaches.
    if (this.pick) {
      return holder;
    }

    const download = document.createElement("a");
    download.className = "shelf-download";
    download.dataset.fileId = item.file_id;
    download.textContent = "Download";
    download.download = item.name;
    if (url !== null) {
      download.href = url;
    }
    download.addEventListener("click", (ev) => this.download(item, ev));
    holder.append(download);
    const onDelete = this.owner.onDelete;
    if (onDelete) {
      holder.append(createCellDelete(item, onDelete, this.deleteUi.isPending(item.file_id)));
    }
    return holder;
  }

  /** Thumbnails arrive when a cell comes near the viewport. */
  private observe(): void {
    const grid = this.grid;
    // A picker attaches by metadata: it never fetches a file to show it.
    if (!grid || this.pick) {
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
    for (const cell of grid.querySelectorAll(".shelf-item")) {
      observer.observe(cell);
    }
  }

  /** A picker tap: hand the file over, then leave the picker. */
  private pickCell(item: ShelfItem): void {
    const pick = this.pick;
    if (!pick) {
      return;
    }
    pick(item);
    this.close();
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
      blob: this.owner.blob,
      onDelete: this.owner.onDelete,
      isDeletePending: (fileId) => this.deleteUi.isPending(fileId),
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
