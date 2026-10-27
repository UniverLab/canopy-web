// SPDX-License-Identifier: Apache-2.0
// The host PTY on the phone: an xterm.js terminal created once with the
// snapshot's cols and rows — the browser never resizes the host — scaled
// with a CSS transform so its full width fits the screen. Pinch or the
// +/− buttons zoom, scrolling stays inside xterm's own viewport, output
// follows the bottom unless the user scrolled up, and tapping the
// terminal focuses xterm's hidden textarea so the soft keyboard opens and
// typed characters come back through onData as input.

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";

export type TerminalTheme = "light" | "dark";

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
  dispose: () => void;
}

export type TerminalFactory = (host: HTMLElement, cols: number, rows: number) => TerminalHandle;

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

// Base scale so the terminal's full width fits the pane, times the zoom.
export function computeScale(paneWidth: number, contentWidth: number, zoom: number): number {
  if (paneWidth <= 0 || contentWidth <= 0) {
    return 1;
  }
  return (paneWidth / contentWidth) * clampZoom(zoom);
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

function systemTheme(): TerminalTheme {
  if (typeof globalThis.matchMedia === "function") {
    return globalThis.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

const THEMES = {
  dark: { background: "#0c0c0c", foreground: "#e8e6e1", cursor: "#3fb8b0" },
  light: { background: "#faf8f4", foreground: "#1d1510", cursor: "#0e7c76" },
} as const;

export function createXtermHandle(
  host: HTMLElement,
  cols: number,
  rows: number,
  theme?: TerminalTheme,
): TerminalHandle {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 2000,
    fontSize: 14,
    fontFamily: `"Sometype Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
    theme: { ...THEMES[theme ?? systemTheme()] },
  });
  terminal.open(host);
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
  private handle: TerminalHandle | null = null;
  private zoom = 1;
  private following = true;
  private stopObserving: (() => void) | null = null;
  private pinchStart: { distance: number; zoom: number } | null = null;

  constructor(factory: TerminalFactory, callbacks: TerminalViewCallbacks) {
    this.factory = factory;
    this.callbacks = callbacks;
  }

  // The scaffold: .term-fit (the pane, clips) > .term-scale (the CSS
  // transform) > .term-host (xterm's own fixed pixel size).
  mount(parent: HTMLElement, cols: number, rows: number): void {
    this.dispose();
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
    this.handle = this.factory(host, cols, rows);
    this.handle.onUserInput((text) => this.callbacks.onUserInput(text));
    this.handle.onScroll(() => this.refreshFollow());
    host.addEventListener("click", () => this.handle?.focus());
    fit.addEventListener("touchstart", (ev) => this.onTouchStart(ev), { passive: true });
    fit.addEventListener("touchmove", (ev) => this.onTouchMove(ev), { passive: true });
    fit.addEventListener("touchend", () => {
      this.pinchStart = null;
    });
    const refit = () => this.refit();
    if (typeof ResizeObserver !== "undefined" && fit) {
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

  write(text: string): void {
    this.handle?.write(text);
  }

  clear(): void {
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
    const scale = computeScale(fit.clientWidth, content.scrollWidth, this.zoom);
    scaler.style.transform = `scale(${scale})`;
    scaler.style.width = `${content.scrollWidth * scale}px`;
    scaler.style.height = `${content.scrollHeight * scale}px`;
  }

  dispose(): void {
    this.stopObserving?.();
    this.stopObserving = null;
    this.handle?.dispose();
    this.handle = null;
    this.fit?.remove();
    this.fit = null;
    this.scaler = null;
    this.host = null;
    this.pinchStart = null;
    this.following = true;
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
