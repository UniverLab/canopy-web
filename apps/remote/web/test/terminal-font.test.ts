// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_FONT_SPEC,
  TERMINAL_FONT_TIMEOUT_MS,
  terminalFontGate,
} from "../src/terminal-font.js";

function installFonts(load: (font: string) => Promise<unknown>): void {
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

  it("resolves once the real face is loaded", async () => {
    const load = vi.fn(() => Promise.resolve([]));
    installFonts(load);
    await terminalFontGate();
    expect(load).toHaveBeenCalledWith(TERMINAL_FONT_SPEC);
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
