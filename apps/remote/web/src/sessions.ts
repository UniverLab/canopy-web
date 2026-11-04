// SPDX-License-Identifier: Apache-2.0
// The session list: a store fed by the sessions frame and the
// session_added / session_removed / exited events, plus the DOM renderer
// the Sessions route uses. An exited session keeps its row with a dead
// dot until the host removes it.

import { formatLastOutput, statusDot, workdirBasename } from "./protocol.js";
import type { SessionItem } from "./protocol.js";
import { icon } from "./icons-dom.js";
import { sessionTitle } from "./titles.js";

export class SessionStore {
  private readonly items = new Map<string, SessionItem>();
  private readonly listeners = new Set<() => void>();
  // False until the host's first sessions frame: an empty map before it
  // means "not heard yet", not "no sessions".
  private listed = false;

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
    this.listed = true;
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

  loaded(): boolean {
    return this.listed;
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

// The name the session view opens with: the store's row when it is there
// (exactly what the list renders), else the spawn's requested name while
// session_added is still in flight, else the id. The spawned frame lands
// before session_added, so the store is empty at creation time.
export function openSessionName(id: string, store: SessionStore, spawnName?: string | null): string {
  const item = store.get(id);
  if (item) {
    return item.name || item.id;
  }
  if (spawnName !== undefined && spawnName !== null && spawnName !== "") {
    return spawnName;
  }
  return id;
}

// The late session_added converges the open view in place: the store row
// wins, the title and header patch without a full render (which would
// drop the terminal). Returns the name to keep.
export function convergeOpenSessionName(
  root: HTMLElement,
  store: SessionStore,
  sessionId: string,
  current: string,
): string {
  const item = store.get(sessionId);
  if (!item) {
    return current;
  }
  const next = item.name || item.id;
  if (next === current) {
    return current;
  }
  document.title = sessionTitle(next);
  const title = root.querySelector(".session-title");
  if (title) {
    title.textContent = next;
  }
  return next;
}

export interface SessionListCallbacks {
  onOpen: (id: string) => void;
  onNew: () => void;
}

/** The shelf's share of the list: the one union row and its badge. */
export interface SessionListShelf {
  enabled: boolean;
  /** The unseen files on every shelf together. */
  unseen: number;
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
// carries no file affordance at all. The guest list is the same rows with
// no New button: a guest joins what the owner granted, never spawns.
export function renderSessions(
  root: HTMLElement,
  items: SessionItem[],
  nowMs: number,
  callbacks: SessionListCallbacks,
  shelf?: SessionListShelf,
  loaded = true,
  guest = false,
): void {
  const row = (item: SessionItem): string => {
    const cliModel = [item.cli, item.model].filter((part) => part !== "").join(" · ");
    const base = workdirBasename(item.workdir);
    const sub = [cliModel, base].filter((part) => part !== "").join(" · ");
    // What the row is, at a glance: a dead session is the square the
    // kill left behind, an agent is the bot, a shell its own terminal.
    // The host's kind decides — never the cli heuristic — and anything
    // that is not a terminal reads as an agent, like the TUI's hub.
    const mark =
      statusDot(item.status) === "dead" ? "square" : item.kind === "terminal" ? "squareTerminal" : "bot";
    return (
      `<li><button type="button" class="session-row" data-session="${esc(item.id)}">` +
      `<span class="session-kind" data-kind="${mark}" aria-hidden="true">${icon(mark)}</span>` +
      `<span class="dot dot-${esc(statusDot(item.status))}" title="${esc(item.status)}" aria-hidden="true"></span>` +
      `<span class="session-main"><span class="session-name">${esc(item.name || item.id)}</span>` +
      (sub === "" ? "" : `<span class="session-sub">${esc(sub)}</span>`) +
      `</span>` +
      `<span class="session-age">${esc(formatLastOutput(nowMs, item.lastOutputAt))}</span>` +
      `</button></li>`
    );
  };
  // Agents above terminals, each group in name order; every kind but
  // "terminal" belongs to Agents.
  const byName = (a: SessionItem, b: SessionItem): number => a.name.localeCompare(b.name);
  const agents = items.filter((item) => item.kind !== "terminal").sort(byName);
  const terminals = items.filter((item) => item.kind === "terminal").sort(byName);
  const group = (title: string, rows: SessionItem[]): string =>
    rows.length === 0
      ? ""
      : `<h3 class="session-group">${title}</h3>` +
        `<ul class="session-list">${rows.map(row).join("")}</ul>`;
  // The union shelf rides above the sessions, always while the feature
  // flag is on — even at zero files, so the entry point never disappears.
  const shelfOn = shelf?.enabled === true;
  const shelfRow = shelfOn && shelf
    ? `<li><button type="button" class="session-row shelf-row" id="host-shelf-row">` +
      `<span class="session-kind" data-kind="folderOpen" aria-hidden="true">${icon("folderOpen")}</span>` +
      `<span class="session-main"><span class="session-name">Shelf</span>` +
      `<span class="session-sub">Files from the host and its sessions</span></span>` +
      `<span class="files-badge" id="shelf-row-badge"${shelf.unseen === 0 ? " hidden" : ""}>` +
      `${shelf.unseen === 0 ? "" : shelf.unseen}</span></button></li>`
    : "";
  const shelfList = shelfRow === "" ? "" : `<ul class="session-list">${shelfRow}</ul>`;
  const heading = guest ? `<h2>Shared sessions</h2>` : "";
  const empty = loaded
    ? guest
      ? "No sessions shared with you."
      : "No sessions on this host."
    : "Connecting to the host…";
  const newButton = guest
    ? ""
    : `<button type="button" id="session-new">${icon("plus")}<span>New session</span></button>`;
  root.innerHTML =
    `<div class="sessions-head">${heading}${newButton}</div>` +
    (items.length === 0
      ? `${shelfList}<p class="empty">${empty}</p>`
      : `${shelfList}${group("Agents", agents)}${group("Terminals", terminals)}`);
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
