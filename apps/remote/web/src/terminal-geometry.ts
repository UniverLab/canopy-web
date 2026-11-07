// SPDX-License-Identifier: Apache-2.0
// The terminal's pure geometry: zoom clamps, fit scales, the owned size a
// device asserts while it controls the PTY, and the touch scroll and fling
// math. No DOM, no xterm — the view and the unit tests share it. Split
// out of terminal.ts to keep the view a readable size.

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 3;
// The smallest glyph height a session may render at, in CSS px.
export const MIN_GLYPH_PX = 11;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

// While this device owns the size the zoom never shrinks the rendering
// below its natural scale: a fitted grid at zoom < 1 would leave the card
// half empty with no way back, so the owner floor is 1. Snapshot mode
// keeps the global floor — shrinking a fixed snapshot stays useful there.
export function clampOwnerZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(1, zoom));
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

// The owner's chosen width in columns: the slider names cols directly,
// still inside the owned bounds. Rows always stay fitted to the panel,
// so the slider reflows the width without ever zooming the glyphs.
export function setOwnedWidth(size: TermSize, cols: number): TermSize {
  return {
    cols: clampInt(Math.round(cols), OWNED_MIN_COLS, OWNED_MAX_COLS),
    rows: size.rows,
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
