// SPDX-License-Identifier: Apache-2.0
// The session list: a store fed by the sessions frame and the
// session_added / session_removed / exited events, plus the DOM renderer
// the Sessions route uses. An exited session keeps its row with a dead
// dot until the host removes it.

import { formatLastOutput, statusDot, workdirBasename } from "./protocol.js";
import type { SessionItem } from "./protocol.js";
import { icon } from "./icons-dom.js";

export class SessionStore {
  private readonly items = new Map<string, SessionItem>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  replace(items: SessionItem[]): void {
    this.items.clear();
    for (const item of items) {
      this.items.set(item.id, item);
    }
    this.notify();
  }

  add(item: SessionItem): void {
    this.items.set(item.id, item);
    this.notify();
  }

  remove(id: string): void {
    if (this.items.delete(id)) {
      this.notify();
    }
  }

  markExited(id: string): void {
    const item = this.items.get(id);
    if (item && item.status !== "exited") {
      this.items.set(id, { ...item, status: "exited" });
      this.notify();
    }
  }

  get(id: string): SessionItem | null {
    return this.items.get(id) ?? null;
  }

  list(): SessionItem[] {
    return [...this.items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get size(): number {
    return this.items.size;
  }
}

export interface SessionListCallbacks {
  onOpen: (id: string) => void;
  onNew: () => void;
}

/** The shelf's share of the list: counts and the host's own row. */
export interface SessionListShelf {
  enabled: boolean;
  hostCount: number;
  count: (id: string) => number;
  onOpenShelf: () => void;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// nowMs is injected so tests pin the relative times. The shelf argument
// is optional: without it (or without hello.features "shelf") the list
// carries no file affordance at all.
export function renderSessions(
  root: HTMLElement,
  items: SessionItem[],
  nowMs: number,
  callbacks: SessionListCallbacks,
  shelf?: SessionListShelf,
): void {
  const files = (id: string): string => {
    if (!shelf?.enabled) {
      return "";
    }
    const count = shelf.count(id);
    return count === 0
      ? ""
      : `<span class="session-files">${icon("folder")}<span class="session-files-count">${count}</span></span>`;
  };
  const rows = items
    .map((item) => {
      const cliModel = [item.cli, item.model].filter((part) => part !== "").join(" · ");
      const base = workdirBasename(item.workdir);
      const sub = [cliModel, base].filter((part) => part !== "").join(" · ");
      // What the row is, at a glance: a dead session is the square the
      // kill left behind, an agent is the bot, a shell its own terminal.
      const mark = statusDot(item.status) === "dead" ? "square" : item.cli === "" ? "squareTerminal" : "bot";
      return (
        `<li><button type="button" class="session-row" data-session="${esc(item.id)}">` +
        `<span class="session-kind" data-kind="${mark}" aria-hidden="true">${icon(mark)}</span>` +
        `<span class="dot dot-${esc(statusDot(item.status))}" title="${esc(item.status)}" aria-hidden="true"></span>` +
        `<span class="session-main"><span class="session-name">${esc(item.name || item.id)}</span>` +
        (sub === "" ? "" : `<span class="session-sub">${esc(sub)}</span>`) +
        `</span>${files(item.id)}` +
        `<span class="session-age">${esc(formatLastOutput(nowMs, item.lastOutputAt))}</span>` +
        `</button></li>`
      );
    })
    .join("");
  // The host's own shelf rides above the sessions, but only while it
  // holds files and only behind the feature flag.
  const shelfOn = shelf?.enabled === true && shelf.hostCount > 0;
  const shelfRow = shelfOn && shelf
    ? `<li><button type="button" class="session-row shelf-row" id="host-shelf-row">` +
      `<span class="session-kind" data-kind="folderOpen" aria-hidden="true">${icon("folderOpen")}</span>` +
      `<span class="session-main"><span class="session-name">Shelf</span>` +
      `<span class="session-sub">Files the host sent</span></span>` +
      `<span class="session-files">${icon("folderOpen")}` +
      `<span class="session-files-count">${shelf.hostCount}</span></span></button></li>`
    : "";
  const list = items.length === 0 && shelfRow === "";
  root.innerHTML =
    `<div class="sessions-head"><h2>Sessions</h2>` +
    `<button type="button" id="session-new">${icon("plus")}<span>New session</span></button></div>` +
    (list ? `<p class="empty">No sessions on this host.</p>` : `<ul class="session-list">${shelfRow}${rows}</ul>`);
  root.querySelector("#session-new")?.addEventListener("click", () => callbacks.onNew());
  if (shelfOn) {
    root.querySelector("#host-shelf-row")?.addEventListener("click", () => shelf?.onOpenShelf());
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-session]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-session");
      if (id) {
        callbacks.onOpen(id);
      }
    });
  }
}
