// SPDX-License-Identifier: Apache-2.0
// The key bar under the terminal: the nine keys a phone keyboard lacks.
// Esc, Tab, the arrows and Enter send their bytes; Ctrl and Shift are
// one-shot latching modifiers (see modifiers.ts) with no bytes of their
// own. Esc, Ctrl and Shift stay words — a phone reader knows them — while
// Tab, the arrows and Enter wear their Lucide icon; the latch shows a
// circle that morphs to a filled dot while it is armed. Rendering is plain
// buttons; the bytes table is exported so the session layer and the tests
// share one definition.

import { icon, mountMorphSlot, type IconName, type MorphSlot } from "./icons-dom.js";
import type { ModifierState } from "./modifiers.js";

export interface KeyDef {
  /** Stable id used in tests and selectors. */
  id: string;
  label: string;
  ariaLabel: string;
  bytes: readonly number[];
  /** The key drawn as an icon instead of the word in `label`. */
  icon?: IconName;
}

export const KEY_DEFS: readonly KeyDef[] = [
  { id: "esc", label: "Esc", ariaLabel: "Escape", bytes: [0x1b] },
  { id: "ctrl", label: "Ctrl", ariaLabel: "Control", bytes: [] },
  { id: "shift", label: "Shift", ariaLabel: "Shift", bytes: [] },
  { id: "tab", label: "", ariaLabel: "Tab", bytes: [0x09], icon: "arrowRightToLine" },
  { id: "left", label: "", ariaLabel: "Arrow left", bytes: [0x1b, 0x5b, 0x44], icon: "arrowLeft" },
  { id: "up", label: "", ariaLabel: "Arrow up", bytes: [0x1b, 0x5b, 0x41], icon: "arrowUp" },
  { id: "down", label: "", ariaLabel: "Arrow down", bytes: [0x1b, 0x5b, 0x42], icon: "arrowDown" },
  { id: "right", label: "", ariaLabel: "Arrow right", bytes: [0x1b, 0x5b, 0x43], icon: "arrowRight" },
  { id: "enter", label: "", ariaLabel: "Enter", bytes: [0x0d], icon: "cornerDownLeft" },
];

export function isLatchKey(id: string): boolean {
  return id === "ctrl" || id === "shift";
}

export function keyBytes(def: KeyDef): Uint8Array {
  return new Uint8Array(def.bytes);
}

export function keyById(id: string): KeyDef | null {
  return KEY_DEFS.find((def) => def.id === id) ?? null;
}

/**
 * The latch indicator's slot per key button: a circle that becomes a dot
 * while the modifier is armed. A WeakMap keeps the bar's DOM the only
 * handle the shell needs.
 */
const latchSlots = new WeakMap<HTMLElement, MorphSlot>();

/** One icon in a key: hidden from readers, the button carries the name. */
function iconSlot(name: IconName): HTMLElement {
  const slot = document.createElement("span");
  slot.className = "icon-slot";
  slot.setAttribute("aria-hidden", "true");
  slot.innerHTML = icon(name);
  return slot;
}

export function renderKeyBar(bar: HTMLElement, onKey: (def: KeyDef) => void): void {
  bar.replaceChildren();
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Terminal keys");
  for (const def of KEY_DEFS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = def.icon === undefined ? "key" : "key key-icon";
    button.dataset.key = def.id;
    button.setAttribute("aria-label", def.ariaLabel);
    if (def.icon !== undefined) {
      button.append(iconSlot(def.icon));
    }
    if (def.label !== "") {
      button.append(document.createTextNode(def.label));
    }
    if (isLatchKey(def.id)) {
      button.setAttribute("aria-pressed", "false");
      const latch = iconSlot("circle");
      latch.classList.add("latch-icon");
      button.append(latch);
      latchSlots.set(button, mountMorphSlot(latch, "circle"));
    }
    button.addEventListener("click", () => onKey(def));
    bar.appendChild(button);
  }
}

// A latched modifier shows pressed until the next key (or a second tap)
// releases it. The shell owns the latches and calls this after each
// toggle and each consumed key: the circle becomes a filled dot.
export function updateKeyBarLatches(bar: HTMLElement, mods: ModifierState): void {
  for (const [id, latched] of [
    ["ctrl", mods.ctrl],
    ["shift", mods.shift],
  ] as const) {
    const button = bar.querySelector<HTMLButtonElement>(`button.key[data-key="${id}"]`);
    if (button) {
      button.setAttribute("aria-pressed", latched ? "true" : "false");
      latchSlots.get(button)?.to(latched ? "circleDot" : "circle");
    }
  }
}
