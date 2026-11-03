// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_SIZE_KEY_PREFIX,
  controlSizeKey,
  KEYBAR_KEY,
  pointerIsFine,
  readControlSize,
  readKeyBarVisible,
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
