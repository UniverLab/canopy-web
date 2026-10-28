// SPDX-License-Identifier: Apache-2.0
/**
 * The remote editor's owner: it holds the state, wires the canvas,
 * palette, panel and toolbar to it, runs live validation, and answers
 * the Delete key and the Clear button.
 *
 * Two refresh shapes keep the caret alive: `paint()` redraws everything
 * (a selection or a structural change), while `paint({ panel: false })`
 * redraws canvas and validation only and asks the panel to `sync()` its
 * non-focused controls.
 *
 * Every boot starts blank — `spec` and `next` and nothing else. There
 * is no autosave: Import loads a document, Export stores a draft.
 */
import { isRecord } from "../../../../../packages/plate/guards.js";
import type { JsonValue } from "../../../../../src/schema.js";
import type { NodeKind } from "../../../../graphs/src/editor/kinds.js";
import { Canvas, emptySelection, ensembleGeom, type CanvasSelection } from "./canvas.js";
import {
  IMPORT_BAD,
  connectEditor,
  dissolveEnsemble,
  ensembleProblems,
  exportGraph,
  exportProblems,
  flowProblems,
  importGraph,
  makeEnsemble,
  removeEditorEdge,
  removeEditorNode,
} from "./mapping.js";
import { Panel } from "./panel.js";
import {
  NEXT_ID,
  SPEC_ID,
  blankEditorState,
  newEditorId,
  uniqueEditorName,
  type EditorNode,
  type EditorState,
} from "./state.js";
import { Toolbar, type ToolbarHooks } from "./toolbar.js";
import { createRemoteDraft, type DraftCreated } from "./api.js";

/** The shell's static markup: toolbar, import box, palette, stage, panel, share. */
export function editorShell(): string {
  const blank = (kind: string): string =>
    `<button type="button" class="editor-kind" data-blank="${kind}"><span>${kind}</span></button>`;
  return (
    `<div class="remote-editor" id="editor">` +
    `<div class="editor-toolbar" role="toolbar" aria-label="Graph editor">` +
    `<button type="button" class="button" data-action="import"><span>Import</span></button>` +
    `<button type="button" class="button" data-action="export"><span>Export</span></button>` +
    `<span class="editor-status" id="editor-status" role="status"></span>` +
    `</div>` +
    `<p class="editor-notice" id="editor-notice" role="status" hidden></p>` +
    `<ul class="editor-problems" id="editor-problems" hidden></ul>` +
    `<div class="editor-import" id="editor-import" hidden>` +
    `<h2 class="kicker">Import JSON</h2>` +
    `<label class="sr-only" for="editor-import-text">Paste a graph.json, or choose a file.</label>` +
    `<textarea id="editor-import-text" rows="6" spellcheck="false" autocomplete="off"></textarea>` +
    `<div class="editor-import-actions">` +
    `<label class="editor-file" for="editor-import-file"><span>Choose file</span></label>` +
    `<input id="editor-import-file" type="file" accept=".json,application/json">` +
    `<button type="button" class="button" data-action="import-apply"><span>Import</span></button>` +
    `<button type="button" class="button" data-action="import-cancel"><span>Cancel</span></button>` +
    `</div>` +
    `<p class="editor-import-error" id="editor-import-error" role="alert" hidden></p>` +
    `</div>` +
    `<div class="editor-body">` +
    `<aside class="editor-palette" aria-label="Node palette">` +
    `<h2 class="kicker">Nodes</h2>` +
    blank("agent") +
    blank("check") +
    blank("gate") +
    blank("router") +
    `</aside>` +
    `<div class="editor-stage" id="editor-stage">` +
    `<svg class="editor-svg" id="editor-canvas" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Graph canvas"></svg>` +
    `<p class="editor-empty" id="editor-empty">Add a node from the palette, then wire spec through it to next.</p>` +
    `<div class="editor-zoom" role="group" aria-label="Canvas controls">` +
    `<button type="button" data-zoom="out" aria-label="Zoom out">−</button>` +
    `<button type="button" data-zoom="fit" aria-label="Fit the graph">Fit</button>` +
    `<button type="button" data-zoom="in" aria-label="Zoom in">+</button>` +
    `<button type="button" data-action="clear">Clear</button>` +
    `</div>` +
    `<div class="editor-chooser" id="editor-chooser" role="group" aria-label="Condition" hidden>` +
    `<p class="editor-chooser-title">Condition</p>` +
    `<div class="editor-chooser-row">` +
    `<button type="button" data-cond="pass">pass</button>` +
    `<button type="button" data-cond="fail">fail</button>` +
    `<button type="button" data-cond="always">always</button>` +
    `<button type="button" data-cond="error">error</button>` +
    `<span class="editor-chooser-route" id="editor-chooser-route" hidden>` +
    `<label class="sr-only" for="editor-route">Route name</label>` +
    `<input id="editor-route" type="text" placeholder="proceed" autocomplete="off">` +
    `<button type="button" data-cond="route">route</button>` +
    `</span>` +
    `</div>` +
    `<button type="button" class="editor-chooser-cancel" data-cond="cancel">Cancel</button>` +
    `</div>` +
    `</div>` +
    `<aside class="editor-panel" id="editor-panel" aria-label="Inspector"></aside>` +
    `</div>` +
    `<section class="editor-share" id="editor-share" hidden>` +
    `<h2 class="kicker">Draft</h2>` +
    `<div id="editor-share-body"></div>` +
    `</section>` +
    `</div>`
  );
}

interface ConfigError {
  nodeId: string;
  message: string;
}

interface PaintOptions {
  /** Skip the panel rebuild; it `sync()`s its controls instead. */
  panel?: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class EditorApp {
  private state: EditorState = blankEditorState();
  private selection: CanvasSelection = emptySelection();
  private configError: ConfigError | null = null;
  private chooser: { from: string; to: string } | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly canvas: Canvas;
  private readonly panel: Panel;
  private readonly toolbar: Toolbar;

  private readonly statusEl: HTMLElement;
  private readonly problemsEl: HTMLUListElement;
  private readonly noticeEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly chooserEl: HTMLElement;
  private readonly routeRow: HTMLElement;
  private readonly routeInput: HTMLInputElement;
  private readonly stageEl: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    const need = <T extends Element>(selector: string): T => {
      const found = root.querySelector<T>(selector);
      if (found === null) {
        throw new Error(`editor shell is missing ${selector}`);
      }
      return found;
    };
    this.statusEl = need("#editor-status");
    this.problemsEl = need("#editor-problems");
    this.noticeEl = need("#editor-notice");
    this.emptyEl = need("#editor-empty");
    this.chooserEl = need("#editor-chooser");
    this.routeRow = need("#editor-chooser-route");
    this.routeInput = need("#editor-route");
    this.stageEl = need("#editor-stage");
    this.canvas = new Canvas(need("#editor-stage"), {
      pick: (target, additive) => this.pick(target, additive),
      connect: (from, to, at) => this.openChooser(from, to, at),
      changed: () => this.paint(),
    });
    this.panel = new Panel(need("#editor-panel"), {
      graphName: (text) => {
        this.state.name = text;
        this.paint({ panel: false });
      },
      rename: (nodeId, text) => {
        const node = this.nodeOf(nodeId);
        if (node === null || node.id === SPEC_ID || node.id === NEXT_ID) {
          return;
        }
        const taken = new Set(
          this.state.nodes.filter((entry) => entry.id !== nodeId).map((entry) => entry.name),
        );
        node.name = uniqueEditorName(text, taken);
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
      deleteNode: (nodeId) => this.deleteNode(nodeId),
      condition: (edgeId, condition) => {
        const edge = this.state.edges.find((entry) => entry.id === edgeId);
        if (edge !== undefined) {
          edge.condition = condition;
          this.paint({ panel: false });
        }
      },
      deleteEdge: (edgeId) => {
        removeEditorEdge(this.state, edgeId);
        this.deselect();
        this.paint();
      },
      ensembleName: (ensembleId, text) => {
        const ensemble = this.state.ensembles.find((entry) => entry.id === ensembleId);
        if (ensemble !== undefined) {
          ensemble.name = text;
          this.paint({ panel: false });
        }
      },
      ensembleKind: (ensembleId, kind) => {
        const ensemble = this.state.ensembles.find((entry) => entry.id === ensembleId);
        if (ensemble !== undefined) {
          ensemble.kind = kind;
          this.paint({ panel: false });
        }
      },
      ensembleMinPass: (ensembleId, value) => {
        const ensemble = this.state.ensembles.find((entry) => entry.id === ensembleId);
        if (ensemble !== undefined) {
          const max = Math.max(ensemble.members.length, 1);
          ensemble.min_pass = Math.min(Math.max(value, 1), max);
          this.paint({ panel: false });
        }
      },
      ensemblePrompt: (ensembleId, text) => {
        const ensemble = this.state.ensembles.find((entry) => entry.id === ensembleId);
        if (ensemble !== undefined) {
          ensemble.prompt = text;
          this.paint({ panel: false });
        }
      },
      ensembleOverride: (ensembleId, memberId, text) => {
        const ensemble = this.state.ensembles.find((entry) => entry.id === ensembleId);
        if (ensemble === undefined || !ensemble.members.includes(memberId)) {
          return;
        }
        if (text === "") {
          delete ensemble.overrides[memberId];
        } else {
          ensemble.overrides[memberId] = text;
        }
        this.paint({ panel: false });
      },
      deleteEnsemble: (ensembleId) => {
        dissolveEnsemble(this.state, ensembleId);
        this.deselect();
        this.paint();
      },
      makeEnsemble: () => this.makeEnsemble(),
    });
    const toolbarHooks: ToolbarHooks = {
      importText: (text) => this.applyImportText(text),
      exportDraft: () => this.exportDraft(),
      notify: (message) => this.showNotice(message),
    };
    this.toolbar = new Toolbar(root, toolbarHooks);
    root.addEventListener("click", (event) => this.onClick(event));
    // On the document: key events target the focused element (usually the
    // body), which is above the shell — the shell itself never sees them.
    document.addEventListener("keydown", (event) => this.onKey(event));
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
    this.paint();
    this.canvas.fit();
    this.root.dataset.ready = "true";
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
    const grouped = new Set(this.state.ensembles.flatMap((ensemble) => ensemble.members));
    const working = this.state.nodes.filter(
      (node) => node.id !== SPEC_ID && node.id !== NEXT_ID && !grouped.has(node.id),
    );
    this.emptyEl.hidden = working.length > 0 || this.state.ensembles.length > 0;
  }

  private validate(): void {
    const problems = exportProblems(this.state);
    if (this.configError !== null) {
      problems.push(this.configError.message);
    }
    this.problemsEl.innerHTML = problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("");
    this.problemsEl.hidden = problems.length === 0;
    this.statusEl.textContent =
      problems.length === 0
        ? "No problems."
        : problems.length === 1
          ? "1 problem"
          : `${problems.length} problems`;
    this.statusEl.classList.toggle("has-problems", problems.length > 0);
    this.toolbar.setBlocked(problems.length > 0);
  }

  /* ── Selection ────────────────────────────────────────────────────── */

  private pick(
    target: { kind: "node" | "edge" | "ensemble" | "background"; id: string | null },
    additive: boolean,
  ): void {
    this.closeChooser();
    if (target.kind === "background") {
      this.deselect();
      this.canvas.setSelection(this.selection);
      this.validate();
      this.panel.render(this.state, this.selection, null);
      return;
    }
    if (target.kind === "node" && additive && target.id !== null) {
      const multi = [...this.selection.multi];
      if (multi.length === 0 && this.selection.node !== null) {
        multi.push(this.selection.node);
      }
      const at = multi.indexOf(target.id);
      if (at >= 0) {
        multi.splice(at, 1);
      } else {
        multi.push(target.id);
      }
      this.selection = { node: null, edge: null, ensemble: null, multi };
      this.configError = null;
      this.canvas.setSelection(this.selection);
      this.validate();
      this.panel.render(this.state, this.selection, null);
      return;
    }
    if (target.id === null) {
      return;
    }
    this.selection = {
      node: target.kind === "node" ? target.id : null,
      edge: target.kind === "edge" ? target.id : null,
      ensemble: target.kind === "ensemble" ? target.id : null,
      multi: [],
    };
    this.configError = null;
    this.canvas.setSelection(this.selection);
    this.validate();
    this.panel.render(this.state, this.selection, null);
  }

  private deselect(): void {
    this.selection = emptySelection();
    this.configError = null;
    this.closeChooser();
    this.canvas.disarm();
    this.canvas.setSelection(this.selection);
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key !== "Delete" && event.key !== "Backspace") {
      if (event.key === "Escape") {
        this.closeChooser();
        this.canvas.disarm();
      }
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    this.deleteSelection();
  }

  private deleteSelection(): void {
    const dissolved: string[] = [];
    if (this.selection.edge !== null) {
      removeEditorEdge(this.state, this.selection.edge);
    } else if (this.selection.ensemble !== null) {
      dissolveEnsemble(this.state, this.selection.ensemble);
    } else if (this.selection.multi.length > 0) {
      for (const id of this.selection.multi) {
        dissolved.push(...this.takeNode(id));
      }
    } else if (this.selection.node !== null) {
      dissolved.push(...this.takeNode(this.selection.node));
    } else {
      return;
    }
    this.deselect();
    this.paint();
    for (const name of dissolved) {
      this.showNotice(`ensemble ${name} dissolved (fewer than 2 members)`);
    }
  }

  /** Delete one node by id; answers the dissolved ensemble, if any. */
  private takeNode(id: string): string[] {
    if (id === SPEC_ID || id === NEXT_ID) {
      return [];
    }
    const { dissolved } = removeEditorNode(this.state, id);
    return dissolved === null ? [] : [dissolved];
  }

  private deleteNode(nodeId: string): void {
    const dissolved = this.takeNode(nodeId);
    this.deselect();
    this.paint();
    for (const name of dissolved) {
      this.showNotice(`ensemble ${name} dissolved (fewer than 2 members)`);
    }
  }

  /* ── The chooser ──────────────────────────────────────────────────── */

  private openChooser(from: string, to: string, at: { x: number; y: number }): void {
    this.closeChooser();
    if (from === to || from === NEXT_ID || to === SPEC_ID) {
      return;
    }
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
    const ensembleSource = this.state.ensembles.some((ensemble) => ensemble.id === from);
    this.routeRow.hidden = source?.kind !== "router";
    // An ensemble owns pass and fail exits only.
    for (const cond of ["always", "error"]) {
      this.chooserEl.querySelector<HTMLButtonElement>(`[data-cond="${cond}"]`)?.toggleAttribute(
        "hidden",
        ensembleSource,
      );
    }
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
        this.showNotice("A route needs a name.");
        this.routeInput.focus();
        return;
      }
      condition = { route: label };
    }
    const edge = connectEditor(this.state, chooser.from, chooser.to, condition);
    this.closeChooser();
    this.canvas.disarm();
    this.selection = { node: null, edge: edge.id, ensemble: null, multi: [] };
    this.canvas.setSelection(this.selection);
    this.paint();
  }

  /* ── Palette and canvas controls ──────────────────────────────────── */

  private onClick(event: Event): void {
    const target = event.target instanceof Element ? event.target.closest("[data-action],[data-zoom],[data-blank]") : null;
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
    const blank = target?.getAttribute("data-blank");
    if (blank === "agent" || blank === "check" || blank === "gate" || blank === "router") {
      this.addBlank(blank);
      return;
    }
    if (target?.getAttribute("data-action") === "clear") {
      this.clearCanvas();
    }
  }

  private addBlank(kind: NodeKind): void {
    const at = this.freeSpot();
    const node: EditorNode = {
      id: newEditorId(),
      name: uniqueEditorName(kind, new Set(this.state.nodes.map((entry) => entry.name))),
      kind,
      config: {},
      x: at.x,
      y: at.y,
    };
    this.state.nodes.push(node);
    this.selection = { node: node.id, edge: null, ensemble: null, multi: [] };
    this.canvas.setSelection(this.selection);
    this.paint();
    if (!this.canvas.isVisible(node.x, node.y)) {
      this.canvas.fit();
    }
  }

  /** A free point near the visible centre, clear of boxes and ensembles. */
  private freeSpot(): { x: number; y: number } {
    const center = this.canvas.worldCenter();
    const byId = new Map(this.state.nodes.map((node) => [node.id, node]));
    const boxes = this.state.nodes.map((node) => ({ x: node.x, y: node.y, rx: 140, ry: 110 }));
    for (const ensemble of this.state.ensembles) {
      const geom = ensembleGeom(
        ensemble,
        ensemble.members.map((id) => byId.get(id)?.name ?? "?"),
      );
      boxes.push({ x: ensemble.x, y: ensemble.y, rx: (geom.w * 12) / 2 + 80, ry: (geom.h * 12) / 2 + 60 });
    }
    for (let i = 0; i < 60; i += 1) {
      const candidate = {
        x: center.x + (((i + 1) % 3) - 1) * 190,
        y: center.y + Math.floor(i / 3) * 150,
      };
      const free = boxes.every(
        (box) => Math.abs(box.x - candidate.x) >= box.rx || Math.abs(box.y - candidate.y) >= box.ry,
      );
      if (free) {
        return candidate;
      }
    }
    return center;
  }

  private makeEnsemble(): void {
    const result = makeEnsemble(this.state, this.selection.multi);
    if ("error" in result) {
      this.showNotice(result.error);
      return;
    }
    this.selection = { node: null, edge: null, ensemble: result.ensemble.id, multi: [] };
    this.canvas.setSelection(this.selection);
    this.paint();
  }

  private clearCanvas(): void {
    if (!globalThis.confirm("Start over? spec and next stay; everything else is cleared.")) {
      return;
    }
    this.state = blankEditorState();
    this.deselect();
    this.toolbar.hideShare();
    this.paint();
    this.canvas.fit();
  }

  /* ── Import and export ────────────────────────────────────────────── */

  private applyImportText(text: string): string | null {
    const trimmed = text.trim();
    let parsed: unknown = null;
    if (trimmed !== "") {
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        parsed = null;
      }
    }
    if (parsed === null || !isRecord(parsed)) {
      return IMPORT_BAD;
    }
    const result = importGraph(parsed);
    if ("error" in result) {
      return result.error;
    }
    this.state = result.state;
    this.deselect();
    this.paint();
    this.canvas.fit();
    return null;
  }

  private async exportDraft(): Promise<DraftCreated> {
    const problems = [...flowProblems(this.state), ...ensembleProblems(this.state)];
    if (problems.length > 0) {
      throw new Error(problems[0]);
    }
    const document = exportGraph(this.state);
    return createRemoteDraft(document);
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
      const message = "That is not JSON yet — the graph still holds the last valid config.";
      this.configError = { nodeId, message };
      this.paint({ panel: false });
      return message;
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
