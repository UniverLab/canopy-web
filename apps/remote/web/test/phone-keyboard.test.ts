// SPDX-License-Identifier: Apache-2.0
// The phone-keyboard helpers: the keyboard-open threshold and the two
// focus rules the key bar and the terminal pane use.
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropIdleFocus, keyboardOpen, openPhoneKeyboard } from "../src/phone-keyboard.js";

interface Call {
  name: "focus" | "blur";
}

function fakeView(): { calls: Call[]; focus(): void; blur(): void } {
  const calls: Call[] = [];
  return {
    calls,
    focus() {
      calls.push({ name: "focus" });
    },
    blur() {
      calls.push({ name: "blur" });
    },
  };
}

function setPointer(fine: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: fine && query === "(pointer: fine)",
  }));
}

function setViewport(height: number | null, layoutHeight: number): void {
  vi.stubGlobal("visualViewport", height === null ? null : { height });
  vi.stubGlobal("innerHeight", layoutHeight);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("keyboardOpen", () => {
  it("is true only once the keyboard hides more than 120 px", () => {
    expect(keyboardOpen({ height: 640 - 121 }, 640)).toBe(true);
    expect(keyboardOpen({ height: 640 - 120 }, 640)).toBe(false);
    expect(keyboardOpen({ height: 640 }, 640)).toBe(false);
  });

  it("is false when visualViewport is missing", () => {
    expect(keyboardOpen(null, 640)).toBe(false);
    expect(keyboardOpen(undefined, 640)).toBe(false);
  });

  it("reads window.visualViewport and window.innerHeight by default", () => {
    setViewport(340, 640);
    expect(keyboardOpen()).toBe(true);
    setViewport(600, 640);
    expect(keyboardOpen()).toBe(false);
    setViewport(null, 640);
    expect(keyboardOpen()).toBe(false);
  });
});

describe("dropIdleFocus", () => {
  it("blurs a coarse pointer with the keyboard closed", () => {
    setPointer(false);
    setViewport(640, 640);
    const view = fakeView();
    dropIdleFocus(view);
    expect(view.calls).toEqual([{ name: "blur" }]);
  });

  it("does nothing with the keyboard open", () => {
    setPointer(false);
    setViewport(340, 640);
    const view = fakeView();
    dropIdleFocus(view);
    expect(view.calls).toEqual([]);
  });

  it("does nothing on a fine pointer", () => {
    setPointer(true);
    setViewport(640, 640);
    const view = fakeView();
    dropIdleFocus(view);
    expect(view.calls).toEqual([]);
  });
});

describe("openPhoneKeyboard", () => {
  it("blurs then focuses on a coarse pointer with the keyboard closed", () => {
    setPointer(false);
    setViewport(640, 640);
    const view = fakeView();
    openPhoneKeyboard(view);
    expect(view.calls).toEqual([{ name: "blur" }, { name: "focus" }]);
  });

  it("only focuses with the keyboard already open", () => {
    setPointer(false);
    setViewport(340, 640);
    const view = fakeView();
    openPhoneKeyboard(view);
    expect(view.calls).toEqual([{ name: "focus" }]);
  });

  it("only focuses on a fine pointer", () => {
    setPointer(true);
    setViewport(640, 640);
    const view = fakeView();
    openPhoneKeyboard(view);
    expect(view.calls).toEqual([{ name: "focus" }]);
  });
});
