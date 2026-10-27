// SPDX-License-Identifier: Apache-2.0
// The host PTY on the phone: an xterm.js terminal created once with the
// snapshot's cols and rows — the browser never resizes the host — scaled
// exactly once. .term-host keeps xterm's natural pixel size and
// transform:scale(s) does the scaling; the surrounding .term-scale is the
// visual box (natural × s) and .term-fit holds it. The pane itself is the
// scroller (overflow:auto), so when the readable floor wins on a phone the
// 80-column session pans inside the terminal card and the page never
// scrolls sideways. Pinch or the +/− buttons zoom on top of either mode,
// output follows the bottom unless the user scrolled up, and tapping the
// terminal focuses xterm's hidden textarea so the soft keyboard opens and
// typed characters come back through onData as input.
//
// The fitted scale is max(paneWidth / terminalWidth, minScale), where
// minScale = 11 / rowHeight: a phone never renders a session smaller than
// an 11 CSS px glyph. The Fit toggle drops the floor and fits the width.

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  terminalFontGate,
} from "./terminal-font.js";
import { THEME } from "./terminal-theme.js";
import { attachWebgl } from "./terminal-webgl.js";

export interface FollowState {
  following: boolean;
}

export interface TerminalHandle {
  write: (text: string) => void;
  clear: () => void;
  focus: () => void;
  scrollToBottom: () => void;
  isAtBottom: () => boolean;
  onUserInput: (callback: (text: string) => void) => () => void;
  onScroll: (callback: () => void) => () => void;
  /** Fires once the terminal is open (and the WebGL attempt settled). */
  onReady: (callback: () => void) => () => void;
  dispose: () => void;
}

export type TerminalFactory = (host: HTMLElement, cols: number, rows: number) => TerminalHandle;

export interface TerminalViewOptions {
  /** Pure fit-to-width when true; the readable floor when false. */
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

// Base scale: the larger of fit-to-width and the readable floor, times the
// zoom. A minScale of 0 is pure fit-to-width (the Fit toggle).
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
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 2000,
    fontSize: TERMINAL_FONT_SIZE,
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
  return {
    write: (text) => terminal.write(text),
    clear: () => terminal.clear(),
    focus: () => terminal.focus(),
    scrollToBottom: () => terminal.scrollToBottom(),
    isAtBottom: () => {
      const buffer = terminal.buffer.active;
      return buffer.viewportY >= buffer.baseY;
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
  private stopObserving: (() => void) | null = null;
  private pinchStart: { distance: number; zoom: number } | null = null;
  private generation = 0;
  private readyPromise: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | null = null;
  private pendingWrites: string[] = [];

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

  get isFitOnly(): boolean {
    return this.fitOnly;
  }

  write(text: string): void {
    if (this.handle) {
      this.handle.write(text);
      return;
    }
    this.pendingWrites.push(text);
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

  setFitOnly(fitOnly: boolean): void {
    if (this.fitOnly === fitOnly) {
      return;
    }
    this.fitOnly = fitOnly;
    this.refit();
  }

  scrollToLatest(): void {
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
    const naturalWidth = content.scrollWidth;
    const screen = host.querySelector<HTMLElement>(".xterm-screen");
    const naturalHeight =
      screen && screen.offsetHeight > 0 ? screen.offsetHeight : content.scrollHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) {
      return;
    }
    // Both renderers size .xterm-screen in layout px (a CSS transform does
    // not affect offsetHeight), so this is the unscaled row height.
    const rowHeight = this.rows > 0 ? naturalHeight / this.rows : FALLBACK_ROW_HEIGHT;
    const minScale = this.fitOnly ? 0 : computeMinScale(rowHeight);
    const scale = computeScale(fit.clientWidth, naturalWidth, this.zoom, minScale);
    // One scale, applied once: the host is natural-size and carries the
    // transform; the scaler is the visual box (natural × scale) that
    // clips it, so the terminal never renders at scale².
    host.style.transform = `scale(${scale})`;
    scaler.style.width = `${naturalWidth * scale}px`;
    scaler.style.height = `${naturalHeight * scale}px`;
    fit.dataset.scale = `${scale}`;
    fit.dataset.rowHeight = `${rowHeight}`;
    fit.dataset.fit = this.fitOnly ? "on" : "off";
    this.pane?.style.setProperty("--term-visual-h", `${naturalHeight * scale}px`);
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
    handle.onReady(() => this.settleReady());
    for (const text of this.pendingWrites.splice(0)) {
      handle.write(text);
    }
    this.refit();
  }

  private settleReady(): void {
    const resolve = this.resolveReady;
    this.resolveReady = null;
    resolve?.();
  }

  private refreshFollow(): void {
    const atBottom = this.handle?.isAtBottom() ?? true;
    this.setFollowing(atBottom);
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
