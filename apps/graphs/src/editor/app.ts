// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's owner: it holds the state, wires the canvas, palette,
 * panel and share block to it, runs the toolbar (New, Import, Export,
 * Copy link), validates live, and autosaves to localStorage after every
 * commit.
 *
 * Two refresh shapes keep the caret alive: `paint()` redraws everything
 * (a selection or a structural change), while `paint({ panel: false })`
 * redraws canvas, validation and storage only and asks the panel to
 * `sync()` its non-focused controls — so typing in the config box updates
 * the quick fields and vice versa without ever rebuilding the field the
 * user is in.
 *
 * Boot order: a snapshot taken at the same URL wins (edits survive a
 * reload of the page they belong to); otherwise `?draft=`, `?from=` and
 * `?node=` fetch their document, and only a bare `/editor` falls back to
 * the last snapshot of any URL. Every refusal the API or the validator
 * speaks lands in the notice or the problems list, verbatim.
 */
import { ApiError, createDraft, fetchDocument, fetchDraft } from "./api.js";
import { Canvas } from "./canvas.js";
import {
  addBlankNode,
  addCatalogNode,
  connect,
  ensembleBound,
  exportGraph,
  importGraph,
  importNodeDocument,
  removeEdge,
  removeNode,
} from "./document.js";
import { isArray, isRecord, type JsonValue } from "../json.js";
import { Palette } from "./palette.js";
import { Panel, type Selection } from "./panel.js";
import { Share } from "./share.js";
import {
  blankState,
  browserStorage,
  clearSaved,
  loadSaved,
  saveSaved,
  uniqueName,
  type CanvasNode,
  type EditorState,
  type StorageLike,
} from "./state.js";
import type { NodeKind } from "./kinds.js";
import { documentProblems, harnessProblems } from "../validate.js";
import {
  EDITOR_CONFIG_INVALID,
  EDITOR_DRAFT_NODE,
  EDITOR_FAILED,
  EDITOR_IMPORT_BAD,
  EDITOR_LOAD_FAILED,
  EDITOR_NEW_CONFIRM,
  EDITOR_NO_PROBLEMS,
  EDITOR_ROUTE_REQUIRED,
  editorProblemCount,
} from "../pages/copy.js";
import { escapeHtml } from "../pages/md.js";

interface ConfigError {
  nodeId: string;
  message: string;
}

interface PaintOptions {
  /** Skip the panel rebuild; it `sync()`s its controls instead. */
  panel?: boolean;
  /** Skip the localStorage write (New, right after clearing it). */
  persist?: boolean;
}

/** The API's own words for a failure, its problem paths included. */
function apiMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problems.length > 0
      ? `${error.message} — ${error.problems.join(" · ")}`
      : error.message;
  }
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return EDITOR_FAILED;
}

export class EditorApp {
  private state: EditorState = blankState();
  private selection: Selection = { node: null, edge: null };
  private configError: ConfigError | null = null;
  private chooser: { from: string; to: string } | null = null;
  private blocked = false;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly storage: StorageLike | null;
  private readonly source: string;

  private readonly canvas: Canvas;
  private readonly palette: Palette;
  private readonly panel: Panel;
  private readonly share: Share;

  private readonly statusEl: HTMLElement;
  private readonly problemsEl: HTMLUListElement;
  private readonly noticeEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly importEl: HTMLElement;
  private readonly importText: HTMLTextAreaElement;
  private readonly importFile: HTMLInputElement;
  private readonly importError: HTMLElement;
  private readonly chooserEl: HTMLElement;
  private readonly routeRow: HTMLElement;
  private readonly routeInput: HTMLInputElement;
  private readonly stageEl: HTMLElement;
  private readonly shareEl: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    const need = <T extends Element>(selector: string): T => {
      const found = root.querySelector<T>(selector);
      if (found === null) {
        throw new Error(`editor shell is missing ${selector}`);
      }
      return found;
    };
    this.storage = browserStorage();
    this.source = globalThis.location?.search ?? "";
    this.statusEl = need("#editor-status");
    this.problemsEl = need("#editor-problems");
    this.noticeEl = need("#editor-notice");
    this.emptyEl = need("#editor-empty");
    this.exportBtn = need('[data-action="export"]');
    this.copyBtn = need('[data-action="copy-link"]');
    this.importEl = need("#editor-import");
    this.importText = need("#editor-import-text");
    this.importFile = need("#editor-import-file");
    this.importError = need("#editor-import-error");
    this.chooserEl = need("#editor-chooser");
    this.routeRow = need("#editor-chooser-route");
    this.routeInput = need("#editor-route");
    this.stageEl = need("#editor-stage");
    this.shareEl = need("#editor-share");
    this.share = new Share(shareSection(root), need("#editor-share-body"));
    this.canvas = new Canvas(need("#editor-stage"), {
      select: (nodeId, edgeId) => this.select(nodeId, edgeId),
      connect: (from, to, at) => this.openChooser(from, to, at),
      changed: () => this.paint(),
    });
    this.palette = new Palette(root, {
      blank: (kind) => this.addBlank(kind),
      pick: (ref) => void this.addFromCatalog(ref),
      failed: (message) => this.showNotice(message),
    });
    this.panel = new Panel(need("#editor-panel"), {
      graphName: (text) => {
        this.state.name = text;
        this.paint({ panel: false });
      },
      rename: (nodeId, text) => {
        const node = this.nodeOf(nodeId);
        if (node === null || ensembleBound(this.state, node.name)) {
          return;
        }
        const taken = new Set(this.state.nodes.filter((entry) => entry.id !== nodeId).map((entry) => entry.name));
        node.name = uniqueName(text, taken);
        if (this.configError?.nodeId === nodeId) {
          this.configError = null;
        }
        this.paint({ panel: false });
      },
      kind: (nodeId, kind) => {
        const node = this.nodeOf(nodeId);
        if (node === null) {
          return;
        }
        node.kind = kind;
        if (this.configError?.nodeId === nodeId) {
          this.configError = null;
        }
        this.paint({ panel: false });
      },
      quick: (nodeId, key, value) => {
        const node = this.nodeOf(nodeId);
        if (node === null) {
          return;
        }
        if (value === "") {
          delete node.config[key];
        } else {
          node.config[key] = value;
        }
        this.paint({ panel: false });
      },
      config: (nodeId, text) => this.applyConfig(nodeId, text),
      deleteNode: (nodeId) => {
        const node = this.nodeOf(nodeId);
        if (node === null || ensembleBound(this.state, node.name)) {
          return;
        }
        removeNode(this.state, nodeId);
        this.deselect();
        this.paint();
      },
      condition: (edgeId, condition) => {
        const edge = this.state.edges.find((entry) => entry.id === edgeId);
        if (edge !== undefined) {
          edge.condition = condition;
          this.paint({ panel: false });
        }
      },
      deleteEdge: (edgeId) => {
        removeEdge(this.state, edgeId);
        this.deselect();
        this.paint();
      },
    });
    root.addEventListener("click", (event) => this.onClick(event));
    this.importFile.addEventListener("change", () => void this.readImportFile());
    this.routeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.choose("route");
      }
    });
    this.chooserEl.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-cond]") : null;
      const value = target?.getAttribute("data-cond");
      if (value !== null && value !== undefined) {
        this.choose(value);
      }
    });
    void this.boot();
  }

  /* ── Boot ─────────────────────────────────────────────────────────── */

  private async boot(): Promise<void> {
    const saved = loadSaved(this.storage);
    const params = new URLSearchParams(this.source);
    const draftId = params.get("draft") ?? "";
    const fromRef = params.get("from") ?? "";
    const nodeRef = params.get("node") ?? "";
    try {
      if (saved !== null && saved.source === this.source) {
        this.state = saved.state;
      } else if (draftId !== "") {
        await this.loadDraft(draftId);
      } else if (fromRef !== "") {
        await this.loadRef("g", fromRef);
      } else if (nodeRef !== "") {
        await this.loadRef("n", nodeRef);
      } else if (saved !== null) {
        this.state = saved.state;
      }
    } finally {
      this.deselect();
      this.paint();
      if (this.state.nodes.length > 0) {
        this.canvas.fit();
      }
      this.root.dataset.ready = "true";
    }
  }

  private async loadRef(kind: "g" | "n", ref: string): Promise<void> {
    try {
      const document = await fetchDocument(kind, ref);
      if (kind === "g") {
        const result = importGraph(document);
        if ("error" in result) {
          this.showNotice(result.error);
          return;
        }
        this.state = result.state;
        return;
      }
      const source = importNodeDocument(document);
      if ("error" in source) {
        this.showNotice(source.error);
        return;
      }
      const fresh = blankState();
      const added = addCatalogNode(fresh, source.source, { x: 240, y: 180 });
      if ("error" in added) {
        this.showNotice(added.error);
        return;
      }
      this.state = fresh;
    } catch (error) {
      this.showNotice(`${EDITOR_LOAD_FAILED}: ${apiMessage(error)}`);
    }
  }

  private async loadDraft(id: string): Promise<void> {
    try {
      const draft = await fetchDraft(id);
      if (draft.kind !== "graph") {
        this.showNotice(EDITOR_DRAFT_NODE);
        return;
      }
      const result = importGraph(draft.document);
      if ("error" in result) {
        this.showNotice(result.error);
        return;
      }
      this.state = result.state;
    } catch (error) {
      this.showNotice(`${EDITOR_LOAD_FAILED}: ${apiMessage(error)}`);
    }
  }

  /* ── Painting ─────────────────────────────────────────────────────── */

  private paint(options: PaintOptions = {}): void {
    if (options.panel === false) {
      if (this.panel.sync() && this.configError !== null) {
        this.configError = null;
      }
      this.canvas.setState(this.state);
      this.validate();
    } else {
      this.canvas.setState(this.state);
      this.validate();
      this.panel.render(this.state, this.selection, this.configError?.message ?? null);
    }
    this.emptyEl.hidden = this.state.nodes.length > 0;
    if (options.persist !== false) {
      saveSaved(this.storage, this.state, this.source);
    }
  }

  private validate(): void {
    const document = exportGraph(this.state);
    const problems = [...documentProblems("graph", document), ...harnessProblems("graph", document)];
    if (this.configError !== null) {
      const nodes = isArray(document["nodes"]) ? document["nodes"] : [];
      const node = this.state.nodes.find((entry) => entry.id === this.configError?.nodeId);
      const index =
        node === undefined
          ? -1
          : nodes.findIndex((entry) => isRecord(entry) && entry["name"] === node.name);
      problems.push({
        path: index >= 0 ? `#/nodes/${index}/config` : "#/config",
        message: this.configError.message,
      });
    }
    this.problemsEl.innerHTML = problems
      .map(
        (problem) =>
          `<li><code>${escapeHtml(problem.path)}</code>${escapeHtml(problem.message)}</li>`,
      )
      .join("");
    this.problemsEl.hidden = problems.length === 0;
    this.statusEl.textContent =
      problems.length === 0 ? EDITOR_NO_PROBLEMS : editorProblemCount(problems.length);
    this.statusEl.classList.toggle("has-problems", problems.length > 0);
    this.blocked = problems.length > 0;
    this.exportBtn.disabled = this.blocked;
    this.copyBtn.disabled = this.blocked;
  }

  /* ── Selection and the chooser ────────────────────────────────────── */

  private select(nodeId: string | null, edgeId: string | null): void {
    this.closeChooser();
    if (this.selection.node === nodeId && this.selection.edge === edgeId) {
      return;
    }
    this.selection = { node: nodeId, edge: edgeId };
    this.configError = null;
    this.canvas.setSelection(nodeId, edgeId);
    this.validate();
    this.panel.render(this.state, this.selection, null);
  }

  private deselect(): void {
    this.selection = { node: null, edge: null };
    this.configError = null;
    this.closeChooser();
    this.canvas.setSelection(null, null);
  }

  private openChooser(from: string, to: string, at: { x: number; y: number }): void {
    this.closeChooser();
    this.chooser = { from, to };
    const stage = this.stageEl.getBoundingClientRect();
    this.chooserEl.hidden = false;
    const width = this.chooserEl.offsetWidth;
    const height = this.chooserEl.offsetHeight;
    const left = Math.min(
      Math.max(at.x - stage.left - width / 2, 8),
      Math.max(stage.width - width - 8, 8),
    );
    const top = Math.min(
      Math.max(at.y - stage.top + 16, 8),
      Math.max(stage.height - height - 8, 8),
    );
    this.chooserEl.style.left = `${Math.round(left)}px`;
    this.chooserEl.style.top = `${Math.round(top)}px`;
    const source = this.state.nodes.find((node) => node.id === from);
    this.routeRow.hidden = source?.kind !== "router";
    this.routeInput.value = "";
    this.chooserEl.querySelector<HTMLButtonElement>('[data-cond="pass"]')?.focus();
  }

  private closeChooser(): void {
    this.chooser = null;
    this.chooserEl.hidden = true;
  }

  private choose(value: string): void {
    const chooser = this.chooser;
    if (chooser === null) {
      return;
    }
    if (value === "cancel") {
      this.closeChooser();
      return;
    }
    let condition: JsonValue = value;
    if (value === "route") {
      const label = this.routeInput.value.trim();
      if (label === "") {
        this.showNotice(EDITOR_ROUTE_REQUIRED);
        this.routeInput.focus();
        return;
      }
      condition = { route: label };
    }
    const edge = connect(this.state, chooser.from, chooser.to, condition);
    this.closeChooser();
    this.selection = { node: null, edge: edge.id };
    this.canvas.setSelection(null, edge.id);
    this.paint();
  }

  /* ── Palette ──────────────────────────────────────────────────────── */

  private addBlank(kind: NodeKind): void {
    const node = addBlankNode(this.state, kind, this.freeSpot());
    this.selection = { node: node.id, edge: null };
    this.canvas.setSelection(node.id, null);
    this.paint();
    this.reveal(node);
  }

  private async addFromCatalog(ref: string): Promise<void> {
    try {
      const document = await fetchDocument("n", ref);
      const source = importNodeDocument(document);
      if ("error" in source) {
        this.showNotice(source.error);
        return;
      }
      const added = addCatalogNode(this.state, source.source, this.freeSpot());
      if ("error" in added) {
        this.showNotice(added.error);
        return;
      }
      this.selection = { node: added.node.id, edge: null };
      this.canvas.setSelection(added.node.id, null);
      this.paint();
      this.reveal(added.node);
    } catch (error) {
      this.showNotice(apiMessage(error));
    }
  }

  /** A free point near the visible centre: a small grid until one slot is empty. */
  private freeSpot(): { x: number; y: number } {
    const center = this.canvas.worldCenter();
    for (let i = 0; i < 60; i += 1) {
      const candidate = {
        x: center.x + (((i + 1) % 3) - 1) * 190,
        y: center.y + Math.floor(i / 3) * 150,
      };
      const free = this.state.nodes.every(
        (node) => Math.abs(node.x - candidate.x) >= 140 || Math.abs(node.y - candidate.y) >= 110,
      );
      if (free) {
        return candidate;
      }
    }
    return center;
  }

  /** Re-frame the canvas when a fresh node landed outside the view. */
  private reveal(node: CanvasNode): void {
    if (!this.canvas.isVisible(node)) {
      this.canvas.fit();
    }
  }

  /* ── Toolbar ──────────────────────────────────────────────────────── */

  private async onClick(event: Event): Promise<void> {
    const target = event.target instanceof Element ? event.target.closest("[data-action],[data-zoom]") : null;
    const zoom = target?.getAttribute("data-zoom");
    if (zoom !== null && zoom !== undefined) {
      if (zoom === "in") {
        this.canvas.zoomBy(1.3);
      } else if (zoom === "out") {
        this.canvas.zoomBy(1 / 1.3);
      } else {
        this.canvas.fit();
      }
      return;
    }
    const action = target?.getAttribute("data-action") ?? "";
    switch (action) {
      case "new":
        this.newGraph();
        break;
      case "import":
        this.toggleImport();
        break;
      case "import-apply":
        this.applyImport();
        break;
      case "import-cancel":
        this.hideImport();
        break;
      case "export":
        this.exportJson();
        break;
      case "copy-link":
        await this.copyLink();
        break;
      default:
        break;
    }
  }

  private newGraph(): void {
    if (!globalThis.confirm(EDITOR_NEW_CONFIRM)) {
      return;
    }
    clearSaved(this.storage);
    this.state = blankState();
    this.deselect();
    this.shareEl.hidden = true;
    this.paint({ persist: false });
  }

  private toggleImport(): void {
    this.importEl.hidden = !this.importEl.hidden;
    this.importError.hidden = true;
    if (!this.importEl.hidden) {
      this.importText.focus();
    }
  }

  private hideImport(): void {
    this.importEl.hidden = true;
    this.importError.hidden = true;
    this.importText.value = "";
  }

  private applyImport(): void {
    const text = this.importText.value.trim();
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }
    if (parsed === null || !isRecord(parsed)) {
      this.showImportError(EDITOR_IMPORT_BAD);
      return;
    }
    const result = importGraph(parsed);
    if ("error" in result) {
      this.showImportError(result.error);
      return;
    }
    this.state = result.state;
    this.deselect();
    this.shareEl.hidden = true;
    this.hideImport();
    this.paint();
    this.canvas.fit();
  }

  private showImportError(message: string): void {
    this.importError.textContent = message;
    this.importError.hidden = false;
  }

  private async readImportFile(): Promise<void> {
    const file = this.importFile.files?.[0] ?? null;
    this.importFile.value = "";
    if (file === null) {
      return;
    }
    try {
      this.importText.value = await file.text();
    } catch {
      this.showImportError(EDITOR_IMPORT_BAD);
      return;
    }
    this.importError.hidden = true;
    this.importText.focus();
  }

  private exportJson(): void {
    if (this.blocked) {
      return;
    }
    const text = `${JSON.stringify(exportGraph(this.state), null, 2)}\n`;
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${this.state.name}.graph.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async copyLink(): Promise<void> {
    if (this.blocked) {
      return;
    }
    this.copyBtn.disabled = true;
    this.share.busy();
    try {
      const draft = await createDraft(exportGraph(this.state));
      this.share.show(draft);
      this.hideNotice();
    } catch (error) {
      this.shareEl.hidden = true;
      this.showNotice(apiMessage(error));
    } finally {
      this.copyBtn.disabled = this.blocked;
    }
  }

  /* ── Small helpers ────────────────────────────────────────────────── */

  private nodeOf(nodeId: string): EditorState["nodes"][number] | null {
    return this.state.nodes.find((node) => node.id === nodeId) ?? null;
  }

  private applyConfig(nodeId: string, text: string): string | null {
    const node = this.nodeOf(nodeId);
    if (node === null) {
      return null;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed)) {
      this.configError = { nodeId, message: EDITOR_CONFIG_INVALID };
      this.paint({ panel: false });
      return EDITOR_CONFIG_INVALID;
    }
    node.config = parsed;
    if (this.configError?.nodeId === nodeId) {
      this.configError = null;
    }
    this.paint({ panel: false });
    return null;
  }

  private showNotice(message: string): void {
    this.noticeEl.textContent = message;
    this.noticeEl.hidden = false;
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => this.hideNotice(), 12_000);
  }

  private hideNotice(): void {
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.noticeEl.hidden = true;
  }
}

/** The share section element, so the constructor reads one place. */
function shareSection(root: HTMLElement): HTMLElement {
  const section = root.querySelector<HTMLElement>("#editor-share");
  if (section === null) {
    throw new Error("editor shell is missing #editor-share");
  }
  return section;
}
