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

import { openPhoneKeyboard } from "./phone-keyboard.js";
import { terminalFontGate } from "./terminal-font.js";
import type { TerminalFactory, TerminalHandle } from "./terminal-handle.js";
import {
  classifyTouchGesture,
  clampZoom,
  computeFitScale,
  computeOwnedSize,
  decayFlingVelocity,
  flingVelocity,
  shouldContinueFling,
  shouldStartFling,
  splitTouchScroll,
  touchWheelDelta,
  zoomFromPinch,
} from "./terminal-geometry.js";
import type { FlingSample, TermSize, TouchGestureKind } from "./terminal-geometry.js";

// Re-exported from the split modules so the terminal keeps one import.
export {
  FLING_DECAY,
  FLING_START_PX_PER_MS,
  FLING_STOP_PX_PER_MS,
  FLING_WINDOW_MS,
  MAX_ZOOM,
  MIN_GLYPH_PX,
  MIN_ZOOM,
  OWNED_MAX_COLS,
  OWNED_MAX_ROWS,
  OWNED_MIN_COLS,
  OWNED_MIN_ROWS,
  TOUCH_GESTURE_PX,
  classifyTouchGesture,
  clampZoom,
  computeFitScale,
  computeMinScale,
  computeOwnedSize,
  computeScale,
  decayFlingVelocity,
  flingVelocity,
  scaleOwnedSize,
  shouldContinueFling,
  shouldStartFling,
  splitTouchScroll,
  touchWheelDelta,
  zoomFromPinch,
} from "./terminal-geometry.js";
export type {
  FlingSample,
  TermSize,
  TouchGestureKind,
  TouchScrollSplit,
} from "./terminal-geometry.js";
export { bufferLinesToText } from "./term-copy.js";
export type { BufferLike, BufferLineLike } from "./term-copy.js";
export { createXtermHandle } from "./terminal-handle.js";
export type { TerminalFactory, TerminalHandle } from "./terminal-handle.js";

export interface FollowState {
  following: boolean;
}

// The zoom buttons multiply and divide by this.
const ZOOM_STEP = 1.25;
// Used only when xterm has not been measured yet (no layout at all).
const FALLBACK_ROW_HEIGHT = 17;

function touchDistance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
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
  private selectionListeners = new Set<() => void>();

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
        openPhoneKeyboard(this);
        return;
      }
      // Tapped while xterm is still behind the font gate: focus once it
      // opens, unless a remount or dispose replaced this attach first.
      void this.readyPromise.then(() => {
        if (this.generation === generation) {
          openPhoneKeyboard(this);
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

  blur(): void {
    this.handle?.blur();
  }

  /** The current drag selection, or "" while closed or unselected. */
  getSelection(): string {
    return this.handle?.getSelection() ?? "";
  }

  /**
   * Fires when the drag selection changes. Subscribing before xterm opens
   * is fine: the view forwards to the handle once it exists.
   */
  onSelectionChange(callback: () => void): () => void {
    this.selectionListeners.add(callback);
    return () => {
      this.selectionListeners.delete(callback);
    };
  }

  /** The last maxLines logical lines of the active buffer, or "" while closed. */
  bufferText(maxLines: number): string {
    return this.handle?.bufferText(maxLines) ?? "";
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
    this.selectionListeners.clear();
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
    handle.onSelectionChange(() => this.emitSelectionChange());
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

  private emitSelectionChange(): void {
    for (const listener of [...this.selectionListeners]) {
      listener();
    }
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
