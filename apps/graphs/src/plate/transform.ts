// SPDX-License-Identifier: Apache-2.0
/**
 * The plate viewport's transform math: fit, zoom and pan over the
 * document page's horizontal plate, in plain numbers with no DOM.
 *
 * Coordinates: the client paints the svg with
 * `translate(x, y) scale(z)` from a `0 0` origin, so a content point
 * `(cx, cy)` lands on viewport point `(x + cx * z, y + cy * z)`. The
 * zoom is relative to the fit scale: 0.25× to 4× of it. A pan is
 * always clamped so the content covers the viewport's centre — the
 * drawing can never be pushed out of sight.
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
 * Zoom by a factor around one viewport point: the content point under
 * it stays under it. The zoom clamps to the fit-relative range, and
 * the pan clamps so the content still covers the viewport centre.
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
 * Clamp a pan so the content covers the viewport's centre: the centre
 * in content coordinates must lie inside the content box.
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
