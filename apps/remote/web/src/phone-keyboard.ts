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
 * While the phone keyboard is open the session view pins itself to the
 * visual viewport: data-keyboard plus --vv-top/--vv-height let the
 * stylesheet keep the terminal and the key bar above the keyboard, and
 * the pane stays scrolled to its last rows. Listens to the visual
 * viewport's resize and scroll, coalesced through requestAnimationFrame;
 * returns a dispose that removes the listeners and leaves no attribute
 * or property behind. Without visualViewport it does nothing.
 */
export function followKeyboard(main: HTMLElement, pane: HTMLElement): () => void {
  const viewport = globalThis.window?.visualViewport;
  if (!viewport) {
    return () => {};
  }
  const apply = (): void => {
    if (keyboardOpen(viewport, globalThis.window?.innerHeight ?? 0)) {
      main.setAttribute("data-keyboard", "");
      main.style.setProperty("--vv-top", `${viewport.offsetTop}px`);
      main.style.setProperty("--vv-height", `${viewport.height}px`);
      pane.scrollTop = pane.scrollHeight;
    } else {
      main.removeAttribute("data-keyboard");
      main.style.removeProperty("--vv-top");
      main.style.removeProperty("--vv-height");
    }
  };
  let rafId = 0;
  const schedule = (): void => {
    if (rafId !== 0) {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      apply();
    });
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  apply();
  return () => {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    main.removeAttribute("data-keyboard");
    main.style.removeProperty("--vv-top");
    main.style.removeProperty("--vv-height");
  };
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
