// SPDX-License-Identifier: Apache-2.0
// The session view's terminal controls: zoom, the Fit affordance, the
// latest button, and the per-session control-size toggle with its
// explainer. Rendered as HTML beside the terminal pane and wired to the
// open TerminalView plus the shell's live session state.

import { icon } from "./icons-dom.js";
import type { TerminalView } from "./terminal.js";
import { readControlSize, readFitOnly, writeControlSize, writeFitOnly } from "./terminal-prefs.js";

export function termControlsHtml(): string {
  return `
      <div class="term-controls">
        <button type="button" id="term-zoom-out" aria-label="Zoom out">${icon("minus")}</button>
        <button type="button" id="term-zoom-in" aria-label="Zoom in">${icon("plus")}</button>
        <button
          type="button"
          id="term-fit"
          aria-pressed="${readFitOnly() ? "true" : "false"}"
          aria-label="Fit terminal to pane width"
          title="Fit the terminal to the pane width"
        >Fit</button>
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
}

export interface TermControls {
  /** The latest button, for the shell to reveal as follow changes. */
  latestButton: HTMLButtonElement | null;
}

export function wireTermControls(deps: TermControlsDeps): TermControls {
  const { root } = deps;
  root.querySelector("#term-zoom-in")?.addEventListener("click", () => deps.terminalView()?.zoomIn());
  root.querySelector("#term-zoom-out")?.addEventListener("click", () => deps.terminalView()?.zoomOut());
  // The terminal always fits the pane width; Fit stays as a harmless
  // remembered affordance that is never needed to read the line.
  const fitButton = root.querySelector<HTMLButtonElement>("#term-fit");
  fitButton?.addEventListener("click", () => {
    const next = fitButton.getAttribute("aria-pressed") !== "true";
    writeFitOnly(next);
    fitButton.setAttribute("aria-pressed", `${next}`);
    deps.terminalView()?.setFitOnly(next);
  });
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
