// SPDX-License-Identifier: Apache-2.0
/**
 * The inspector panel: one face per selection — the node form (name,
 * kind, quick fields, full config, delete), the edge condition editor,
 * the ensemble form (name, strategy, min_pass, shared prompt, member
 * overrides, delete), the multi-select with its Make-ensemble button,
 * and the graph view with the sections that ride along untouched.
 *
 * Listeners are delegated once in the constructor, so a re-render never
 * loses them. `change` commits and re-renders; `input` commits without
 * re-rendering, which keeps the caret alive in the field being typed.
 */
import { isArray, isRecord, isString } from "../../../../../packages/plate/guards.js";
import type { JsonValue } from "../../../../../src/schema.js";
import type { CanvasSelection } from "./canvas.js";
import { isEditorSlug } from "./mapping.js";
import {
  ENSEMBLE_KINDS,
  ensembleOf,
  endpointName,
  isEnsembleKind,
  isFixedId,
  type EditorEnsemble,
  type EditorNode,
  type EditorState,
} from "./state.js";
import { NODE_KINDS, isNodeKind, type NodeKind } from "../../../../graphs/src/editor/kinds.js";

/** What the panel asks of its owner; every hook commits to the state. */
export interface PanelHooks {
  /** The graph name changed (already under the slug rule). */
  graphName(text: string): void;
  /** A node rename (already unique where it must be). */
  rename(nodeId: string, text: string): void;
  /** The node's kind changed. */
  kind(nodeId: string, kind: NodeKind): void;
  /** A quick field changed: the config key, or `""` to drop it. */
  quick(nodeId: string, key: string, value: string): void;
  /** The full config text: apply it, or answer why it was not applied. */
  config(nodeId: string, text: string): string | null;
  /** Delete the node. */
  deleteNode(nodeId: string): void;
  /** The edge's condition changed. */
  condition(edgeId: string, condition: JsonValue): void;
  /** Delete the edge. */
  deleteEdge(edgeId: string): void;
  /** The ensemble's name changed (non-empty). */
  ensembleName(ensembleId: string, text: string): void;
  /** The ensemble's strategy changed. */
  ensembleKind(ensembleId: string, kind: "parallel" | "cascade" | "round_robin"): void;
  /** The ensemble's min_pass changed (already clamped). */
  ensembleMinPass(ensembleId: string, value: number): void;
  /** The ensemble's shared prompt changed. */
  ensemblePrompt(ensembleId: string, text: string): void;
  /** One member's prompt override changed. */
  ensembleOverride(ensembleId: string, memberId: string, text: string): void;
  /** Dissolve the ensemble; its members stand alone again. */
  deleteEnsemble(ensembleId: string): void;
  /** Group the multi-select as an ensemble. */
  makeEnsemble(): void;
}

/** A labelled control row. */
function field(id: string, label: string, control: string): string {
  return `<div class="editor-field"><label for="${id}">${escapeHtml(label)}</label>${control}</div>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The main text a kind defines: agent prompt + preset, check/gate command. */
function quickFields(node: EditorNode): string {
  const text = (key: string): string => {
    const value = node.config[key];
    return typeof value === "string" ? value : "";
  };
  if (node.kind === "agent") {
    return (
      field(
        "quick-prompt",
        "Prompt",
        `<textarea id="quick-prompt" data-quick="prompt_template" rows="3" spellcheck="false">${escapeHtml(text("prompt_template"))}</textarea>`,
      ) +
      field(
        "quick-preset",
        "Prompt preset",
        `<input id="quick-preset" data-quick="prompt_preset" type="text" value="${escapeHtml(text("prompt_preset"))}" spellcheck="false" autocomplete="off">`,
      )
    );
  }
  if (node.kind === "check" || node.kind === "gate") {
    return field(
      "quick-command",
      "Command",
      `<textarea id="quick-command" data-quick="command" rows="3" spellcheck="false">${escapeHtml(text("command"))}</textarea>`,
    );
  }
  return "";
}

function keptRow(label: string, value: string): string {
  return `<div class="field"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

/** The untouched sections as one read-only block: names, counts, the note. */
function keptView(state: EditorState): string {
  const none = "none";
  const sections = state.sections;
  const hooks = sections["hooks"];
  let hookCount = 0;
  if (isRecord(hooks)) {
    for (const entries of Object.values(hooks)) {
      if (isArray(entries)) {
        hookCount += entries.length;
      }
    }
  }
  const infra = sections["infra_node"];
  const presets = sections["presets"];
  const presetNames = isRecord(presets) ? Object.keys(presets) : [];
  const list = (names: string[]): string => (names.length === 0 ? none : escapeHtml(names.join(", ")));
  return (
    `<section class="editor-kept">` +
    `<p class="editor-kept-note">Hooks, the infra node and presets ride along with the document unchanged.</p>` +
    `<dl class="editor-kept-list">` +
    keptRow("Hooks", hookCount > 0 ? String(hookCount) : none) +
    keptRow("Infra node", isString(infra) ? escapeHtml(infra) : none) +
    keptRow("Presets", list(presetNames)) +
    `</dl></section>`
  );
}

export class Panel {
  private lastState: EditorState | null = null;
  private lastSelection: CanvasSelection = { node: null, edge: null, ensemble: null, multi: [] };
  private lastConfigError: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: PanelHooks,
  ) {
    root.addEventListener("input", (event) => this.onInput(event));
    root.addEventListener("change", (event) => this.onChange(event));
    root.addEventListener("click", (event) => this.onClick(event));
  }

  /** Render the face for the selection; `configError` re-shows a JSON error. */
  render(state: EditorState, selection: CanvasSelection, configError: string | null = null): void {
    this.lastState = state;
    this.lastSelection = selection;
    this.lastConfigError = configError;
    const node =
      selection.node === null
        ? null
        : state.nodes.find((entry) => entry.id === selection.node) ?? null;
    const edge =
      selection.edge === null
        ? null
        : state.edges.find((entry) => entry.id === selection.edge) ?? null;
    const ensemble =
      selection.ensemble === null
        ? null
        : state.ensembles.find((entry) => entry.id === selection.ensemble) ?? null;
    this.root.innerHTML =
      node !== null
        ? this.nodeView(state, node, configError)
        : edge !== null
          ? this.edgeView(state, edge)
          : ensemble !== null
            ? this.ensembleView(state, ensemble)
            : selection.multi.length > 0
              ? this.multiView(state, selection.multi)
              : this.graphView(state);
  }

  /** Re-render from the cached inputs, after a committed `change`. */
  private selfRender(): void {
    if (this.lastState !== null) {
      this.render(this.lastState, this.lastSelection, this.lastConfigError);
    }
  }

  /**
   * Bring the non-focused controls in line with the state after a paint
   * that skipped the panel. Answers true when the config box itself was
   * refreshed — its pending text, and the error it earned, is gone.
   */
  sync(): boolean {
    if (this.lastState === null) {
      return false;
    }
    const node =
      this.lastSelection.node === null
        ? null
        : this.lastState.nodes.find((entry) => entry.id === this.lastSelection.node) ?? null;
    if (node !== null && !isFixedId(node.id) && ensembleOf(this.lastState, node.id) === null) {
      const active = globalThis.document.activeElement;
      const set = (selector: string, value: string): void => {
        const control = this.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
        if (control !== null && control !== active && control.value !== value) {
          control.value = value;
        }
      };
      const text = (key: string): string => {
        const value = node.config[key];
        return typeof value === "string" ? value : "";
      };
      if (node.kind === "agent") {
        set("#quick-prompt", text("prompt_template"));
        set("#quick-preset", text("prompt_preset"));
      } else if (node.kind === "check" || node.kind === "gate") {
        set("#quick-command", text("command"));
      }
      const configBox = this.root.querySelector<HTMLTextAreaElement>("#node-config");
      if (configBox === null || configBox === active) {
        return false;
      }
      configBox.value = JSON.stringify(node.config, null, 2);
      return true;
    }
    if (this.lastSelection.ensemble !== null) {
      const ensemble =
        this.lastState.ensembles.find((entry) => entry.id === this.lastSelection.ensemble) ?? null;
      if (ensemble === null) {
        return false;
      }
      const active = globalThis.document.activeElement;
      const prompt = this.root.querySelector<HTMLTextAreaElement>("#ensemble-prompt");
      if (prompt !== null && prompt !== active && prompt.value !== ensemble.prompt) {
        prompt.value = ensemble.prompt;
      }
      return false;
    }
    return false;
  }

  private nodeView(state: EditorState, node: EditorNode, configError: string | null): string {
    if (isFixedId(node.id)) {
      const note =
        node.id === "spec"
          ? "The fixed entry. Its output starts the graph; wire it to begin."
          : "The fixed exit. A pass into it ends that branch; it exports nothing itself.";
      return (
        `<h2 class="kicker">Node</h2>` +
        field(
          "node-name",
          "Name",
          `<input id="node-name" type="text" value="${escapeHtml(node.name)}" disabled>`,
        ) +
        `<p class="editor-hint">${escapeHtml(note)}</p>` +
        keptView(state)
      );
    }
    const ensemble = ensembleOf(state, node.id);
    if (ensemble !== null) {
      return (
        `<h2 class="kicker">Node</h2>` +
        field(
          "node-name",
          "Name",
          `<input id="node-name" type="text" value="${escapeHtml(node.name)}" spellcheck="false" autocomplete="off" aria-describedby="node-name-error">` +
            `<p class="editor-field-error" id="node-name-error" hidden>A name is 1-48 characters of a-z, 0-9 or -.</p>`,
        ) +
        `<p class="editor-hint">A member of the ${escapeHtml(ensemble.name)} ensemble. Its kind stays agent while grouped.</p>` +
        `<button type="button" class="button editor-danger" data-action="delete-node"><span>Delete node</span></button>` +
        keptView(state)
      );
    }
    return (
      `<h2 class="kicker">Node</h2>` +
      field(
        "node-name",
        "Name",
        `<input id="node-name" type="text" value="${escapeHtml(node.name)}" spellcheck="false" autocomplete="off" aria-describedby="node-name-error">` +
          `<p class="editor-field-error" id="node-name-error" hidden>A name is 1-48 characters of a-z, 0-9 or -.</p>`,
      ) +
      field(
        "node-kind",
        "Kind",
        `<select id="node-kind">${NODE_KINDS.map(
          (kind) => `<option value="${kind}"${kind === node.kind ? " selected" : ""}>${kind}</option>`,
        ).join("")}</select>`,
      ) +
      quickFields(node) +
      field(
        "node-config",
        "Config (JSON)",
        `<textarea id="node-config" rows="9" spellcheck="false" aria-describedby="node-config-error">${escapeHtml(
          JSON.stringify(node.config, null, 2),
        )}</textarea>` +
          `<p class="editor-field-error" id="node-config-error"${
            configError === null ? " hidden" : ""
          }>${escapeHtml(configError ?? "")}</p>`,
      ) +
      `<button type="button" class="button editor-danger" data-action="delete-node"><span>Delete node</span></button>` +
      keptView(state)
    );
  }

  private edgeView(
    state: EditorState,
    edge: { id: string; from: string; to: string; condition: JsonValue },
  ): string {
    const fromNode = state.nodes.find((node) => node.id === edge.from);
    const fromEnsemble = state.ensembles.some((ensemble) => ensemble.id === edge.from);
    const condition = edge.condition;
    const routeLabel =
      isRecord(condition) && "route" in condition && isString(condition["route"]) ? condition["route"] : "";
    const isRoute = isRecord(condition) && "route" in condition;
    const scalar = isString(condition) ? condition : isRoute ? "route" : "pass";
    const options = fromEnsemble
      ? ["pass", "fail"]
      : ["pass", "fail", "always", "error"];
    const routeCapable = fromNode?.kind === "router";
    if ((routeCapable || isRoute) && !fromEnsemble) {
      options.push("route");
    }
    if (!options.includes(scalar)) {
      options.push(scalar);
    }
    return (
      `<h2 class="kicker">Edge</h2>` +
      `<p class="editor-edge-endpoints">${escapeHtml(`${endpointName(state, edge.from)} → ${endpointName(state, edge.to)}`)}</p>` +
      field(
        "edge-condition",
        "Condition",
        `<select id="edge-condition">${options.map(
          (option) => `<option value="${option}"${option === scalar ? " selected" : ""}>${option}</option>`,
        ).join("")}</select>`,
      ) +
      (isRoute
        ? field(
            "edge-route",
            "Route name",
            `<input id="edge-route" type="text" value="${escapeHtml(routeLabel)}" placeholder="proceed" autocomplete="off">`,
          )
        : "") +
      `<button type="button" class="button editor-danger" data-action="delete-edge"><span>Delete edge</span></button>` +
      keptView(state)
    );
  }

  private ensembleView(state: EditorState, ensemble: EditorEnsemble): string {
    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    const overrides = ensemble.members
      .map(
        (id) =>
          field(
            `override-${id}`,
            `Override · ${byId.get(id)?.name ?? "?"}`,
            `<textarea id="override-${id}" data-override="${id}" rows="2" spellcheck="false">${escapeHtml(
              ensemble.overrides[id] ?? "",
            )}</textarea>`,
          ),
      )
      .join("");
    return (
      `<h2 class="kicker">Ensemble</h2>` +
      field(
        "ensemble-name",
        "Name",
        `<input id="ensemble-name" type="text" value="${escapeHtml(ensemble.name)}" spellcheck="false" autocomplete="off" aria-describedby="ensemble-name-error">` +
          `<p class="editor-field-error" id="ensemble-name-error" hidden>An ensemble needs a name.</p>`,
      ) +
      field(
        "ensemble-kind",
        "Strategy",
        `<select id="ensemble-kind">${ENSEMBLE_KINDS.map(
          (kind) => `<option value="${kind}"${kind === ensemble.kind ? " selected" : ""}>${kind}</option>`,
        ).join("")}</select>`,
      ) +
      field(
        "ensemble-min-pass",
        `Min pass (1–${Math.max(ensemble.members.length, 1)})`,
        `<input id="ensemble-min-pass" type="number" min="1" max="${Math.max(ensemble.members.length, 1)}" value="${ensemble.min_pass}">`,
      ) +
      field(
        "ensemble-prompt",
        "Shared prompt",
        `<textarea id="ensemble-prompt" rows="4" spellcheck="false">${escapeHtml(ensemble.prompt)}</textarea>`,
      ) +
      overrides +
      `<button type="button" class="button editor-danger" data-action="delete-ensemble"><span>Delete ensemble</span></button>` +
      keptView(state)
    );
  }

  private multiView(state: EditorState, multi: string[]): string {
    const names = multi.map((id) => endpointName(state, id));
    return (
      `<h2 class="kicker">Selection</h2>` +
      `<p class="editor-hint">${escapeHtml(`${multi.length} nodes: ${names.join(", ")}`)}</p>` +
      `<p class="editor-hint">Shift-click toggles nodes. Group 2–8 agent nodes as an ensemble.</p>` +
      `<button type="button" class="button" data-action="make-ensemble"><span>Make ensemble</span></button>` +
      keptView(state)
    );
  }

  private graphView(state: EditorState): string {
    return (
      `<h2 class="kicker">Graph</h2>` +
      field(
        "graph-name",
        "Name",
        `<input id="graph-name" type="text" value="${escapeHtml(state.name)}" spellcheck="false" autocomplete="off" aria-describedby="graph-name-error">` +
          `<p class="editor-field-error" id="graph-name-error" hidden>A name is 1-48 characters of a-z, 0-9 or -.</p>`,
      ) +
      `<p class="editor-hint">Select a node or an edge on the canvas to edit it. Shift-click selects several.</p>` +
      keptView(state)
    );
  }

  /** Toggle a field's inline error (`<id>-error`) with the value's validity. */
  private showValidity(id: string, valid: boolean): void {
    const error = this.root.querySelector<HTMLElement>(`#${id}-error`);
    if (error !== null) {
      error.hidden = valid;
    }
  }

  private onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      return;
    }
    const nodeId = this.lastSelection.node;
    const ensembleId = this.lastSelection.ensemble;
    if (target.id === "node-name" || target.id === "graph-name") {
      this.showValidity(target.id, isEditorSlug(target.value));
      return;
    }
    if (target.id === "ensemble-name") {
      this.showValidity("ensemble-name", target.value.trim() !== "");
      return;
    }
    if (target.id === "node-config") {
      if (nodeId === null) {
        return;
      }
      const error = this.hooks.config(nodeId, target.value);
      const box = this.root.querySelector<HTMLElement>("#node-config-error");
      if (box !== null) {
        box.textContent = error ?? "";
        box.hidden = error === null;
      }
      return;
    }
    if (target.id === "ensemble-prompt") {
      if (ensembleId !== null) {
        this.hooks.ensemblePrompt(ensembleId, target.value);
      }
      return;
    }
    if (target.id === "edge-route") {
      if (this.lastSelection.edge !== null) {
        this.hooks.condition(this.lastSelection.edge, { route: target.value });
      }
      return;
    }
    const override = target.getAttribute("data-override");
    if (override !== null && ensembleId !== null) {
      this.hooks.ensembleOverride(ensembleId, override, target.value);
      return;
    }
    const quick = target.getAttribute("data-quick");
    if (quick !== null && nodeId !== null) {
      this.hooks.quick(nodeId, quick, target.value);
    }
  }

  private onChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
      return;
    }
    const nodeId = this.lastSelection.node;
    const edgeId = this.lastSelection.edge;
    const ensembleId = this.lastSelection.ensemble;
    if (target.id === "node-name") {
      if (nodeId !== null && isEditorSlug(target.value)) {
        this.hooks.rename(nodeId, target.value);
        this.selfRender();
      } else {
        this.showValidity("node-name", false);
      }
      return;
    }
    if (target.id === "graph-name") {
      if (isEditorSlug(target.value)) {
        this.hooks.graphName(target.value);
        this.selfRender();
      } else {
        this.showValidity("graph-name", false);
      }
      return;
    }
    if (target.id === "node-kind") {
      if (nodeId !== null && isNodeKind(target.value)) {
        this.hooks.kind(nodeId, target.value);
        this.selfRender();
      }
      return;
    }
    if (target.id === "edge-condition" && edgeId !== null) {
      const condition: JsonValue = target.value === "route" ? { route: "" } : target.value;
      this.hooks.condition(edgeId, condition);
      this.selfRender();
      return;
    }
    if (target.id === "ensemble-name" && ensembleId !== null) {
      if (target.value.trim() !== "") {
        this.hooks.ensembleName(ensembleId, target.value.trim());
        this.selfRender();
      } else {
        this.showValidity("ensemble-name", false);
      }
      return;
    }
    if (target.id === "ensemble-kind" && ensembleId !== null) {
      if (isEnsembleKind(target.value)) {
        this.hooks.ensembleKind(ensembleId, target.value);
        this.selfRender();
      }
      return;
    }
    if (target.id === "ensemble-min-pass" && ensembleId !== null) {
      const value = Number.parseInt(target.value, 10);
      if (Number.isInteger(value)) {
        this.hooks.ensembleMinPass(ensembleId, value);
        this.selfRender();
      }
    }
  }

  private onClick(event: Event): void {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    const action = target?.getAttribute("data-action") ?? "";
    if (action === "delete-node" && this.lastSelection.node !== null) {
      this.hooks.deleteNode(this.lastSelection.node);
      return;
    }
    if (action === "delete-edge" && this.lastSelection.edge !== null) {
      this.hooks.deleteEdge(this.lastSelection.edge);
      return;
    }
    if (action === "delete-ensemble" && this.lastSelection.ensemble !== null) {
      this.hooks.deleteEnsemble(this.lastSelection.ensemble);
      return;
    }
    if (action === "make-ensemble") {
      this.hooks.makeEnsemble();
    }
  }
}
