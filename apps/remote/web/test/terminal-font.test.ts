// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_DPR_1_LIMIT,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_DPR1,
  TERMINAL_FONT_SPEC,
  TERMINAL_FONT_TIMEOUT_MS,
  TERMINAL_SYMBOL_SAMPLE,
  TERMINAL_SYMBOL_SPEC,
  terminalFontGate,
  terminalFontSizeForDpr,
} from "../src/terminal-font.js";

function installFonts(load: (font: string, text?: string) => Promise<unknown>): void {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load },
  });
}

describe("terminalFontGate", () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "fonts");
  });

  it("does not wait when the Font Loading API is absent", () => {
    expect("fonts" in document).toBe(false);
    expect(terminalFontGate()).toBeNull();
  });

  it("stacks Canopy Symbols behind JetBrains Mono", () => {
    expect(TERMINAL_FONT_FAMILY).toBe(
      '"JetBrains Mono", "Canopy Symbols", ui-monospace, monospace',
    );
  });

  it("resolves once the real face is loaded", async () => {
    const load = vi.fn(() => Promise.resolve([]));
    installFonts(load);
    await terminalFontGate();
    expect(load).toHaveBeenCalledWith(TERMINAL_FONT_SPEC);
  });

  it("waits for the symbols face with sample text from its range", async () => {
    const load = vi.fn(() => Promise.resolve([]));
    installFonts(load);
    await terminalFontGate();
    expect(load).toHaveBeenCalledWith(TERMINAL_SYMBOL_SPEC, TERMINAL_SYMBOL_SAMPLE);
    expect(load).toHaveBeenCalledTimes(2);
    // JetBrains Mono first: the cell size is measured from that face.
    expect(vi.mocked(load).mock.calls[0]).toEqual([TERMINAL_FONT_SPEC]);
  });

  it("samples a code point the symbols face covers", () => {
    expect(TERMINAL_SYMBOL_SAMPLE).toBe("⏵");
    expect(TERMINAL_SYMBOL_SPEC).toContain("Canopy Symbols");
  });

  it("resolves when the load rejects", async () => {
    installFonts(() => Promise.reject(new Error("offline")));
    await expect(terminalFontGate()).resolves.toBeUndefined();
  });

  it("falls back after 1.5 s when the face never arrives", async () => {
    vi.useFakeTimers();
    installFonts(() => new Promise(() => {}));
    const gate = terminalFontGate();
    let settled = false;
    void gate?.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(TERMINAL_FONT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});

// The DPR gate carves out the ~1-DPR displays only: the default size
// (14, the measured face size) stays for DPR 2+, where the WebGL backing
// store already rasterises every glyph at twice the density, and only a
// display below the limit opens at the double size.
describe("terminalFontSizeForDpr", () => {
  it("defaults to 14: the measured size stays the default", () => {
    expect(TERMINAL_FONT_SIZE).toBe(14);
    expect(TERMINAL_FONT_SIZE_DPR1).toBe(28);
  });

  it("opens at the double size at DPR 1 and below", () => {
    expect(terminalFontSizeForDpr(1)).toBe(TERMINAL_FONT_SIZE_DPR1);
    expect(terminalFontSizeForDpr(0.5)).toBe(TERMINAL_FONT_SIZE_DPR1);
  });

  it("opens at the double size when the DPR is unknown or broken", () => {
    expect(terminalFontSizeForDpr(undefined)).toBe(TERMINAL_FONT_SIZE_DPR1);
    expect(terminalFontSizeForDpr(null)).toBe(TERMINAL_FONT_SIZE_DPR1);
    expect(terminalFontSizeForDpr(0)).toBe(TERMINAL_FONT_SIZE_DPR1);
  });

  it("keeps the double size at fractional DPRs just below the limit", () => {
    // A 1.05 DPR (105 % browser zoom over a 1-DPR display) is still DPR 1's
    // thin raster; 1.1 is not.
    expect(terminalFontSizeForDpr(TERMINAL_DPR_1_LIMIT)).toBe(TERMINAL_FONT_SIZE_DPR1);
    expect(terminalFontSizeForDpr(TERMINAL_DPR_1_LIMIT + 0.001)).toBe(TERMINAL_FONT_SIZE);
  });

  it("opens at 14 at DPR 2+: those rasters are already dense", () => {
    expect(terminalFontSizeForDpr(2)).toBe(TERMINAL_FONT_SIZE);
    expect(terminalFontSizeForDpr(3)).toBe(TERMINAL_FONT_SIZE);
    expect(terminalFontSizeForDpr(1.25)).toBe(TERMINAL_FONT_SIZE);
  });
});
