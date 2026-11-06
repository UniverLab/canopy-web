// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_SCALE_KEY_PREFIX,
  CONTROL_SIZE_KEY_PREFIX,
  controlScaleKey,
  controlSizeKey,
  KEYBAR_KEY,
  pointerIsFine,
  readControlScale,
  readControlSize,
  readKeyBarVisible,
  writeControlScale,
  writeControlSize,
  writeKeyBarVisible,
} from "../src/terminal-prefs.js";

describe("key bar visibility", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("defaults visible on touch and hidden under a fine pointer", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: fine)" }));
    expect(pointerIsFine()).toBe(true);
    expect(readKeyBarVisible()).toBe(false);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(pointerIsFine()).toBe(false);
    expect(readKeyBarVisible()).toBe(true);
  });

  it("remembers the choice per device over the pointer default", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    writeKeyBarVisible(false);
    expect(localStorage.getItem(KEYBAR_KEY)).toBe("0");
    expect(readKeyBarVisible()).toBe(false);
    writeKeyBarVisible(true);
    expect(localStorage.getItem(KEYBAR_KEY)).toBe("1");
    expect(readKeyBarVisible()).toBe(true);
  });

  it("falls back to the pointer default when storage throws (private mode)", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage is blocked");
      },
    });
    try {
      expect(readKeyBarVisible()).toBe(false);
      expect(() => writeKeyBarVisible(true)).not.toThrow();
      expect(readControlSize("smoke")).toBe(false);
      expect(() => writeControlSize("smoke", true)).not.toThrow();
      expect(readControlScale("smoke")).toBe(100);
      expect(() => writeControlScale("smoke", 150)).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
  });
});

describe("control size prefs", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("keeps control-size per session, default off", () => {
    expect(readControlSize("smoke")).toBe(false);
    expect(readControlSize("other")).toBe(false);
    writeControlSize("smoke", true);
    expect(localStorage.getItem(controlSizeKey("smoke"))).toBe("1");
    expect(controlSizeKey("smoke")).toBe(`${CONTROL_SIZE_KEY_PREFIX}smoke`);
    expect(readControlSize("smoke")).toBe(true);
    expect(readControlSize("other")).toBe(false);
    writeControlSize("smoke", false);
    expect(localStorage.getItem(controlSizeKey("smoke"))).toBe("0");
    expect(readControlSize("smoke")).toBe(false);
  });
});

describe("control scale prefs", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("keeps the scale per session, 100 by default", () => {
    expect(readControlScale("smoke")).toBe(100);
    writeControlScale("smoke", 150);
    expect(localStorage.getItem(controlScaleKey("smoke"))).toBe("150");
    expect(controlScaleKey("smoke")).toBe(`${CONTROL_SCALE_KEY_PREFIX}smoke`);
    expect(readControlScale("smoke")).toBe(150);
    expect(readControlScale("other")).toBe(100);
  });

  it("reads out-of-range and off-step values as 100", () => {
    for (const bad of ["40", "210", "155", "", "abc", "NaN"]) {
      localStorage.setItem(controlScaleKey("smoke"), bad);
      expect(readControlScale("smoke"), bad).toBe(100);
    }
    localStorage.setItem(controlScaleKey("smoke"), "50");
    expect(readControlScale("smoke")).toBe(50);
    localStorage.setItem(controlScaleKey("smoke"), "200");
    expect(readControlScale("smoke")).toBe(200);
  });
});
