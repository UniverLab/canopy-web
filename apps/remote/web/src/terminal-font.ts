// SPDX-License-Identifier: Apache-2.0
// The terminal face is JetBrains Mono (self-hosted, unsubset, see
// terminal-font.css). xterm measures its cell size when it opens, so the
// terminal must not open before the face is there — otherwise a Latin
// fallback sets the cell size and the box drawing of a canopy session
// misaligns. We wait for document.fonts.load, but never longer than 1.5 s:
// a slow network must not leave the operator with no terminal at all.

export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", ui-monospace, monospace';
export const TERMINAL_FONT_SIZE = 14;
// DPR-1 fallback size: at devicePixelRatio 1 the WebGL backing store is the
// CSS size with no supersampling, so JetBrains Mono's cells hold only
// 14 device px and a hyphen rasterises as a single ~1 px row — it reads
// as a space (audit U5, 2026-11-01: at DPR 1 the VIA-TECLADO hyphen cell
// kept 5 pixels above half foreground brightness where letters kept
// 22-32). Opening the terminal at double size rasterises the glyphs at
// twice the resolution and the fit-to-width scale (one transform, never
// two) brings the visual size back down, so a hyphen renders from a
// ~2 px-thick raster instead. DPR 2+ already renders fine and the
// browser zoom re-rasterises on its own, so those keep the default size.
export const TERMINAL_FONT_SIZE_DPR1 = 28;
// A DPR at or below 1.05 counts as DPR 1: common desktop monitors and the
// window sizes of a zoomed-out browser tab land here, and fractional
// scales above it (125 %, 150 %) already rasterise a thicker stroke.
export const TERMINAL_DPR_1_LIMIT = 1.05;
export const TERMINAL_FONT_SPEC = `${TERMINAL_FONT_SIZE}px "JetBrains Mono"`;

// The size createXtermHandle opens with: the double-size fallback at DPI 1,
// the measured default everywhere else. An unknown or invalid DPR counts
// as DPR 1: the thinnest known case decides, and legible beats sharp.
export function terminalFontSizeForDpr(dpr: number | undefined | null): number {
  if (!(dpr != null && dpr > TERMINAL_DPR_1_LIMIT)) {
    return TERMINAL_FONT_SIZE_DPR1;
  }
  return TERMINAL_FONT_SIZE;
}
export const TERMINAL_FONT_TIMEOUT_MS = 1500;

// Null means there is nothing to wait for (no Font Loading API, as in
// happy-dom), so the caller can open the terminal synchronously.
export function terminalFontGate(): Promise<void> | null {
  if (typeof document === "undefined") {
    return null;
  }
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== "function") {
    return null;
  }
  let loaded: Promise<unknown>;
  try {
    loaded = fonts.load(TERMINAL_FONT_SPEC);
  } catch {
    return null;
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TERMINAL_FONT_TIMEOUT_MS);
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    loaded.then(settle, settle);
  });
}
