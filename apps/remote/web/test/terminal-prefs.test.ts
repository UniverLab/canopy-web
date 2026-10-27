// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { FIT_ONLY_KEY, readFitOnly, writeFitOnly } from "../src/terminal-prefs.js";

describe("terminal prefs", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to the readable floor (Fit off)", () => {
    expect(readFitOnly()).toBe(false);
  });

  it("remembers Fit per device", () => {
    writeFitOnly(true);
    expect(localStorage.getItem(FIT_ONLY_KEY)).toBe("1");
    expect(readFitOnly()).toBe(true);
    writeFitOnly(false);
    expect(localStorage.getItem(FIT_ONLY_KEY)).toBe("0");
    expect(readFitOnly()).toBe(false);
  });

  it("survives a storage that throws (private mode)", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage is blocked");
      },
    });
    try {
      expect(readFitOnly()).toBe(false);
      expect(() => writeFitOnly(true)).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    }
  });
});
