// SPDX-License-Identifier: Apache-2.0
// The New dialog's folder picker: one module owns the breadcrumb, filter,
// hidden switch, folder list, recent suggestions and the dir_list request
// lifecycle. new-dialog.ts only opens it and receives the picked path.

import type { DirEntry, DirList } from "./dir-protocol.js";
import { icon } from "./icons-dom.js";
import { newReqId, workdirBasename } from "./protocol.js";
import { esc } from "./sheet.js";

export interface DirPickerDeps {
  /** The folder to open first; null or "" asks the host for home. */
  startPath: () => string | null;
  /** Suggestions for the Recent section, already capped by the caller. */
  recent: () => string[];
  /** Sends dir_list{req,path?}; false means the frame could not go out. */
  onList: (path: string | undefined, req: string) => boolean;
  onPick: (path: string) => void;
  onCancel: () => void;
}

export interface PathSegment {
  label: string;
  path: string;
}

export function pathSegments(path: string): PathSegment[] {
  if (!path.startsWith("/")) {
    return path === "" ? [] : [{ label: path, path }];
  }
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") {
    return [{ label: "/", path: "/" }];
  }
  const segments: PathSegment[] = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of trimmed.split("/").filter((piece) => piece !== "")) {
    current += `/${part}`;
    segments.push({ label: part, path: current });
  }
  return segments;
}

export function joinChildPath(parent: string, name: string): string {
  if (parent === "/") {
    return `/${name}`;
  }
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

export function visibleDirs(dirs: DirEntry[], showHidden: boolean): DirEntry[] {
  return dirs.filter(
    (dir) =>
      dir.name !== "." &&
      dir.name !== ".." &&
      (showHidden || !dir.name.startsWith(".")),
  );
}

export class DirPicker {
  private readonly deps: DirPickerDeps;
  private root: HTMLElement | null = null;
  private wired: HTMLElement | null = null;
  private current: string | null = null;
  private parent: string | null = null;
  private dirs: DirEntry[] = [];
  private truncated = false;
  private query = "";
  private showHidden = false;
  private error: string | null = null;
  private touched = false;
  private started = false;
  private startFallback = false;
  private stickyError = false;
  private pending: string | null = null;
  private loading = false;

  constructor(deps: DirPickerDeps) {
    this.deps = deps;
  }

  mount(root: HTMLElement): void {
    this.root = root;
    this.attach(root);
    if (!this.started) {
      this.started = true;
      const path = this.deps.startPath();
      this.request(path === null || path === "" ? undefined : path, false);
      return;
    }
    this.render();
  }

  clear(): void {
    this.root = null;
    this.current = null;
    this.parent = null;
    this.dirs = [];
    this.truncated = false;
    this.query = "";
    this.showHidden = false;
    this.error = null;
    this.touched = false;
    this.started = false;
    this.startFallback = false;
    this.stickyError = false;
    this.pending = null;
    this.loading = false;
  }

  handleList(list: DirList): void {
    if (this.pending === null || list.req !== this.pending) {
      return;
    }
    this.pending = null;
    this.loading = false;
    this.current = list.path;
    this.parent = list.parent;
    this.dirs = list.dirs;
    this.truncated = list.truncated;
    if (!this.stickyError) {
      this.error = null;
    }
    this.render();
  }

  handleError(message: string, req: string | null): boolean {
    if (req === null || this.pending === null || req !== this.pending) {
      return false;
    }
    this.pending = null;
    this.loading = false;
    if (this.current === null && !this.startFallback) {
      // The start path failed before anything loaded: show its message once
      // and ask for home instead. The next user navigation clears it.
      this.error = message;
      this.stickyError = true;
      this.startFallback = true;
      this.request(undefined, false, true);
      return true;
    }
    this.error = message;
    this.stickyError = this.current === null;
    this.render();
    return true;
  }

  private attach(root: HTMLElement): void {
    if (this.wired === root) {
      return;
    }
    this.wired = root;
    root.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest("#dir-use")) {
        this.pick();
        return;
      }
      if (target?.closest("#dir-cancel")) {
        this.deps.onCancel();
        return;
      }
      const button = target?.closest<HTMLButtonElement>("button[data-dir-path]");
      const path = button?.getAttribute("data-dir-path");
      if (path !== null && path !== undefined) {
        this.navigate(path);
      }
    });
    root.addEventListener("input", (ev) => {
      const input = ev.target as HTMLInputElement | null;
      if (input?.id !== "dir-filter") {
        return;
      }
      this.query = input.value;
      this.renderRows();
    });
    root.addEventListener("change", (ev) => {
      const input = ev.target as HTMLInputElement | null;
      if (input?.id !== "dir-hidden") {
        return;
      }
      this.showHidden = input.checked;
      this.renderRows();
    });
  }

  private request(path: string | undefined, user: boolean, preserveError = false): void {
    const req = newReqId();
    this.pending = req;
    this.loading = true;
    if (user) {
      this.touched = true;
      this.query = "";
      this.error = null;
      this.stickyError = false;
    } else if (!preserveError && !this.stickyError) {
      this.error = null;
    }
    if (!this.deps.onList(path, req)) {
      this.pending = null;
      this.loading = false;
      this.error = "Not connected";
      this.stickyError = false;
      this.render();
      return;
    }
    this.render();
  }

  private navigate(path: string): void {
    this.request(path, true);
  }

  private pick(): void {
    if (this.current !== null) {
      this.deps.onPick(this.current);
    }
  }

  private filteredDirs(): DirEntry[] {
    const needle = this.query.trim().toLowerCase();
    return visibleDirs(this.dirs, this.showHidden).filter(
      (dir) => needle === "" || dir.name.toLowerCase().includes(needle),
    );
  }

  private crumbsHtml(): string {
    if (this.current === null) {
      return "";
    }
    return pathSegments(this.current)
      .map((segment, index) => {
        const sep = index === 0 ? "" : `<span class="dir-crumb-sep" aria-hidden="true">/</span>`;
        return `${sep}<button type="button" class="dir-crumb" data-dir-path="${esc(segment.path)}">${esc(segment.label)}</button>`;
      })
      .join("");
  }

  private recentHtml(): string {
    if (this.touched || this.current === null) {
      return "";
    }
    const items = this.deps.recent().slice(0, 6);
    if (items.length === 0) {
      return "";
    }
    return `
      <section id="dir-recent" class="dir-recent">
        <h3>Recent</h3>
        <div class="dir-recent-list">${items
          .map(
            (path) =>
              `<button type="button" class="dir-recent-item" data-dir-path="${esc(path)}">${esc(path)}</button>`,
          )
          .join("")}</div>
      </section>`;
  }

  private statusHtml(): string {
    if (this.loading) {
      return `<p id="dir-status" class="dir-status">Loading…</p>`;
    }
    const notes: string[] = [];
    if (this.truncated) {
      notes.push("Showing the first 500 folders; filter or type the path.");
    }
    const visible = this.filteredDirs();
    if (visible.length === 0) {
      notes.push(this.query.trim() === "" ? "No folders here." : "No folders match.");
    }
    return `<p id="dir-status" class="dir-status">${esc(notes.join(" "))}</p>`;
  }

  private rowsHtml(): string {
    const up =
      this.parent === null
        ? ""
        : `<button type="button" class="dir-up" data-dir-path="${esc(this.parent)}"><span>..</span></button>`;
    const rows = this.filteredDirs()
      .map((dir) => {
        const path = this.current === null ? dir.name : joinChildPath(this.current, dir.name);
        return `<button type="button" class="dir-row-item" data-dir-path="${esc(path)}"><span class="dir-row-icon" aria-hidden="true">${icon("folder")}</span><span class="dir-row-name">${esc(dir.name)}</span></button>`;
      })
      .join("");
    return up + rows;
  }

  private listHtml(): string {
    if (this.loading) {
      return this.statusHtml();
    }
    return `${this.statusHtml()}${this.rowsHtml()}`;
  }

  private useLabel(): string {
    if (this.current === null) {
      return "Use this folder";
    }
    return `Use this folder · ${workdirBasename(this.current) || this.current}`;
  }

  private pickerHtml(): string {
    const error = this.error ?? "";
    return `<div class="dir-picker">
      <nav id="dir-crumbs" class="dir-crumbs" aria-label="Directory path">${this.crumbsHtml()}</nav>
      <label class="dir-filter">Filter
        <input id="dir-filter" type="search" autocomplete="off" spellcheck="false" value="${esc(this.query)}">
      </label>
      <label class="dir-hidden"><input id="dir-hidden" type="checkbox" role="switch"${this.showHidden ? " checked" : ""}> Show hidden</label>
      <p id="dir-error" class="dir-error" role="alert"${this.error === null ? " hidden" : ""}>${esc(error)}</p>
      ${this.recentHtml()}
      <div id="dir-list" class="dir-list">${this.listHtml()}</div>
      <div class="sheet-actions dir-actions">
        <button type="button" id="dir-cancel">Cancel</button>
        <button type="button" id="dir-use" class="primary"${this.current === null ? " disabled" : ""}>${esc(this.useLabel())}</button>
      </div>
    </div>`;
  }

  private render(): void {
    const root = this.root;
    if (root === null) {
      return;
    }
    root.innerHTML = this.pickerHtml();
    const crumbs = root.querySelector<HTMLElement>("#dir-crumbs");
    if (crumbs !== null) {
      crumbs.scrollLeft = crumbs.scrollWidth;
    }
  }

  private renderRows(): void {
    const list = this.root?.querySelector<HTMLElement>("#dir-list");
    if (list) {
      list.innerHTML = this.listHtml();
    }
  }
}
