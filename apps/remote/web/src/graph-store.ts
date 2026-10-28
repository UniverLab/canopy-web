// SPDX-License-Identifier: Apache-2.0
// The graph store: the Graphs tab's list and the open graph view's
// summary, drawing document and live state, plus the three frames out
// (`graphs`, `graph_watch`, `graph_unwatch`). The shell subscribes to
// render, the frame router pushes into it, and both entry points drive
// watch/unwatch — the same shape the shelf controller uses.

import { buildGraphs, buildGraphUnwatch, buildGraphWatch, newReqId } from "./protocol.js";
import type { GraphState, GraphSummary, GraphWatchReply } from "./protocol.js";

export interface GraphStoreDeps {
  /** False when the frame could not be sent (no connection yet). */
  send: (data: string) => boolean;
}

export class GraphStore {
  private readonly send: (data: string) => boolean;
  private readonly listeners = new Set<() => void>();
  private items: GraphSummary[] = [];
  /** The graph being watched right now, or null when nothing is watched. */
  private watching: string | null = null;
  /** The graph the summary/state belong to, so a new id starts clean. */
  private open: string | null = null;
  private summary: GraphSummary | null = null;
  private doc: unknown = null;
  private state: GraphState | null = null;
  private receivedAt: number | null = null;

  constructor(deps: GraphStoreDeps) {
    this.send = deps.send;
  }

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

  // --- outbound -------------------------------------------------------

  /** Ask for the list; false when the link is down. */
  requestList(): boolean {
    return this.send(buildGraphs(newReqId()));
  }

  /** Watch a graph: a fresh id starts from a clean slate. */
  watch(id: string): boolean {
    if (id !== this.open) {
      this.open = id;
      this.summary = null;
      this.doc = null;
      this.state = null;
      this.receivedAt = null;
    }
    this.watching = id;
    return this.send(buildGraphWatch(id));
  }

  /** Stop watching; the last state stays for the next watch or reconnect. */
  unwatch(): boolean {
    const id = this.watching;
    this.watching = null;
    return id === null ? true : this.send(buildGraphUnwatch(id));
  }

  /** Re-send the watch after a reconnect, only while a watch is open. */
  rewatch(): boolean {
    return this.watching === null ? true : this.send(buildGraphWatch(this.watching));
  }

  watchedId(): string | null {
    return this.watching;
  }

  // --- inbound --------------------------------------------------------

  handleGraphs(items: GraphSummary[]): void {
    this.items = items;
    this.notify();
  }

  handleGraph(reply: GraphWatchReply): void {
    if (this.open !== null && reply.summary.id !== this.open) {
      return;
    }
    this.summary = reply.summary;
    this.doc = reply.doc;
    this.notify();
  }

  handleGraphState(state: GraphState): void {
    this.state = state;
    this.receivedAt = Date.now();
    this.notify();
  }

  /** Leaving the host or pairing again: nothing of its graphs stays. */
  reset(): void {
    this.items = [];
    this.watching = null;
    this.open = null;
    this.summary = null;
    this.doc = null;
    this.state = null;
    this.receivedAt = null;
    this.notify();
  }

  // --- reads ----------------------------------------------------------

  list(): GraphSummary[] {
    return [...this.items].sort((a, b) => a.name.localeCompare(b.name));
  }

  currentSummary(): GraphSummary | null {
    return this.summary;
  }

  currentDoc(): unknown {
    return this.doc;
  }

  currentState(): GraphState | null {
    return this.state;
  }

  /** When the last state arrived locally (epoch ms), or null yet. */
  lastReceivedAt(): number | null {
    return this.receivedAt;
  }
}
