// SPDX-License-Identifier: Apache-2.0
/**
 * The plate viewport's client: pan and zoom over the catalogue page's
 * horizontal plate, mounted on the server-rendered svg.
 *
 * The figure ships complete without scripting — the plate in a scrolling
 * viewport — and this bundle only adds the stage behaviour, through the
 * shared `mountPlateViewer` in `packages/plate/viewport.ts`. The script
 * self-mounts, so the page carries no inline bootstrap; without it the
 * viewport keeps its `overflow: auto` fallback at scale 1.
 *
 * Bundled by `npm run build:look` into /look/plate.js (an IIFE like
 * icons.js), because the catalogue has no module build of its own.
 */
import { mountPlateViewer, type PlateLabels } from "../../../../packages/plate/viewport.js";
import { PLATE_FIT, PLATE_FIT_LABEL, PLATE_ZOOM_IN, PLATE_ZOOM_OUT } from "../pages/copy.js";

/** The figures that become viewports: the document pages' own plates. */
const SELECTOR = "figure.plate[data-plate]";

/** The catalogue's words for the three overlaid controls. */
const LABELS: PlateLabels = {
  zoomOut: PLATE_ZOOM_OUT,
  zoomIn: PLATE_ZOOM_IN,
  fit: PLATE_FIT,
  fitLabel: PLATE_FIT_LABEL,
};

/**
 * Turn every document plate of a document into a pan-and-zoom viewport.
 * Idempotent per figure; figures without a sized svg keep scrolling.
 */
export function mountPlateViewers(doc: Document = document): void {
  for (const figure of doc.querySelectorAll(SELECTOR)) {
    if (figure instanceof HTMLElement) {
      mountPlateViewer(figure, LABELS);
    }
  }
}

// Self-mounting: the page loads this bundle with `defer` and no inline
// bootstrap, so a reader without scripting still gets the full plate.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountPlateViewers(document));
  } else {
    mountPlateViewers(document);
  }
}
