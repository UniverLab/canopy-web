// SPDX-License-Identifier: Apache-2.0
/**
 * The remote editor canvas: boxes with ports on one SVG, driven by
 * pointer events so mouse and touch behave alike.
 *
 * Every node is a box with its kind icon and name, an input port on its
 * left edge and an output port on its right (`spec` keeps only the
 * output, `next` only the input). An edge starts at an output port: drag
 * it onto an input port, or — on touch screens — tap the output and
 * then the input. The app turns the landing into a condition through
 * its `connect` hook.
 *
 * Ensembles draw exactly as the plate draws them: the dashed box, the
 * title and subtitle lines and the member chips come from the plate's
 * own `groupTitle`/`groupSubtitle`/`groupWidth` geometry, in plate
 * units under one `scale(12)` transform. Member chips are selectable
 * but take no edges; wiring attaches to the ensemble's own ports.
 *
 * Coordinates are world pixels at zoom 1; the view transform pans and
 * zooms under them. Shift-click toggles nodes in the multi-select the
 * inspector's Make-ensemble button reads.
 */
import { classOf, type EdgeClass } from "../../../../../packages/plate/document.js";
import {
  forceArcOf,
  GROUP_FOOT,
  GROUP_HEAD,
  groupSubtitle,
  groupTitle,
  groupWidth,
  LIFT_STEP,
  MEMBER_DY,
  MEMBER_GEOM,
  plateLabel,
} from "../../../../../packages/plate/layout.js";
import { PALETTE, edgePath, type Pt } from "../../../../../packages/plate/vocabulary.js";
import {
  NEXT_ID,
  SPEC_ID,
  type EditorEnsemble,
  type EditorNode,
  type EditorState,
} from "./state.js";

/** Plate units in canvas pixels at zoom 1. */
export const SCALE = 12;

/** A node box, in world pixels. */
export const NODE_W = 132;
export const NODE_H = 52;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;

/** Draw order per class, the plate's: error, pass, then fail on top. */
const EDGE_ORDER: Record<EdgeClass, number> = { error: 0, order: 1, pass: 2, fail: 3 };

/** What the canvas highlights: one node, edge or ensemble, or a multi-select. */
export interface CanvasSelection {
  node: string | null;
  edge: string | null;
  ensemble: string | null;
  multi: string[];
}

/** The empty selection. */
export function emptySelection(): CanvasSelection {
  return { node: null, edge: null, ensemble: null, multi: [] };
}

/** What the canvas tells its owner. */
export interface CanvasHooks {
  /** A press picked a target; `additive` is the shift-click toggle. */
  pick(target: { kind: "node" | "edge" | "ensemble" | "background"; id: string | null }, additive: boolean): void;
  /** A port drag (or tap-tap) landed; the point anchors the chooser. */
  connect(fromId: string, toId: string, at: { x: number; y: number }): void;
  /** A drag finished: the document changed. */
  changed(): void;
}

type Pan = { kind: "pan"; pointerId: number; startX: number; startY: number; viewX: number; viewY: number; moved: boolean };
type Drag = { kind: "drag"; pointerId: number; id: string; ensemble: boolean; startX: number; startY: number; origX: number; origY: number; moved: boolean };
type Connect = { kind: "connect"; pointerId: number; from: string; cx: number; cy: number; startX: number; startY: number; moved: boolean };
type Interaction = Pan | Drag | Connect | null;

interface View {
  x: number;
  y: number;
  z: number;
}

/** Escape text for svg content and attribute values alike (the plate's rule). */
function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** The svg's own stylesheet, built from the plate's palette so no hex is copied. */
function canvasStyle(): string {
  const mix = `color-mix(in srgb,var(--canopy,#00a9a0) 22%,${PALETTE.deep})`;
  return (
    `.editor-svg text{font-family:var(--font-mono,"Sometype Mono","Courier New",monospace)}` +
    `.editor-svg .node{cursor:grab}` +
    `.editor-svg .node-box{fill:#0c1416;stroke:${PALETTE.gateStroke};stroke-width:1.5}` +
    `.editor-svg .node.kind-agent .node-box{fill:${mix};stroke:var(--canopy,#00a9a0)}` +
    `.editor-svg .node.fixed .node-box{stroke-dasharray:6 4}` +
    `.editor-svg .node.selected .node-box{stroke:var(--teal,#00a9a0);stroke-width:3}` +
    `.editor-svg .node-name{fill:${PALETTE.label};font-size:13px;pointer-events:none}` +
    `.editor-svg .kind-mark{stroke:var(--canopy,#00a9a0);fill:none;stroke-width:1.5;pointer-events:none}` +
    `.editor-svg .kind-mark.solid{fill:var(--canopy,#00a9a0);stroke:none}` +
    `.editor-svg .port-hit{fill:transparent;cursor:crosshair}` +
    `.editor-svg .port-in{fill:#0c1416;stroke:var(--teal,#00a9a0);stroke-width:2;pointer-events:none}` +
    `.editor-svg .port-out{fill:var(--teal,#00a9a0);stroke:${PALETTE.deep};stroke-width:1.5;pointer-events:none;opacity:.75}` +
    `.editor-svg .node:hover .port-out,.editor-svg .node.selected .port-out,` +
    `.editor-svg .ensemble:hover .port-out,.editor-svg .ensemble.selected .port-out{opacity:1}` +
    `.editor-svg .port-out.armed{stroke:var(--teal,#00a9a0);stroke-width:2;opacity:1}` +
    `.editor-svg .edge-line{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.14;opacity:.85}` +
    `.editor-svg .edge.fail .edge-line{stroke:${PALETTE.red};stroke-dasharray:1 .8}` +
    `.editor-svg .edge.error .edge-line{stroke:currentColor;stroke-width:.1;stroke-dasharray:.4 .7;opacity:.5}` +
    `.editor-svg .edge.selected .edge-line{stroke-width:.26;opacity:1}` +
    `.editor-svg .edge-hit{fill:none;stroke:transparent;stroke-width:1.6;pointer-events:stroke;cursor:pointer}` +
    `.editor-svg .rubber{fill:none;stroke:var(--teal,#00a9a0);stroke-width:.12;stroke-dasharray:.6 .5;pointer-events:none}` +
    `.editor-svg .ensemble{cursor:grab}` +
    `.editor-svg .ensemble-hit{fill:transparent}` +
    `.editor-svg .group-box{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.3;stroke-dasharray:1.2 .9;opacity:.85}` +
    `.editor-svg .ensemble.selected .group-box{stroke:var(--teal,#00a9a0);stroke-width:.5;opacity:1}` +
    `.editor-svg .group-title,.editor-svg .group-subtitle{font-size:1.9px;fill:var(--canopy,#00a9a0);letter-spacing:.14em;text-transform:uppercase;pointer-events:none}` +
    `.editor-svg .member-shape{fill:${mix};stroke:var(--nc,var(--canopy,#00a9a0));stroke-width:.3}` +
    `.editor-svg .member.selected .member-shape{stroke:var(--teal,#00a9a0);stroke-width:.5}` +
    `.editor-svg .member-label{font-size:1.9px;fill:#e8f6f1;text-anchor:middle;pointer-events:none}`
  );
}

/** One ensemble's plate geometry: title, subtitle and box, in units. */
export interface EnsembleGeom {
  title: string;
  subtitle: string;
  w: number;
  h: number;
  labels: string[];
}

export function ensembleGeom(ensemble: EditorEnsemble, names: string[]): EnsembleGeom {
  const labels = names.map((name) => plateLabel(name));
  const title = groupTitle(ensemble.name);
  const subtitle = groupSubtitle(ensemble.kind, ensemble.min_pass, ensemble.members.length);
  const w = groupWidth(title, subtitle, labels);
  const h = GROUP_HEAD + ensemble.members.length * MEMBER_DY + GROUP_FOOT;
  return { title, subtitle, w, h, labels };
}

export class Canvas {
  private readonly svg: SVGSVGElement;
  private readonly world: SVGGElement;
  private state: EditorState | null = null;
  private view: View = { x: 0, y: 0, z: 1 };
  private selected: CanvasSelection = emptySelection();
  private interaction: Interaction = null;
  private pinch: { d0: number; z0: number; worldMid: Pt } | null = null;
  private readonly pointers = new Map<number, Pt>();
  /** The output port a tap armed, waiting for its input tap. */
  private pending: string | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly hooks: CanvasHooks,
  ) {
    let svg = host.querySelector("svg.editor-svg") as SVGSVGElement | null;
    if (svg === null) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "editor-svg");
      host.prepend(svg);
    }
    this.svg = svg;
    svg.innerHTML = `<style>${canvasStyle()}</style><g class="world"></g>`;
    this.world = svg.querySelector("g.world") as SVGGElement;
    svg.addEventListener("pointerdown", (event) => this.down(event));
    svg.addEventListener("pointermove", (event) => this.move(event));
    svg.addEventListener("pointerup", (event) => this.up(event));
    svg.addEventListener("pointercancel", (event) => this.cancel(event));
    svg.addEventListener(
      "wheel",
      (event) => {
        const wheel = event as WheelEvent;
        wheel.preventDefault();
        const rect = this.svg.getBoundingClientRect();
        const px = wheel.clientX - rect.left;
        const py = wheel.clientY - rect.top;
        const before = this.toWorld(px, py);
        const z = clampZoom(this.view.z * Math.exp(-wheel.deltaY * 0.0015));
        this.view = { x: px - before.x * z, y: py - before.y * z, z };
        this.applyView();
      },
      { passive: false },
    );
    this.applyView();
  }

  /** Hand the canvas its document; `null` clears it. */
  setState(state: EditorState | null): void {
    this.state = state;
    if (state === null) {
      this.selected = emptySelection();
      this.pending = null;
    } else if (this.pending !== null && !this.hasEndpoint(this.pending)) {
      this.pending = null;
    }
    this.render();
  }

  /** Highlight a selection without touching anything else. */
  setSelection(selection: CanvasSelection): void {
    this.selected = selection;
    this.render();
  }

  /** Drop a tap-armed output port. */
  disarm(): void {
    if (this.pending !== null) {
      this.pending = null;
      this.render();
    }
  }

  private hasEndpoint(id: string): boolean {
    return (
      this.state?.nodes.some((node) => node.id === id) === true ||
      this.state?.ensembles.some((ensemble) => ensemble.id === id) === true
    );
  }

  /** The world point at the middle of the visible canvas — where new nodes land. */
  worldCenter(): Pt {
    const rect = this.svg.getBoundingClientRect();
    return this.toWorld(rect.width / 2, rect.height / 2);
  }

  /** True when the box sits inside the view — the signal to `fit()` after a drop. */
  isVisible(x: number, y: number): boolean {
    const rect = this.svg.getBoundingClientRect();
    const margin = 80;
    const px = this.view.x + x * this.view.z;
    const py = this.view.y + y * this.view.z;
    return (
      px >= margin && px <= rect.width - margin && py >= margin && py <= rect.height - margin
    );
  }

  /** Multiply the zoom, keeping the canvas centre where it was. */
  zoomBy(factor: number): void {
    const rect = this.svg.getBoundingClientRect();
    const px = rect.width / 2;
    const py = rect.height / 2;
    const before = this.toWorld(px, py);
    const z = clampZoom(this.view.z * factor);
    this.view = { x: px - before.x * z, y: py - before.y * z, z };
    this.applyView();
  }

  /** Frame every box with a comfortable margin (or reset an empty canvas). */
  fit(): void {
    const rect = this.svg.getBoundingClientRect();
    const state = this.state;
    if (state === null || rect.width === 0) {
      this.view = { x: 0, y: 0, z: 1 };
      this.applyView();
      return;
    }
    const grouped = new Set(state.ensembles.flatMap((ensemble) => ensemble.members));
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const span = (x0: number, x1: number, y0: number, y1: number): void => {
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x1);
      minY = Math.min(minY, y0);
      maxY = Math.max(maxY, y1);
    };
    for (const node of state.nodes) {
      if (grouped.has(node.id)) {
        continue;
      }
      span(node.x - NODE_W / 2, node.x + NODE_W / 2, node.y - NODE_H / 2, node.y + NODE_H / 2);
    }
    for (const ensemble of state.ensembles) {
      const geom = this.geomOf(ensemble);
      span(
        ensemble.x - (geom.w * SCALE) / 2,
        ensemble.x + (geom.w * SCALE) / 2,
        ensemble.y - (geom.h * SCALE) / 2,
        ensemble.y + (geom.h * SCALE) / 2,
      );
    }
    if (!Number.isFinite(minX)) {
      this.view = { x: 0, y: 0, z: 1 };
      this.applyView();
      return;
    }
    const pad = 48;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const z = clampZoom(Math.min((rect.width - pad * 2) / spanX, (rect.height - pad * 2) / spanY, 1.4));
    this.view = {
      x: rect.width / 2 - ((minX + maxX) / 2) * z,
      y: rect.height / 2 - ((minY + maxY) / 2) * z,
      z,
    };
    this.applyView();
  }

  private geomOf(ensemble: EditorEnsemble): EnsembleGeom {
    const byId = new Map((this.state?.nodes ?? []).map((node) => [node.id, node]));
    return ensembleGeom(
      ensemble,
      ensemble.members.map((id) => byId.get(id)?.name ?? "?"),
    );
  }

  /** The port point of an endpoint, in plate units — null for a grouped member. */
  private portOf(id: string, side: "left" | "right"): Pt | null {
    const state = this.state;
    if (state === null) {
      return null;
    }
    const grouped = new Set(state.ensembles.flatMap((ensemble) => ensemble.members));
    if (grouped.has(id)) {
      return null;
    }
    const node = state.nodes.find((entry) => entry.id === id);
    if (node !== undefined) {
      const dx = side === "left" ? -NODE_W / 2 : NODE_W / 2;
      return { x: (node.x + dx) / SCALE, y: node.y / SCALE };
    }
    const ensemble = state.ensembles.find((entry) => entry.id === id);
    if (ensemble === undefined) {
      return null;
    }
    const geom = this.geomOf(ensemble);
    const dx = side === "left" ? -geom.w / 2 : geom.w / 2;
    return { x: ensemble.x / SCALE + dx, y: ensemble.y / SCALE };
  }

  /** Rebuild the world group: edges, the rubber line, ensembles, nodes. */
  render(): void {
    const state = this.state;
    if (state === null) {
      this.world.innerHTML = "";
      return;
    }
    const grouped = new Set(state.ensembles.flatMap((ensemble) => ensemble.members));
    const drawn = state.edges.flatMap((edge) => {
      const a = this.portOf(edge.from, "right");
      const b = this.portOf(edge.to, "left");
      return a === null || b === null ? [] : [{ edge, cls: classOf(edge.condition), a, b }];
    });
    drawn.sort(
      (left, right) =>
        EDGE_ORDER[left.cls] - EDGE_ORDER[right.cls] ||
        (left.a.x - right.a.x) ||
        (left.a.y - right.a.y),
    );
    const arcIndex = new Map<string, number>();
    const edges = drawn
      .map(({ edge, cls, a, b }) => {
        const ensembled =
          state.ensembles.some((ensemble) => ensemble.id === edge.from) ||
          state.ensembles.some((ensemble) => ensemble.id === edge.to);
        const fromId = ensembled && state.ensembles.some((e) => e.id === edge.from)
          ? `ensemble:${edge.from}`
          : edge.from;
        const toId = ensembled && state.ensembles.some((e) => e.id === edge.to)
          ? `ensemble:${edge.to}`
          : edge.to;
        const forceArc = forceArcOf(cls, fromId, toId);
        let lift = 0;
        const arcs = forceArc || (cls === "fail" && Math.abs(b.y - a.y) <= 6);
        if (arcs) {
          lift = (arcIndex.get(edge.to) ?? 0) * LIFT_STEP;
          arcIndex.set(edge.to, (arcIndex.get(edge.to) ?? 0) + 1);
        }
        const d = edgePath(a, b, cls === "fail", lift, forceArc);
        const selected = this.selected.edge === edge.id;
        return (
          `<g class="edge ${cls}${selected ? " selected" : ""}" data-edge="${edge.id}">` +
          `<path class="edge-hit" d="${d}" transform="scale(${SCALE})"/>` +
          `<path class="edge-line" d="${d}" transform="scale(${SCALE})"/>` +
          `</g>`
        );
      })
      .join("");
    const ensembles = state.ensembles.map((ensemble) => this.ensembleMarkup(ensemble)).join("");
    const nodes = state.nodes
      .filter((node) => !grouped.has(node.id))
      .map((node) => this.nodeMarkup(node))
      .join("");
    this.world.innerHTML = edges + this.rubber() + ensembles + nodes;
  }

  /** The dragging connection line, while a port drag is in flight. */
  private rubber(): string {
    if (this.interaction?.kind !== "connect") {
      return "";
    }
    const a = this.portOf(this.interaction.from, "right");
    if (a === null) {
      return "";
    }
    const at = this.toWorld(this.interaction.cx, this.interaction.cy);
    const b: Pt = { x: at.x / SCALE, y: at.y / SCALE };
    return `<path class="rubber" d="${edgePath(a, b, false)}" transform="scale(${SCALE})"/>`;
  }

  /** The kind icon: a small mark at the box's left. */
  private kindMark(kind: string): string {
    switch (kind) {
      case "agent":
        return `<circle class="kind-mark solid" cx="-52" cy="0" r="6"/>`;
      case "check":
        return `<rect class="kind-mark" x="-58" y="-6" width="12" height="12" rx="2"/>`;
      case "gate":
      case "router":
        return `<rect class="kind-mark" x="-58" y="-6" width="12" height="12" rx="1" transform="rotate(45 -52 0)"/>`;
      case "spec":
        return `<path class="kind-mark solid" d="M-58 -7 L-46 0 L-58 7 Z"/>`;
      default:
        return `<circle class="kind-mark" cx="-52" cy="0" r="6"/>`;
    }
  }

  /** One node: the box, its icon and name, and its ports. */
  private nodeMarkup(node: EditorNode): string {
    const fixed = node.id === SPEC_ID || node.id === NEXT_ID;
    const selected =
      this.selected.node === node.id || this.selected.multi.includes(node.id);
    const armedOut = this.pending === node.id ? " armed" : "";
    const input =
      node.id === SPEC_ID
        ? ""
        : `<circle class="port-hit" data-input="${node.id}" cx="${-NODE_W / 2}" cy="0" r="13"/>` +
          `<circle class="port-in" cx="${-NODE_W / 2}" cy="0" r="6"/>`;
    const output =
      node.id === NEXT_ID
        ? ""
        : `<circle class="port-hit" data-output="${node.id}" cx="${NODE_W / 2}" cy="0" r="13"/>` +
          `<circle class="port-out${armedOut}" cx="${NODE_W / 2}" cy="0" r="6"/>`;
    return (
      `<g class="node kind-${escape(node.kind)}${fixed ? " fixed" : ""}${selected ? " selected" : ""}" ` +
      `data-node="${node.id}" transform="translate(${node.x} ${node.y})">` +
      `<title>${escape(node.name)} (${escape(node.kind)})</title>` +
      `<rect class="node-box" x="${-NODE_W / 2}" y="${-NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="8"/>` +
      this.kindMark(node.kind) +
      `<text class="node-name" x="-38" y="0" dy="4.5">${escape(plateLabel(node.name))}</text>` +
      input +
      output +
      `</g>`
    );
  }

  /** One ensemble: the plate's dashed box, title lines and member chips. */
  private ensembleMarkup(ensemble: EditorEnsemble): string {
    const geom = this.geomOf(ensemble);
    const selected = this.selected.ensemble === ensemble.id;
    const byId = new Map((this.state?.nodes ?? []).map((node) => [node.id, node]));
    const members = ensemble.members
      .map((id, index) => {
        const name = byId.get(id)?.name ?? "?";
        const y = -geom.h / 2 + GROUP_HEAD + index * MEMBER_DY + MEMBER_DY / 2;
        const marked =
          this.selected.node === id || this.selected.multi.includes(id) ? " selected" : "";
        return (
          `<g class="member${marked}" data-node="${id}">` +
          `<title>${escape(name)} (agent)</title>` +
          `<rect class="member-shape" x="${-MEMBER_GEOM.w / 2}" y="${y - MEMBER_GEOM.h / 2}" ` +
          `width="${MEMBER_GEOM.w}" height="${MEMBER_GEOM.h}" rx="1"/>` +
          `<text class="member-label" x="0" y="${y}" dy="0.7">${escape(geom.labels[index] ?? "?")}</text>` +
          `</g>`
        );
      })
      .join("");
    const armedOut = this.pending === ensemble.id ? " armed" : "";
    return (
      `<g class="ensemble${selected ? " selected" : ""}" data-ensemble="${ensemble.id}" ` +
      `transform="translate(${ensemble.x} ${ensemble.y}) scale(${SCALE})">` +
      `<title>${escape(ensemble.name)} (${escape(ensemble.kind)} ensemble)</title>` +
      `<rect class="group-box" x="${-geom.w / 2}" y="${-geom.h / 2}" width="${geom.w}" height="${geom.h}" rx="2"/>` +
      `<rect class="ensemble-hit" x="${-geom.w / 2}" y="${-geom.h / 2}" width="${geom.w}" height="${geom.h}"/>` +
      `<text class="group-title" x="${-geom.w / 2 + 2}" y="${-geom.h / 2 + 3.4}">${escape(geom.title)}</text>` +
      `<text class="group-subtitle" x="${-geom.w / 2 + 2}" y="${-geom.h / 2 + 5.8}">${escape(geom.subtitle)}</text>` +
      members +
      `<circle class="port-hit" data-input="${ensemble.id}" cx="${-geom.w / 2}" cy="0" r="1.9"/>` +
      `<circle class="port-in" cx="${-geom.w / 2}" cy="0" r="0.9"/>` +
      `<circle class="port-hit" data-output="${ensemble.id}" cx="${geom.w / 2}" cy="0" r="1.9"/>` +
      `<circle class="port-out${armedOut}" cx="${geom.w / 2}" cy="0" r="0.9"/>` +
      `</g>`
    );
  }

  private applyView(): void {
    this.world.setAttribute("transform", `translate(${this.view.x} ${this.view.y}) scale(${this.view.z})`);
  }

  /** Screen pixels inside the svg → world point, under the current view. */
  private toWorld(px: number, py: number): Pt {
    return { x: (px - this.view.x) / this.view.z, y: (py - this.view.y) / this.view.z };
  }

  private down(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2 && (this.interaction === null || this.interaction.kind === "pan")) {
      this.startPinch();
      return;
    }
    if (this.interaction !== null || this.pointers.size > 1) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const output = target?.closest("[data-output]") ?? null;
    const input = target?.closest("[data-input]") ?? null;
    // An input tap completes a tap-armed output: the touch wiring path.
    if (input !== null && this.pending !== null) {
      const to = input.getAttribute("data-input") ?? "";
      if (to !== "" && to !== this.pending) {
        this.hooks.connect(this.pending, to, { x: event.clientX, y: event.clientY });
        this.pending = null;
        this.render();
      }
      return;
    }
    if (output !== null) {
      const from = output.getAttribute("data-output") ?? "";
      if (from === "" || (this.state?.nodes.some((n) => n.id === NEXT_ID && n.id === from) === true)) {
        return;
      }
      this.svg.setPointerCapture(event.pointerId);
      this.interaction = {
        kind: "connect",
        pointerId: event.pointerId,
        from,
        cx: event.clientX,
        cy: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      this.render();
      return;
    }
    if (input !== null) {
      return;
    }
    const chip = target?.closest("g.member") ?? null;
    const nodeEl = target?.closest("g.node") ?? null;
    const ensembleEl = target?.closest("g.ensemble") ?? null;
    const edgeEl = target?.closest("[data-edge]") ?? null;
    if (chip !== null) {
      this.hooks.pick({ kind: "node", id: chip.getAttribute("data-node") }, event.shiftKey);
      return;
    }
    if (nodeEl !== null) {
      const id = nodeEl.getAttribute("data-node") ?? "";
      this.hooks.pick({ kind: "node", id }, event.shiftKey);
      if (event.shiftKey) {
        return;
      }
      const node = this.state?.nodes.find((candidate) => candidate.id === id);
      if (node === undefined) {
        return;
      }
      this.svg.setPointerCapture(event.pointerId);
      this.interaction = {
        kind: "drag",
        pointerId: event.pointerId,
        id,
        ensemble: false,
        startX: event.clientX,
        startY: event.clientY,
        origX: node.x,
        origY: node.y,
        moved: false,
      };
      return;
    }
    if (ensembleEl !== null) {
      const id = ensembleEl.getAttribute("data-ensemble") ?? "";
      this.hooks.pick({ kind: "ensemble", id }, event.shiftKey);
      if (event.shiftKey) {
        return;
      }
      const ensemble = this.state?.ensembles.find((candidate) => candidate.id === id);
      if (ensemble === undefined) {
        return;
      }
      this.svg.setPointerCapture(event.pointerId);
      this.interaction = {
        kind: "drag",
        pointerId: event.pointerId,
        id,
        ensemble: true,
        startX: event.clientX,
        startY: event.clientY,
        origX: ensemble.x,
        origY: ensemble.y,
        moved: false,
      };
      return;
    }
    if (edgeEl !== null) {
      this.hooks.pick({ kind: "edge", id: edgeEl.getAttribute("data-edge") }, event.shiftKey);
      return;
    }
    this.svg.setPointerCapture(event.pointerId);
    this.interaction = {
      kind: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: this.view.x,
      viewY: this.view.y,
      moved: false,
    };
  }

  private move(event: PointerEvent): void {
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (this.pinch !== null) {
      this.updatePinch();
      return;
    }
    const interaction = this.interaction;
    if (interaction === null || interaction.pointerId !== event.pointerId) {
      return;
    }
    if (interaction.kind === "pan") {
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      interaction.moved = interaction.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3;
      this.view = { ...this.view, x: interaction.viewX + dx, y: interaction.viewY + dy };
      this.applyView();
      return;
    }
    if (interaction.kind === "drag") {
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      interaction.moved = interaction.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3;
      if (interaction.ensemble) {
        const ensemble = this.state?.ensembles.find((candidate) => candidate.id === interaction.id);
        if (ensemble === undefined) {
          return;
        }
        ensemble.x = interaction.origX + dx / this.view.z;
        ensemble.y = interaction.origY + dy / this.view.z;
      } else {
        const node = this.state?.nodes.find((candidate) => candidate.id === interaction.id);
        if (node === undefined) {
          return;
        }
        node.x = interaction.origX + dx / this.view.z;
        node.y = interaction.origY + dy / this.view.z;
      }
      this.render();
      return;
    }
    const moved =
      Math.abs(event.clientX - interaction.startX) > 4 ||
      Math.abs(event.clientY - interaction.startY) > 4;
    interaction.moved = interaction.moved || moved;
    interaction.cx = event.clientX;
    interaction.cy = event.clientY;
    this.render();
  }

  private up(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.pinch !== null) {
      if (this.pointers.size < 2) {
        this.pinch = null;
        this.interaction = null;
      }
      return;
    }
    const interaction = this.interaction;
    if (interaction === null || interaction.pointerId !== event.pointerId) {
      return;
    }
    this.interaction = null;
    try {
      this.svg.releasePointerCapture(event.pointerId);
    } catch {
      // The capture may already be gone; nothing depends on it.
    }
    if (interaction.kind === "pan") {
      if (!interaction.moved) {
        this.pending = null;
        this.hooks.pick({ kind: "background", id: null }, false);
        this.render();
      }
      return;
    }
    if (interaction.kind === "drag") {
      if (interaction.moved) {
        this.hooks.changed();
      }
      return;
    }
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const input = element instanceof Element ? element.closest("[data-input]") : null;
    const to = input?.getAttribute("data-input") ?? null;
    if (to !== null && to !== interaction.from && this.hasEndpoint(to)) {
      this.pending = null;
      this.hooks.connect(interaction.from, to, { x: event.clientX, y: event.clientY });
      this.render();
      return;
    }
    // A tap on an output arm it; a drag to nowhere disarms.
    if (!interaction.moved) {
      this.pending = this.pending === interaction.from ? null : interaction.from;
    } else {
      this.pending = null;
    }
    this.render();
  }

  private cancel(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    const interaction = this.interaction;
    if (this.pinch !== null && this.pointers.size < 2) {
      this.pinch = null;
    }
    if (interaction === null || interaction.pointerId !== event.pointerId) {
      return;
    }
    this.interaction = null;
    if (interaction.kind === "connect") {
      this.render();
    }
  }

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (a === undefined || b === undefined) {
      return;
    }
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (dist < 24) {
      return;
    }
    this.interaction = null;
    const rect = this.svg.getBoundingClientRect();
    const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    this.pinch = { d0: dist, z0: this.view.z, worldMid: this.toWorld(mid.x, mid.y) };
  }

  private updatePinch(): void {
    const pinch = this.pinch;
    const [a, b] = [...this.pointers.values()];
    if (pinch === null || a === undefined || b === undefined) {
      return;
    }
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (dist <= 0) {
      return;
    }
    const rect = this.svg.getBoundingClientRect();
    const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    const z = clampZoom(pinch.z0 * (dist / pinch.d0));
    this.view = { x: mid.x - pinch.worldMid.x * z, y: mid.y - pinch.worldMid.y * z, z };
    this.applyView();
  }
}
