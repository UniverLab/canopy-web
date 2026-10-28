// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { keyBytesWithModifiers, ModifierLatches, textBytesWithModifiers } from "../src/modifiers.js";

const CTRL = { ctrl: true, shift: false };
const SHIFT = { ctrl: false, shift: true };
const BOTH = { ctrl: true, shift: true };
const NONE = { ctrl: false, shift: false };

describe("ModifierLatches", () => {
  it("toggles each latch independently and releases both at once", () => {
    const latches = new ModifierLatches();
    expect(latches.hasLatch).toBe(false);
    expect(latches.toggleCtrl()).toBe(true);
    expect(latches.ctrl).toBe(true);
    expect(latches.shift).toBe(false);
    expect(latches.hasLatch).toBe(true);
    // A second tap releases without sending.
    expect(latches.toggleCtrl()).toBe(false);
    expect(latches.hasLatch).toBe(false);
    latches.toggleCtrl();
    latches.toggleShift();
    expect(latches.snapshot()).toEqual(BOTH);
    latches.release();
    expect(latches.snapshot()).toEqual(NONE);
  });
});

describe("keyBytesWithModifiers", () => {
  it("sends the base bytes with no latch", () => {
    expect([...keyBytesWithModifiers("esc", NONE)]).toEqual([0x1b]);
    expect([...keyBytesWithModifiers("tab", NONE)]).toEqual([0x09]);
    expect([...keyBytesWithModifiers("enter", NONE)]).toEqual([0x0d]);
    expect([...keyBytesWithModifiers("up", NONE)]).toEqual([0x1b, 0x5b, 0x41]);
    expect([...keyBytesWithModifiers("down", NONE)]).toEqual([0x1b, 0x5b, 0x42]);
    expect([...keyBytesWithModifiers("right", NONE)]).toEqual([0x1b, 0x5b, 0x43]);
    expect([...keyBytesWithModifiers("left", NONE)]).toEqual([0x1b, 0x5b, 0x44]);
  });

  it("leaves Esc and Enter alone under any latch", () => {
    for (const mods of [CTRL, SHIFT, BOTH]) {
      expect([...keyBytesWithModifiers("esc", mods)]).toEqual([0x1b]);
      expect([...keyBytesWithModifiers("enter", mods)]).toEqual([0x0d]);
    }
  });

  it("sends back-tab with Shift latched", () => {
    expect([...keyBytesWithModifiers("tab", SHIFT)]).toEqual([0x1b, 0x5b, 0x5a]);
    expect([...keyBytesWithModifiers("tab", BOTH)]).toEqual([0x1b, 0x5b, 0x5a]);
    expect([...keyBytesWithModifiers("tab", CTRL)]).toEqual([0x09]);
  });

  it("sends the xterm shift arrows", () => {
    expect([...keyBytesWithModifiers("up", SHIFT)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x41]);
    expect([...keyBytesWithModifiers("down", SHIFT)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x42]);
    expect([...keyBytesWithModifiers("right", SHIFT)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x43]);
    expect([...keyBytesWithModifiers("left", SHIFT)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x44]);
  });

  it("sends the xterm ctrl arrows", () => {
    expect([...keyBytesWithModifiers("up", CTRL)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x41]);
    expect([...keyBytesWithModifiers("down", CTRL)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x42]);
    expect([...keyBytesWithModifiers("right", CTRL)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x43]);
    expect([...keyBytesWithModifiers("left", CTRL)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x44]);
  });

  it("sends the xterm ctrl+shift arrows with both latched", () => {
    expect([...keyBytesWithModifiers("up", BOTH)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x36, 0x41]);
    expect([...keyBytesWithModifiers("down", BOTH)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x36, 0x42]);
    expect([...keyBytesWithModifiers("right", BOTH)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x36, 0x43]);
    expect([...keyBytesWithModifiers("left", BOTH)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x36, 0x44]);
  });

  it("has no bytes for the latch keys themselves", () => {
    expect([...keyBytesWithModifiers("ctrl", NONE)]).toEqual([]);
    expect([...keyBytesWithModifiers("shift", BOTH)]).toEqual([]);
  });
});

describe("textBytesWithModifiers", () => {
  it("passes text through with no latch", () => {
    expect([...textBytesWithModifiers("c", NONE)]).toEqual([0x63]);
    expect([...textBytesWithModifiers("hi", NONE)]).toEqual([0x68, 0x69]);
  });

  it("turns a latched Ctrl letter into its control byte", () => {
    expect([...textBytesWithModifiers("a", CTRL)]).toEqual([0x01]);
    expect([...textBytesWithModifiers("c", CTRL)]).toEqual([0x03]);
    expect([...textBytesWithModifiers("z", CTRL)]).toEqual([0x1a]);
    expect([...textBytesWithModifiers("C", CTRL)]).toEqual([0x03]);
    expect([...textBytesWithModifiers("Z", BOTH)]).toEqual([0x1a]);
  });

  it("turns a latched Ctrl+[ into ESC", () => {
    expect([...textBytesWithModifiers("[", CTRL)]).toEqual([0x1b]);
    expect([...textBytesWithModifiers("[", BOTH)]).toEqual([0x1b]);
  });

  it("leaves other latched input unchanged for the caller to release", () => {
    expect([...textBytesWithModifiers("5", CTRL)]).toEqual([0x35]);
    expect([...textBytesWithModifiers("c", SHIFT)]).toEqual([0x63]);
    expect([...textBytesWithModifiers("hi", CTRL)]).toEqual([0x68, 0x69]);
  });
});
