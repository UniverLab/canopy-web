// SPDX-License-Identifier: Apache-2.0
/**
 * The inspector panel: a side column on desktop, a bottom sheet under
 * 640 px (pure CSS — the markup is the same). It renders exactly three
 * faces: the selected node's form (name under the slug rule, kind, the
 * quick field for the main text its kind defines, the full `config` as
 * JSON, delete), the selected edge's condition editor, and the graph
 * view (its name, the hint) — and under all three, the sections the
 * editor keeps untouched, read-only, with the note that says so.
 *
 * Listeners are delegated once in the constructor, so a re-render never
 * loses them. `change` commits (and lets the panel re-render itself);
 * `input` commits without re-rendering, which keeps the caret alive in
 * the very fields the user is typing into.
 */
import { iconSvg } from "../../../../packages/look/icon-svg.js";
import { isArray, isRecord, isString, type JsonValue } from "../json.js";
import {
  EDITOR_CONDITION_LABEL,
  EDITOR_DELETE_EDGE,
  EDITOR_DELETE_NODE,
  EDITOR_DELETE_BLOCKED,
  EDITOR_EDGE_HEADING,
  EDITOR_FIELD_COMMAND,
  EDITOR_FIELD_CONFIG,
  EDITOR_FIELD_KIND,
  EDITOR_FIELD_NAME,
  EDITOR_FIELD_PRESET,
  EDITOR_FIELD_PROMPT,
  EDITOR_NAME_INVALID,
  EDITOR_PANEL_GRAPH_HEADING,
  EDITOR_PANEL_NODE_HEADING,
  EDITOR_ROUTE_LABEL,
  EDITOR_ROUTE_PLACEHOLDER,
  EDITOR_SELECT_HINT,
  EDITOR_SECTION_ENSEMBLES,
  EDITOR_SECTION_EMPTY,
  EDITOR_SECTION_HOOKS,
  EDITOR_SECTION_INFRA,
  EDITOR_SECTION_PRESETS,
  EDITOR_UNTOUCHED_NOTE,
  editorEdgeLabel,
} from "../pages/copy.js";
import { escapeHtml } from "../pages/md.js";
import { ensembleBound } from "./document.js";
import { NODE_KINDS, isNodeKind, type NodeKind } from "./kinds.js";
import { isSlugName, type CanvasEdge, type CanvasNode, type EditorState } from "./state.js";

/** What is selected on the canvas: at most one node or one edge. */
export interface Selection {
  node: string | null;
  edge: string | null;
}

/** What the panel asks of its owner; every hook commits to the state. */
export interface PanelHooks {
  /** The graph name changed (already under the slug rule). */
  graphName(text: string): void;
  /** A node rename (already under the slug rule; may be made unique). */
  rename(nodeId: string, text: string): void;
  /** The node's kind changed. */
  kind(nodeId: string, kind: NodeKind): void;
  /** A quick field changed: the config key, or `""` to drop it. */
  quick(nodeId: string, key: string, value: string): void;
  /** The full config text: apply it, or answer the reason it was not applied. */
  config(nodeId: string, text: string): string | null;
  /** Delete the node (the panel already refused an ensemble-bound one). */
  deleteNode(nodeId: string): void;
  /** The edge's condition changed (a route may be an empty name yet). */
  condition(edgeId: string, condition: JsonValue): void;
  /** Delete the edge. */
  deleteEdge(edgeId: string): void;
}

/** A labelled control row. */
function field(id: string, label: string, control: string): string {
  return `<div class="editor-field"><label for="${id}">${escapeHtml(label)}</label>${control}</div>`;
}

/** The main text a kind defines: agent prompt + preset, check/gate command. */
function quickFields(node: CanvasNode): string {
  const text = (key: string): string => {
    const value = node.config[key];
    return typeof value === "string" ? value : "";
  };
  if (node.kind === "agent") {
    return (
      field(
        "quick-prompt",
        EDITOR_FIELD_PROMPT,
        `<textarea id="quick-prompt" data-quick="prompt_template" rows="3" spellcheck="false">${escapeHtml(text("prompt_template"))}</textarea>`,
      ) +
      field(
        "quick-preset",
        EDITOR_FIELD_PRESET,
        `<input id="quick-preset" data-quick="prompt_preset" type="text" value="${escapeHtml(text("prompt_preset"))}" spellcheck="false" autocomplete="off">`,
      )
    );
  }
  if (node.kind === "check" || node.kind === "gate") {
    return field(
      "quick-command",
      EDITOR_FIELD_COMMAND,
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
  const none = escapeHtml(EDITOR_SECTION_EMPTY);
  const sections = state.sections;
  const ensembles = sections["ensembles"];
  const ensembleNames = isArray(ensembles)
    ? ensembles.flatMap((entry) => (isRecord(entry) && isString(entry["name"]) ? [entry["name"]] : []))
    : [];
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
    `<p class="editor-kept-note">${escapeHtml(EDITOR_UNTOUCHED_NOTE)}</p>` +
    `<dl class="editor-kept-list">` +
    keptRow(EDITOR_SECTION_ENSEMBLES, list(ensembleNames)) +
    keptRow(EDITOR_SECTION_HOOKS, hookCount > 0 ? String(hookCount) : none) +
    keptRow(EDITOR_SECTION_INFRA, isString(infra) ? escapeHtml(infra) : none) +
    keptRow(EDITOR_SECTION_PRESETS, list(presetNames)) +
    `</dl></section>`
  );
}

export class Panel {
  private lastState: EditorState | null = null;
  private lastSelection: Selection = { node: null, edge: null };
  private lastConfigError: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: PanelHooks,
  ) {
    root.addEventListener("input", (event) => this.onInput(event));
    root.addEventListener("change", (event) => this.onChange(event));
    root.addEventListener("click", (event) => this.onClick(event));
  }

  /** Render the face for the selection; `configError` re-shows a pending JSON error. */
  render(state: EditorState, selection: Selection, configError: string | null = null): void {
    this.lastState = state;
    this.lastSelection = selection;
    this.lastConfigError = configError;
    const node = selection.node === null ? null : state.nodes.find((entry) => entry.id === selection.node) ?? null;
    const edge = selection.edge === null ? null : state.edges.find((entry) => entry.id === selection.edge) ?? null;
    this.root.innerHTML =
      node !== null
        ? this.nodeView(state, node, configError)
        : edge !== null
          ? this.edgeView(state, edge)
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
   * that skipped the panel, so the quick fields and the config box never
   * disagree while the user types into one of them. Answers true when
   * the config box itself was refreshed — its pending text, and with it
   * the error it earned, is gone.
   */
  sync(): boolean {
    if (this.lastState === null) {
      return false;
    }
    const node =
      this.lastSelection.node === null
        ? null
        : this.lastState.nodes.find((entry) => entry.id === this.lastSelection.node) ?? null;
    if (node === null) {
      return false;
    }
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

  private nodeView(state: EditorState, node: CanvasNode, configError: string | null): string {
    const locked = ensembleBound(state, node.name);
    return (
      `<h2 class="kicker">${escapeHtml(EDITOR_PANEL_NODE_HEADING)}</h2>` +
      field(
        "node-name",
        EDITOR_FIELD_NAME,
        `<input id="node-name" type="text" value="${escapeHtml(node.name)}" spellcheck="false" autocomplete="off" aria-describedby="node-name-error">` +
          `<p class="editor-field-error" id="node-name-error" hidden>${escapeHtml(EDITOR_NAME_INVALID)}</p>`,
      ) +
      field(
        "node-kind",
        EDITOR_FIELD_KIND,
        `<select id="node-kind">${NODE_KINDS.map(
          (kind) => `<option value="${kind}"${kind === node.kind ? " selected" : ""}>${kind}</option>`,
        ).join("")}</select>`,
      ) +
      quickFields(node) +
      field(
        "node-config",
        EDITOR_FIELD_CONFIG,
        `<textarea id="node-config" rows="9" spellcheck="false" aria-describedby="node-config-error">${escapeHtml(
          JSON.stringify(node.config, null, 2),
        )}</textarea>` +
          `<p class="editor-field-error" id="node-config-error"${
            configError === null ? " hidden" : ""
          }>${escapeHtml(configError ?? "")}</p>`,
      ) +
      (locked ? `<p class="editor-hint editor-blocked">${escapeHtml(EDITOR_DELETE_BLOCKED)}</p>` : "") +
      `<button type="button" class="button editor-danger" data-action="delete-node"${
        locked ? " disabled" : ""
      }>${iconSvg("x")}<span>${escapeHtml(EDITOR_DELETE_NODE)}</span></button>` +
      keptView(state)
    );
  }

  private edgeView(state: EditorState, edge: CanvasEdge): string {
    const from = state.nodes.find((node) => node.id === edge.from);
    const to = state.nodes.find((node) => node.id === edge.to);
    const condition = edge.condition;
    const routeLabel =
      isRecord(condition) && "route" in condition && isString(condition["route"]) ? condition["route"] : "";
    const isRoute = isRecord(condition) && "route" in condition;
    const scalar = isString(condition) ? condition : isRoute ? "route" : "pass";
    const routeCapable = from?.kind === "router";
    const options = ["pass", "fail", "always"];
    if (routeCapable || isRoute) {
      options.push("route");
    }
    if (scalar === "error" || scalar === "break") {
      options.push(scalar);
    }
    return (
      `<h2 class="kicker">${escapeHtml(EDITOR_EDGE_HEADING)}</h2>` +
      `<p class="editor-edge-endpoints">${escapeHtml(editorEdgeLabel(from?.name ?? "?", to?.name ?? "?"))}</p>` +
      field(
        "edge-condition",
        EDITOR_CONDITION_LABEL,
        `<select id="edge-condition">${options.map(
          (option) => `<option value="${option}"${option === scalar ? " selected" : ""}>${option}</option>`,
        ).join("")}</select>`,
      ) +
      (isRoute
        ? field(
            "edge-route",
            EDITOR_ROUTE_LABEL,
            `<input id="edge-route" type="text" value="${escapeHtml(routeLabel)}" placeholder="${escapeHtml(
              EDITOR_ROUTE_PLACEHOLDER,
            )}" autocomplete="off">`,
          )
        : "") +
      `<button type="button" class="button editor-danger" data-action="delete-edge">${iconSvg(
        "x",
      )}<span>${escapeHtml(EDITOR_DELETE_EDGE)}</span></button>` +
      keptView(state)
    );
  }

  private graphView(state: EditorState): string {
    return (
      `<h2 class="kicker">${escapeHtml(EDITOR_PANEL_GRAPH_HEADING)}</h2>` +
      field(
        "graph-name",
        EDITOR_FIELD_NAME,
        `<input id="graph-name" type="text" value="${escapeHtml(state.name)}" spellcheck="false" autocomplete="off" aria-describedby="graph-name-error">` +
          `<p class="editor-field-error" id="graph-name-error" hidden>${escapeHtml(EDITOR_NAME_INVALID)}</p>`,
      ) +
      `<p class="editor-hint">${escapeHtml(EDITOR_SELECT_HINT)}</p>` +
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
    if (target.id === "node-name" || target.id === "graph-name") {
      this.showValidity(target.id, isSlugName(target.value));
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
    if (target.id === "edge-route") {
      if (this.lastSelection.edge !== null) {
        this.hooks.condition(this.lastSelection.edge, { route: target.value });
      }
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
    if (target.id === "node-name") {
      if (nodeId !== null && isSlugName(target.value)) {
        this.hooks.rename(nodeId, target.value);
        this.selfRender();
      } else {
        this.showValidity("node-name", false);
      }
      return;
    }
    if (target.id === "graph-name") {
      if (isSlugName(target.value)) {
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
      const condition: JsonValue =
        target.value === "route" ? { route: "" } : target.value;
      this.hooks.condition(edgeId, condition);
      this.selfRender();
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
    }
  }
}
