// SPDX-License-Identifier: Apache-2.0
/**
 * The palette: a blank node of every kind, and the catalogue's own nodes
 * through `/api/official` (its listing) and `/api/search` (a query).
 *
 * Picking a catalogue row asks the app for its document — the palette
 * only ever carries refs, never documents, so the harness and kind rules
 * stay in one place (document.ts). Search runs on submit and on a
 * debounced input, so Enter and typing both work without hammering the
 * API.
 */
import { NO_RESULTS, EDITOR_CATALOGUE_EMPTY, EDITOR_CATALOGUE_FAILED } from "../pages/copy.js";
import { escapeHtml } from "../pages/md.js";
import { fetchOfficial, fetchSearch, type CatalogRow } from "./api.js";
import { NODE_KINDS, type NodeKind } from "./kinds.js";

/** What the palette asks of its owner. */
export interface PaletteHooks {
  /** A blank node of `kind` was requested. */
  blank(kind: NodeKind): void;
  /** A catalogue row was picked, by its `owner/repo/slug` ref. */
  pick(ref: string): void;
  /** The catalogue failed to answer; the message is shown to the user. */
  failed(message: string): void;
}

export class Palette {
  private readonly results: HTMLUListElement;
  private readonly emptyNote: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: PaletteHooks,
  ) {
    this.results = root.querySelector("#editor-results") as HTMLUListElement;
    this.emptyNote = root.querySelector("#editor-results-empty") as HTMLElement;
    this.form = root.querySelector("form.editor-search") as HTMLFormElement;
    this.input = root.querySelector("#editor-search") as HTMLInputElement;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-blank]")) {
      button.addEventListener("click", () => {
        const kind = button.getAttribute("data-blank");
        if (kind !== null && NODE_KINDS.includes(kind as NodeKind)) {
          this.hooks.blank(kind as NodeKind);
        }
      });
    }
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.search(this.input.value);
    });
    this.input.addEventListener("input", () => {
      if (this.searchTimer !== null) {
        clearTimeout(this.searchTimer);
      }
      this.searchTimer = setTimeout(() => this.search(this.input.value), 300);
    });
    this.results.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-ref]") : null;
      const ref = target?.getAttribute("data-ref");
      if (ref !== undefined && ref !== null) {
        this.hooks.pick(ref);
      }
    });
    void this.official();
  }

  /** The official listing: the nodes that are always there to pick. */
  private async official(): Promise<void> {
    try {
      const listing = await fetchOfficial();
      this.render(listing.nodes, EDITOR_CATALOGUE_EMPTY);
    } catch {
      this.hooks.failed(EDITOR_CATALOGUE_FAILED);
    }
  }

  /** A query, or the official listing again when the box is emptied. */
  private async search(query: string): Promise<void> {
    const text = query.trim();
    if (text === "") {
      await this.official();
      return;
    }
    try {
      const rows = (await fetchSearch(text)).filter((row) => row.kind === "node");
      this.render(rows, NO_RESULTS);
    } catch {
      this.hooks.failed(EDITOR_CATALOGUE_FAILED);
    }
  }

  /** Rows as buttons; the empty note says which emptiness this is. */
  private render(rows: CatalogRow[], emptyText: string): void {
    this.emptyNote.textContent = emptyText;
    this.emptyNote.hidden = rows.length > 0;
    this.results.innerHTML = rows
      .map(
        (row) =>
          `<li><button type="button" class="editor-result" data-ref="${escapeHtml(`${row.repo}/${row.slug}`)}">` +
          `<span class="editor-result-name">${escapeHtml(row.name)}</span>` +
          `<span class="row-source">${escapeHtml(row.repo)}</span>` +
          `</button></li>`,
      )
      .join("");
  }
}
