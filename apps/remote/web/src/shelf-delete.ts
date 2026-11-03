// SPDX-License-Identifier: Apache-2.0
// The shelf's delete half: the date helpers the grid and the viewer share
// (moved here intact — shelf.ts sits at the gate's size limit) plus the
// delete controls both surfaces render — a small × on every grid cell, a
// Delete button in the viewer bar, and the one inline error line. Names go
// in as text nodes, like everywhere else on the shelf.

import type { ShelfItem } from "./protocol.js";

/** The `from · age` line under a file's name, in the grid and the viewer. */
export function metaLine(item: ShelfItem): string {
  return [item.from, formatAge(Date.now(), item.created_at)]
    .filter((part) => part !== "")
    .join(" · ");
}

/** A short relative age for the meta line. */
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

/** How a delete names its file: the name, or the id when it has none. */
export function deleteLabel(item: ShelfItem): string {
  return item.name !== "" ? item.name : item.file_id;
}

/** A surface showing one file's delete state: the viewer implements it. */
export interface DeletePendingView {
  setDeletePending(fileId: string, pending: boolean): void;
}

/**
 * The small × in a grid cell's corner. Immediate, no confirm: the shelf
 * is a transient tray of copies, and the host evicts under retention and
 * cap anyway.
 */
export function createCellDelete(
  item: ShelfItem,
  onDelete: (item: ShelfItem) => void,
  pending: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "shelf-delete";
  button.dataset.fileId = item.file_id;
  button.setAttribute("aria-label", `Delete ${deleteLabel(item)}`);
  button.textContent = "×";
  button.disabled = pending;
  button.addEventListener("click", () => onDelete(item));
  return button;
}

/**
 * The viewer bar's Delete button, inserted ahead of the close control.
 * Null when the feature is off — then the bar keeps its old shape.
 */
export function createViewerDelete(
  bar: HTMLElement,
  close: HTMLElement,
  current: () => ShelfItem | undefined,
  onDelete: ((item: ShelfItem) => void) | null,
): HTMLButtonElement | null {
  if (!onDelete) {
    return null;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "viewer-delete";
  button.id = "shelf-delete";
  button.textContent = "Delete";
  button.addEventListener("click", () => {
    const item = current();
    if (item) {
      onDelete(item);
    }
  });
  bar.insertBefore(button, close);
  return button;
}

/**
 * The delete state behind one open sheet: which files have a delete in
 * flight, and the one inline error line a failed delete leaves. The sheet
 * owns one; the controller drives it through the sheet's deleteState.
 */
export class ShelfDeleteUi {
  private readonly pending = new Set<string>();
  private error: HTMLElement | null = null;

  /** The error line goes between the empty note and the sections. */
  mount(body: HTMLElement, grid: HTMLElement): void {
    const line = document.createElement("p");
    line.className = "shelf-delete-error";
    line.id = "shelf-delete-error";
    line.hidden = true;
    body.insertBefore(line, grid);
    this.error = line;
  }

  isPending(fileId: string): boolean {
    return this.pending.has(fileId);
  }

  setPending(
    fileId: string,
    pending: boolean,
    grid: HTMLElement | null,
    viewer: DeletePendingView | null,
  ): void {
    if (pending) {
      this.pending.add(fileId);
    } else {
      this.pending.delete(fileId);
    }
    if (grid) {
      for (const control of grid.querySelectorAll<HTMLButtonElement>(".shelf-delete")) {
        if (control.dataset.fileId === fileId) {
          control.disabled = pending;
        }
      }
    }
    viewer?.setDeletePending(fileId, pending);
  }

  /** Null clears the line; a name paints `Couldn't delete <name>`. */
  showError(name: string | null): void {
    const line = this.error;
    if (!line) {
      return;
    }
    line.hidden = name === null;
    line.textContent = name === null ? "" : `Couldn't delete ${name}`;
  }
}
