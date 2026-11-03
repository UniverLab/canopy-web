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
// and on buffer change with no manual Fit press. Every refit anchors the
// pane at scrollLeft 0, so the line start stays visible and a stale
// scroll never clips the left edge. The Fit toggle remains as a harmless
// remembered affordance that no longer changes the scale.

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import {
  TERMINAL_FONT_FAMILY,
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
  dispose: () => void;
}

export type TerminalFactory = (host: HTMLElement, cols: number, rows: number) => TerminalHandle;

export interface TerminalViewOptions {
  /**
   * Remembered Fit affordance only: the view always fits the pane width,
   * so this no longer changes the scale. Kept so the button's wiring and
   * the per-device preference keep working as a harmless no-op.
   */
  fitOnly?: boolean;
}

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
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 2000,
    fontSize: terminalFontSizeForDpr(dpr),
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
    dispose: () => terminal.dispose(),
  };
}

export interface TerminalViewCallbacks {
  onUserInput: (text: string) => void;
  onFollowChange?: (state: FollowState) => void;
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
  private fitOnly: boolean;
  private rows = 0;
  private following = true;
  private alternate = false;
  private stopObserving: (() => void) | null = null;
  private pinchStart: { distance: number; zoom: number } | null = null;
  private generation = 0;
  private readyPromise: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | null = null;
  private pendingWrites: Uint8Array[] = [];

  constructor(
    factory: TerminalFactory,
    callbacks: TerminalViewCallbacks,
    options?: TerminalViewOptions,
  ) {
    this.factory = factory;
    this.callbacks = callbacks;
    this.fitOnly = options?.fitOnly ?? false;
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
    this.rows = rows;
    host.addEventListener("click", () => this.handle?.focus());
    fit.addEventListener("touchstart", (ev) => this.onTouchStart(ev), { passive: true });
    fit.addEventListener("touchmove", (ev) => this.onTouchMove(ev), { passive: true });
    fit.addEventListener("touchend", () => {
      this.pinchStart = null;
    });
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
        this.openTerminal(cols, rows);
      });
    } else {
      this.openTerminal(cols, rows);
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

  get isFitOnly(): boolean {
    return this.fitOnly;
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
  }

  zoomIn(): void {
    this.setZoom(this.zoom * ZOOM_STEP);
  }

  zoomOut(): void {
    this.setZoom(this.zoom / ZOOM_STEP);
  }

  /**
   * The Fit button's remembered state; kept as a harmless no-op (the view
   * always fits). It mirrors the flag to the dataset only — never a refit,
   * which would yank a manual pan back to the left edge.
   */
  setFitOnly(fitOnly: boolean): void {
    if (this.fitOnly === fitOnly) {
      return;
    }
    this.fitOnly = fitOnly;
    if (this.fit) {
      this.fit.dataset.fit = fitOnly ? "on" : "off";
    }
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
    if (!fit || !scaler || !host) {
      return;
    }
    const content = host.firstElementChild ?? host;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    // The scale measures the real .xterm-screen, never the .xterm wrapper:
    // the wrapper can be narrower than the screen it holds, and a scale
    // from the wrapper overflows the panel on the right.
    const naturalWidth =
      screen && screen.scrollWidth > 0 ? screen.scrollWidth : content.scrollWidth;
    const naturalHeight =
      screen && screen.offsetHeight > 0 ? screen.offsetHeight : content.scrollHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) {
      return;
    }
    // Both renderers size .xterm-screen in layout px (a CSS transform does
    // not affect offsetHeight), so this is the unscaled row height.
    const rowHeight = this.rows > 0 ? naturalHeight / this.rows : FALLBACK_ROW_HEIGHT;
    // The normal buffer fits the width; the alternate (fullscreen) buffer
    // fits the whole frame into the fit box (its height is the visible
    // height, capped at 60vh by the stylesheet). Before any layout the
    // box has no height yet, so alternate falls back to the width fit.
    const fitAll = this.alternate && fit.clientHeight > 0;
    const scale = computeFitScale(
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
    fit.dataset.fit = this.fitOnly ? "on" : "off";
    this.pane?.style.setProperty("--term-visual-h", `${naturalHeight * scale}px`);
    // A stale horizontal scroll would clip the line start after the scale
    // shrinks (open, resize, zoom out): anchor the pane at the left edge so
    // the line start is always visible. Panning right stays the user's own
    // move — scrolls never refit, so this never yanks a manual pan back.
    if (this.pane) {
      this.pane.scrollLeft = 0;
    }
  }

  dispose(): void {
    this.generation += 1;
    this.settleReady();
    this.stopObserving?.();
    this.stopObserving = null;
    this.handle?.dispose();
    this.handle = null;
    this.fit?.remove();
    this.fit = null;
    this.scaler = null;
    this.host = null;
    this.pane = null;
    this.rows = 0;
    this.pinchStart = null;
    this.following = true;
    this.alternate = false;
    this.pendingWrites.length = 0;
  }

  private openTerminal(cols: number, rows: number): void {
    const host = this.host;
    if (!host) {
      this.settleReady();
      return;
    }
    const handle = this.factory(host, cols, rows);
    this.handle = handle;
    handle.onUserInput((text) => this.callbacks.onUserInput(text));
    handle.onScroll(() => this.refreshFollow());
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
    if (ev.touches.length === 2) {
      const [a, b] = [ev.touches[0], ev.touches[1]];
      if (a && b) {
        this.pinchStart = { distance: touchDistance(a, b), zoom: this.zoom };
      }
    }
  }

  private onTouchMove(ev: TouchEvent): void {
    if (ev.touches.length !== 2 || !this.pinchStart) {
      return;
    }
    const [a, b] = [ev.touches[0], ev.touches[1]];
    if (!a || !b) {
      return;
    }
    this.setZoom(zoomFromPinch(this.pinchStart.distance, touchDistance(a, b), this.pinchStart.zoom));
  }
}
