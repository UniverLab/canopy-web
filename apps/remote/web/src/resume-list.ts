// SPDX-License-Identifier: Apache-2.0
// The New dialog's Resume pane: the host's recorded conversations, one
// filter and the scrolling list of rows. The pane owns its list state —
// items, filter, the in-flight request and the error line — while the
// dialog owns the frames and closes the sheet on a matching spawned.
// Split out of new-dialog.ts so the coordinator stays a coordinator.

import { formatAge } from "./shelf-delete.js";
import { esc } from "./sheet.js";
import { workdirBasename } from "./protocol.js";
import type { ResumableSession } from "./protocol.js";

/** One row: the host's conversation as `resumable{sessions}` lists it. */
export type ResumeRow = ResumableSession;

export interface ResumeListOptions {
  /** A row was tapped; the dialog sends session_resume for that id. */
  onResume: (id: string) => void;
  /** The Retry button beside a failed resumable_list. */
  onRetry: () => void;
  /** The clock behind the relative start times; real time by default. */
  nowMs?: () => number;
}

const LOADING = "Loading…";
const EMPTY = "No past sessions to resume.";

export class ResumeList {
  private readonly options: ResumeListOptions;
  private body: HTMLElement | null = null;
  private items: ResumeRow[] = [];
  private query = "";
  private loading = false;
  private error: string | null = null;
  /** The request awaiting an answer: the list's or one resume's. */
  private pending: string | null = null;

  constructor(options: ResumeListOptions) {
    this.options = options;
  }

  /** Entering Resume: the filter, the error line, the status and the list. */
  mount(body: HTMLElement): void {
    this.body = body;
    body.innerHTML = `
      <label>Filter
        <input id="resume-filter" type="search" autocomplete="off" spellcheck="false"
          placeholder="name, harness or folder" value="${esc(this.query)}">
      </label>
      <p class="resume-error" id="resume-error" role="alert" hidden>
        <span id="resume-error-text"></span>
        <button type="button" id="resume-retry">Retry</button>
      </p>
      <p class="resume-status" id="resume-status" role="status"></p>
      <div class="resume-list" id="resume-list" role="list"></div>`;
    body.querySelector<HTMLInputElement>("#resume-filter")?.addEventListener("input", (ev) => {
      this.query = (ev.target as HTMLInputElement).value;
      this.paint();
    });
    body.querySelector<HTMLButtonElement>("#resume-retry")?.addEventListener("click", () => {
      this.options.onRetry();
    });
    body.querySelector<HTMLElement>("#resume-list")?.addEventListener("click", (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>(".resume-row");
      const id = row?.dataset.resumeId;
      if (id !== undefined && !this.loading) {
        this.options.onResume(id);
      }
    });
    this.paint();
  }

  /** The host's answer: newest first, as it sent them. */
  setItems(items: ResumeRow[]): void {
    this.items = items;
    this.loading = false;
    this.error = null;
    this.pending = null;
    this.paint();
  }

  /** A request is in flight: the status says so and every row is disabled. */
  setLoading(req: string): void {
    this.loading = true;
    this.error = null;
    this.pending = req;
    this.paint();
  }

  /** The host refused: its message and a Retry, with the list usable again. */
  setError(message: string): void {
    this.loading = false;
    this.error = message;
    this.pending = null;
    this.paint();
  }

  /** The sheet closed: the next open starts from a clean pane. */
  clear(): void {
    this.body = null;
    this.items = [];
    this.query = "";
    this.loading = false;
    this.error = null;
    this.pending = null;
  }

  /** A spawned: true when it answers the resume this pane sent. */
  handleSpawned(req: string): boolean {
    if (this.pending === null || this.pending !== req) {
      return false;
    }
    this.pending = null;
    return true;
  }

  /** An error for either request: true when this pane consumed it. */
  handleError(message: string, req: string | null): boolean {
    if (this.pending === null) {
      return false;
    }
    if (req !== null && req !== this.pending) {
      return false;
    }
    this.setError(message);
    return true;
  }

  private now(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private visibleRows(): ResumeRow[] {
    const query = this.query.trim().toLowerCase();
    if (query === "") {
      return this.items;
    }
    return this.items.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.cli.toLowerCase().includes(query) ||
        item.workdir.toLowerCase().includes(query),
    );
  }

  private rowHtml(item: ResumeRow): string {
    const started = item.started_at === null ? "" : formatAge(this.now(), item.started_at);
    const meta = [item.cli, workdirBasename(item.workdir), started]
      .filter((part) => part !== "")
      .join(" · ");
    const note = item.has_conversation ? "" : " · latest in this folder";
    const name = item.name === "" ? item.id : item.name;
    const disabled = this.loading ? " disabled" : "";
    return `
        <button type="button" class="resume-row" role="listitem" data-resume-id="${esc(item.id)}"${disabled}>
          <span class="resume-name">${esc(name)}</span>
          <span class="resume-meta">${esc(meta + note)}</span>
        </button>`;
  }

  private statusText(): string {
    if (this.loading) {
      return LOADING;
    }
    if (this.error !== null) {
      return "";
    }
    return this.items.length === 0 ? EMPTY : "";
  }

  private paint(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    const error = body.querySelector<HTMLElement>("#resume-error");
    const errorText = body.querySelector<HTMLElement>("#resume-error-text");
    if (error && errorText) {
      errorText.textContent = this.error ?? "";
      error.hidden = this.error === null;
    }
    const status = body.querySelector<HTMLElement>("#resume-status");
    if (status) {
      status.textContent = this.statusText();
    }
    const list = body.querySelector<HTMLElement>("#resume-list");
    if (list) {
      list.innerHTML = this.visibleRows().map((item) => this.rowHtml(item)).join("");
    }
  }
}
