// SPDX-License-Identifier: Apache-2.0
/**
 * The editor canvas: one SVG in the plate's vocabulary, driven by pointer
 * events so mouse and touch behave alike.
 *
 * Coordinates: state carries world pixels — plate units × `SCALE` at zoom
 * 1 (the plate itself draws at `PLATE_SCALE` 5; an editing surface needs
 * bigger targets). Each node renders as `translate(x y) scale(12)` over
 * its plate geometry, edges call the plate's own `edgePath` in units
 * inside `transform="scale(12)"` — so shapes, curves, the fail arc's
 * lift, the label metrics and the colours are the plate's constants,
 * never re-derived here. The paint rules live in a `<style>` the canvas
 * builds once from `PALETTE`, so there is not one duplicated hex in the
 * stylesheet.
 *
 * Interactions: dragging a node moves it; dragging the background pans;
 * the wheel and two fingers pinch-zoom (buttons live in the shell and
 * call `zoomBy`/`fit`); dragging from a node's output handle lands a
 * connection, which the app turns into a condition through its `connect`
 * hook. Selection is announced through `select`; a finished drag through
 * `changed`, which is where the app autosaves.
 */
import { GEOM, PALETTE, TYPE, edgePath, type Pt } from "../../../../packages/plate/vocabulary.js";
import { LIFT_STEP, PLATE_SCALE, labelHalfOf, nodeBottom, plateLabel } from "../../../../packages/plate/layout.js";
import { classOf, type EdgeClass } from "../../../../packages/plate/document.js";
import { shapeOfKind } from "./kinds.js";
import type { CanvasNode, EditorState } from "./state.js";

/** Plate units in canvas pixels at zoom 1. */
export const SCALE = 12;

/** A node label, in units: the plate's own rendered label size, reused. */
const LABEL_SIZE = (TYPE.label * PLATE_SCALE) / SCALE;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;

/** Draw order per class, the plate's: error, pass, then fail on top. */
const EDGE_ORDER: Record<EdgeClass, number> = { error: 0, order: 1, pass: 2, fail: 3 };

/** What the canvas tells its owner. */
export interface CanvasHooks {
  /** A press decided a selection: a node id, an edge id, or null for the background. */
  select(nodeId: string | null, edgeId: string | null): void;
  /** A handle drag landed on another node; the point is in client pixels, for anchoring the chooser. */
  connect(fromId: string, toId: string, at: { x: number; y: number }): void;
  /** A node drag finished: the document changed and may be autosaved. */
  changed(): void;
}

type Pan = { kind: "pan"; pointerId: number; startX: number; startY: number; viewX: number; viewY: number; moved: boolean };
type Drag = { kind: "drag"; pointerId: number; id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean };
type Connect = { kind: "connect"; pointerId: number; from: string; cx: number; cy: number };
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
    `.editor-svg .node .shape{stroke-width:.18}` +
    `.editor-svg .node.shape-agent .shape{fill:${mix};stroke:var(--canopy,#00a9a0)}` +
    `.editor-svg .node.shape-check .shape,.editor-svg .node.shape-gate .shape{fill:${PALETTE.gateFill};stroke:${PALETTE.gateStroke}}` +
    `.editor-svg .label{fill:${PALETTE.label}}` +
    `.editor-svg .node.selected .shape{stroke:var(--teal,#00a9a0);stroke-width:.3}` +
    `.editor-svg .handle-hit{fill:transparent;cursor:crosshair}` +
    `.editor-svg .handle-dot{fill:var(--teal,#00a9a0);stroke:${PALETTE.deep};stroke-width:.12;pointer-events:none;opacity:.55}` +
    `.editor-svg .node:hover .handle-dot,.editor-svg .node.selected .handle-dot{opacity:1}` +
    `.editor-svg .edge-line{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.14;opacity:.85}` +
    `.editor-svg .edge.fail .edge-line{stroke:${PALETTE.red};stroke-dasharray:1 .8}` +
    `.editor-svg .edge.error .edge-line{stroke:currentColor;stroke-width:.1;stroke-dasharray:.4 .7;opacity:.5}` +
    `.editor-svg .edge.selected .edge-line{stroke-width:.26;opacity:1}` +
    `.editor-svg .edge-hit{fill:none;stroke:transparent;stroke-width:1.6;pointer-events:stroke;cursor:pointer}` +
    `.editor-svg .rubber{fill:none;stroke:var(--teal,#00a9a0);stroke-width:.12;stroke-dasharray:.6 .5;pointer-events:none}`
  );
}

export class Canvas {
  private readonly svg: SVGSVGElement;
  private readonly world: SVGGElement;
  private state: EditorState | null = null;
  private view: View = { x: 0, y: 0, z: 1 };
  private selected: { node: string | null; edge: string | null } = { node: null, edge: null };
  private interaction: Interaction = null;
  private pinch: { d0: number; z0: number; worldMid: Pt } | null = null;
  private readonly pointers = new Map<number, Pt>();

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
      this.selected = { node: null, edge: null };
    }
    this.render();
  }

  /** Highlight a selection without touching anything else. */
  setSelection(nodeId: string | null, edgeId: string | null): void {
    this.selected = { node: nodeId, edge: edgeId };
    this.render();
  }

  /** The world point at the middle of the visible canvas — where new nodes land. */
  worldCenter(): Pt {
    const rect = this.svg.getBoundingClientRect();
    return this.toWorld(rect.width / 2, rect.height / 2);
  }

  /**
   * True when the node sits inside the view with room for its handle and
   * its label — the caller's signal to `fit()` after dropping one in.
   */
  isVisible(node: CanvasNode): boolean {
    const rect = this.svg.getBoundingClientRect();
    const margin = 44;
    const x = this.view.x + node.x * this.view.z;
    const y = this.view.y + node.y * this.view.z;
    return (
      x >= margin && x <= rect.width - margin && y >= margin && y <= rect.height - margin
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

  /** Frame every node with a comfortable margin (or reset an empty canvas). */
  fit(): void {
    const rect = this.svg.getBoundingClientRect();
    const nodes = this.state?.nodes ?? [];
    if (nodes.length === 0 || rect.width === 0) {
      this.view = { x: 0, y: 0, z: 1 };
      this.applyView();
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of nodes) {
      const geom = GEOM[shapeOfKind(node.kind)];
      const halfW = (Math.max(labelHalfOf(node.name, null), geom.w) * SCALE) / 2;
      const halfH = ((geom.rot === 0 ? geom.h : geom.w * Math.SQRT2) * SCALE) / 2;
      minX = Math.min(minX, node.x - halfW);
      maxX = Math.max(maxX, node.x + halfW);
      minY = Math.min(minY, node.y - halfH);
      maxY = Math.max(maxY, node.y + nodeBottom(0, null) * SCALE);
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

  /** Rebuild the world group from the state: edges, the rubber line, nodes. */
  render(): void {
    const state = this.state;
    if (state === null) {
      this.world.innerHTML = "";
      return;
    }
    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    const drawn = state.edges.flatMap((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      return from === undefined || to === undefined
        ? []
        : [{ edge, cls: classOf(edge.condition), from, to }];
    });
    drawn.sort(
      (left, right) =>
        EDGE_ORDER[left.cls] - EDGE_ORDER[right.cls] ||
        (left.from.name < right.from.name ? -1 : left.from.name > right.from.name ? 1 : 0) ||
        (left.to.name < right.to.name ? -1 : left.to.name > right.to.name ? 1 : 0),
    );
    // Same-row fail arcs stack, exactly like the plate's: one lift per extra
    // back edge into the same target.
    const arcIndex = new Map<string, number>();
    const edges = drawn
      .map(({ edge, cls, from, to }) => {
        const a: Pt = { x: from.x / SCALE, y: from.y / SCALE };
        const b: Pt = { x: to.x / SCALE, y: to.y / SCALE };
        let lift = 0;
        if (cls === "fail" && Math.abs(b.y - a.y) <= 6) {
          lift = (arcIndex.get(edge.to) ?? 0) * LIFT_STEP;
          arcIndex.set(edge.to, (arcIndex.get(edge.to) ?? 0) + 1);
        }
        const d = edgePath(a, b, cls === "fail", lift);
        const selected = this.selected.edge === edge.id;
        return (
          `<g class="edge ${cls}${selected ? " selected" : ""}" data-edge="${edge.id}">` +
          `<path class="edge-hit" d="${d}" transform="scale(${SCALE})"/>` +
          `<path class="edge-line" d="${d}" transform="scale(${SCALE})"/>` +
          `</g>`
        );
      })
      .join("");
    const nodes = state.nodes.map((node) => this.nodeMarkup(node)).join("");
    this.world.innerHTML = edges + this.rubber(byId) + nodes;
  }

  /** The dragging connection line, while a handle drag is in flight. */
  private rubber(byId: ReadonlyMap<string, CanvasNode>): string {
    if (this.interaction?.kind !== "connect") {
      return "";
    }
    const from = byId.get(this.interaction.from);
    if (from === undefined) {
      return "";
    }
    const at = this.toWorld(this.interaction.cx, this.interaction.cy);
    const a: Pt = { x: from.x / SCALE, y: from.y / SCALE };
    const b: Pt = { x: at.x / SCALE, y: at.y / SCALE };
    return `<path class="rubber" d="${edgePath(a, b, false)}" transform="scale(${SCALE})"/>`;
  }

  /** One node: plate geometry, the truncated label, the output handle. */
  private nodeMarkup(node: CanvasNode): string {
    const geom = GEOM[shapeOfKind(node.kind)];
    const rotate = geom.rot === 0 ? "" : ` transform="rotate(${geom.rot})"`;
    const handleX = geom.rot === 0 ? geom.w / 2 : (geom.w * Math.SQRT2) / 2;
    const selected = this.selected.node === node.id;
    return (
      `<g class="node shape-${shapeOfKind(node.kind)}${selected ? " selected" : ""}" data-node="${node.id}" ` +
      `transform="translate(${node.x} ${node.y}) scale(${SCALE})">` +
      `<title>${escape(node.name)} (${escape(node.kind)})</title>` +
      `<rect class="shape" x="${-geom.w / 2}" y="${-geom.h / 2}" width="${geom.w}" height="${geom.h}" rx="${geom.rx}"${rotate}/>` +
      `<text class="label" y="${TYPE.labelDy}" font-size="${LABEL_SIZE}" text-anchor="middle">${escape(plateLabel(node.name))}</text>` +
      `<circle class="handle-hit" data-handle="${node.id}" cx="${handleX}" cy="0" r="1.9"/>` +
      `<circle class="handle-dot" cx="${handleX}" cy="0" r="0.9"/>` +
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
    const nodeEl = target?.closest("[data-node]") ?? null;
    const handle = target?.closest("[data-handle]") ?? null;
    const edgeEl = target?.closest("[data-edge]") ?? null;
    if (handle !== null && nodeEl !== null) {
      this.svg.setPointerCapture(event.pointerId);
      this.interaction = {
        kind: "connect",
        pointerId: event.pointerId,
        from: nodeEl.getAttribute("data-node") ?? "",
        cx: event.clientX,
        cy: event.clientY,
      };
      this.render();
      return;
    }
    if (nodeEl !== null) {
      const id = nodeEl.getAttribute("data-node") ?? "";
      const node = this.state?.nodes.find((candidate) => candidate.id === id);
      if (node === undefined) {
        return;
      }
      this.hooks.select(id, null);
      this.svg.setPointerCapture(event.pointerId);
      this.interaction = {
        kind: "drag",
        pointerId: event.pointerId,
        id,
        startX: event.clientX,
        startY: event.clientY,
        origX: node.x,
        origY: node.y,
        moved: false,
      };
      return;
    }
    if (edgeEl !== null) {
      this.hooks.select(null, edgeEl.getAttribute("data-edge"));
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
      const node = this.state?.nodes.find((candidate) => candidate.id === interaction.id);
      if (node === undefined) {
        return;
      }
      node.x = interaction.origX + dx / this.view.z;
      node.y = interaction.origY + dy / this.view.z;
      this.render();
      return;
    }
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
        this.hooks.select(null, null);
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
    const nodeEl = element instanceof Element ? element.closest("[data-node]") : null;
    const to = nodeEl?.getAttribute("data-node") ?? null;
    if (to !== null && to !== interaction.from && this.state?.nodes.some((node) => node.id === to) === true) {
      this.hooks.connect(interaction.from, to, { x: event.clientX, y: event.clientY });
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
