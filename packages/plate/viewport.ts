// SPDX-License-Identifier: Apache-2.0
/**
 * The plate viewport: the transform math and the DOM behaviour of the one
 * pan-and-zoom canvas both the catalogue and the remote draw a graph on.
 *
 * The math is plain numbers with no DOM. Coordinates: the client paints the
 * svg with `translate(x, y) scale(z)` from a `0 0` origin, so a content
 * point `(cx, cy)` lands on viewport point `(x + cx * z, y + cy * z)`. The
 * zoom is relative to the fit scale: 0.25× to 4× of it. A pan is always
 * clamped so the content covers the viewport's centre — the drawing can
 * never be pushed out of sight.
 *
 * The viewer mounts on a server-rendered `figure.plate[data-plate]` and adds
 * the stage behaviour: pointer drags pan in both axes, pinch and Ctrl/⌘ +
 * wheel zoom around the pointer, plain wheel scrolls the page, and the
 * overlaid controls (zoom out, zoom in, Fit) plus the keyboard (`+`, `-`,
 * `0`, arrows) drive the same view. `replaceSvg` swaps the drawing under a
 * live view, so a pushed state never resets pan or zoom.
 */
export interface PlateSize {
  w: number;
  h: number;
}

export interface PlateView {
  x: number;
  y: number;
  z: number;
}

/** The four control strings the viewer renders. */
export interface PlateLabels {
  zoomOut: string;
  zoomIn: string;
  fit: string;
  fitLabel: string;
}

/** A mounted viewport: replace its drawing, or take it down again. */
export interface PlateViewer {
  /** Swap the figure's svg, keeping the current view when the size is unchanged. */
  replaceSvg(html: string): void;
  /** Remove every listener, the controls and the live state. */
  dispose(): void;
}

/** The zoom range, as multiples of the fit scale. */
export const ZOOM_MIN_REL = 0.25;
export const ZOOM_MAX_REL = 4;

/** One keyboard/button zoom step. */
export const ZOOM_STEP = 1.25;

/** One arrow-key pan, in viewport pixels. */
export const PAN_STEP = 48;

/** The scale that fits the whole content inside the viewport. */
export function fitScale(content: PlateSize, viewport: PlateSize): number {
  if (content.w <= 0 || content.h <= 0 || viewport.w <= 0 || viewport.h <= 0) {
    return 1;
  }
  return Math.min(viewport.w / content.w, viewport.h / content.h);
}

/** Clamp a zoom to the fit-relative range. */
export function clampZoom(z: number, fit: number): number {
  if (!Number.isFinite(z) || !Number.isFinite(fit) || fit <= 0) {
    return fit > 0 ? fit : 1;
  }
  return Math.min(fit * ZOOM_MAX_REL, Math.max(fit * ZOOM_MIN_REL, z));
}

/** The fit view: the whole content visible, centred in the viewport. */
export function fitView(content: PlateSize, viewport: PlateSize): PlateView {
  const z = fitScale(content, viewport);
  return {
    x: (viewport.w - content.w * z) / 2,
    y: (viewport.h - content.h * z) / 2,
    z,
  };
}

/**
 * Zoom by a factor around one viewport point: the content point under it
 * stays under it. The zoom clamps to the fit-relative range, and the pan
 * clamps so the content still covers the viewport centre.
 */
export function zoomAround(
  view: PlateView,
  fit: number,
  factor: number,
  px: number,
  py: number,
  content: PlateSize,
  viewport: PlateSize,
): PlateView {
  if (!(view.z > 0) || !Number.isFinite(factor) || factor <= 0) {
    return { ...view };
  }
  const z = clampZoom(view.z * factor, fit);
  const k = z / view.z;
  return clampPan({ x: px - (px - view.x) * k, y: py - (py - view.y) * k, z }, content, viewport);
}

/**
 * Clamp a pan so the content covers the viewport's centre: the centre in
 * content coordinates must lie inside the content box.
 */
export function clampPan(view: PlateView, content: PlateSize, viewport: PlateSize): PlateView {
  const cx = viewport.w / 2;
  const cy = viewport.h / 2;
  return {
    x: Math.min(cx, Math.max(cx - content.w * view.z, view.x)),
    y: Math.min(cy, Math.max(cy - content.h * view.z, view.y)),
    z: view.z,
  };
}

/** Pan by a viewport-pixel delta, clamped to the centre rule. */
export function panBy(
  view: PlateView,
  dx: number,
  dy: number,
  content: PlateSize,
  viewport: PlateSize,
): PlateView {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { ...view };
  }
  return clampPan({ x: view.x + dx, y: view.y + dy, z: view.z }, content, viewport);
}

/** The viewport's live size, in CSS pixels. */
function viewportOf(figure: HTMLElement): PlateSize {
  return { w: figure.clientWidth, h: figure.clientHeight };
}

/** The svg's intrinsic size, from its own width/height attributes. */
function contentOf(svg: Element): PlateSize | null {
  const w = Number(svg.getAttribute("width"));
  const h = Number(svg.getAttribute("height"));
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

/** The viewer's whole mutable state; the svg is swapped by `replaceSvg`. */
interface State {
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

/** Paint the view: the svg keeps its intrinsic layout box and moves under it. */
function apply(state: State): void {
  const { x, y, z } = state.view;
  state.svg.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
}

/** Refit around the live viewport and paint. */
function fit(state: State): void {
  const viewport = viewportOf(state.figure);
  state.fit = fitScale(state.content, viewport);
  state.view = fitView(state.content, viewport);
  state.atFit = true;
  apply(state);
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

/**
 * Turn one figure into a pan-and-zoom viewport. Idempotent per figure;
 * figures without a sized svg answer null and keep scrolling.
 */
export function mountPlateViewer(figure: HTMLElement, labels: PlateLabels): PlateViewer | null {
  if (figure.dataset["plateLive"] === "true") {
    return null;
  }
  const initial = figure.querySelector("svg.plate-svg") as SVGSVGElement | null;
  if (initial === null) {
    return null;
  }
  const content = contentOf(initial);
  if (content === null) {
    return null;
  }

  const state: State = {
    figure,
    svg: initial,
    content,
    view: { x: 0, y: 0, z: 1 },
    fit: 1,
    atFit: true,
    pointers: new Map(),
    pinchPrev: null,
    pan: null,
  };

  figure.dataset["plateLive"] = "true";
  figure.classList.add("is-live");
  initial.style.width = `${content.w}px`;
  initial.style.height = `${content.h}px`;
  figure.style.setProperty("--plate-ratio", `${content.w} / ${content.h}`);
  fit(state);

  const cleanups: Array<() => void> = [];
  const on = <T extends EventTarget>(
    target: T,
    type: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  // The overlaid controls: zoom out, zoom in, Fit.
  const bar = document.createElement("div");
  bar.className = "plate-controls";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", labels.fitLabel);
  const aroundCentre = (factor: number): void => {
    const viewport = viewportOf(state.figure);
    state.view = zoomAround(
      state.view, state.fit, factor, viewport.w / 2, viewport.h / 2, state.content, viewport,
    );
    state.atFit = false;
    apply(state);
  };
  bar.append(
    control(labels.zoomOut, "−", () => aroundCentre(1 / ZOOM_STEP)),
    control(labels.zoomIn, "+", () => aroundCentre(ZOOM_STEP)),
    control(labels.fitLabel, labels.fit, () => fit(state)),
  );
  figure.append(bar);

  const toLocal = (clientX: number, clientY: number): { px: number; py: number } => {
    const rect = figure.getBoundingClientRect();
    return { px: clientX - rect.left - figure.clientLeft, py: clientY - rect.top - figure.clientTop };
  };

  on(figure, "pointerdown", (raw) => {
    const event = raw as PointerEvent;
    if (event.button !== 0 || (event.target as Element | null)?.closest?.(".plate-controls") !== null) {
      return;
    }
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 2) {
      state.pan = null;
      state.pinchPrev = null;
      return;
    }
    if (state.pointers.size > 2 || state.pinchPrev !== null) {
      return;
    }
    state.pan = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: state.view.x,
      viewY: state.view.y,
    };
    try {
      figure.setPointerCapture(event.pointerId);
    } catch {
      // The capture is a convenience; the drag still tracks without it.
    }
  });

  on(figure, "pointermove", (raw) => {
    const event = raw as PointerEvent;
    if (!state.pointers.has(event.pointerId)) {
      return;
    }
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const viewport = viewportOf(figure);
    if (state.pointers.size === 2) {
      const [a, b] = [...state.pointers.values()];
      if (a === undefined || b === undefined) {
        return;
      }
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = toLocal((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (state.pinchPrev !== null && state.pinchPrev > 0 && dist > 0) {
        state.view = zoomAround(
          state.view, state.fit, dist / state.pinchPrev, mid.px, mid.py, state.content, viewport,
        );
        state.atFit = false;
        apply(state);
      }
      state.pinchPrev = dist;
      return;
    }
    const pan = state.pan;
    if (pan === null || pan.id !== event.pointerId) {
      return;
    }
    state.view = panBy(
      { ...state.view, x: pan.viewX, y: pan.viewY },
      event.clientX - pan.startX,
      event.clientY - pan.startY,
      state.content,
      viewport,
    );
    state.atFit = false;
    apply(state);
  });

  const endPointer = (raw: Event): void => {
    const event = raw as PointerEvent;
    state.pointers.delete(event.pointerId);
    if (state.pointers.size < 2) {
      state.pinchPrev = null;
    }
    if (state.pan?.id === event.pointerId) {
      state.pan = null;
    }
    try {
      figure.releasePointerCapture(event.pointerId);
    } catch {
      // The capture may already be gone; nothing depends on it.
    }
  };
  on(figure, "pointerup", endPointer);
  on(figure, "pointercancel", endPointer);

  // Ctrl/⌘ + wheel (and the trackpad pinch, which arrives the same way)
  // zooms around the pointer; a plain wheel is the page's own scroll and
  // passes through untouched.
  on(
    figure,
    "wheel",
    (raw) => {
      const wheel = raw as WheelEvent;
      if (!wheel.ctrlKey && !wheel.metaKey) {
        return;
      }
      wheel.preventDefault();
      const unit = wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? 800 : 1;
      const { px, py } = toLocal(wheel.clientX, wheel.clientY);
      const viewport = viewportOf(figure);
      state.view = zoomAround(
        state.view, state.fit, Math.exp(-wheel.deltaY * unit * 0.01), px, py, state.content, viewport,
      );
      state.atFit = false;
      apply(state);
    },
    { passive: false },
  );

  on(figure, "keydown", (raw) => {
    const event = raw as KeyboardEvent;
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
        state.view = zoomAround(state.view, state.fit, ZOOM_STEP, centre.px, centre.py, state.content, viewport);
        state.atFit = false;
        apply(state);
        event.preventDefault();
        break;
      case "-":
      case "_":
        state.view = zoomAround(state.view, state.fit, 1 / ZOOM_STEP, centre.px, centre.py, state.content, viewport);
        state.atFit = false;
        apply(state);
        event.preventDefault();
        break;
      case "0":
        fit(state);
        event.preventDefault();
        break;
      case "ArrowLeft":
        state.view = panBy(state.view, PAN_STEP, 0, state.content, viewport);
        state.atFit = false;
        apply(state);
        event.preventDefault();
        break;
      case "ArrowRight":
        state.view = panBy(state.view, -PAN_STEP, 0, state.content, viewport);
        state.atFit = false;
        apply(state);
        event.preventDefault();
        break;
      case "ArrowUp":
        state.view = panBy(state.view, 0, PAN_STEP, state.content, viewport);
        state.atFit = false;
        apply(state);
        event.preventDefault();
        break;
      case "ArrowDown":
        state.view = panBy(state.view, 0, -PAN_STEP, state.content, viewport);
        state.atFit = false;
        apply(state);
        event.preventDefault();
        break;
      default:
        break;
    }
  });

  // A resize keeps the current zoom and recentres only a view at Fit.
  // The kept zoom re-clamps to the new fit's range, so it cannot strand
  // the view outside 0.25×–4× of the fit scale.
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      if (state.atFit) {
        fit(state);
      } else {
        const viewport = viewportOf(figure);
        state.fit = fitScale(state.content, viewport);
        state.view = clampPan(
          { ...state.view, z: clampZoom(state.view.z, state.fit) }, state.content, viewport,
        );
        apply(state);
      }
    });
    observer.observe(figure);
  }

  return {
    replaceSvg(html: string): void {
      const holder = figure.ownerDocument.createElement("div");
      holder.innerHTML = html;
      const next = holder.querySelector("svg.plate-svg") as SVGSVGElement | null;
      if (next === null) {
        return;
      }
      const size = contentOf(next);
      if (size === null) {
        return;
      }
      const same = size.w === state.content.w && size.h === state.content.h;
      next.style.width = `${size.w}px`;
      next.style.height = `${size.h}px`;
      figure.style.setProperty("--plate-ratio", `${size.w} / ${size.h}`);
      state.svg.replaceWith(next);
      state.svg = next;
      if (same) {
        apply(state);
      } else {
        state.content = size;
        fit(state);
      }
    },
    dispose(): void {
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.length = 0;
      observer?.disconnect();
      observer = null;
      bar.remove();
      delete figure.dataset["plateLive"];
      figure.classList.remove("is-live");
      figure.style.removeProperty("--plate-ratio");
    },
  };
}
