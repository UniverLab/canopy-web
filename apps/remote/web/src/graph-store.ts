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
  /** The latest watch's req: an error carrying it failed this watch. */
  private watchReq: string | null = null;
  /** The latest watch's failure, cleared by the next watch or reply. */
  private watchErrorMessage: string | null = null;

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
    const req = newReqId();
    this.watchReq = req;
    this.watchErrorMessage = null;
    return this.send(buildGraphWatch(req, id));
  }

  /** Stop watching; the last state stays for the next watch or reconnect. */
  unwatch(): boolean {
    const id = this.watching;
    this.watching = null;
    return id === null ? true : this.send(buildGraphUnwatch(id));
  }

  /** Re-send the watch after a reconnect, only while a watch is open. */
  rewatch(): boolean {
    if (this.watching === null) {
      return true;
    }
    const req = newReqId();
    this.watchReq = req;
    this.watchErrorMessage = null;
    return this.send(buildGraphWatch(req, this.watching));
  }

  watchedId(): string | null {
    return this.watching;
  }

  /** The latest watch's failure message, or null while it stands. */
  watchError(): string | null {
    return this.watchErrorMessage;
  }

  // --- inbound --------------------------------------------------------

  handleGraphs(items: GraphSummary[]): void {
    this.items = items;
    this.notify();
  }

  /**
   * True when the error failed this watch: its req is the latest watch's.
   * The router stays dumb — the store claims its own errors, like the
   * shelf fetcher does for its transfers.
   */
  handleWatchError(message: string, req: string | null): boolean {
    if (req === null || req !== this.watchReq) {
      return false;
    }
    this.watchErrorMessage = message;
    this.notify();
    return true;
  }

  handleGraph(reply: GraphWatchReply): void {
    if (this.open !== null && reply.summary.id !== this.open) {
      return;
    }
    this.watchErrorMessage = null;
    this.summary = reply.summary;
    this.doc = reply.doc;
    // The reply carries the first live state: apply it exactly like a
    // push, so the view paints without waiting for the next one.
    this.state = reply.state;
    this.receivedAt = Date.now();
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
    this.watchReq = null;
    this.watchErrorMessage = null;
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
