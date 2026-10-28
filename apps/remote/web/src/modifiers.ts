// SPDX-License-Identifier: Apache-2.0
// One-shot latching modifiers for the key bar: tapping Ctrl or Shift arms
// it, the next key (from the bar or the phone keyboard) goes out with the
// modifier, then the latch releases. Tapping the latch again releases it
// without sending. Pure module: no DOM, no network.

export interface ModifierState {
  ctrl: boolean;
  shift: boolean;
}

export const NO_MODIFIERS: ModifierState = { ctrl: false, shift: false };

export class ModifierLatches {
  private ctrlLatched = false;
  private shiftLatched = false;

  get ctrl(): boolean {
    return this.ctrlLatched;
  }

  get shift(): boolean {
    return this.shiftLatched;
  }

  get hasLatch(): boolean {
    return this.ctrlLatched || this.shiftLatched;
  }

  snapshot(): ModifierState {
    return { ctrl: this.ctrlLatched, shift: this.shiftLatched };
  }

  toggleCtrl(): boolean {
    this.ctrlLatched = !this.ctrlLatched;
    return this.ctrlLatched;
  }

  toggleShift(): boolean {
    this.shiftLatched = !this.shiftLatched;
    return this.shiftLatched;
  }

  release(): void {
    this.ctrlLatched = false;
    this.shiftLatched = false;
  }
}

const ARROW_FINAL: Record<string, number> = { up: 0x41, down: 0x42, right: 0x43, left: 0x44 };

function arrowBytes(id: string, mods: ModifierState): Uint8Array | null {
  const fin = ARROW_FINAL[id];
  if (fin === undefined) {
    return null;
  }
  if (!mods.ctrl && !mods.shift) {
    return new Uint8Array([0x1b, 0x5b, fin]);
  }
  // xterm modify-arrow: 2 is shift, 5 is ctrl, 6 is both.
  const mod = mods.ctrl && mods.shift ? 0x36 : mods.ctrl ? 0x35 : 0x32;
  return new Uint8Array([0x1b, 0x5b, 0x31, 0x3b, mod, fin]);
}

// The bar key with the latch applied. Esc and Enter are unaffected by the
// modifiers; Tab with Shift is back-tab; arrows carry the xterm modifier.
// Modifier keys themselves have no bytes (the shell toggles the latch).
export function keyBytesWithModifiers(id: string, mods: ModifierState): Uint8Array {
  const arrow = arrowBytes(id, mods);
  if (arrow) {
    return arrow;
  }
  if (id === "esc") {
    return new Uint8Array([0x1b]);
  }
  if (id === "enter") {
    return new Uint8Array([0x0d]);
  }
  if (id === "tab") {
    return mods.shift ? new Uint8Array([0x1b, 0x5b, 0x5a]) : new Uint8Array([0x09]);
  }
  return new Uint8Array([]);
}

// Phone-keyboard text with the latch applied. A latched Ctrl turns a
// single letter into its control byte (a→0x01 … z→0x1a, either case) and
// "[" into ESC; anything else goes out unchanged. Shift never alters
// typed text (the keyboard already shifted it). The caller releases the
// latch after any input, modified or not.
export function textBytesWithModifiers(text: string, mods: ModifierState): Uint8Array {
  if (mods.ctrl && text.length === 1) {
    const ch = text[0] as string;
    if (ch === "[") {
      return new Uint8Array([0x1b]);
    }
    const lower = ch.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      return new Uint8Array([lower.charCodeAt(0) - 0x60]);
    }
  }
  return new TextEncoder().encode(text);
}
