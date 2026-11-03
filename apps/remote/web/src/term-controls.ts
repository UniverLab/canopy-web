// SPDX-License-Identifier: Apache-2.0
// The session view's terminal controls: zoom, the key-bar switch, the
// Prompt Builder button, the latest button, and the per-session
// control-size toggle with its explainer. Rendered as HTML beside the
// terminal pane and wired to the open TerminalView plus the shell's live
// session state.

import { icon } from "./icons-dom.js";
import type { TerminalView } from "./terminal.js";
import {
  readControlSize,
  readKeyBarVisible,
  writeControlSize,
  writeKeyBarVisible,
} from "./terminal-prefs.js";

export function termControlsHtml(): string {
  return `
      <div class="term-controls">
        <button type="button" id="term-zoom-out" aria-label="Zoom out">${icon("minus")}</button>
        <button type="button" id="term-zoom-in" aria-label="Zoom in">${icon("plus")}</button>
        <button
          type="button"
          id="term-keys"
          aria-pressed="${readKeyBarVisible() ? "true" : "false"}"
          aria-label="Show terminal keys"
          title="Show or hide the terminal keys"
        >Keys</button>
        <button type="button" id="term-builder">${icon("blocks")}<span>Builder</span></button>
        <button type="button" id="term-latest" hidden aria-label="Scroll to the latest output">${icon("arrowDown")}<span>latest</span></button>
      </div>`;
}

// The size row lives below the keybar, not beside the controls: the nine
// keys must all stay inside a 360×640 viewport, and any row above them
// pushes the second key row out of view.
export function termSizeHtml(sessionId: string | null): string {
  return `
      <div class="term-size">
        <label class="term-size-toggle"><input
          type="checkbox"
          id="term-control-size"
          ${sessionId !== null && readControlSize(sessionId) ? "checked" : ""}
        > This device controls the size</label>
        <p class="term-size-note">Only one client should control the size.</p>
      </div>`;
}

export interface TermControlsDeps {
  root: HTMLElement;
  sessionId: () => string | null;
  terminalView: () => TerminalView | null;
  sessionSize: () => { cols: number; rows: number };
  onControlSize: (cols: number, rows: number) => void;
  /** Open the Prompt Builder sheet; the controls row owns its button. */
  onBuilder: () => void;
}

export interface TermControls {
  /** The latest button, for the shell to reveal as follow changes. */
  latestButton: HTMLButtonElement | null;
}

export function wireTermControls(deps: TermControlsDeps): TermControls {
  const { root } = deps;
  root.querySelector("#term-zoom-in")?.addEventListener("click", () => deps.terminalView()?.zoomIn());
  root.querySelector("#term-zoom-out")?.addEventListener("click", () => deps.terminalView()?.zoomOut());
  root.querySelector("#term-builder")?.addEventListener("click", () => deps.onBuilder());
  // The Keys switch hides the nine-key bar and nothing else: the zoom and
  // the builder stay put. The choice is remembered per device.
  const keysButton = root.querySelector<HTMLButtonElement>("#term-keys");
  const keyBar = root.querySelector<HTMLElement>("#keybar");
  const showKeyBar = (visible: boolean): void => {
    keysButton?.setAttribute("aria-pressed", visible ? "true" : "false");
    if (keyBar) {
      keyBar.hidden = !visible;
    }
  };
  if (keysButton) {
    showKeyBar(readKeyBarVisible());
    keysButton.addEventListener("click", () => {
      const next = keysButton.getAttribute("aria-pressed") !== "true";
      writeKeyBarVisible(next);
      showKeyBar(next);
    });
  }
  const latestButton = root.querySelector<HTMLButtonElement>("#term-latest");
  latestButton?.addEventListener("click", () => {
    const view = deps.terminalView();
    view?.scrollToLatest();
    // In fullscreen follow stays off, so the button stays visible; anywhere
    // else the tap means "follow now" and hides it.
    if (latestButton && !view?.isAlternate) {
      latestButton.hidden = true;
    }
  });
  // Per-session, default off: while on, the device asserts its PTY size
  // to the host. Turning it on sends the open terminal's real cols and
  // rows at once; turning it off just stops asserting.
  const sizeToggle = root.querySelector<HTMLInputElement>("#term-control-size");
  sizeToggle?.addEventListener("change", () => {
    const id = deps.sessionId();
    if (id === null) {
      return;
    }
    const next = sizeToggle.checked;
    writeControlSize(id, next);
    const { cols, rows } = deps.sessionSize();
    if (next && cols > 0 && rows > 0) {
      deps.onControlSize(cols, rows);
    }
  });
  return { latestButton };
}
