// SPDX-License-Identifier: Apache-2.0
// The terminal's palette. The surface is the kit's black stage (#050505),
// so the 16 ANSI colours are tuned to it instead of being xterm's
// defaults. The hues come from canopy's TUI (src/tui/ui/theme.rs):
// status_ok #42a5f5, status_fail #e53935, interrupted #ffb300, router
// #ab47bc and the canopy teal #3fb8b0, adjusted in lightness only until
// every colour except black clears 4.5:1 against the surface. Blue and
// bright blue are the dim chrome of a session (borders, hints), so they
// only need 3:1 — in practice they clear 4.5:1 too. Truecolor SGR is
// passed through as-is: the theme never sets minimumContrastRatio, which
// would rewrite it.

export const TERMINAL_BACKGROUND = "#050505";

export const THEME = {
  background: TERMINAL_BACKGROUND,
  foreground: "#edfffe",
  cursor: "#3fb8b0",
  selectionBackground: "#10554f",
  black: "#123330",
  red: "#e84e4a",
  green: "#2ea862",
  yellow: "#ffb300",
  blue: "#42a5f5",
  magenta: "#b863c6",
  cyan: "#3fb8b0",
  white: "#edfffe",
  brightBlack: "#7d928f",
  brightRed: "#ef8683",
  brightGreen: "#81c784",
  brightYellow: "#ffca28",
  brightBlue: "#90caf9",
  brightMagenta: "#cd91d7",
  brightCyan: "#7fe3dc",
  brightWhite: "#f4fffe",
} as const;
