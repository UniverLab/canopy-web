// SPDX-License-Identifier: Apache-2.0
// Per-device terminal preferences. The key bar is shown on touch by default
// and hidden under a fine pointer; a tap on the Keys switch remembers the
// choice. "This device controls the size" is per session: each session
// remembers whether this device asserts its PTY size, default off. Every
// storage access is guarded: Safari private mode and embedded webviews throw
// on localStorage, and a terminal must still open without it.

export const KEYBAR_KEY = "canopy.remote.term.keybar";
export const CONTROL_SIZE_KEY_PREFIX = "canopy.remote.term.controlSize.";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True when the primary pointer is a mouse or trackpad. */
export function pointerIsFine(): boolean {
  try {
    return (
      typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(pointer: fine)").matches
    );
  } catch {
    return false;
  }
}

/** Visible on touch by default; hidden under a fine pointer. */
export function defaultKeyBarVisible(): boolean {
  return !pointerIsFine();
}

/** The remembered key-bar choice, falling back to the pointer default. */
export function readKeyBarVisible(): boolean {
  try {
    const stored = storage()?.getItem(KEYBAR_KEY);
    if (stored === "1") {
      return true;
    }
    if (stored === "0") {
      return false;
    }
  } catch {
    // Fall through to the pointer default.
  }
  return defaultKeyBarVisible();
}

export function writeKeyBarVisible(value: boolean): void {
  try {
    storage()?.setItem(KEYBAR_KEY, value ? "1" : "0");
  } catch {
    // A terminal that cannot remember the toggle still works.
  }
}

export const CONTROL_SCALE_KEY_PREFIX = "canopy.remote.term.controlScale.";
export const CONTROL_SCALE_MIN = 50;
export const CONTROL_SCALE_MAX = 200;
export const CONTROL_SCALE_STEP = 10;
const CONTROL_SCALE_DEFAULT = 100;

export function controlSizeKey(sessionId: string): string {
  return `${CONTROL_SIZE_KEY_PREFIX}${sessionId}`;
}

export function readControlSize(sessionId: string): boolean {
  try {
    return storage()?.getItem(controlSizeKey(sessionId)) === "1";
  } catch {
    return false;
  }
}

export function writeControlSize(sessionId: string, value: boolean): void {
  try {
    storage()?.setItem(controlSizeKey(sessionId), value ? "1" : "0");
  } catch {
    // A terminal that cannot remember the toggle still works.
  }
}

export function controlScaleKey(sessionId: string): string {
  return `${CONTROL_SCALE_KEY_PREFIX}${sessionId}`;
}

/** The remembered slider percentage, 100 unless a valid 50..200 step of 10. */
export function readControlScale(sessionId: string): number {
  try {
    const value = Number.parseInt(storage()?.getItem(controlScaleKey(sessionId)) ?? "", 10);
    if (
      Number.isInteger(value) &&
      value >= CONTROL_SCALE_MIN &&
      value <= CONTROL_SCALE_MAX &&
      value % CONTROL_SCALE_STEP === 0
    ) {
      return value;
    }
  } catch {
    // Fall through to the default.
  }
  return CONTROL_SCALE_DEFAULT;
}

export function writeControlScale(sessionId: string, value: number): void {
  try {
    storage()?.setItem(controlScaleKey(sessionId), String(value));
  } catch {
    // A terminal that cannot remember the scale still works.
  }
}
