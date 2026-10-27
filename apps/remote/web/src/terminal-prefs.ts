// SPDX-License-Identifier: Apache-2.0
// Per-device terminal preferences. The readable floor is the default on
// phones (Fit off); Fit on is pure fit-to-width for a wide screen. Every
// storage access is guarded: Safari private mode and embedded webviews
// throw on localStorage, and a terminal must still open without it.

export const FIT_ONLY_KEY = "canopy.remote.term.fitOnly";

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
