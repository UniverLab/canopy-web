// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_SIZE_KEY_PREFIX,
  controlSizeKey,
  FIT_ONLY_KEY,
  readControlSize,
  readFitOnly,
  writeControlSize,
  writeFitOnly,
} from "../src/terminal-prefs.js";

describe("terminal prefs", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to Fit off", () => {
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
