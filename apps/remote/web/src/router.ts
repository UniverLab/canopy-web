// SPDX-License-Identifier: Apache-2.0
// Frame routing between the data channel and the session shell: joined
// snapshots mount and feed the terminal, every other protocol frame goes
// to the session store, the open session, the catalog cache, a sheet, or
// the composer. Extracted from the entry point so tests pin the exact
// wiring the app uses; main.ts and the fake host both route through here.

import type { CatalogStore } from "./catalog.js";
import type { JoinedSnapshot } from "./channel.js";
import type { GraphStore } from "./graph-store.js";
import { parseHostMetrics } from "./metrics.js";
import type { MetricsStore } from "./metrics-store.js";
import {
  parseCatalog,
  parseComposed,
  parseError,
  parseExited,
  parseFilePart,
  parseForbidden,
  parseGraph,
  parseGraphState,
  parseGraphs,
  parseHello,
  parseOk,
  parseOut,
  parseSessionAdded,
  parseSessionRemoved,
  parseSessions,
  parseShelf,
  parseShelfAdded,
  parseShelfRemoved,
  parseSpawned,
} from "./protocol.js";
import type { SessionController } from "./session.js";
import type { ShelfFrames } from "./shelf-controller.js";
import type { SessionStore } from "./sessions.js";

export interface FrameRouter {
  handleSnapshot: (snapshot: JoinedSnapshot) => void;
  handleFrame: (frame: unknown) => void;
}

/**
 * The slice of the shell the router paints: the full Shell satisfies it,
 * and so does the guest view's stub, which owns no composer or sheets.
 */
export interface RouterShell {
  ensureTerminal: (id: string, cols: number, rows: number) => void;
  composerOk: (req: string) => void;
  composerError: (message: string, req: string | null) => void;
  sheetSpawned: (req: string, id: string) => void;
  sheetComposed: (req: string, text: string) => void;
  sheetOk: (req: string) => void;
  sheetError: (message: string, req: string | null, code: string) => void;
}

export interface FrameRouterDeps {
  store: SessionStore;
  controller: SessionController;
  shell: RouterShell;
  catalog: CatalogStore;
  /** The session shelf; absent in tests that do not exercise it. */
  shelf?: ShelfFrames;
  /** The watched graphs; absent in tests that do not exercise them. */
  graphs?: GraphStore;
  /** The host metrics; absent in tests that do not exercise them. */
  metrics?: MetricsStore;
  /** A denied guest attach; absent outside the guest view. */
  onForbidden?: (id: string | null) => void;
}

export function createFrameRouter(deps: FrameRouterDeps): FrameRouter {
  const { store, controller, shell, catalog, shelf, graphs, metrics, onForbidden } = deps;

  function handleSnapshot(snapshot: JoinedSnapshot): void {
    shell.ensureTerminal(snapshot.id, snapshot.cols, snapshot.rows);
    controller.handleSnapshot(snapshot);
  }

  function handleFrame(frame: unknown): void {
    const sessions = parseSessions(frame);
    if (sessions) {
      store.replace(sessions);
      return;
    }
    const added = parseSessionAdded(frame);
    if (added) {
      store.add(added);
      return;
    }
    const removed = parseSessionRemoved(frame);
    if (removed !== null) {
      store.remove(removed);
      return;
    }
    const exited = parseExited(frame);
    if (exited) {
      store.markExited(exited.id);
      controller.handleExited(exited.id, exited.code);
      return;
    }
    const out = parseOut(frame);
    if (out) {
      controller.handleOut(out);
      return;
    }
    // Graph watching: the list, the watch reply (summary + drawing) and
    // the live-state pushes. Each parser is additive, so a host that
    // sends none of them changes nothing.
    const graphsList = parseGraphs(frame);
    if (graphsList) {
      graphs?.handleGraphs(graphsList);
      return;
    }
    const graphReply = parseGraph(frame);
    if (graphReply) {
      graphs?.handleGraph(graphReply);
      return;
    }
    const graphState = parseGraphState(frame);
    if (graphState) {
      graphs?.handleGraphState(graphState);
      return;
    }
    // Host metrics pushes while watched; a host that sends none changes
    // nothing, and the strip stays hidden.
    const hostMetrics = parseHostMetrics(frame);
    if (hostMetrics) {
      metrics?.handleFrame(hostMetrics);
      return;
    }
    const catalogReply = parseCatalog(frame);
    if (catalogReply) {
      catalog.replace(catalogReply);
      return;
    }
    const spawned = parseSpawned(frame);
    if (spawned) {
      shell.sheetSpawned(spawned.req, spawned.id);
      return;
    }
    const composed = parseComposed(frame);
    if (composed) {
      shell.sheetComposed(composed.req, composed.text);
      return;
    }
    // The shelf half of v1: hello gates the whole feature, the rest is
    // list/push/removal/file-part. Every parser here is additive, so a
    // host that sends none of them changes nothing.
    const hello = parseHello(frame);
    if (hello !== null) {
      shelf?.handleHello(hello);
      return;
    }
    const shelfList = parseShelf(frame);
    if (shelfList) {
      shelf?.handleList(shelfList);
      return;
    }
    const shelfAdded = parseShelfAdded(frame);
    if (shelfAdded) {
      shelf?.handleAdded(shelfAdded);
      return;
    }
    const shelfRemoved = parseShelfRemoved(frame);
    if (shelfRemoved !== null) {
      shelf?.handleRemoved(shelfRemoved);
      return;
    }
    const filePart = parseFilePart(frame);
    if (filePart) {
      shelf?.handlePart(filePart);
      return;
    }
    const ok = parseOk(frame);
    if (ok !== null) {
      shell.composerOk(ok);
      shell.sheetOk(ok);
      return;
    }
    const forbidden = parseForbidden(frame);
    if (forbidden) {
      // A denied guest attach never touches the composer or a sheet: the
      // guest view paints its own unauthorized state. Without a guest
      // handler (the owner flow, which the hub never forbids) the frame
      // falls through to the generic error below.
      if (onForbidden) {
        onForbidden(forbidden.id);
        return;
      }
    }
    const error = parseError(frame);
    if (error) {
      // A shelf transfer answers its own req (busy, not_found, …) and
      // must never surface as a composer or dialog error.
      if (shelf?.handleError(error)) {
        return;
      }
      shell.composerError(error.message, error.req);
      shell.sheetError(error.message, error.req, error.code);
    }
  }

  return { handleSnapshot, handleFrame };
}
