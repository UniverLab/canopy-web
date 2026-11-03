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
  written: Uint8Array[] = [];
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

  write = (data: Uint8Array): void => {
    this.written.push(data);
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
    view.write(new TextEncoder().encode("hi"));
    expect(handles[0]?.written).toEqual([new TextEncoder().encode("hi")]);
    handles[0]?.emitInput("x");
    expect(inputs).toEqual(["x"]);
    parent.querySelector(".term-host")?.dispatchEvent(new Event("click", { bubbles: true }));
    // Clicking the terminal focuses it, opening the soft keyboard.
    expect(handles[0]?.focused).toBe(1);
    view.dispose();
    expect(handles[0]?.disposed).toBe(true);
    expect(view.fitted).toBe(false);
  });

  it("waits for the real face and keeps the writes that arrive first", async () => {
    const { parent, view, handles } = setup();
    let release: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A Font Loading API that stays pending until the test releases it: the
    // snapshot beats the face exactly as it can on a slow network.
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: () => loaded, ready: Promise.resolve() },
    });
    try {
      view.mount(parent, 80, 24);
      // The cell size must be measured with the real face, so xterm is not
      // open yet and nothing has been written to it.
      expect(view.fitted).toBe(false);
      expect(handles).toHaveLength(0);
      view.write(new TextEncoder().encode("hello from the host\r\n"));
      expect(handles).toHaveLength(0);
      release();
      await view.ready();
      expect(handles).toHaveLength(1);
      // The buffered snapshot is flushed into xterm as its bytes when it opens.
      expect(handles[0]?.written).toEqual([new TextEncoder().encode("hello from the host\r\n")]);
    } finally {
      Reflect.deleteProperty(document, "fonts");
      view.dispose();
    }
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
    // Always fit-to-width, so the expected scale is pane / content; the
    // Fit toggle is a no-op that must not change it.
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

  it("always fits the pane width with Fit off, and Fit is a no-op", () => {
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
    // 24 rows × 17 px: the old 11 px floor would be 11 / 17 here, wider
    // than the pane. The view ignores it now — the rightmost column fits
    // with no manual Fit press.
    Object.defineProperty(host, "scrollHeight", { value: 408, configurable: true });
    // A stale horizontal scroll from before the refit (open, resize, zoom
    // out): the refit must anchor the pane back at the line start.
    parent.scrollLeft = 48;
    view.refit();
    const fitted = 356 / 672;
    expect(view.isFitOnly).toBe(false);
    expect(host.style.transform).toBe(`scale(${fitted})`);
    expect(fit.dataset.fit).toBe("off");
    expect(scaler.style.width).toBe(`${672 * fitted}px`);
    expect(672 * fitted).toBeCloseTo(356, 6);
    expect(parent.scrollLeft).toBe(0);
    // Fit on changes nothing but the remembered toggle: same scale, same
    // box, still anchored left.
    view.setFitOnly(true);
    expect(view.isFitOnly).toBe(true);
    expect(fit.dataset.fit).toBe("on");
    expect(host.style.transform).toBe(`scale(${fitted})`);
    expect(scaler.style.width).toBe(`${672 * fitted}px`);
    expect(parent.scrollLeft).toBe(0);
    view.setFitOnly(false);
    expect(host.style.transform).toBe(`scale(${fitted})`);
    view.dispose();
  });

  it("keeps the line start visible when zoom overflows the pane", () => {
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
    Object.defineProperty(host, "scrollHeight", { value: 408, configurable: true });
    view.refit();
    expect(parent.scrollLeft).toBe(0);
    // 200 % zoom overflows to the right (the pane pans), but the refit
    // re-anchors the pane so the line start stays visible.
    parent.scrollLeft = 120;
    view.setZoom(2);
    const zoomed = (356 / 672) * 2;
    expect(host.style.transform).toBe(`scale(${zoomed})`);
    expect(parseFloat(scaler.style.width)).toBeCloseTo(672 * zoomed, 3);
    expect(672 * zoomed).toBeGreaterThan(356);
    expect(parent.scrollLeft).toBe(0);
    view.dispose();
  });

  it("keeps a manual pan when Fit is toggled", () => {
    const { parent, view } = setup();
    view.mount(parent, 80, 24);
    const fit = parent.querySelector<HTMLElement>(".term-fit");
    const host = parent.querySelector<HTMLElement>(".term-host");
    if (!fit || !host) {
      throw new Error("missing scaffold");
    }
    Object.defineProperty(fit, "clientWidth", { value: 356, configurable: true });
    Object.defineProperty(host, "scrollWidth", { value: 672, configurable: true });
    Object.defineProperty(host, "scrollHeight", { value: 408, configurable: true });
    view.setZoom(2);
    const zoomed = (356 / 672) * 2;
    expect(host.style.transform).toBe(`scale(${zoomed})`);
    // The user pans right to read the zoomed line's end; toggling Fit is a
    // harmless no-op, so the pan and the scale must survive it.
    parent.scrollLeft = 120;
    view.setFitOnly(true);
    expect(fit.dataset.fit).toBe("on");
    expect(host.style.transform).toBe(`scale(${zoomed})`);
    expect(parent.scrollLeft).toBe(120);
    view.setFitOnly(false);
    expect(fit.dataset.fit).toBe("off");
    expect(host.style.transform).toBe(`scale(${zoomed})`);
    expect(parent.scrollLeft).toBe(120);
    view.dispose();
  });
});
