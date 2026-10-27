// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { keyById, keyBytes, KEY_DEFS, renderKeyBar } from "../src/keys.js";
import type { KeyDef } from "../src/keys.js";

describe("key bar bytes", () => {
  const bytesOf = (id: string): number[] => {
    const def = keyById(id);
    if (!def) {
      throw new Error(`missing key ${id}`);
    }
    return [...keyBytes(def)];
  };

  it("sends the exact control bytes", () => {
    expect(bytesOf("esc")).toEqual([0x1b]);
    expect(bytesOf("tab")).toEqual([0x09]);
    expect(bytesOf("up")).toEqual([0x1b, 0x5b, 0x41]);
    expect(bytesOf("down")).toEqual([0x1b, 0x5b, 0x42]);
    expect(bytesOf("left")).toEqual([0x1b, 0x5b, 0x44]);
    expect(bytesOf("right")).toEqual([0x1b, 0x5b, 0x43]);
    expect(bytesOf("enter")).toEqual([0x0d]);
    expect(bytesOf("ctrl-c")).toEqual([0x03]);
    expect(bytesOf("y")).toEqual([0x79]);
    expect(bytesOf("n")).toEqual([0x6e]);
  });

  it("defines ten keys in bar order", () => {
    expect(KEY_DEFS.map((def) => def.id)).toEqual([
      "esc",
      "tab",
      "up",
      "down",
      "left",
      "right",
      "enter",
      "ctrl-c",
      "y",
      "n",
    ]);
    expect(keyById("nope")).toBeNull();
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
    expect(buttons).toHaveLength(10);
    expect(buttons[0]?.textContent).toBe("Esc");
    buttons[7]?.click();
    expect(pressed.map((def) => def.id)).toEqual(["ctrl-c"]);
    expect(bar.getAttribute("role")).toBe("toolbar");
  });
});
