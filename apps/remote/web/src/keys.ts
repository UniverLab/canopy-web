// SPDX-License-Identifier: Apache-2.0
// The key bar under the terminal: ten keys with the exact bytes each one
// sends as an input frame. Rendering is plain buttons; the bytes table is
// exported so the session layer and the tests share one definition.

export interface KeyDef {
  /** Stable id used in tests and selectors. */
  id: string;
  label: string;
  ariaLabel: string;
  bytes: readonly number[];
}

export const KEY_DEFS: readonly KeyDef[] = [
  { id: "esc", label: "Esc", ariaLabel: "Escape", bytes: [0x1b] },
  { id: "tab", label: "Tab", ariaLabel: "Tab", bytes: [0x09] },
  { id: "up", label: "↑", ariaLabel: "Arrow up", bytes: [0x1b, 0x5b, 0x41] },
  { id: "down", label: "↓", ariaLabel: "Arrow down", bytes: [0x1b, 0x5b, 0x42] },
  { id: "left", label: "←", ariaLabel: "Arrow left", bytes: [0x1b, 0x5b, 0x44] },
  { id: "right", label: "→", ariaLabel: "Arrow right", bytes: [0x1b, 0x5b, 0x43] },
  { id: "enter", label: "Enter", ariaLabel: "Enter", bytes: [0x0d] },
  { id: "ctrl-c", label: "Ctrl+C", ariaLabel: "Control C", bytes: [0x03] },
  { id: "y", label: "y", ariaLabel: "Answer y", bytes: [0x79] },
  { id: "n", label: "n", ariaLabel: "Answer n", bytes: [0x6e] },
];

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
    button.addEventListener("click", () => onKey(def));
    bar.appendChild(button);
  }
}
