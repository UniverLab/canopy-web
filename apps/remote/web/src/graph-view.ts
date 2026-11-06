// SPDX-License-Identifier: Apache-2.0
// The graph view: the header (name, status chip, done/total, blocker
// text), the plate on the black stage — repainted from every
// `graph_state` push through one pan-and-zoom viewer that keeps its view —
// and the spec checklist below it in queue order. Read-only, and through a
// disconnect it keeps the last state with a "disconnected — last update"
// note. The shell owns the watches; this module only paints what the store
// holds.

import type { GraphDocument } from "../../../../packages/plate/document.js";
import { renderPlate } from "../../../../packages/plate/render.js";
import type { PlateState } from "../../../../packages/plate/render.js";
import { mountPlateViewer, type PlateLabels, type PlateViewer } from "../../../../packages/plate/viewport.js";
import { REMOTE_FOOTER } from "./footer.js";
import { specMark, statusChip } from "./graphs-list.js";
import { icon } from "./icons-dom.js";
import type { GraphControlAction } from "./protocol.js";
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
  /** The failed watch's message, shown until the drawing arrives. */
  watchError?: string | null;
  connected: boolean;
  /** The host speaks graph_control: hello carried it for this device. */
  canControl: boolean;
  /** A pause/continue request is in flight: the button stays disabled. */
  controlPending: boolean;
  /** The last control request's failure, cleared by the next success. */
  controlError: string | null;
  /** Ask the host to pause or continue; the reply repaints the button. */
  onControl: (action: GraphControlAction) => void;
  onBack: () => void;
}

/** The catalogue's words for the three overlaid controls. */
const PLATE_LABELS: PlateLabels = {
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  fit: "Fit",
  fitLabel: "Fit the graph",
};

/** The mounted viewer, if the stage currently holds a readable drawing. */
let viewer: PlateViewer | null = null;

/** The running spec row already scrolled into view; null until it changes. */
let scrolledRunning: string | null = null;

/** Take the viewer down: leaving the view, or a stage with no drawing. */
export function disposeGraphView(): void {
  viewer?.dispose();
  viewer = null;
}

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

/** The pause/continue control each live status offers, or null for none. */
export function controlForStatus(status: string): GraphControlAction | null {
  if (status === "running") {
    return "pause";
  }
  if (status === "paused" || status === "failed") {
    return "continue";
  }
  return null;
}

/** The plate's live overlay for a pushed state; none until one arrives. */
export function plateStateOf(state: GraphState | null): PlateState | undefined {
  return state === null
    ? undefined
    : { nodes: state.nodes, current: state.current_node ?? undefined };
}

/** The stage's content: the drawing's svg, or the line that holds it. */
type Stage = { svg: string } | { wait: string };

/** The plate with the live overlay; a missing drawing holds the stage. */
function stageOf(args: GraphViewArgs): Stage {
  if (args.doc === null || args.doc === undefined) {
    if (args.watchError !== null && args.watchError !== undefined) {
      return { wait: `<p class="graph-wait">Could not open this graph: ${esc(args.watchError)}</p>` };
    }
    return { wait: `<p class="graph-wait">Waiting for the drawing…</p>` };
  }
  const svg = renderPlate(args.doc as GraphDocument, plateStateOf(args.state));
  return svg === ""
    ? { wait: `<p class="graph-wait">This drawing could not be read.</p>` }
    : { svg };
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
    return `<p class="empty">Waiting for the specs…</p>`;
  }
  if (state.specs.length === 0) {
    return `<p class="empty">No specs in the queue.</p>`;
  }
  return state.specs.map(specRow).join("");
}

/** The row of one spec, matched exactly by attribute — never through a
 * selector built from the id, which the host controls (a newline in it
 * would make querySelector throw inside paint). */
function specRowById(list: HTMLElement, id: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>(".spec-row")) {
    if (row.getAttribute("data-spec") === id) {
      return row;
    }
  }
  return null;
}

/** Scroll the running row into view the moment it changes, never again. */
function scrollRunning(list: HTMLElement, state: GraphState | null): void {
  const running = state?.specs.find((spec) => spec.status === "running") ?? null;
  const id = running?.id ?? null;
  if (id !== null && id !== scrolledRunning) {
    const row = specRowById(list, id);
    try {
      row?.scrollIntoView({ block: "nearest" });
    } catch {
      /* a DOM without layout (tests) simply keeps its scroll */
    }
  }
  scrolledRunning = id;
}

/** Paint the stage: the viewer holds a drawing, or a line holds the stage. */
function paintStage(stage: HTMLElement, args: GraphViewArgs): void {
  const next = stageOf(args);
  if ("wait" in next) {
    disposeGraphView();
    stage.innerHTML = next.wait;
    return;
  }
  // A live viewer swaps only the drawing, so a push never resets the view.
  if (viewer !== null) {
    viewer.replaceSvg(next.svg);
    return;
  }
  stage.innerHTML = `<figure class="plate" data-plate>${next.svg}</figure>`;
  const figure = stage.querySelector<HTMLElement>("figure.plate[data-plate]");
  viewer = figure === null ? null : mountPlateViewer(figure, PLATE_LABELS);
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
    // A refused pause or continue beats the disconnect line: it names
    // what just failed, and the next success clears it.
    const text =
      args.controlError !== null && args.controlError !== undefined && args.controlError !== ""
        ? args.controlError
        : args.connected || args.receivedAt === null
          ? ""
          : `disconnected — last update ${clockOf(args.receivedAt)}`;
    note.hidden = text === "";
    note.textContent = text;
  }
  const action = main.querySelector<HTMLButtonElement>("#graph-action");
  if (action) {
    // The control lives only here, never in the list rows: pause while
    // running, continue while parked or refused, nothing anywhere else —
    // and nothing at all against an older host. The button node itself
    // never swaps, so a push under a finger only repaints it.
    const status = args.state?.status ?? args.summary?.status ?? "";
    const visible =
      args.canControl === true &&
      (status === "running" || status === "pausing" || status === "paused" || status === "failed");
    action.hidden = !visible;
    if (visible) {
      const control = controlForStatus(status);
      action.dataset["action"] = control ?? "";
      action.disabled = args.controlPending === true || control === null;
      if (status === "pausing") {
        action.setAttribute("aria-label", "Pausing");
        action.innerHTML = `<span>Pausing...</span>`;
      } else if (control === "pause") {
        action.setAttribute("aria-label", "Pause the graph");
        action.innerHTML = `${icon("pause")}<span>Pause</span>`;
      } else {
        action.setAttribute("aria-label", "Continue the graph");
        action.innerHTML = `${icon("play")}<span>Continue</span>`;
      }
    }
  }
  const stage = main.querySelector<HTMLElement>("#graph-stage");
  if (stage) {
    paintStage(stage, args);
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
    `<button type="button" id="graph-action" hidden></button>` +
    `</div>` +
    `<p class="graph-blocker" id="graph-blocker" hidden></p>` +
    `<p class="graph-note" id="graph-note" hidden></p>` +
    `<div class="graph-stage" id="graph-stage"></div>` +
    `<h2>Specs</h2>` +
    `<ol class="spec-list" id="spec-list"></ol>` +
    `</main>` +
    REMOTE_FOOTER
  );
}

/** Mount the graph view (or update it in place when it is already up). */
export function renderGraphView(root: HTMLElement, args: GraphViewArgs): void {
  disposeGraphView();
  scrolledRunning = null;
  root.innerHTML = viewHtml(args);
  root.querySelector("#graph-back")?.addEventListener("click", () => args.onBack());
  // The painted action rides the button's dataset (repainted in place by
  // every push), so the listener attached once still asks for today's one.
  root.querySelector("#graph-action")?.addEventListener("click", (event) => {
    const target = event.currentTarget;
    const action = target instanceof HTMLElement ? target.dataset["action"] : undefined;
    if (action === "pause" || action === "continue") {
      args.onControl(action);
    }
  });
  const main = root.querySelector<HTMLElement>("main.graph-view");
  if (main) {
    paint(main, args);
  }
}

/** Repaint the mounted view; a no-op when the graph view is not open. */
export function updateGraphView(root: HTMLElement, args: GraphViewArgs): void {
  const main = root.querySelector<HTMLElement>("main.graph-view");
  if (main === null) {
    disposeGraphView();
    return;
  }
  paint(main, args);
}
