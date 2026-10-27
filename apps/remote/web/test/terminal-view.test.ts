// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import {
  clampZoom,
  computeMinScale,
  computeScale,
  MAX_ZOOM,
  MIN_ZOOM,
  TerminalView,
  zoomFromPinch,
} from "../src/terminal.js";
import type { TerminalFactory, TerminalHandle } from "../src/terminal.js";

class FakeHandle implements TerminalHandle {
  written: string[] = [];
  clears = 0;
  focused = 0;
  disposed = false;
  atBottom = true;
  scrolledToBottom = 0;
  cols: number;
  rows: number;
  private inputListeners: ((text: string) => void)[] = [];
  private scrollListeners: (() => void)[] = [];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  write = (text: string): void => {
    this.written.push(text);
  };
  clear = (): void => {
    this.clears += 1;
  };
  focus = (): void => {
    this.focused += 1;
  };
  scrollToBottom = (): void => {
    this.scrolledToBottom += 1;
    this.atBottom = true;
  };
  isAtBottom = (): boolean => this.atBottom;
  onUserInput = (callback: (text: string) => void): (() => void) => {
    this.inputListeners.push(callback);
    return () => {};
  };
  onScroll = (callback: () => void): (() => void) => {
    this.scrollListeners.push(callback);
    return () => {};
  };
  onReady = (callback: () => void): (() => void) => {
    callback();
    return () => {};
  };
  dispose = (): void => {
    this.disposed = true;
  };

  emitInput(text: string): void {
    for (const listener of this.inputListeners) {
      listener(text);
    }
  }

  emitScroll(atBottom: boolean): void {
    this.atBottom = atBottom;
    for (const listener of this.scrollListeners) {
      listener();
    }
  }
}

function setup() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const handles: FakeHandle[] = [];
  const factory: TerminalFactory = (_host, cols, rows) => {
    const handle = new FakeHandle(cols, rows);
    handles.push(handle);
    return handle;
  };
  const inputs: string[] = [];
  const follows: boolean[] = [];
  const view = new TerminalView(factory, {
    onUserInput: (text) => inputs.push(text),
    onFollowChange: ({ following }) => follows.push(following),
  });
  return { parent, view, handles, inputs, follows };
}

describe("scale math", () => {
  it("fits the full width times the zoom", () => {
    expect(computeScale(360, 720, 1)).toBe(0.5);
    expect(computeScale(360, 720, 2)).toBe(1);
    expect(computeScale(0, 720, 1)).toBe(1);
    expect(computeScale(360, 0, 1)).toBe(1);
  });

  it("clamps the zoom", () => {
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("derives zoom from a pinch", () => {
    expect(zoomFromPinch(100, 200, 1)).toBe(2);
    expect(zoomFromPinch(200, 100, 1)).toBe(0.5);
    expect(zoomFromPinch(0, 100, 1)).toBe(1);
  });
});

describe("readable floor", () => {
  // 14 px JetBrains Mono: 8.4 px cell, 17 px row in a real browser.
  const ROW_HEIGHT = 17;
  const CELL_WIDTH = 8.4;
  // Main's 1 rem side padding plus the pane's 1 px border.
  const paneFor = (viewport: number): number => viewport - 34;

  it("never renders a row below 11 CSS px at 360, 390 or 1280", () => {
    const minScale = computeMinScale(ROW_HEIGHT);
    for (const viewport of [360, 390, 1280]) {
      for (const cols of [80, 120]) {
        const pane = paneFor(viewport);
        const content = cols * CELL_WIDTH;
        const scale = computeScale(pane, content, 1, minScale);
        expect(scale).toBeCloseTo(Math.max(pane / content, minScale), 10);
        expect(ROW_HEIGHT * scale).toBeGreaterThanOrEqual(11);
        // Whatever wins, the terminal never sits narrower than the pane.
        expect(content * scale).toBeGreaterThanOrEqual(pane - 1e-9);
      }
    }
  });

  it("picks the floor on a phone and fit-to-width on a desktop", () => {
    const minScale = computeMinScale(ROW_HEIGHT);
    // 80 columns at 390 px: fit would be 0.53, the floor is 0.647.
    expect(computeScale(paneFor(390), 80 * CELL_WIDTH, 1, minScale)).toBeCloseTo(minScale, 10);
    // 80 columns at 1280 px fit comfortably (the app is capped at 48 rem).
    expect(computeScale(paneFor(1280), 80 * CELL_WIDTH, 1, minScale)).toBeCloseTo(
      paneFor(1280) / (80 * CELL_WIDTH),
      10,
    );
    // 120 columns still fit at 1280.
    expect(computeScale(paneFor(1280), 120 * CELL_WIDTH, 1, minScale)).toBeCloseTo(
      paneFor(1280) / (120 * CELL_WIDTH),
      10,
    );
  });

  it("keeps the − / + zoom on top of either mode", () => {
    const minScale = computeMinScale(ROW_HEIGHT);
    expect(computeScale(paneFor(390), 80 * CELL_WIDTH, 2, minScale)).toBeCloseTo(minScale * 2, 10);
    expect(computeScale(paneFor(390), 80 * CELL_WIDTH, 0.5, minScale)).toBeCloseTo(
      minScale * 0.5,
      10,
    );
    // Fit on: no floor at all.
    expect(computeScale(paneFor(390), 80 * CELL_WIDTH, 1, 0)).toBeCloseTo(
      paneFor(390) / (80 * CELL_WIDTH),
      10,
    );
  });
});

describe("TerminalView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts with the snapshot size and forwards input", () => {
    const { parent, view, handles, inputs } = setup();
    view.mount(parent, 80, 24);
    expect(view.fitted).toBe(true);
    expect(handles).toHaveLength(1);
    expect(handles[0]?.cols).toBe(80);
    expect(handles[0]?.rows).toBe(24);
    view.write("hi");
    expect(handles[0]?.written).toEqual(["hi"]);
    handles[0]?.emitInput("x");
    expect(inputs).toEqual(["x"]);
    parent.querySelector(".term-host")?.dispatchEvent(new Event("click", { bubbles: true }));
    // Clicking the terminal focuses it, opening the soft keyboard.
    expect(handles[0]?.focused).toBe(1);
    view.dispose();
    expect(handles[0]?.disposed).toBe(true);
    expect(view.fitted).toBe(false);
  });

  it("tracks follow state and scrolls to latest", () => {
    const { parent, view, handles, follows } = setup();
    view.mount(parent, 80, 24);
    expect(view.isFollowing).toBe(true);
    handles[0]?.emitScroll(false);
    expect(view.isFollowing).toBe(false);
    expect(follows).toEqual([false]);
    view.scrollToLatest();
    expect(handles[0]?.scrolledToBottom).toBe(1);
    expect(view.isFollowing).toBe(true);
    expect(follows).toEqual([false, true]);
    view.dispose();
  });

  it("zooms in steps within bounds", () => {
    const { parent, view } = setup();
    view.mount(parent, 80, 24);
    expect(view.currentZoom).toBe(1);
    view.zoomIn();
    expect(view.currentZoom).toBeCloseTo(1.25, 5);
    view.zoomOut();
    view.zoomOut();
    expect(view.currentZoom).toBeCloseTo(0.8, 5);
    view.setZoom(99);
    expect(view.currentZoom).toBe(MAX_ZOOM);
    view.dispose();
  });

  it("builds the fit > scale > host scaffold", () => {
    const { parent, view } = setup();
    view.mount(parent, 80, 24);
    const fit = parent.querySelector(".term-fit");
    expect(fit?.querySelector(".term-scale > .term-host")).not.toBeNull();
    view.dispose();
    expect(parent.querySelector(".term-fit")).toBeNull();
  });

  it("scales once into the visual box and reports the scale", () => {
    const { parent, view } = setup();
    view.mount(parent, 80, 24);
    // Pure fit-to-width (Fit on), so the expected scale is pane / content.
    view.setFitOnly(true);
    const fit = parent.querySelector<HTMLElement>(".term-fit");
    const scaler = parent.querySelector<HTMLElement>(".term-scale");
    const host = parent.querySelector<HTMLElement>(".term-host");
    if (!fit || !scaler || !host) {
      throw new Error("missing scaffold");
    }
    // happy-dom has no layout: pin the measurements refit reads.
    Object.defineProperty(fit, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(host, "scrollWidth", { value: 800, configurable: true });
    Object.defineProperty(host, "scrollHeight", { value: 480, configurable: true });
    view.refit();
    // The scale applies once, on the host; the scaler is the visual box
    // (natural × scale) and the pane learns the visual height.
    expect(scaler.style.transform).toBe("");
    expect(host.style.transform).toBe("scale(0.5)");
    expect(scaler.style.width).toBe("400px");
    expect(scaler.style.height).toBe("240px");
    expect(fit.dataset.scale).toBe("0.5");
    expect(fit.dataset.fit).toBe("on");
    expect(parent.style.getPropertyValue("--term-visual-h")).toBe("240px");
    view.dispose();
  });

  it("applies the 11 px readable floor unless Fit is on", () => {
    const { parent, view } = setup();
    view.mount(parent, 80, 24);
    const fit = parent.querySelector<HTMLElement>(".term-fit");
    const scaler = parent.querySelector<HTMLElement>(".term-scale");
    const host = parent.querySelector<HTMLElement>(".term-host");
    if (!fit || !scaler || !host) {
      throw new Error("missing scaffold");
    }
    Object.defineProperty(fit, "clientWidth", { value: 356, configurable: true });
    Object.defineProperty(host, "scrollWidth", { value: 672, configurable: true });
    // 24 rows × 17 px: the floor is 11 / 17, wider than the pane.
    Object.defineProperty(host, "scrollHeight", { value: 408, configurable: true });
    view.refit();
    const floor = computeMinScale(17);
    expect(view.isFitOnly).toBe(false);
    expect(host.style.transform).toBe(`scale(${floor})`);
    expect(fit.dataset.fit).toBe("off");
    // The visual box is wider than the pane, which is what makes the pane
    // scroll horizontally instead of shrinking the glyphs.
    expect(parseFloat(scaler.style.width)).toBeCloseTo(672 * floor, 3);
    expect(672 * floor).toBeGreaterThan(356);
    view.setFitOnly(true);
    expect(view.isFitOnly).toBe(true);
    expect(fit.dataset.fit).toBe("on");
    expect(host.style.transform).toBe(`scale(${356 / 672})`);
    expect(672 * (356 / 672)).toBeCloseTo(356, 6);
    view.dispose();
  });
});
