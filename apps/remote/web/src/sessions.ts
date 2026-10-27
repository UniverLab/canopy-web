// SPDX-License-Identifier: Apache-2.0
// The session list: a store fed by the sessions frame and the
// session_added / session_removed / exited events, plus the DOM renderer
// the Sessions route uses. An exited session keeps its row with a dead
// dot until the host removes it.

import { formatLastOutput, statusDot, workdirBasename } from "./protocol.js";
import type { SessionItem } from "./protocol.js";

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

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// nowMs is injected so tests pin the relative times.
export function renderSessions(
  root: HTMLElement,
  items: SessionItem[],
  nowMs: number,
  callbacks: SessionListCallbacks,
): void {
  const rows = items
    .map((item) => {
      const cliModel = [item.cli, item.model].filter((part) => part !== "").join(" · ");
      const base = workdirBasename(item.workdir);
      const sub = [cliModel, base].filter((part) => part !== "").join(" · ");
      return (
        `<li><button type="button" class="session-row" data-session="${esc(item.id)}">` +
        `<span class="dot dot-${esc(statusDot(item.status))}" title="${esc(item.status)}" aria-hidden="true"></span>` +
        `<span class="session-main"><span class="session-name">${esc(item.name || item.id)}</span>` +
        (sub === "" ? "" : `<span class="session-sub">${esc(sub)}</span>`) +
        `</span><span class="session-age">${esc(formatLastOutput(nowMs, item.lastOutputAt))}</span>` +
        `</button></li>`
      );
    })
    .join("");
  root.innerHTML =
    `<div class="sessions-head"><h2>Sessions</h2>` +
    `<button type="button" id="session-new">New</button></div>` +
    (items.length === 0
      ? `<p class="empty">No sessions on this host.</p>`
      : `<ul class="session-list">${rows}</ul>`);
  root.querySelector("#session-new")?.addEventListener("click", () => callbacks.onNew());
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-session]")) {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-session");
      if (id) {
        callbacks.onOpen(id);
      }
    });
  }
}
