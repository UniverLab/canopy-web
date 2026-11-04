// SPDX-License-Identifier: Apache-2.0
// The shared plate viewer in the DOM: mounting sets the fit, a drag pans,
// `replaceSvg` keeps the view when the drawing's size is unchanged and
// refits when it grows, and `dispose` takes every listener and control
// away. happy-dom has no layout, so the viewport is stubbed on the figure.
import { afterEach, describe, expect, it } from "vitest";
import {
  mountPlateViewer,
  type PlateLabels,
  type PlateViewer,
} from "../../../../packages/plate/viewport.js";

const LABELS: PlateLabels = {
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  fit: "Fit",
  fitLabel: "Fit the graph",
};

const VIEWPORT = { w: 800, h: 400 };

function svgOf(w: number, h: number): string {
  return (
    `<svg class="plate-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}"/></svg>`
  );
}

function figureOf(w: number, h: number): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "plate";
  figure.dataset["plate"] = "";
  figure.innerHTML = svgOf(w, h);
  Object.defineProperty(figure, "clientWidth", { value: VIEWPORT.w, configurable: true });
  Object.defineProperty(figure, "clientHeight", { value: VIEWPORT.h, configurable: true });
  document.body.append(figure);
  return figure;
}

function setup(w = 400, h = 200): { figure: HTMLElement; viewer: PlateViewer } {
  const figure = figureOf(w, h);
  const viewer = mountPlateViewer(figure, LABELS);
  if (viewer === null) {
    throw new Error("the figure did not mount");
  }
  return { figure, viewer };
}

function pointer(figure: HTMLElement, type: string, x: number, y: number): void {
  figure.dispatchEvent(
    new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true }),
  );
}

function drag(figure: HTMLElement, from: [number, number], to: [number, number]): void {
  pointer(figure, "pointerdown", from[0], from[1]);
  pointer(figure, "pointermove", to[0], to[1]);
  pointer(figure, "pointerup", to[0], to[1]);
}

function svgIn(figure: HTMLElement): SVGSVGElement {
  return figure.querySelector("svg.plate-svg") as SVGSVGElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("mountPlateViewer", () => {
  it("fits the drawing to the viewport and adds the three controls", () => {
    const { figure } = setup();
    // 400 × 200 content in an 800 × 400 viewport fits at scale 2.
    expect(svgIn(figure).style.transform).toBe("translate(0px, 0px) scale(2)");
    expect(figure.classList.contains("is-live")).toBe(true);
    expect(figure.style.getPropertyValue("--plate-ratio")).toBe("400 / 200");
    const controls = [...figure.querySelectorAll(".plate-controls button")];
    expect(controls.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Zoom out",
      "Zoom in",
      "Fit the graph",
    ]);
  });

  it("answers null for a figure without a sized svg", () => {
    const figure = document.createElement("figure");
    figure.className = "plate";
    figure.innerHTML = `<svg class="plate-svg"></svg>`;
    expect(mountPlateViewer(figure, LABELS)).toBeNull();
  });
});

describe("replaceSvg", () => {
  it("keeps a panned and zoomed view when the drawing keeps its size", () => {
    const { figure, viewer } = setup();
    drag(figure, [100, 100], [150, 130]);
    const old = svgIn(figure);
    const kept = old.style.transform;
    expect(kept).not.toBe("translate(0px, 0px) scale(2)");

    viewer.replaceSvg(svgOf(400, 200));
    const next = svgIn(figure);
    expect(next).not.toBe(old);
    expect(next.style.transform).toBe(kept);
  });

  it("refits when the new drawing has a different size", () => {
    const { figure, viewer } = setup();
    drag(figure, [100, 100], [150, 130]);
    expect(svgIn(figure).style.transform).not.toBe("translate(0px, 0px) scale(2)");

    viewer.replaceSvg(svgOf(800, 400));
    // 800 × 400 content in an 800 × 400 viewport fits at scale 1.
    expect(svgIn(figure).style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(figure.style.getPropertyValue("--plate-ratio")).toBe("800 / 400");
  });
});

describe("dispose", () => {
  it("removes the controls and stops responding to pointer events", () => {
    const { figure, viewer } = setup();
    const svg = svgIn(figure);
    const fitted = svg.style.transform;
    viewer.dispose();
    expect(figure.querySelectorAll(".plate-controls").length).toBe(0);
    expect(figure.classList.contains("is-live")).toBe(false);
    drag(figure, [100, 100], [150, 130]);
    expect(svg.style.transform).toBe(fitted);
  });
});
