// SPDX-License-Identifier: Apache-2.0
// Frame routing between the data channel and the session shell: joined
// snapshots mount and feed the terminal, every other protocol frame goes
// to the session store, the open session, or the composer. Extracted from
// the entry point so tests pin the exact wiring the app uses; main.ts and
// the fake host both route through here.

import type { Shell } from "./app.js";
import type { JoinedSnapshot } from "./channel.js";
import {
  parseError,
  parseExited,
  parseOk,
  parseOut,
  parseSessionAdded,
  parseSessionRemoved,
  parseSessions,
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
}

export function createFrameRouter(deps: FrameRouterDeps): FrameRouter {
  const { store, controller, shell } = deps;

  function handleSnapshot(snapshot: JoinedSnapshot): void {
    globalThis.dispatchEvent(new CustomEvent("canopy:snapshot", { detail: snapshot }));
    shell.ensureTerminal(snapshot.id, snapshot.cols, snapshot.rows);
    controller.handleSnapshot(snapshot);
  }

  function handleFrame(frame: unknown): void {
    globalThis.dispatchEvent(new CustomEvent("canopy:frame", { detail: frame }));
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
    const ok = parseOk(frame);
    if (ok !== null) {
      shell.composerOk(ok);
      return;
    }
    const error = parseError(frame);
    if (error) {
      shell.composerError(error.message, error.req);
    }
  }

  return { handleSnapshot, handleFrame };
}
