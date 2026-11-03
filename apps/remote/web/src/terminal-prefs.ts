// SPDX-License-Identifier: Apache-2.0
// Per-device terminal preferences. The terminal always fits the pane width;
// Fit stays as a harmless remembered affordance. "This device controls the
// size" is per session: each session remembers whether this device asserts
// its PTY size, default off. Every storage access is guarded: Safari
// private mode and embedded webviews throw on localStorage, and a
// terminal must still open without it.

export const FIT_ONLY_KEY = "canopy.remote.term.fitOnly";
export const CONTROL_SIZE_KEY_PREFIX = "canopy.remote.term.controlSize.";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readFitOnly(): boolean {
  try {
    return storage()?.getItem(FIT_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeFitOnly(value: boolean): void {
  try {
    storage()?.setItem(FIT_ONLY_KEY, value ? "1" : "0");
  } catch {
    // A terminal that cannot remember the toggle still works.
  }
}

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
