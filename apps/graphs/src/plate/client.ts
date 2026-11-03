// SPDX-License-Identifier: Apache-2.0
/**
 * The plate viewport's client: pan and zoom over the document page's
 * horizontal plate, mounted on the server-rendered svg.
 *
 * The figure ships complete without scripting — the one horizontal
 * plate in a scrolling viewport — and this bundle only adds the
 * stage behaviour: pointer drags pan in both axes, pinch and
 * Ctrl/⌘ + wheel zoom around the pointer, plain wheel scrolls the
 * page, and the overlaid controls (zoom out, zoom in, Fit) plus the
 * keyboard (`+`, `-`, `0`, arrows) drive the same view. The script
 * self-mounts, so the page carries no inline bootstrap; without it
 * the viewport keeps its `overflow: auto` fallback at scale 1.
 *
 * Bundled by `npm run build:look` into /look/plate.js (an IIFE like
 * icons.js), because the catalogue has no module build of its own.
 */
import {
  PAN_STEP,
  ZOOM_STEP,
  clampPan,
  clampZoom,
  fitScale,
  fitView,
  panBy,
  zoomAround,
  type PlateSize,
  type PlateView,
} from "./transform.js";
import { PLATE_FIT, PLATE_FIT_LABEL, PLATE_ZOOM_IN, PLATE_ZOOM_OUT } from "../pages/copy.js";

/** The figures that become viewports: the document pages' own plates. */
const SELECTOR = "figure.plate[data-plate]";

/** One viewer: the figure, its svg, and the view it paints. */
interface Viewer {
  figure: HTMLElement;
  svg: SVGSVGElement;
  content: PlateSize;
  view: PlateView;
  fit: number;
  atFit: boolean;
  pointers: Map<number, { x: number; y: number }>;
  pinchPrev: number | null;
  pan: { id: number; startX: number; startY: number; viewX: number; viewY: number } | null;
}

/** The viewport's live size, in CSS pixels. */
function viewportOf(figure: HTMLElement): PlateSize {
  return { w: figure.clientWidth, h: figure.clientHeight };
}

/** The svg's intrinsic size, from its own width/height attributes. */
function contentOf(svg: SVGSVGElement): PlateSize | null {
  const w = Number(svg.getAttribute("width"));
  const h = Number(svg.getAttribute("height"));
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

/** Paint the view: the svg keeps its intrinsic layout box and moves under it. */
function apply(viewer: Viewer): void {
  const { x, y, z } = viewer.view;
  viewer.svg.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
}

/** Refit around the live viewport and paint. */
function fit(viewer: Viewer): void {
  const viewport = viewportOf(viewer.figure);
  viewer.fit = fitScale(viewer.content, viewport);
  viewer.view = fitView(viewer.content, viewport);
  viewer.atFit = true;
  apply(viewer);
}

/** One control button: a 44 px target with its accessible name. */
function control(label: string, text: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  return button;
}

/** The overlaid controls: zoom out, zoom in, Fit. */
function mountControls(viewer: Viewer): void {
  const bar = document.createElement("div");
  bar.className = "plate-controls";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", PLATE_FIT_LABEL);
  const aroundCentre = (factor: number): void => {
    const viewport = viewportOf(viewer.figure);
    viewer.view = zoomAround(
      viewer.view, viewer.fit, factor, viewport.w / 2, viewport.h / 2, viewer.content, viewport,
    );
    viewer.atFit = false;
    apply(viewer);
  };
  bar.append(
    control(PLATE_ZOOM_OUT, "−", () => aroundCentre(1 / ZOOM_STEP)),
    control(PLATE_ZOOM_IN, "+", () => aroundCentre(ZOOM_STEP)),
    control(PLATE_FIT_LABEL, PLATE_FIT, () => fit(viewer)),
  );
  viewer.figure.append(bar);
}

/** A wheel delta in pixels, whatever units the device reported. */
function deltaPixels(event: WheelEvent): { dx: number; dy: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
  return { dx: event.deltaX * unit, dy: event.deltaY * unit };
}

/** Wire one figure: pointer pan, pinch zoom, wheel zoom, keyboard, resize. */
function mountFigure(figure: HTMLElement): void {
  if (figure.dataset["plateLive"] === "true") {
    return;
  }
  const svg = figure.querySelector("svg.plate-svg");
  if (!(svg instanceof SVGSVGElement)) {
    return;
  }
  const content = contentOf(svg);
  if (content === null) {
    return;
  }
  figure.dataset["plateLive"] = "true";
  figure.classList.add("is-live");
  svg.style.width = `${content.w}px`;
  svg.style.height = `${content.h}px`;
  const viewer: Viewer = {
    figure,
    svg,
    content,
    view: { x: 0, y: 0, z: 1 },
    fit: 1,
    atFit: true,
    pointers: new Map(),
    pinchPrev: null,
    pan: null,
  };
  fit(viewer);
  mountControls(viewer);

  const toLocal = (clientX: number, clientY: number): { px: number; py: number } => {
    const rect = figure.getBoundingClientRect();
    return { px: clientX - rect.left - figure.clientLeft, py: clientY - rect.top - figure.clientTop };
  };

  figure.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as Element | null)?.closest?.(".plate-controls") !== null) {
      return;
    }
    viewer.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (viewer.pointers.size === 2) {
      viewer.pan = null;
      viewer.pinchPrev = null;
      return;
    }
    if (viewer.pointers.size > 2 || viewer.pinchPrev !== null) {
      return;
    }
    viewer.pan = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: viewer.view.x,
      viewY: viewer.view.y,
    };
    try {
      figure.setPointerCapture(event.pointerId);
    } catch {
      // The capture is a convenience; the drag still tracks without it.
    }
  });

  figure.addEventListener("pointermove", (event) => {
    if (!viewer.pointers.has(event.pointerId)) {
      return;
    }
    viewer.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const viewport = viewportOf(figure);
    if (viewer.pointers.size === 2) {
      const [a, b] = [...viewer.pointers.values()];
      if (a === undefined || b === undefined) {
        return;
      }
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = toLocal((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (viewer.pinchPrev !== null && viewer.pinchPrev > 0 && dist > 0) {
        viewer.view = zoomAround(
          viewer.view, viewer.fit, dist / viewer.pinchPrev, mid.px, mid.py, content, viewport,
        );
        viewer.atFit = false;
        apply(viewer);
      }
      viewer.pinchPrev = dist;
      return;
    }
    const pan = viewer.pan;
    if (pan === null || pan.id !== event.pointerId) {
      return;
    }
    viewer.view = panBy(
      { ...viewer.view, x: pan.viewX, y: pan.viewY },
      event.clientX - pan.startX,
      event.clientY - pan.startY,
      content,
      viewport,
    );
    viewer.atFit = false;
    apply(viewer);
  });

  const endPointer = (event: PointerEvent): void => {
    viewer.pointers.delete(event.pointerId);
    if (viewer.pointers.size < 2) {
      viewer.pinchPrev = null;
    }
    if (viewer.pan?.id === event.pointerId) {
      viewer.pan = null;
    }
    try {
      figure.releasePointerCapture(event.pointerId);
    } catch {
      // The capture may already be gone; nothing depends on it.
    }
  };
  figure.addEventListener("pointerup", endPointer);
  figure.addEventListener("pointercancel", endPointer);

  // Ctrl/⌘ + wheel (and the trackpad pinch, which arrives the same way)
  // zooms around the pointer; a plain wheel is the page's own scroll and
  // passes through untouched.
  figure.addEventListener("wheel", (event) => {
    const wheel = event as WheelEvent;
    if (!wheel.ctrlKey && !wheel.metaKey) {
      return;
    }
    wheel.preventDefault();
    const { dy } = deltaPixels(wheel);
    const { px, py } = toLocal(wheel.clientX, wheel.clientY);
    const viewport = viewportOf(figure);
    viewer.view = zoomAround(viewer.view, viewer.fit, Math.exp(-dy * 0.01), px, py, content, viewport);
    viewer.atFit = false;
    apply(viewer);
  }, { passive: false });

  figure.addEventListener("keydown", (event) => {
    // A modified key belongs to the browser (Ctrl/⌘ + `+` zooms the page);
    // the viewport only answers bare keys.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const viewport = viewportOf(figure);
    const centre = { px: viewport.w / 2, py: viewport.h / 2 };
    switch (event.key) {
      case "+":
      case "=":
        viewer.view = zoomAround(viewer.view, viewer.fit, ZOOM_STEP, centre.px, centre.py, content, viewport);
        viewer.atFit = false;
        apply(viewer);
        event.preventDefault();
        break;
      case "-":
      case "_":
        viewer.view = zoomAround(viewer.view, viewer.fit, 1 / ZOOM_STEP, centre.px, centre.py, content, viewport);
        viewer.atFit = false;
        apply(viewer);
        event.preventDefault();
        break;
      case "0":
        fit(viewer);
        event.preventDefault();
        break;
      case "ArrowLeft":
        viewer.view = panBy(viewer.view, PAN_STEP, 0, content, viewport);
        viewer.atFit = false;
        apply(viewer);
        event.preventDefault();
        break;
      case "ArrowRight":
        viewer.view = panBy(viewer.view, -PAN_STEP, 0, content, viewport);
        viewer.atFit = false;
        apply(viewer);
        event.preventDefault();
        break;
      case "ArrowUp":
        viewer.view = panBy(viewer.view, 0, PAN_STEP, content, viewport);
        viewer.atFit = false;
        apply(viewer);
        event.preventDefault();
        break;
      case "ArrowDown":
        viewer.view = panBy(viewer.view, 0, -PAN_STEP, content, viewport);
        viewer.atFit = false;
        apply(viewer);
        event.preventDefault();
        break;
      default:
        break;
    }
  });

  // A resize keeps the current zoom and recentres only a view at Fit.
  // The kept zoom re-clamps to the new fit's range, so it cannot strand
  // the view outside 0.25×–4× of the fit scale.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (viewer.atFit) {
        fit(viewer);
      } else {
        const viewport = viewportOf(figure);
        viewer.fit = fitScale(content, viewport);
        viewer.view = clampPan({ ...viewer.view, z: clampZoom(viewer.view.z, viewer.fit) }, content, viewport);
        apply(viewer);
      }
    }).observe(figure);
  }
}

/**
 * Turn every document plate of a document into a pan-and-zoom viewport.
 * Idempotent per figure; figures without a sized svg keep scrolling.
 */
export function mountPlateViewers(doc: Document = document): void {
  for (const figure of doc.querySelectorAll(SELECTOR)) {
    if (figure instanceof HTMLElement) {
      mountFigure(figure);
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
