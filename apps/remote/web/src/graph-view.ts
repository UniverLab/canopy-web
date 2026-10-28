// SPDX-License-Identifier: Apache-2.0
// The graph view: the header (name, status chip, done/total, blocker
// text), the plate on the black stage — re-rendered from every
// `graph_state` push with its scroll position kept, vertical below 720 px
// and horizontal above — and the spec checklist below it in queue order.
// Read-only, and through a disconnect it keeps the last state with a
// "disconnected — last update" note. The shell owns the watches; this
// module only paints what the store holds.

import type { GraphDocument } from "../../../../packages/plate/document.js";
import { renderPlate } from "../../../../packages/plate/render.js";
import type { PlateState } from "../../../../packages/plate/render.js";
import { specMark, statusChip } from "./graphs-list.js";
import { icon } from "./icons-dom.js";
import type { GraphState, GraphSpecRow, GraphSummary } from "./protocol.js";

export interface GraphViewArgs {
  /** The shell's topbar markup; the view rides below it. */
  header: string;
  /** The connection banner, "" while nothing is wrong. */
  banner: string;
  id: string;
  name: string;
  summary: GraphSummary | null;
  /** The graph document behind the plate, or null before the watch reply. */
  doc: unknown;
  state: GraphState | null;
  /** When the last state arrived locally (epoch ms), or null. */
  receivedAt: number | null;
  connected: boolean;
  orientation: "vertical" | "horizontal";
  onBack: () => void;
}

/** The running spec row already scrolled into view; null until it changes. */
let scrolledRunning: string | null = null;

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** The plate's live overlay for a pushed state; none until one arrives. */
export function plateStateOf(state: GraphState | null): PlateState | undefined {
  return state === null
    ? undefined
    : { nodes: state.nodes, current: state.current_node ?? undefined };
}

/** The plate with the live overlay; a missing drawing holds the stage. */
function stageHtml(args: GraphViewArgs): string {
  if (args.doc === null || args.doc === undefined) {
    return `<p class="graph-wait">Waiting for the drawing…</p>`;
  }
  const html = renderPlate(args.doc as GraphDocument, args.orientation, plateStateOf(args.state));
  return html === "" ? `<p class="graph-wait">This drawing could not be read.</p>` : html;
}

function specRow(spec: GraphSpecRow): string {
  const mark = specMark(spec.status);
  const code = spec.code === null ? "" : `<span class="spec-code">${esc(spec.code)}</span>`;
  const attempts =
    spec.attempts > 1
      ? `<span class="spec-attempts" title="${spec.attempts} attempts">×${spec.attempts}</span>`
      : "";
  return (
    `<li class="spec-row" data-status="${spec.status}" data-spec="${esc(spec.id)}">` +
    `<span class="spec-mark" role="img" data-status="${spec.status}" ` +
    `title="${mark.label}" aria-label="${mark.label}">${icon(mark.icon)}</span>` +
    code +
    `<span class="spec-name">${esc(spec.name)}</span>` +
    attempts +
    `</li>`
  );
}

function checklistHtml(state: GraphState | null): string {
  if (state === null) {
    return `<p class="empty">No state yet.</p>`;
  }
  if (state.specs.length === 0) {
    return `<p class="empty">No specs in the queue.</p>`;
  }
  return state.specs.map(specRow).join("");
}

/** Scroll the running row into view the moment it changes, never again. */
function scrollRunning(list: HTMLElement, state: GraphState | null): void {
  const running = state?.specs.find((spec) => spec.status === "running") ?? null;
  const id = running?.id ?? null;
  if (id !== null && id !== scrolledRunning) {
    const row = list.querySelector<HTMLElement>(`[data-spec="${id.replace(/"/g, '\\"')}"]`);
    try {
      row?.scrollIntoView({ block: "nearest" });
    } catch {
      /* a DOM without layout (tests) simply keeps its scroll */
    }
  }
  scrolledRunning = id;
}

function paint(main: HTMLElement, args: GraphViewArgs): void {
  const summary = args.summary;
  const title = main.querySelector<HTMLElement>(".graph-title");
  if (title) {
    title.textContent = args.name;
  }
  // The header follows the live state once pushes arrive: the summary is
  // the watch reply's snapshot, the state ticks with every push.
  const live = args.state === null ? null : { status: args.state.status, blocked: args.state.blocked };
  const chip = main.querySelector<HTMLElement>("#graph-chip");
  if (chip) {
    const source = live ?? summary;
    chip.innerHTML = source === null ? "" : statusChip(source);
  }
  const count = main.querySelector<HTMLElement>("#graph-count");
  if (count) {
    const done =
      args.state === null
        ? (summary?.done ?? 0)
        : args.state.specs.filter((spec) => spec.status === "completed").length;
    const total = args.state === null ? (summary?.total ?? 0) : args.state.specs.length;
    count.hidden = summary === null && args.state === null;
    count.textContent = summary === null && args.state === null ? "" : `${done}/${total}`;
  }
  const blocked = (args.state?.blocked ?? summary?.blocked) === true;
  const blocker = main.querySelector<HTMLElement>("#graph-blocker");
  if (blocker) {
    const text = args.state?.blocker ?? "";
    blocker.hidden = !blocked;
    blocker.textContent = blocked && text === "" ? "blocked" : text;
  }
  const note = main.querySelector<HTMLElement>("#graph-note");
  if (note) {
    const text =
      args.connected || args.receivedAt === null
        ? ""
        : `disconnected — last update ${clockOf(args.receivedAt)}`;
    note.hidden = text === "";
    note.textContent = text;
  }
  const stage = main.querySelector<HTMLElement>("#graph-stage");
  if (stage) {
    const keep = { left: stage.scrollLeft, top: stage.scrollTop };
    stage.innerHTML = stageHtml(args);
    stage.scrollLeft = keep.left;
    stage.scrollTop = keep.top;
  }
  const list = main.querySelector<HTMLElement>("#spec-list");
  if (list) {
    list.innerHTML = checklistHtml(args.state);
    scrollRunning(list, args.state);
  }
}

function viewHtml(args: GraphViewArgs): string {
  return (
    `${args.header}` +
    `<main class="graph-view">` +
    args.banner +
    `<div class="graph-bar">` +
    `<button type="button" id="graph-back" aria-label="Back to graphs">${icon("chevronLeft")}</button>` +
    `<span class="graph-title">${esc(args.name)}</span>` +
    `<span id="graph-chip"></span>` +
    `<span class="graph-count" id="graph-count" hidden></span>` +
    `</div>` +
    `<p class="graph-blocker" id="graph-blocker" hidden></p>` +
    `<p class="graph-note" id="graph-note" hidden></p>` +
    `<div class="graph-stage" id="graph-stage"></div>` +
    `<h2>Checklist</h2>` +
    `<ol class="spec-list" id="spec-list"></ol>` +
    `</main>`
  );
}

/** Mount the graph view (or update it in place when it is already up). */
export function renderGraphView(root: HTMLElement, args: GraphViewArgs): void {
  scrolledRunning = null;
  root.innerHTML = viewHtml(args);
  root.querySelector("#graph-back")?.addEventListener("click", () => args.onBack());
  const main = root.querySelector<HTMLElement>("main.graph-view");
  if (main) {
    paint(main, args);
  }
}

/** Repaint the mounted view; a no-op when the graph view is not open. */
export function updateGraphView(root: HTMLElement, args: GraphViewArgs): void {
  const main = root.querySelector<HTMLElement>("main.graph-view");
  if (main === null) {
    return;
  }
  paint(main, args);
}
