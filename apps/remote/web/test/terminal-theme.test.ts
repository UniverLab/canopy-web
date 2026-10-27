// SPDX-License-Identifier: Apache-2.0
// The palette rule from the spec: every normal and bright ANSI colour
// except black clears 4.5:1 against the terminal surface, and the two
// blues (dim chrome) clear 3:1. Contrast is computed here, not stored, so
// a later hue change has to face the same rule.
import { describe, expect, it } from "vitest";
import { TERMINAL_BACKGROUND, THEME } from "../src/terminal-theme.js";

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function channel(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const parts = hex.replace("#", "").match(/../g) ?? [];
  const [r, g, b] = parts.map((part) => channel(parseInt(part, 16) / 255));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("terminal palette", () => {
  it("defines all 16 ANSI colours and a selection background", () => {
    expect(ANSI).toHaveLength(16);
    for (const key of ANSI) {
      expect(THEME[key], key).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(THEME.selectionBackground).toMatch(/^#[0-9a-f]{6}$/);
    expect(THEME.background).toBe(TERMINAL_BACKGROUND);
    // The canopy teal is the cursor.
    expect(THEME.cursor).toBe("#3fb8b0");
  });

  it("keeps every colour but black at 4.5:1 on the #011d1c surface", () => {
    for (const key of ANSI) {
      if (key === "black") {
        continue;
      }
      expect(contrast(THEME[key], TERMINAL_BACKGROUND), key).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps blue and bright blue usable as dim chrome (3:1)", () => {
    expect(contrast(THEME.blue, TERMINAL_BACKGROUND)).toBeGreaterThanOrEqual(3);
    expect(contrast(THEME.brightBlue, TERMINAL_BACKGROUND)).toBeGreaterThanOrEqual(3);
  });
});
