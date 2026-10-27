// SPDX-License-Identifier: Apache-2.0
// Frame routing between the data channel and the session shell: joined
// snapshots mount and feed the terminal, every other protocol frame goes
// to the session store, the open session, the catalog cache, a sheet, or
// the composer. Extracted from the entry point so tests pin the exact
// wiring the app uses; main.ts and the fake host both route through here.

import type { Shell } from "./app.js";
import type { CatalogStore } from "./catalog.js";
import type { JoinedSnapshot } from "./channel.js";
import {
  parseCatalog,
  parseComposed,
  parseError,
  parseExited,
  parseOk,
  parseOut,
  parseSessionAdded,
  parseSessionRemoved,
  parseSessions,
  parseSpawned,
} from "./protocol.js";
import type { SessionController } from "./session.js";
import type { SessionStore } from "./sessions.js";

export interface FrameRouter {
  handleSnapshot: (snapshot: JoinedSnapshot) => void;
  handleFrame: (frame: unknown) => void;
}

export interface FrameRouterDeps {
  store: SessionStore;
  controller: SessionController;
  shell: Shell;
  catalog: CatalogStore;
}

export function createFrameRouter(deps: FrameRouterDeps): FrameRouter {
  const { store, controller, shell, catalog } = deps;

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
    const ok = parseOk(frame);
    if (ok !== null) {
      shell.composerOk(ok);
      shell.sheetOk(ok);
      return;
    }
    const error = parseError(frame);
    if (error) {
      shell.composerError(error.message, error.req);
      shell.sheetError(error.message, error.req, error.code);
    }
  }

  return { handleSnapshot, handleFrame };
}
