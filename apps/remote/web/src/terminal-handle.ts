// SPDX-License-Identifier: Apache-2.0
// The production terminal handle: xterm.js opened once with the
// snapshot's grid, behind the TerminalHandle the views drive. Split out
// of terminal.ts to keep the view a readable size.

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { bufferLinesToText, handleCopyKeydown } from "./term-copy.js";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  terminalFontSizeForDpr,
} from "./terminal-font.js";
import { THEME } from "./terminal-theme.js";
import { attachWebgl } from "./terminal-webgl.js";

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
  /** The current drag selection, or "" when there is none. */
  getSelection: () => string;
  /** Fires when the drag selection changes. */
  onSelectionChange: (callback: () => void) => () => void;
  /** The last maxLines logical lines of the active buffer as plain text. */
  bufferText: (maxLines: number) => string;
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
  // Ctrl+Shift+C with a selection copies instead of reaching the session;
  // every other key (plain Ctrl+C included) still goes through.
  terminal.attachCustomKeyEventHandler((ev) => handleCopyKeydown(ev, () => terminal.getSelection()));
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
    getSelection: () => terminal.getSelection(),
    onSelectionChange: (callback) => {
      const sub = terminal.onSelectionChange(() => callback());
      return () => sub.dispose();
    },
    bufferText: (maxLines) => bufferLinesToText(terminal.buffer.active, maxLines),
    resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
    baseScale: TERMINAL_FONT_SIZE / fontSize,
    dispose: () => terminal.dispose(),
  };
}
