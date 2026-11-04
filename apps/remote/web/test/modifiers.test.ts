// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  isTerminalReport,
  keyBytesWithModifiers,
  ModifierLatches,
  textBytesWithModifiers,
} from "../src/modifiers.js";

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
    expect([...keyBytesWithModifiers("backspace", NONE)]).toEqual([0x7f]);
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

  it("sends BS for Ctrl+Backspace and ignores Shift", () => {
    expect([...keyBytesWithModifiers("backspace", CTRL)]).toEqual([0x08]);
    expect([...keyBytesWithModifiers("backspace", BOTH)]).toEqual([0x08]);
    expect([...keyBytesWithModifiers("backspace", SHIFT)]).toEqual([0x7f]);
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

  it("uppercases a single lowercase letter with Shift latched", () => {
    expect([...textBytesWithModifiers("a", SHIFT)]).toEqual([0x41]);
    expect([...textBytesWithModifiers("z", SHIFT)]).toEqual([0x5a]);
    // Already shifted, longer text and non-letters go out unchanged.
    expect([...textBytesWithModifiers("A", SHIFT)]).toEqual([0x41]);
    expect([...textBytesWithModifiers("hi", SHIFT)]).toEqual([0x68, 0x69]);
    expect([...textBytesWithModifiers("5", SHIFT)]).toEqual([0x35]);
  });

  it("keeps Ctrl's precedence over Shift for typed text", () => {
    expect([...textBytesWithModifiers("c", BOTH)]).toEqual([0x03]);
    expect([...textBytesWithModifiers("[", SHIFT)]).toEqual([0x5b]);
  });

  it("leaves other latched input unchanged for the caller to release", () => {
    expect([...textBytesWithModifiers("5", CTRL)]).toEqual([0x35]);
    expect([...textBytesWithModifiers("hi", CTRL)]).toEqual([0x68, 0x69]);
  });
});

describe("isTerminalReport", () => {
  it("matches the focus reports", () => {
    expect(isTerminalReport("\x1b[I")).toBe(true);
    expect(isTerminalReport("\x1b[O")).toBe(true);
  });

  it("matches cursor position replies", () => {
    expect(isTerminalReport("\x1b[24;80R")).toBe(true);
    expect(isTerminalReport("\x1b[1;1R")).toBe(true);
  });

  it("matches device attribute replies", () => {
    expect(isTerminalReport("\x1b[?1;2c")).toBe(true);
    expect(isTerminalReport("\x1b[?62c")).toBe(true);
    expect(isTerminalReport("\x1b[>0;95;0c")).toBe(true);
  });

  it("matches SGR mouse reports, press and release", () => {
    expect(isTerminalReport("\x1b[<0;10;20M")).toBe(true);
    expect(isTerminalReport("\x1b[<0;10;20m")).toBe(true);
    expect(isTerminalReport("\x1b[<64;5;7M")).toBe(true);
  });

  it("matches X10 mouse reports, three bytes after ESC[M", () => {
    expect(isTerminalReport("\x1b[M !\"")).toBe(true);
    expect(isTerminalReport("\x1b[M#(+")).toBe(true);
  });

  it("rejects typed input: a lone ESC, arrows and plain text", () => {
    expect(isTerminalReport("\x1b")).toBe(false);
    expect(isTerminalReport("\x1b[A")).toBe(false);
    expect(isTerminalReport("\x1b[1;5A")).toBe(false);
    expect(isTerminalReport("\x1b[Z")).toBe(false);
    expect(isTerminalReport("c")).toBe(false);
    expect(isTerminalReport("hello")).toBe(false);
    expect(isTerminalReport("")).toBe(false);
    expect(isTerminalReport("\x1b[M !")).toBe(false);
  });
});
