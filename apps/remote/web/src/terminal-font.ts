// SPDX-License-Identifier: Apache-2.0
// The terminal face is JetBrains Mono (self-hosted, unsubset, see
// terminal-font.css). xterm measures its cell size when it opens, so the
// terminal must not open before the face is there — otherwise a Latin
// fallback sets the cell size and the box drawing of a canopy session
// misaligns. We wait for document.fonts.load, but never longer than 1.5 s:
// a slow network must not leave the operator with no terminal at all.

export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", ui-monospace, monospace';
export const TERMINAL_FONT_SIZE = 14;
export const TERMINAL_FONT_SPEC = `${TERMINAL_FONT_SIZE}px "JetBrains Mono"`;
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
