// SPDX-License-Identifier: Apache-2.0
// The phone keyboard is a side effect of focus: xterm's hidden textarea
// keeps focus after the keyboard is dismissed, so a later tap on the key
// bar reopens it. Only Ctrl, Shift and a tap on the terminal pane should
// open it; every other bar key drops an idle focus first so the keyboard
// stays closed, and arming a latch re-opens it even when the textarea is
// still focused (blur then focus, inside the same tap gesture).

import { pointerIsFine } from "./terminal-prefs.js";

export interface VisualViewportLike {
  readonly height: number;
}

/** The phone keyboard hides a share of the layout viewport. */
export function keyboardOpen(
  viewport: VisualViewportLike | null | undefined = globalThis.window?.visualViewport,
  layoutHeight: number = globalThis.window?.innerHeight ?? 0,
): boolean {
  if (viewport === null || viewport === undefined) {
    return false;
  }
  return layoutHeight - viewport.height > 120;
}

/**
 * A bar key other than Ctrl or Shift sends its bytes and leaves the
 * keyboard closed: on a coarse pointer with the keyboard closed the idle
 * focus goes, so the phone does not reopen it on the next tap.
 */
export function dropIdleFocus(view: { blur(): void }): void {
  if (pointerIsFine() || keyboardOpen()) {
    return;
  }
  view.blur();
}

/**
 * Open the keyboard for a key that is followed by typing (Ctrl, Shift) or
 * for a pane tap. Focusing an already focused element does not reopen a
 * phone keyboard, so a coarse pointer with the keyboard closed blurs
 * first, in the same call and inside the tap gesture.
 */
export function openPhoneKeyboard(view: { focus(): void; blur(): void }): void {
  if (!pointerIsFine() && !keyboardOpen()) {
    view.blur();
  }
  view.focus();
}
