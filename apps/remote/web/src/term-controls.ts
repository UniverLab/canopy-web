// SPDX-License-Identifier: Apache-2.0
// The session view's terminal controls: zoom, the key-bar switch, the
// Prompt Builder button, the fullscreen button, the latest button, and
// the per-session control-size toggle with its explainer. Rendered as
// HTML beside the terminal pane (the latest button floats over the
// pane's bottom-right corner) and wired to the open TerminalView plus
// the shell's live session state.
//
// The control-size toggle makes this device the size owner: it computes
// the cols × rows that fit its own panel (TerminalView.ownedSize), resizes
// the local terminal to them and asserts them to the host, then re-asserts
// (debounced) whenever the panel changes — a resize, an orientation
// change, fullscreen, the zoom — for as long as the toggle stays on.
// The host's `resized` frame lands in handleResized: a follower resizes
// to it, and an owner whose size was replaced by another device's lets go
// (no resize ping-pong) and says so in the size row's note.

import { icon } from "./icons-dom.js";
import type { TermSize, TerminalView } from "./terminal.js";
import {
  readControlSize,
  readKeyBarVisible,
  writeControlSize,
  writeKeyBarVisible,
} from "./terminal-prefs.js";

// The fullscreen control only exists where the browser can honour it:
// iPhone Safari reports fullscreenEnabled false, and an installed
// standalone app is already chromeless.
function fullscreenAvailable(): boolean {
  try {
    if (typeof document === "undefined" || document.fullscreenEnabled !== true) {
      return false;
    }
    return (
      typeof globalThis.matchMedia !== "function" ||
      !globalThis.matchMedia("(display-mode: standalone)").matches
    );
  } catch {
    return false;
  }
}

export function termControlsHtml(): string {
  const fullscreen = fullscreenAvailable()
    ? `
        <button type="button" id="term-fullscreen" aria-pressed="false" aria-label="Enter fullscreen">${icon("maximize")}</button>`
    : "";
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
        >${icon("keyboard")}<span>Keys</span></button>
        <button type="button" id="term-builder" aria-label="Builder">${icon("blocks")}<span>Builder</span></button>
        <button type="button" id="term-copy" aria-label="Copy text" title="Copy text from the terminal">${icon("copy")}</button>${fullscreen}
      </div>`;
}

/**
 * The latest button, floating over the terminal card's bottom-right
 * corner rather than in the toolbar row, where an eighth 44 px target
 * wrapped onto a row of its own on a phone and cost the terminal a row.
 * Icon-only at every width: the aria-label and the title name it. The
 * shell renders it inside the `.term-stage` beside `#term-pane`.
 */
export function termLatestHtml(): string {
  return `
        <button
          type="button"
          id="term-latest"
          hidden
          aria-label="Scroll to the latest output"
          title="Scroll to the latest output"
        >${icon("arrowDown")}</button>`;
}

/**
 * Whether the latest button stays hidden. On the shell's buffer it shows
 * while the view no longer follows the bottom. A fullscreen app has no
 * tail to follow (follow stays off) and the button floats over the frame,
 * often over the app's own input line, so there it shows only while the
 * pane is scrolled away from the frame's top, which a tap brings back.
 */
export function latestHidden(following: boolean, alternate: boolean, paneScrollTop: number): boolean {
  return alternate ? paneScrollTop <= 0 : following;
}

const SIZE_NOTE = "Only one client should control the size.";
/** The size row's note once another device replaced this one's size. */
export const SIZE_TAKEN_NOTE = "Size taken over by another device.";

// The size row lives below the keybar, not beside the controls: the ten
// keys must all stay inside a 360×640 viewport, and any row above them
// pushes the second key row out of view. The checkbox is drawn as a
// switch (role="switch" announces on/off) and the whole label is its
// 44 px target; Space toggles it and the focus ring is the global one.
export function termSizeHtml(sessionId: string | null): string {
  return `
      <div class="term-size">
        <label class="term-size-toggle"><input
          type="checkbox"
          role="switch"
          id="term-control-size"
          ${sessionId !== null && readControlSize(sessionId) ? "checked" : ""}
        ><span>This device controls the size</span></label>
        <p class="term-size-note" role="status">${SIZE_NOTE}</p>
      </div>`;
}

/** The slice of the open TerminalView the controls drive. */
export type TermControlsView = Pick<
  TerminalView,
  "zoomIn" | "zoomOut" | "scrollToLatest" | "isAlternate" | "fitted" | "ready" | "ownedSize" | "setSizeOwner"
>;

export interface TermControlsDeps {
  root: HTMLElement;
  sessionId: () => string | null;
  terminalView: () => TermControlsView | null;
  /** Send resize{id,cols,rows}: this device asserts its size to the host. */
  onControlSize: (cols: number, rows: number) => void;
  /** Resize the local terminal to cols × rows (the shell tracks the size). */
  onLocalSize: (cols: number, rows: number) => void;
  /** Open the Prompt Builder sheet; the controls row owns its button. */
  onBuilder: () => void;
  /** Open the Copy sheet; the controls row owns its button. */
  onCopy: () => void;
}

export interface TermControls {
  /** The latest button, for the shell to reveal as follow changes. */
  latestButton: HTMLButtonElement | null;
  /**
   * A terminal (re)mounted: a remembered toggle asserts the size that fits
   * this panel again, even when it did not change, so a reconnected or
   * resized session keeps the size this device asked for.
   */
  reassert: () => void;
  /** The panel layout changed (the zoom): re-assert, debounced, while on. */
  schedule: () => void;
  /**
   * The host reports the session's PTY size. A follower resizes to it; an
   * owner whose own size it is not (another device took over) turns its
   * toggle off, remembers that, and follows.
   */
  handleResized: (cols: number, rows: number) => void;
  /** Stop watching the panel; the session view is going away. */
  dispose: () => void;
}

/** Panel changes settle this long before the size is asserted again. */
export const SIZE_DEBOUNCE_MS = 150;
// A measurement that is not ready yet (the terminal still opening) retries
// on the debounce this many times before waiting for the next change.
const SIZE_MEASURE_RETRIES = 5;
// The sizes this device sent that the host may still echo back: a slow
// echo of an older one must not read as another device taking over.
const MAX_ASSERTED = 8;

function sameSize(a: TermSize | null, b: TermSize): boolean {
  return a !== null && a.cols === b.cols && a.rows === b.rows;
}

export function wireTermControls(deps: TermControlsDeps): TermControls {
  const { root } = deps;
  root.querySelector("#term-zoom-in")?.addEventListener("click", () => deps.terminalView()?.zoomIn());
  root.querySelector("#term-zoom-out")?.addEventListener("click", () => deps.terminalView()?.zoomOut());
  root.querySelector("#term-builder")?.addEventListener("click", () => deps.onBuilder());
  root.querySelector("#term-copy")?.addEventListener("click", () => deps.onCopy());
  // The Keys switch hides the ten-key bar and nothing else: the zoom and
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
  // Fullscreen is a tap, not a latch the shell tracks: the browser owns
  // the state, and fullscreenchange repaints the button (maximize when
  // windowed, minimize while fullscreen). The document listener drops
  // itself once a re-render orphans the button.
  const fsButton = root.querySelector<HTMLButtonElement>("#term-fullscreen");
  if (fsButton) {
    const paintFullscreen = (): void => {
      if (!fsButton.isConnected) {
        document.removeEventListener("fullscreenchange", paintFullscreen);
        return;
      }
      const active = document.fullscreenElement !== null;
      fsButton.setAttribute("aria-pressed", active ? "true" : "false");
      fsButton.setAttribute("aria-label", active ? "Exit fullscreen" : "Enter fullscreen");
      fsButton.innerHTML = icon(active ? "minimize" : "maximize");
    };
    fsButton.addEventListener("click", () => {
      if (document.fullscreenElement === null) {
        void document.documentElement
          .requestFullscreen({ navigationUI: "hide" })
          .catch(() => undefined);
      } else {
        void document.exitFullscreen().catch(() => undefined);
      }
    });
    document.addEventListener("fullscreenchange", paintFullscreen);
    paintFullscreen();
  }
  const latestButton = root.querySelector<HTMLButtonElement>("#term-latest");
  latestButton?.addEventListener("click", () => {
    deps.terminalView()?.scrollToLatest();
    // The tap means "follow now", or in fullscreen "back to the frame's
    // top": either way there is nothing left to jump to.
    if (latestButton) {
      latestButton.hidden = true;
    }
  });
  // Per-session, default off: while on, the device asserts the size that
  // fits its own panel. Turning it on sends that size at once (and resizes
  // the local terminal to it); turning it off stops asserting and the
  // terminal follows the host's size again.
  const sizeToggle = root.querySelector<HTMLInputElement>("#term-control-size");
  const sizeNote = root.querySelector<HTMLElement>(".term-size-note");
  let owning = false;
  let lastSent: TermSize | null = null;
  let asserted: TermSize[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let generation = 0;
  let unwatch: (() => void) | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    if (!owning) {
      return;
    }
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      assertSize(false);
    }, SIZE_DEBOUNCE_MS);
  };

  // Measure and send: an unchanged size is not sent again unless forced
  // (a fresh mount, where the host may hold any size).
  function assertSize(force: boolean): void {
    if (!owning || deps.sessionId() === null) {
      return;
    }
    const view = deps.terminalView();
    if (!view) {
      return;
    }
    const size = view.ownedSize();
    if (size === null) {
      if (retries < SIZE_MEASURE_RETRIES) {
        retries += 1;
        schedule();
      }
      return;
    }
    retries = 0;
    if (!force && sameSize(lastSent, size)) {
      return;
    }
    lastSent = size;
    asserted.push(size);
    if (asserted.length > MAX_ASSERTED) {
      asserted.shift();
    }
    deps.onLocalSize(size.cols, size.rows);
    deps.onControlSize(size.cols, size.rows);
  }

  // The panel changes that move the size: its own box (a window resize, a
  // keyboard, the key bar), an orientation change and fullscreen. The zoom
  // reaches schedule() through the shell.
  const watch = (): void => {
    if (unwatch !== null) {
      return;
    }
    const pane = root.querySelector<HTMLElement>("#term-pane");
    const observer =
      pane !== null && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => schedule())
        : null;
    if (pane !== null) {
      observer?.observe(pane);
    }
    globalThis.addEventListener("resize", schedule);
    globalThis.addEventListener("orientationchange", schedule);
    document.addEventListener("fullscreenchange", schedule);
    unwatch = () => {
      observer?.disconnect();
      globalThis.removeEventListener("resize", schedule);
      globalThis.removeEventListener("orientationchange", schedule);
      document.removeEventListener("fullscreenchange", schedule);
    };
  };

  const stopWatching = (): void => {
    unwatch?.();
    unwatch = null;
    clearTimer();
  };

  const setNote = (text: string): void => {
    if (sizeNote) {
      sizeNote.textContent = text;
      sizeNote.classList.toggle("is-notice", text !== SIZE_NOTE);
    }
  };

  const startOwning = (): void => {
    owning = true;
    lastSent = null;
    asserted = [];
    setNote(SIZE_NOTE);
    retries = 0;
    generation += 1;
    watch();
    const view = deps.terminalView();
    if (!view) {
      // No terminal yet: its mount re-asserts.
      return;
    }
    view.setSizeOwner(true);
    if (view.fitted) {
      assertSize(true);
      return;
    }
    const pending = generation;
    void view.ready().then(() => {
      if (pending === generation && owning && deps.terminalView() === view) {
        assertSize(true);
      }
    });
  };

  const stopOwning = (): void => {
    owning = false;
    lastSent = null;
    asserted = [];
    generation += 1;
    stopWatching();
    deps.terminalView()?.setSizeOwner(false);
  };

  sizeToggle?.addEventListener("change", () => {
    const id = deps.sessionId();
    if (id === null) {
      return;
    }
    const next = sizeToggle.checked;
    writeControlSize(id, next);
    if (next) {
      startOwning();
    } else {
      stopOwning();
    }
  });

  return {
    latestButton,
    reassert: () => {
      const id = deps.sessionId();
      if (id === null || !readControlSize(id)) {
        return;
      }
      if (sizeToggle) {
        sizeToggle.checked = true;
      }
      startOwning();
    },
    schedule,
    handleResized: (cols, rows) => {
      const reported = { cols, rows };
      if (owning && asserted.length > 0) {
        const index = asserted.findIndex((size) => sameSize(size, reported));
        if (index >= 0) {
          // The host confirms one of ours: drop the older ones.
          asserted = asserted.slice(index);
          return;
        }
        // Another device (or the host's own TUI) set a size this device
        // never asked for: let it have the size rather than fight back.
        const id = deps.sessionId();
        if (id !== null) {
          writeControlSize(id, false);
        }
        if (sizeToggle) {
          sizeToggle.checked = false;
        }
        stopOwning();
        setNote(SIZE_TAKEN_NOTE);
      }
      // A follower (or an owner yet to assert) takes the host's size.
      deps.onLocalSize(cols, rows);
    },
    dispose: () => {
      owning = false;
      generation += 1;
      stopWatching();
    },
  };
}
