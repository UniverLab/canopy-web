// SPDX-License-Identifier: Apache-2.0
// The Graphs tab of the home screen: one row per graph the host reports —
// name, status chip with icon and word, done/total with a thin progress
// bar, the current spec and the workdir — plus the status vocabulary the
// graph view's header reuses. Read-only: a row opens the graph, nothing
// here pauses, continues or resets anything.

import { icon } from "./icons-dom.js";
import type { IconName } from "./icons-dom.js";
import type { GraphSummary, SpecStatus } from "./protocol.js";

/** The word the chip shows: a blocked graph reads blocked, not paused. */
export function graphStatusWord(summary: Pick<GraphSummary, "status" | "blocked">): string {
  if (summary.blocked) {
    return "blocked";
  }
  return summary.status === "pausing" ? "paused" : summary.status;
}

const STATUS_ICON: Record<string, IconName> = {
  running: "loader",
  paused: "pause",
  failed: "x",
  completed: "check",
  blocked: "triangleAlert",
};

/** The chip's icon: a spinner while it runs, an alert while it is blocked. */
export function graphStatusIcon(word: string): IconName {
  return STATUS_ICON[word] ?? "circle";
}

/** The status chip: icon plus word, never colour alone. */
export function statusChip(summary: Pick<GraphSummary, "status" | "blocked">): string {
  const word = graphStatusWord(summary);
  const spin = word === "running" ? " chip-spin" : "";
  return (
    `<span class="status-chip${spin}" data-status="${word}" title="${word}">` +
    `${icon(graphStatusIcon(word))}<span class="status-word">${word}</span></span>`
  );
}

/** One checklist mark: its icon and the word behind the icon. */
export interface SpecMark {
  icon: IconName;
  label: string;
}

const SPEC_MARKS: Record<SpecStatus, SpecMark> = {
  completed: { icon: "check", label: "completed" },
  running: { icon: "circleDot", label: "running" },
  failed: { icon: "x", label: "failed" },
  pending: { icon: "circle", label: "pending" },
};

/** The icon and label the checklist draws for a spec status. */
export function specMark(status: SpecStatus): SpecMark {
  return SPEC_MARKS[status];
}

export interface GraphsListCallbacks {
  onOpen: (id: string, name: string) => void;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The done/total fraction and the bar behind it, as one fragment. */
function progress(summary: GraphSummary): string {
  const total = summary.total <= 0 ? 0 : summary.total;
  const done = Math.min(summary.done, total);
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    `<span class="graph-count">${summary.done}/${summary.total}</span>` +
    `<span class="progress" role="presentation">` +
    `<span class="progress-fill" style="width:${percent}%"></span></span>`
  );
}

function row(summary: GraphSummary): string {
  const spec = summary.current_spec === "" ? "" : `<span class="graph-spec">${esc(summary.current_spec)}</span>`;
  const workdir = summary.workdir === "" ? "" : `<span class="graph-workdir">${esc(summary.workdir)}</span>`;
  return (
    `<li><button type="button" class="graph-row" data-graph="${esc(summary.id)}">` +
    `<span class="graph-main">` +
    `<span class="graph-name">${esc(summary.name || summary.id)}</span>` +
    spec +
    workdir +
    `</span>` +
    `<span class="graph-side">` +
    statusChip(summary) +
    `<span class="graph-progress">${progress(summary)}</span>` +
    `</span></button></li>`
  );
}

/** Paint the Graphs tab into `root`; no state, no timers, no network. */
export function renderGraphsList(
  root: HTMLElement,
  items: GraphSummary[],
  callbacks: GraphsListCallbacks,
): void {
  root.innerHTML =
    `<div class="sessions-head"><h2>Graphs</h2></div>` +
    (items.length === 0
      ? `<p class="empty">No graphs running on this machine</p>`
      : `<ul class="graph-list">${items.map(row).join("")}</ul>`);
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-graph]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-graph");
      if (id) {
        callbacks.onOpen(id, button.querySelector(".graph-name")?.textContent ?? id);
      }
    });
  }
}
