// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { isLatchKey, keyById, keyBytes, KEY_DEFS, renderKeyBar, updateKeyBarLatches } from "../src/keys.js";
import type { KeyDef } from "../src/keys.js";

describe("key bar bytes", () => {
  const bytesOf = (id: string): number[] => {
    const def = keyById(id);
    if (!def) {
      throw new Error(`missing key ${id}`);
    }
    return [...keyBytes(def)];
  };

  it("sends the exact base bytes", () => {
    expect(bytesOf("esc")).toEqual([0x1b]);
    expect(bytesOf("tab")).toEqual([0x09]);
    expect(bytesOf("up")).toEqual([0x1b, 0x5b, 0x41]);
    expect(bytesOf("down")).toEqual([0x1b, 0x5b, 0x42]);
    expect(bytesOf("left")).toEqual([0x1b, 0x5b, 0x44]);
    expect(bytesOf("right")).toEqual([0x1b, 0x5b, 0x43]);
    expect(bytesOf("enter")).toEqual([0x0d]);
  });

  it("gives the latching modifiers no bytes of their own", () => {
    expect(bytesOf("ctrl")).toEqual([]);
    expect(bytesOf("shift")).toEqual([]);
    expect(isLatchKey("ctrl")).toBe(true);
    expect(isLatchKey("shift")).toBe(true);
    expect(isLatchKey("tab")).toBe(false);
  });

  it("defines nine keys in bar order", () => {
    expect(KEY_DEFS.map((def) => def.id)).toEqual([
      "esc",
      "ctrl",
      "shift",
      "tab",
      "left",
      "up",
      "down",
      "right",
      "enter",
    ]);
    expect(keyById("nope")).toBeNull();
    expect(keyById("ctrl-c")).toBeNull();
    expect(keyById("y")).toBeNull();
    expect(keyById("n")).toBeNull();
  });
});

describe("renderKeyBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders one button per key and reports presses", () => {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    const pressed: KeyDef[] = [];
    renderKeyBar(bar, (def) => pressed.push(def));
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button.key")];
    expect(buttons).toHaveLength(9);
    expect(buttons[0]?.textContent).toBe("Esc");
    buttons[4]?.click();
    expect(pressed.map((def) => def.id)).toEqual(["left"]);
    expect(bar.getAttribute("role")).toBe("toolbar");
  });

  it("marks the latches unpressed until the shell updates them", () => {
    const bar = document.createElement("div");
    document.body.appendChild(bar);
    renderKeyBar(bar, () => {});
    const ctrl = bar.querySelector<HTMLButtonElement>('button.key[data-key="ctrl"]');
    const shift = bar.querySelector<HTMLButtonElement>('button.key[data-key="shift"]');
    const tab = bar.querySelector<HTMLButtonElement>('button.key[data-key="tab"]');
    expect(ctrl?.getAttribute("aria-pressed")).toBe("false");
    expect(shift?.getAttribute("aria-pressed")).toBe("false");
    expect(tab?.hasAttribute("aria-pressed")).toBe(false);
    updateKeyBarLatches(bar, { ctrl: true, shift: false });
    expect(ctrl?.getAttribute("aria-pressed")).toBe("true");
    expect(shift?.getAttribute("aria-pressed")).toBe("false");
    updateKeyBarLatches(bar, { ctrl: false, shift: false });
    expect(ctrl?.getAttribute("aria-pressed")).toBe("false");
  });
});
