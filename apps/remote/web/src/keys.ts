// SPDX-License-Identifier: Apache-2.0
// The key bar under the terminal: the nine keys a phone keyboard lacks.
// Esc, Tab, the arrows and Enter send their bytes; Ctrl and Shift are
// one-shot latching modifiers (see modifiers.ts) with no bytes of their
// own. Rendering is plain buttons; the bytes table is exported so the
// session layer and the tests share one definition.

import type { ModifierState } from "./modifiers.js";

export interface KeyDef {
  /** Stable id used in tests and selectors. */
  id: string;
  label: string;
  ariaLabel: string;
  bytes: readonly number[];
}

export const KEY_DEFS: readonly KeyDef[] = [
  { id: "esc", label: "Esc", ariaLabel: "Escape", bytes: [0x1b] },
  { id: "ctrl", label: "Ctrl", ariaLabel: "Control", bytes: [] },
  { id: "shift", label: "Shift", ariaLabel: "Shift", bytes: [] },
  { id: "tab", label: "Tab", ariaLabel: "Tab", bytes: [0x09] },
  { id: "left", label: "←", ariaLabel: "Arrow left", bytes: [0x1b, 0x5b, 0x44] },
  { id: "up", label: "↑", ariaLabel: "Arrow up", bytes: [0x1b, 0x5b, 0x41] },
  { id: "down", label: "↓", ariaLabel: "Arrow down", bytes: [0x1b, 0x5b, 0x42] },
  { id: "right", label: "→", ariaLabel: "Arrow right", bytes: [0x1b, 0x5b, 0x43] },
  { id: "enter", label: "Enter", ariaLabel: "Enter", bytes: [0x0d] },
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

export function renderKeyBar(bar: HTMLElement, onKey: (def: KeyDef) => void): void {
  bar.replaceChildren();
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Terminal keys");
  for (const def of KEY_DEFS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key";
    button.dataset.key = def.id;
    button.textContent = def.label;
    button.setAttribute("aria-label", def.ariaLabel);
    if (isLatchKey(def.id)) {
      button.setAttribute("aria-pressed", "false");
    }
    button.addEventListener("click", () => onKey(def));
    bar.appendChild(button);
  }
}

// A latched modifier shows pressed until the next key (or a second tap)
// releases it. The shell owns the latches and calls this after each
// toggle and each consumed key.
export function updateKeyBarLatches(bar: HTMLElement, mods: ModifierState): void {
  for (const [id, latched] of [
    ["ctrl", mods.ctrl],
    ["shift", mods.shift],
  ] as const) {
    const button = bar.querySelector<HTMLButtonElement>(`button.key[data-key="${id}"]`);
    if (button) {
      button.setAttribute("aria-pressed", latched ? "true" : "false");
    }
  }
}
