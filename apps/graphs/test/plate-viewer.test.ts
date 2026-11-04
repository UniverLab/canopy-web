// SPDX-License-Identifier: Apache-2.0
/**
 * The plate viewport's transform math: the fit scale, the fit view, the
 * clamped zoom around a point, and the pan that always keeps the content
 * covering the viewport's centre. Pure numbers, no DOM — the viewer in
 * `packages/plate/viewport.ts` paints what these return.
 */
import { describe, expect, it } from "vitest";
import {
  PAN_STEP,
  ZOOM_MAX_REL,
  ZOOM_MIN_REL,
  ZOOM_STEP,
  clampPan,
  clampZoom,
  fitScale,
  fitView,
  panBy,
  zoomAround,
} from "../../../packages/plate/viewport.js";

const CONTENT = { w: 2000, h: 500 };
const VIEWPORT = { w: 700, h: 900 };

describe("fitScale", () => {
  it("fits the constraining axis: width here, height for a tall drawing", () => {
    expect(fitScale(CONTENT, VIEWPORT)).toBeCloseTo(0.35, 10);
    expect(fitScale({ w: 400, h: 2000 }, VIEWPORT)).toBeCloseTo(0.45, 10);
  });

  it("answers 1 for a degenerate box instead of dividing by zero", () => {
    expect(fitScale({ w: 0, h: 500 }, VIEWPORT)).toBe(1);
    expect(fitScale(CONTENT, { w: 700, h: 0 })).toBe(1);
  });
});

describe("fitView", () => {
  it("shows the whole graph centred", () => {
    const view = fitView(CONTENT, VIEWPORT);
    expect(view.z).toBeCloseTo(0.35, 10);
    // Painted 700 × 175, centred in 700 × 900.
    expect(view.x).toBeCloseTo(0, 10);
    expect(view.y).toBeCloseTo(362.5, 10);
  });
});

describe("clampZoom", () => {
  it("holds 0.25× to 4× of the fit scale", () => {
    expect(clampZoom(0.35, 0.35)).toBeCloseTo(0.35, 10);
    expect(clampZoom(10, 0.35)).toBeCloseTo(0.35 * ZOOM_MAX_REL, 10);
    expect(clampZoom(0.001, 0.35)).toBeCloseTo(0.35 * ZOOM_MIN_REL, 10);
  });

  it("falls back to fit for a non-finite zoom", () => {
    expect(clampZoom(Number.NaN, 0.35)).toBeCloseTo(0.35, 10);
  });
});

describe("zoomAround", () => {
  it("keeps the content point under the pointer where it was", () => {
    const fit = fitScale(CONTENT, VIEWPORT);
    const before = fitView(CONTENT, VIEWPORT);
    // (100, 450) sits on the painted drawing, not in its letterbox.
    const after = zoomAround(before, fit, 2, 100, 450, CONTENT, VIEWPORT);
    expect(after.z).toBeCloseTo(before.z * 2, 10);
    // The same content point lands on (100, 450) before and after.
    const at = (view: typeof before): [number, number] => [(100 - view.x) / view.z, (450 - view.y) / view.z];
    const [bx, by] = at(before);
    const [ax, ay] = at(after);
    expect(ax).toBeCloseTo(bx, 10);
    expect(ay).toBeCloseTo(by, 10);
  });

  it("clamps past the range and keeps the centre covered", () => {
    const fit = fitScale(CONTENT, VIEWPORT);
    const before = fitView(CONTENT, VIEWPORT);
    const zoomed = zoomAround(before, fit, 100, 0, 0, CONTENT, VIEWPORT);
    expect(zoomed.z).toBeCloseTo(fit * ZOOM_MAX_REL, 10);
    const shrunk = zoomAround(before, fit, 0.0001, 0, 0, CONTENT, VIEWPORT);
    expect(shrunk.z).toBeCloseTo(fit * ZOOM_MIN_REL, 10);
    for (const view of [zoomed, shrunk]) {
      const cx = (VIEWPORT.w / 2 - view.x) / view.z;
      const cy = (VIEWPORT.h / 2 - view.y) / view.z;
      expect(cx).toBeGreaterThanOrEqual(-1e-9);
      expect(cx).toBeLessThanOrEqual(CONTENT.w + 1e-9);
      expect(cy).toBeGreaterThanOrEqual(-1e-9);
      expect(cy).toBeLessThanOrEqual(CONTENT.h + 1e-9);
    }
  });

  it("ignores a non-positive factor", () => {
    const fit = fitScale(CONTENT, VIEWPORT);
    const before = fitView(CONTENT, VIEWPORT);
    expect(zoomAround(before, fit, 0, 100, 200, CONTENT, VIEWPORT)).toEqual(before);
    expect(zoomAround(before, fit, -2, 100, 200, CONTENT, VIEWPORT)).toEqual(before);
  });
});

describe("pan", () => {
  it("moves the view by the delta inside the range", () => {
    const before = { x: 100, y: 100, z: 1 };
    const viewport = { w: 700, h: 900 };
    const content = { w: 2000, h: 2000 };
    const after = panBy(before, 30, -20, content, viewport);
    expect(after).toEqual({ x: 130, y: 80, z: 1 });
  });

  it("clamps so the content still covers the viewport centre", () => {
    const viewport = { w: 700, h: 900 };
    const content = { w: 2000, h: 500 };
    const view = { x: 0, y: 362.5, z: 0.35 };
    // Far past every edge: the centre stays on the drawing.
    const clamped = panBy(view, -100_000, 100_000, content, viewport);
    expect(clamped.x).toBeCloseTo(VIEWPORT.w / 2 - CONTENT.w * 0.35, 10);
    expect(clamped.y).toBeCloseTo(VIEWPORT.h / 2, 10);
    // Even zoomed to the minimum, a pan cannot lose the drawing.
    const tiny = clampPan({ x: 999_999, y: -999_999, z: fitScale(content, viewport) * ZOOM_MIN_REL }, content, viewport);
    const cx = (viewport.w / 2 - tiny.x) / tiny.z;
    const cy = (viewport.h / 2 - tiny.y) / tiny.z;
    expect(cx).toBeGreaterThanOrEqual(-1e-9);
    expect(cx).toBeLessThanOrEqual(content.w + 1e-9);
    expect(cy).toBeGreaterThanOrEqual(-1e-9);
    expect(cy).toBeLessThanOrEqual(content.h + 1e-9);
  });

  it("ignores a non-finite delta", () => {
    const before = { x: 100, y: 100, z: 1 };
    expect(panBy(before, Number.NaN, 0, CONTENT, VIEWPORT)).toEqual(before);
  });
});

describe("steps", () => {
  it("zooms in fixed steps and pans arrow keys by a fixed stride", () => {
    expect(ZOOM_STEP).toBeGreaterThan(1);
    expect(PAN_STEP).toBeGreaterThan(0);
  });
});
