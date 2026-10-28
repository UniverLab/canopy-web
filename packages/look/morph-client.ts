// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue's one morph: the Copy button's icon becomes a check on a
 * successful copy, then goes back after a moment.
 *
 * The pages are server-rendered strings, so every Copy button ships the
 * static Lucide SVG inside `.copy-icon`; on the first click this module
 * replaces it with morphicons' `<morph-icon>` element and morphs it. Until
 * then nothing of the morpher is needed, and with scripting off the static
 * icon is still the right one.
 *
 * Bundled by `npm run build:look` into /look/icons.js (an IIFE exposing
 * `CanopyIcons`), because the catalogue has no module build of its own.
 */
import { defineMorphIcon, type MorphIconElement } from "morphicons/element";
import { check, copy } from "./icons.js";

/** How long the check stays before the icon goes back to `copy`. */
export const COPY_DONE_MS = 1500;

/** The word a button shows while copied; the markup may override it. */
const DEFAULT_DONE = "Copied";

/** The pending "go back" timer, one per button. */
const timers = new WeakMap<Element, ReturnType<typeof globalThis.setTimeout>>();

/** The `<morph-icon>` inside a button's `.copy-icon`, created on first use. */
function morphIn(host: HTMLElement): MorphIconElement {
  const existing = host.querySelector("morph-icon");
  if (existing !== null) {
    return existing;
  }
  defineMorphIcon();
  const icon = document.createElement("morph-icon");
  icon.setAttribute("size", "16");
  icon.setAttribute("color", "currentColor");
  icon.setAttribute("stroke-width", "1.75");
  icon.setAttribute("spring", "snappy");
  icon.setAttribute("reduced-motion", "user");
  icon.setAttribute("aria-hidden", "true");
  icon.icon = copy;
  host.replaceChildren(icon);
  return icon;
}

/**
 * Show `copy` or `check` in one button's icon slot. The slot keeps its
 * box: only the path inside the 16 px SVG changes.
 */
export function setCopyState(button: Element, copied: boolean): void {
  const host = button.querySelector<HTMLElement>(".copy-icon");
  if (host === null) {
    return;
  }
  const icon = morphIn(host);
  icon.morphTo(copied ? check : copy, "snappy");
  host.dataset.icon = copied ? "check" : "copy";
}

/** Copy one command: the clipboard, the word, and the icon. */
function copyCommand(button: HTMLElement): void {
  const command = button.dataset["copy"] ?? "";
  if (command !== "") {
    // A denied clipboard must never keep the check from showing: the copy
    // is a convenience, the confirmation is the button's own state.
    navigator.clipboard?.writeText(command).catch(() => undefined);
  }
  setCopyState(button, true);
  const label = button.querySelector<HTMLElement>(".copy-text");
  if (label !== null) {
    const done = button.dataset["done"] ?? DEFAULT_DONE;
    label.textContent = done;
  }
  const pending = timers.get(button);
  if (pending !== undefined) {
    globalThis.clearTimeout(pending);
  }
  timers.set(
    button,
    globalThis.setTimeout(() => {
      timers.delete(button);
      setCopyState(button, false);
      if (label !== null) {
        label.textContent = button.dataset["label"] ?? "Copy";
      }
    }, COPY_DONE_MS),
  );
}

/**
 * Wire every `.copy` button of a document through one delegated listener,
 * so the buttons stay plain, focusable `type="button"` elements and the
 * keyboard reaches them for free. Idempotent per document.
 */
export function mountCopyButtons(doc: Document = document): void {
  if (doc.documentElement.dataset["copyMounted"] === "true") {
    return;
  }
  doc.documentElement.dataset["copyMounted"] = "true";
  doc.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const button = target?.closest?.(".copy") ?? null;
    if (button instanceof HTMLElement) {
      copyCommand(button);
    }
  });
}
