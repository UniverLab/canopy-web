// SPDX-License-Identifier: Apache-2.0
// The host PTY on the phone: an xterm.js terminal created once with the
// snapshot's cols and rows — the browser never resizes the host (unless
// the control-size toggle says so) — scaled exactly once. .term-host
// keeps xterm's natural pixel size and transform:scale(s) does the
// scaling; the surrounding .term-scale is the visual box (natural × s)
// and .term-fit holds it. The pane itself is the scroller
// (overflow:auto), so a zoomed session pans inside the terminal card and
// the page never scrolls sideways. Pinch or the +/− buttons zoom on top
// of the fit, output follows the bottom unless the user scrolled up, and
// tapping the terminal focuses xterm's hidden textarea so the soft
// keyboard opens and typed characters come back through onData as input.
//
// The fitted scale is paneWidth / terminalWidth times the zoom while the
// normal buffer is active; a fullscreen app switches xterm to the
// alternate buffer, and then the whole frame — every row and column —
// fits the panel with min(panelW/naturalW, panelH/naturalH) and
// follow-bottom switches off until the app exits back to the shell. The
// scale always measures the real .xterm-screen, never the .xterm wrapper.
// The terminal fits its panel on open, on panel resize, on zoom change
// and on buffer change. Every refit anchors the pane at scrollLeft 0, so
// the line start stays visible and a stale scroll never clips the left
// edge.
//
// While this device controls the size (the control-size toggle), the
// direction flips: the grid is computed from the panel (ownedSize) and the
// local terminal is resized to it, so it renders at its base scale (the
// face at 14 CSS px) times the zoom instead of being fitted to the width.

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  terminalFontSizeForDpr,
  terminalFontGate,
} from "./terminal-font.js";
import { THEME } from "./terminal-theme.js";
import { attachWebgl } from "./terminal-webgl.js";

export interface FollowState {
  following: boolean;
}

export interface TerminalHandle {
  write: (data: Uint8Array) => void;
  clear: () => void;
  focus: () => void;
  scrollToBottom: () => void;
  isAtBottom: () => boolean;
  /** True while xterm's alternate (fullscreen) buffer is active. Absent means always normal. */
  isAlternateBuffer?: () => boolean;
  /** Fires when the active buffer changes between normal and alternate. */
  onBufferChange?: (callback: () => void) => () => void;
  onUserInput: (callback: (text: string) => void) => () => void;
  onScroll: (callback: () => void) => () => void;
  /** Fires once the terminal is open (and the WebGL attempt settled). */
  onReady: (callback: () => void) => () => void;
  /** Resize the local terminal to cols × rows. Absent means a fixed size. */
  resize?: (cols: number, rows: number) => void;
  /**
   * The scale that shows the opened face at TERMINAL_FONT_SIZE CSS px: the
   * DPR-1 double-size face renders at 0.5. Absent means 1.
   */
  baseScale?: number;
  dispose: () => void;
}

export type TerminalFactory = (host: HTMLElement, cols: number, rows: number) => TerminalHandle;

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
// The smallest glyph height a session may render at, in CSS px.
export const MIN_GLYPH_PX = 11;
// Used only when xterm has not been measured yet (no layout at all).
const FALLBACK_ROW_HEIGHT = 17;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export interface TermSize {
  cols: number;
  rows: number;
}

// The bounds of a size this device asserts: below them a session is
// unusable, above them the panel measurement is surely wrong.
export const OWNED_MIN_COLS = 20;
export const OWNED_MAX_COLS = 500;
export const OWNED_MIN_ROWS = 5;
export const OWNED_MAX_ROWS = 200;

function clampInt(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// The cols × rows that fit a panel of panelWidth × panelHeight CSS px with
// cells of cellWidth × cellHeight CSS px (as they render on screen), within
// the owned bounds. Null when either box is not measured yet.
export function computeOwnedSize(
  panelWidth: number,
  panelHeight: number,
  cellWidth: number,
  cellHeight: number,
): TermSize | null {
  if (!(panelWidth > 0 && panelHeight > 0 && cellWidth > 0 && cellHeight > 0)) {
    return null;
  }
  // The epsilon keeps an exact fit (336 / 8.4) from flooring one short.
  const cols = Math.floor(panelWidth / cellWidth + 1e-6);
  const rows = Math.floor(panelHeight / cellHeight + 1e-6);
  return {
    cols: clampInt(cols, OWNED_MIN_COLS, OWNED_MAX_COLS),
    rows: clampInt(rows, OWNED_MIN_ROWS, OWNED_MAX_ROWS),
  };
}

// 11 CSS px of glyph at the terminal's natural row height.
export function computeMinScale(rowHeight: number): number {
  if (!(rowHeight > 0)) {
    return 1;
  }
  return MIN_GLYPH_PX / rowHeight;
}

// Base scale: the larger of fit-to-width and minScale, times the zoom. The
// view always passes a minScale of 0 (pure fit-to-width); the parameter
// stays for the scale-math unit tests.
export function computeScale(
  paneWidth: number,
  contentWidth: number,
  zoom: number,
  minScale = 0,
): number {
  if (paneWidth <= 0 || contentWidth <= 0) {
    return 1;
  }
  return Math.max(paneWidth / contentWidth, minScale) * clampZoom(zoom);
}

// The fitted scale for the active buffer: the normal buffer keeps the
// width fit, while the alternate (fullscreen) buffer fits the whole frame
// — every row and column — with min(panelW/naturalW, panelH/naturalH).
// Zoom multiplies on top in both modes.
export function computeFitScale(
  paneWidth: number,
  paneHeight: number,
  contentWidth: number,
  contentHeight: number,
  zoom: number,
  alternate: boolean,
): number {
  if (!alternate) {
    return computeScale(paneWidth, contentWidth, zoom, 0);
  }
  if (paneWidth <= 0 || paneHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return 1;
  }
  return Math.min(paneWidth / contentWidth, paneHeight / contentHeight) * clampZoom(zoom);
}

export function zoomFromPinch(startDistance: number, currentDistance: number, startZoom: number): number {
  if (startDistance <= 0) {
    return startZoom;
  }
  return clampZoom(startZoom * (currentDistance / startDistance));
}

function touchDistance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

// One-finger scroll: the first 8 px decide vertical (the terminal scrolls
// its history) or horizontal (left to the browser, which pans the pane).
export const TOUCH_GESTURE_PX = 8;

export type TouchGestureKind = "undecided" | "vertical" | "horizontal";

export function classifyTouchGesture(dx: number, dy: number): TouchGestureKind {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < TOUCH_GESTURE_PX) {
    return "undecided";
  }
  // A tie at 45 degrees scrolls the terminal.
  return Math.abs(dy) >= Math.abs(dx) ? "vertical" : "horizontal";
}

export interface TouchScrollSplit {
  pane: number; // CSS px the pane absorbs by moving its own scrollTop.
  terminal: number; // CSS px left for the terminal (the scroll remainder).
}

// Scroll chaining for one step: the zoomed pane moves first while it can
// still go in the drag's direction, the rest goes to the terminal.
// scrollDelta is positive downwards, like scrollTop and deltaY.
export function splitTouchScroll(
  scrollDelta: number,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): TouchScrollSplit {
  if (scrollDelta === 0) {
    return { pane: 0, terminal: 0 };
  }
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const pane = Math.min(Math.max(scrollDelta, -scrollTop), maxScroll - scrollTop);
  const terminal = scrollDelta - pane;
  // Math.min/max can hand back -0 at a clamped edge; the contract is +0.
  return { pane: pane === 0 ? 0 : pane, terminal: terminal === 0 ? 0 : terminal };
}

// The terminal half of a chained scroll as xterm's deltaY: finger-space CSS px back into unscaled px.
export function touchWheelDelta(terminalPx: number, scale: number): number {
  if (!(scale > 0)) {
    return terminalPx;
  }
  return terminalPx / scale;
}

// Fling: lifting a vertical drag faster than 0.3 px/ms (over its last 100 ms)
// keeps scrolling with a 0.95 decay per frame until under 0.05 px/ms.
export const FLING_WINDOW_MS = 100;
export const FLING_START_PX_PER_MS = 0.3;
export const FLING_DECAY = 0.95;
export const FLING_STOP_PX_PER_MS = 0.05;

export interface FlingSample {
  y: number; // Finger clientY in CSS px.
  t: number; // Event timeStamp in ms.
}

// Finger velocity over the samples' last 100 ms, in px/ms (positive down).
// Fewer than two samples in the window, or no time elapsed, means no fling.
export function flingVelocity(samples: readonly FlingSample[]): number {
  const end = samples[samples.length - 1];
  if (!end || samples.length < 2) {
    return 0;
  }
  const cutoff = end.t - FLING_WINDOW_MS;
  const start = samples.find((sample) => sample.t >= cutoff) ?? end;
  const dt = end.t - start.t;
  if (!(dt > 0)) {
    return 0;
  }
  return (end.y - start.y) / dt;
}

export function decayFlingVelocity(velocity: number): number {
  return velocity * FLING_DECAY;
}

export function shouldStartFling(velocity: number): boolean {
  return Math.abs(velocity) > FLING_START_PX_PER_MS;
}

export function shouldContinueFling(velocity: number): boolean {
  return Math.abs(velocity) >= FLING_STOP_PX_PER_MS;
}

export function createXtermHandle(
  host: HTMLElement,
  cols: number,
  rows: number,
): TerminalHandle {
  // DPR-gated size: at DPR 1 the WebGL backing store is the CSS size and
  // 14 px glyphs rasterise a hyphen into a single ~1 px row that reads
  // away; double the source size and let the fit scale bring it back
  // (see terminal-font.ts). The size is fixed at open — a later browser
  // zoom lands as layout and the fit scale absorbs it, no re-open.
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : undefined;
  const fontSize = terminalFontSizeForDpr(dpr);
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 2000,
    fontSize,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontWeight: 400,
    fontWeightBold: 700,
    // Box drawing and block elements are drawn by the renderer, so a
    // canopy TUI's frames never depend on a font's glyph metrics.
    customGlyphs: true,
    theme: { ...THEME },
  });
  terminal.open(host);
  // After open(): the addon needs the screen's canvas. A failure or a
  // context loss leaves xterm's DOM renderer running.
  attachWebgl(terminal);
  // Test hook: the fake host's e2e reads the active buffer through it —
  // buffer reads work under WebGL too, where the DOM carries no row text.
  (host as unknown as { __xterm?: Terminal }).__xterm = terminal;
  return {
    write: (data) => terminal.write(data),
    clear: () => terminal.clear(),
    focus: () => terminal.focus(),
    scrollToBottom: () => terminal.scrollToBottom(),
    isAtBottom: () => {
      const buffer = terminal.buffer.active;
      return buffer.viewportY >= buffer.baseY;
    },
    isAlternateBuffer: () => terminal.buffer.active.type === "alternate",
    onBufferChange: (callback) => {
      const sub = terminal.buffer.onBufferChange(() => callback());
      return () => sub.dispose();
    },
    onUserInput: (callback) => {
      const sub = terminal.onData(callback);
      return () => sub.dispose();
    },
    onScroll: (callback) => {
      const sub = terminal.onScroll(() => callback());
      return () => sub.dispose();
    },
    onReady: (callback) => {
      callback();
      return () => {};
    },
    resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
    baseScale: TERMINAL_FONT_SIZE / fontSize,
    dispose: () => terminal.dispose(),
  };
}

export interface TerminalViewCallbacks {
  onUserInput: (text: string) => void;
  onFollowChange?: (state: FollowState) => void;
  /** Fires after the zoom changed (buttons or pinch). */
  onZoomChange?: () => void;
}

export class TerminalView {
  private readonly factory: TerminalFactory;
  private readonly callbacks: TerminalViewCallbacks;
  private fit: HTMLElement | null = null;
  private scaler: HTMLElement | null = null;
  private host: HTMLElement | null = null;
  private pane: HTMLElement | null = null;
  private handle: TerminalHandle | null = null;
  private zoom = 1;
  private cols = 0;
  private rows = 0;
  private sizeOwner = false;
  private following = true;
  private alternate = false;
  private stopObserving: (() => void) | null = null;
  private paneClick: { parent: HTMLElement; handler: () => void } | null = null;
  private pinchStart: { distance: number; zoom: number } | null = null;
  private touchGesture: {
    startX: number; startY: number; lastX: number; lastY: number;
    kind: TouchGestureKind; samples: FlingSample[];
    clientX: number; clientY: number;
  } | null = null;
  private flingFrame: number | null = null;
  private generation = 0;
  private readyPromise: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | null = null;
  private pendingWrites: Uint8Array[] = [];

  constructor(factory: TerminalFactory, callbacks: TerminalViewCallbacks) {
    this.factory = factory;
    this.callbacks = callbacks;
  }

  // The scaffold: .term-pane (sizes and scrolls) > .term-fit (width
  // 100 %) > .term-scale (the visual box) > .term-host (xterm's natural
  // pixel size, shrunk by one transform:scale). The terminal opens only
  // once the real face is loaded, or the 1.5 s fallback fired.
  mount(parent: HTMLElement, cols: number, rows: number): void {
    this.dispose();
    const generation = this.generation;
    const fit = document.createElement("div");
    fit.className = "term-fit";
    const scaler = document.createElement("div");
    scaler.className = "term-scale";
    const host = document.createElement("div");
    host.className = "term-host";
    scaler.appendChild(host);
    fit.appendChild(scaler);
    parent.appendChild(fit);
    this.fit = fit;
    this.scaler = scaler;
    this.host = host;
    this.pane = parent;
    this.cols = cols;
    this.rows = rows;
    // Tapping anywhere in the pane — the terminal or its padding — focuses
    // xterm's hidden textarea so the phone keyboard opens. The listener
    // lives on the shell-owned pane (host clicks bubble up to it), so
    // dispose removes it; the fit's own listeners go with the scaffold.
    const onPaneClick = (): void => {
      if (this.handle) {
        this.handle.focus();
        return;
      }
      // Tapped while xterm is still behind the font gate: focus once it
      // opens, unless a remount or dispose replaced this attach first.
      void this.readyPromise.then(() => {
        if (this.generation === generation) {
          this.handle?.focus();
        }
      });
    };
    parent.addEventListener("click", onPaneClick);
    this.paneClick = { parent, handler: onPaneClick };
    // One-finger scroll (capture pre-empts xterm's own touch scroll; the move
    // listener is non-passive so vertical drags preventDefault, horizontal never do).
    fit.addEventListener("touchstart", (ev) => this.onTouchStart(ev), { passive: true, capture: true });
    fit.addEventListener("touchmove", (ev) => this.onTouchMove(ev), { passive: false, capture: true });
    fit.addEventListener("touchend", (ev) => this.onTouchEnd(ev), { passive: true });
    fit.addEventListener("touchcancel", () => this.onTouchCancel(), { passive: true });
    const refit = () => this.refit();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(refit);
      // Both boxes: the pane carries the panel resize (and the browser
      // zoom, which lands as layout), the fit carries the visual-height
      // settle. Neither write feeds back into the pane's own size, so the
      // observer fires at most once more per change — never a loop.
      observer.observe(parent);
      observer.observe(fit);
      this.stopObserving = () => observer.disconnect();
    } else {
      globalThis.addEventListener("resize", refit);
      this.stopObserving = () => globalThis.removeEventListener("resize", refit);
    }
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(refit);
    }
    if (typeof document !== "undefined" && "fonts" in document) {
      void document.fonts.ready.then(refit);
    }
    this.refreshFollow();
    const gate = terminalFontGate();
    if (gate) {
      this.readyPromise = new Promise<void>((resolve) => {
        this.resolveReady = resolve;
      });
      void gate.then(() => {
        if (this.host !== host || this.generation !== generation) {
          this.settleReady();
          return;
        }
        this.openTerminal();
      });
    } else {
      this.openTerminal();
      this.readyPromise = Promise.resolve();
    }
  }

  /** Resolves when xterm is open; writes made before that are buffered. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  get fitted(): boolean {
    return this.handle !== null;
  }

  get currentZoom(): number {
    return this.zoom;
  }

  get isFollowing(): boolean {
    return this.following;
  }

  /** True while xterm's alternate (fullscreen) buffer is active. */
  get isAlternate(): boolean {
    return this.alternate;
  }

  write(data: Uint8Array): void {
    if (this.handle) {
      this.handle.write(data);
      return;
    }
    this.pendingWrites.push(data);
  }

  clear(): void {
    this.pendingWrites.length = 0;
    this.handle?.clear();
  }

  focus(): void {
    this.handle?.focus();
  }

  setZoom(zoom: number): void {
    this.zoom = clampZoom(zoom);
    this.refit();
    this.callbacks.onZoomChange?.();
  }

  /** True while this device asserts the PTY size (the control-size toggle). */
  get isSizeOwner(): boolean {
    return this.sizeOwner;
  }

  // While this device owns the size the terminal is sized to the panel, so
  // it renders at its base scale times the zoom instead of being fitted;
  // the pane carries data-size-owner so the stylesheet gives the fit box a
  // height that never follows the content (rows are measured from it).
  setSizeOwner(owner: boolean): void {
    if (this.sizeOwner === owner) {
      return;
    }
    this.sizeOwner = owner;
    if (this.pane) {
      if (owner) {
        this.pane.dataset.sizeOwner = "true";
      } else {
        delete this.pane.dataset.sizeOwner;
      }
    }
    this.refit();
  }

  // The cols × rows that fit this device's panel at the current font size
  // and zoom: the cell is measured off the open terminal (screen / grid)
  // and shown at the owner scale. Null until the terminal is open and laid
  // out.
  ownedSize(): TermSize | null {
    const fit = this.fit;
    const natural = this.naturalSize();
    if (!this.handle || !fit || !natural || this.cols <= 0 || this.rows <= 0) {
      return null;
    }
    const scale = this.ownerScale();
    return computeOwnedSize(
      fit.clientWidth,
      fit.clientHeight,
      (natural.width / this.cols) * scale,
      (natural.height / this.rows) * scale,
    );
  }

  // Resizes the local terminal (the host's size changed, or this device
  // asserted its own) and refits. A terminal still behind the font gate
  // opens at the new size. False when the size is invalid or unchanged.
  resize(cols: number, rows: number): boolean {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      return false;
    }
    if (cols === this.cols && rows === this.rows) {
      return false;
    }
    this.cols = cols;
    this.rows = rows;
    this.handle?.resize?.(cols, rows);
    this.refit();
    return true;
  }

  /** The local terminal's current grid, 0 × 0 before mount. */
  get size(): TermSize {
    return { cols: this.cols, rows: this.rows };
  }

  zoomIn(): void {
    this.setZoom(this.zoom * ZOOM_STEP);
  }

  zoomOut(): void {
    this.setZoom(this.zoom / ZOOM_STEP);
  }

  scrollToLatest(): void {
    // Fullscreen has no tail to follow: latest re-shows the frame top and
    // follow stays off until the app exits back to the shell.
    if (this.alternate) {
      if (this.pane) {
        this.pane.scrollTop = 0;
      }
      this.setFollowing(false);
      return;
    }
    this.handle?.scrollToBottom();
    this.setFollowing(true);
  }

  refit(): void {
    const fit = this.fit;
    const scaler = this.scaler;
    const host = this.host;
    const natural = this.naturalSize();
    if (!fit || !scaler || !host || !natural) {
      return;
    }
    const naturalWidth = natural.width;
    const naturalHeight = natural.height;
    // Both renderers size .xterm-screen in layout px (a CSS transform does
    // not affect offsetHeight), so this is the unscaled row height.
    const rowHeight = this.rows > 0 ? naturalHeight / this.rows : FALLBACK_ROW_HEIGHT;
    // The normal buffer fits the width; the alternate (fullscreen) buffer
    // fits the whole frame into the fit box (its height is the visible
    // height, capped at 60vh by the stylesheet). Before any layout the
    // box has no height yet, so alternate falls back to the width fit.
    const fitAll = this.alternate && fit.clientHeight > 0;
    // A size owner's terminal already fits the panel by its grid: it shows
    // at the base scale times the zoom, never stretched to the width.
    const scale = this.sizeOwner
      ? this.ownerScale()
      : computeFitScale(
          fit.clientWidth,
          fit.clientHeight,
          naturalWidth,
          naturalHeight,
          this.zoom,
          fitAll,
        );
    // One scale, applied once: the host is natural-size and carries the
    // transform; the scaler is the visual box (natural × scale) that
    // clips it, so the terminal never renders at scale².
    host.style.transform = `scale(${scale})`;
    scaler.style.width = `${naturalWidth * scale}px`;
    scaler.style.height = `${naturalHeight * scale}px`;
    fit.dataset.scale = `${scale}`;
    fit.dataset.buffer = this.alternate ? "alternate" : "normal";
    fit.dataset.rowHeight = `${rowHeight}`;
    this.pane?.style.setProperty("--term-visual-h", `${naturalHeight * scale}px`);
    // A stale horizontal scroll would clip the line start after the scale
    // shrinks (open, resize, zoom out): anchor the pane at the left edge so
    // the line start is always visible. Panning right stays the user's own
    // move — scrolls never refit, so this never yanks a manual pan back.
    if (this.pane) {
      this.pane.scrollLeft = 0;
    }
  }

  // The terminal's unscaled pixel size. The scale measures the real
  // .xterm-screen, never the .xterm wrapper: the wrapper can be narrower
  // than the screen it holds, and a scale from the wrapper overflows the
  // panel on the right.
  private naturalSize(): { width: number; height: number } | null {
    const host = this.host;
    if (!host) {
      return null;
    }
    const content = host.firstElementChild ?? host;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const width = screen && screen.scrollWidth > 0 ? screen.scrollWidth : content.scrollWidth;
    const height = screen && screen.offsetHeight > 0 ? screen.offsetHeight : content.scrollHeight;
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  }

  private ownerScale(): number {
    const base = this.handle?.baseScale;
    return (base !== undefined && base > 0 ? base : 1) * this.zoom;
  }

  dispose(): void {
    this.generation += 1;
    this.settleReady();
    this.stopFling();
    this.stopObserving?.();
    this.stopObserving = null;
    if (this.paneClick) {
      this.paneClick.parent.removeEventListener("click", this.paneClick.handler);
      this.paneClick = null;
    }
    if (this.pane) {
      delete this.pane.dataset.sizeOwner;
    }
    this.sizeOwner = false;
    this.handle?.dispose();
    this.handle = null;
    this.fit?.remove();
    this.fit = null;
    this.scaler = null;
    this.host = null;
    this.pane = null;
    this.cols = 0;
    this.rows = 0;
    this.pinchStart = null;
    this.touchGesture = null;
    this.following = true;
    this.alternate = false;
    this.pendingWrites.length = 0;
  }

  private openTerminal(): void {
    const host = this.host;
    if (!host) {
      this.settleReady();
      return;
    }
    // The grid as it stands now: a resize behind the font gate counts.
    const handle = this.factory(host, this.cols, this.rows);
    this.handle = handle;
    handle.onUserInput((text) => this.callbacks.onUserInput(text));
    handle.onScroll(() => this.refreshFollow());
    // Wheel and touch scrolling never fire onScroll (xterm suppresses it on
    // the viewport path), so follow-bottom watches the viewport itself.
    host.querySelector(".xterm-viewport")?.addEventListener("scroll", () => this.refreshFollow());
    handle.onBufferChange?.(() => this.syncBufferMode());
    handle.onReady(() => this.settleReady());
    for (const data of this.pendingWrites.splice(0)) {
      handle.write(data);
    }
    this.refit();
  }

  private settleReady(): void {
    const resolve = this.resolveReady;
    this.resolveReady = null;
    resolve?.();
  }

  private refreshFollow(): void {
    // Follow-bottom is off while the alternate buffer is active: a
    // fullscreen frame has no tail to follow, only a whole screen to show.
    if (this.alternate) {
      this.setFollowing(false);
      return;
    }
    const atBottom = this.handle?.isAtBottom() ?? true;
    this.setFollowing(atBottom);
  }

  // A fullscreen app entered or left: entering drops any bottom scroll so
  // the frame paints from the top, switches follow off and refits to the
  // whole frame; leaving resumes the width fit plus follow-bottom.
  private syncBufferMode(): void {
    const alternate = this.handle?.isAlternateBuffer?.() ?? false;
    if (alternate === this.alternate) {
      return;
    }
    this.alternate = alternate;
    if (alternate) {
      this.setFollowing(false);
    } else {
      this.refreshFollow();
    }
    this.refit();
    if (alternate && this.pane) {
      this.pane.scrollTop = 0;
    }
  }

  private setFollowing(following: boolean): void {
    if (this.following === following) {
      return;
    }
    this.following = following;
    this.callbacks.onFollowChange?.({ following });
  }

  private onTouchStart(ev: TouchEvent): void {
    this.stopFling();
    if (ev.touches.length === 2) {
      // The second finger turns the gesture into the existing pinch: drop
      // one-finger tracking and let the event reach xterm untouched.
      this.touchGesture = null;
      const [a, b] = [ev.touches[0], ev.touches[1]];
      if (a && b) {
        this.pinchStart = { distance: touchDistance(a, b), zoom: this.zoom };
      }
      return;
    }
    if (ev.touches.length !== 1) {
      this.touchGesture = null;
      this.pinchStart = null;
      return;
    }
    const touch = ev.touches[0];
    if (!touch) {
      return;
    }
    this.beginGesture(touch, ev.timeStamp);
    // One finger stays with the view, never with xterm's touch scroll as well.
    ev.stopPropagation();
  }

  private onTouchMove(ev: TouchEvent): void {
    if (ev.touches.length === 2) {
      // The existing pinch, untouched — xterm still sees it as before.
      if (!this.pinchStart) {
        return;
      }
      const [a, b] = [ev.touches[0], ev.touches[1]];
      if (!a || !b) {
        return;
      }
      this.setZoom(zoomFromPinch(this.pinchStart.distance, touchDistance(a, b), this.pinchStart.zoom));
      return;
    }
    const gesture = this.touchGesture;
    const touch = ev.touches[0];
    if (!gesture || !touch || ev.touches.length !== 1) {
      return;
    }
    ev.stopPropagation();
    gesture.clientX = touch.clientX;
    gesture.clientY = touch.clientY;
    if (gesture.kind === "undecided") {
      gesture.kind = classifyTouchGesture(touch.clientX - gesture.startX, touch.clientY - gesture.startY);
      if (gesture.kind === "undecided") {
        gesture.lastX = touch.clientX;
        gesture.lastY = touch.clientY;
        return;
      }
      // The classifying move carries the whole gesture so far: nothing under 8 px is dropped.
      gesture.lastX = gesture.startX;
      gesture.lastY = gesture.startY;
    }
    if (gesture.kind === "horizontal") {
      // Left to the browser: the zoomed pane pans sideways natively.
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
      return;
    }
    ev.preventDefault();
    gesture.samples.push({ y: touch.clientY, t: ev.timeStamp });
    const fingerDy = touch.clientY - gesture.lastY;
    gesture.lastX = touch.clientX;
    gesture.lastY = touch.clientY;
    this.applyTouchScroll(fingerDy, touch.clientX, touch.clientY);
  }

  private onTouchEnd(ev: TouchEvent): void {
    this.pinchStart = null;
    const gesture = this.touchGesture;
    if (ev.touches.length === 1) {
      // A lifted finger leaves one behind: it starts a fresh gesture from
      // where it is, never a jump from the old anchor.
      const touch = ev.touches[0];
      this.touchGesture = null;
      if (touch) {
        this.beginGesture(touch, ev.timeStamp);
      }
      return;
    }
    this.touchGesture = null;
    if (ev.touches.length !== 0 || !gesture || gesture.kind !== "vertical") {
      return;
    }
    // A tap and a horizontal drag never fling; a fast vertical tail does.
    const lifted = ev.changedTouches[0];
    const samples = lifted ? [...gesture.samples, { y: lifted.clientY, t: ev.timeStamp }] : gesture.samples;
    const velocity = flingVelocity(samples);
    if (shouldStartFling(velocity)) {
      this.startFling(velocity, gesture.clientX, gesture.clientY);
    }
  }

  private onTouchCancel(): void {
    this.pinchStart = null;
    this.touchGesture = null;
  }

  private beginGesture(touch: Touch, timeStamp: number): void {
    this.touchGesture = {
      startX: touch.clientX, startY: touch.clientY,
      lastX: touch.clientX, lastY: touch.clientY,
      kind: "undecided",
      samples: [{ y: touch.clientY, t: timeStamp }],
      clientX: touch.clientX, clientY: touch.clientY,
    };
  }

  // One vertical step in finger space (positive when the finger moved down):
  // the pane absorbs what it can while zoomed, the rest reaches xterm as a
  // synthetic wheel on .xterm — history scroll or mouse reports, like a real wheel.
  private applyTouchScroll(fingerDy: number, clientX: number, clientY: number): void {
    const scrollDelta = -fingerDy;
    if (scrollDelta === 0) {
      return;
    }
    let terminalPx = scrollDelta;
    const pane = this.pane;
    if (pane) {
      const split = splitTouchScroll(scrollDelta, pane.scrollTop, pane.scrollHeight, pane.clientHeight);
      if (split.pane !== 0) {
        pane.scrollTop += split.pane;
      }
      terminalPx = split.terminal;
    }
    if (terminalPx === 0) {
      return;
    }
    const target = this.host?.querySelector(".xterm");
    if (!target) {
      return;
    }
    target.dispatchEvent(
      new WheelEvent("wheel", {
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: 0,
        deltaY: touchWheelDelta(terminalPx, this.currentScale()),
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  private currentScale(): number {
    const scale = Number(this.fit?.dataset.scale);
    return scale > 0 ? scale : 1;
  }

  private startFling(velocity: number, clientX: number, clientY: number): void {
    this.stopFling();
    if (typeof globalThis.requestAnimationFrame !== "function") {
      return;
    }
    let speed = velocity;
    let previous = -1;
    const step = (now: number): void => {
      if (this.flingFrame === null) {
        return;
      }
      if (previous < 0) {
        previous = now;
      } else {
        const dt = now - previous;
        previous = now;
        if (dt > 0) {
          this.applyTouchScroll(speed * dt, clientX, clientY);
        }
      }
      speed = decayFlingVelocity(speed);
      if (!shouldContinueFling(speed)) {
        this.flingFrame = null;
        return;
      }
      this.flingFrame = globalThis.requestAnimationFrame(step);
    };
    this.flingFrame = globalThis.requestAnimationFrame(step);
  }

  private stopFling(): void {
    if (this.flingFrame !== null) {
      globalThis.cancelAnimationFrame(this.flingFrame);
      this.flingFrame = null;
    }
  }
}
