// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import {
  clampZoom,
  classifyTouchGesture,
  computeFitScale,
  computeMinScale,
  computeOwnedSize,
  computeScale,
  decayFlingVelocity,
  flingVelocity,
  MAX_ZOOM,
  MIN_ZOOM,
  OWNED_MAX_COLS,
  OWNED_MAX_ROWS,
  OWNED_MIN_COLS,
  OWNED_MIN_ROWS,
  shouldContinueFling,
  shouldStartFling,
  splitTouchScroll,
  TerminalView,
  touchWheelDelta,
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
  alternate = false;
  baseScale?: number;
  resizes: { cols: number; rows: number }[] = [];
  private inputListeners: ((text: string) => void)[] = [];
  private scrollListeners: (() => void)[] = [];
  private bufferListeners: (() => void)[] = [];
  private selectionListeners: (() => void)[] = [];

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
  blur = (): void => {};
  scrollToBottom = (): void => {
    this.scrolledToBottom += 1;
    this.atBottom = true;
  };
  isAtBottom = (): boolean => this.atBottom;
  isAlternateBuffer = (): boolean => this.alternate;
  onBufferChange = (callback: () => void): (() => void) => {
    this.bufferListeners.push(callback);
    return () => {};
  };
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
  selection = "";
  bufferLines = "";
  getSelection = (): string => this.selection;
  onSelectionChange = (callback: () => void): (() => void) => {
    this.selectionListeners.push(callback);
    return () => {};
  };
  bufferText = (): string => this.bufferLines;
  resize = (cols: number, rows: number): void => {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push({ cols, rows });
  };
  dispose = (): void => {
    this.disposed = true;
  };

  emitInput(text: string): void {
    for (const listener of this.inputListeners) {
      listener(text);
    }
  }

  emitSelectionChange(selection: string): void {
    this.selection = selection;
    for (const listener of this.selectionListeners) {
      listener();
    }
  }

  emitScroll(atBottom: boolean): void {
    this.atBottom = atBottom;
    for (const listener of this.scrollListeners) {
      listener();
    }
  }

  emitBufferChange(alternate: boolean): void {
    this.alternate = alternate;
    for (const listener of this.bufferListeners) {
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

  it("fits the whole frame in the alternate buffer", () => {
    // 80×24 at 8.4 px cells in a 340×100 box: the height binds.
    const expected = Math.min(340 / 672, 100 / 408);
    expect(expected).toBeLessThan(340 / 672);
    expect(computeFitScale(340, 100, 672, 408, 1, true)).toBeCloseTo(expected, 10);
    expect(computeFitScale(340, 100, 672, 408, 2, true)).toBeCloseTo(expected * 2, 10);
    // No box, no fit: the guards hold on every zero side.
    expect(computeFitScale(0, 100, 672, 408, 1, true)).toBe(1);
    expect(computeFitScale(340, 0, 672, 408, 1, true)).toBe(1);
    expect(computeFitScale(340, 100, 0, 408, 1, true)).toBe(1);
    expect(computeFitScale(340, 100, 672, 0, 1, true)).toBe(1);
  });

  it("keeps the width fit in the normal buffer", () => {
    expect(computeFitScale(340, 100, 672, 408, 1, false)).toBeCloseTo(340 / 672, 10);
    expect(computeFitScale(340, 100, 672, 408, 2, false)).toBeCloseTo((340 / 672) * 2, 10);
  });
});

describe("owned size", () => {
  it("fits whole cells into the panel", () => {
    // 372 × 337 CSS px at 8.4 × 17 px cells: 44 columns, 19 rows.
    expect(computeOwnedSize(372, 337, 8.4, 17)).toEqual({ cols: 44, rows: 19 });
    // A part cell never counts; an exact fit does despite float error.
    expect(computeOwnedSize(100, 100, 8, 16)).toEqual({ cols: 20, rows: 6 });
    expect(computeOwnedSize(336, 340, 8.4, 17)).toEqual({ cols: 40, rows: 20 });
  });

  it("clamps to sane bounds", () => {
    expect(computeOwnedSize(50, 30, 8, 16)).toEqual({ cols: OWNED_MIN_COLS, rows: OWNED_MIN_ROWS });
    expect(computeOwnedSize(100_000, 100_000, 8, 16)).toEqual({
      cols: OWNED_MAX_COLS,
      rows: OWNED_MAX_ROWS,
    });
    expect([OWNED_MIN_COLS, OWNED_MAX_COLS, OWNED_MIN_ROWS, OWNED_MAX_ROWS]).toEqual([20, 500, 5, 200]);
  });

  it("is unknown until both the panel and the cell are measured", () => {
    expect(computeOwnedSize(0, 300, 8, 16)).toBeNull();
    expect(computeOwnedSize(300, 0, 8, 16)).toBeNull();
    expect(computeOwnedSize(300, 300, 0, 16)).toBeNull();
    expect(computeOwnedSize(300, 300, 8, Number.NaN)).toBeNull();
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

describe("one-finger touch scroll", () => {
  it("classifies a gesture by its first 8 px", () => {
    expect(classifyTouchGesture(0, 0)).toBe("undecided");
    expect(classifyTouchGesture(5, 5)).toBe("undecided");
    expect(classifyTouchGesture(0, 8)).toBe("vertical");
    expect(classifyTouchGesture(0, -8)).toBe("vertical");
    expect(classifyTouchGesture(8, 0)).toBe("horizontal");
    expect(classifyTouchGesture(-9, 2)).toBe("horizontal");
    expect(classifyTouchGesture(6, 10)).toBe("vertical");
    expect(classifyTouchGesture(10, 6)).toBe("horizontal");
    // A tie at 45 degrees scrolls the terminal.
    expect(classifyTouchGesture(8, 8)).toBe("vertical");
  });

  it("chains the pane first and hands the rest to the terminal", () => {
    // No pane overflow (zoom 1): everything goes to the terminal.
    expect(splitTouchScroll(-100, 0, 400, 400)).toEqual({ pane: 0, terminal: -100 });
    expect(splitTouchScroll(100, 0, 400, 400)).toEqual({ pane: 0, terminal: 100 });
    // The zoomed pane absorbs what it can…
    expect(splitTouchScroll(-30, 50, 600, 400)).toEqual({ pane: -30, terminal: 0 });
    expect(splitTouchScroll(50, 10, 600, 400)).toEqual({ pane: 50, terminal: 0 });
    // …and the remainder reaches the terminal at either edge.
    expect(splitTouchScroll(-30, 10, 600, 400)).toEqual({ pane: -10, terminal: -20 });
    expect(splitTouchScroll(50, 190, 600, 400)).toEqual({ pane: 10, terminal: 40 });
    expect(splitTouchScroll(0, 50, 600, 400)).toEqual({ pane: 0, terminal: 0 });
  });

  it("scales the terminal remainder back into xterm px", () => {
    expect(touchWheelDelta(-100, 0.5)).toBe(-200);
    expect(touchWheelDelta(50, 2)).toBe(25);
    expect(touchWheelDelta(-100, 1)).toBe(-100);
    expect(touchWheelDelta(-100, 0)).toBe(-100);
  });

  it("flings only fast vertical tails and decays them per frame", () => {
    // Velocity over the last 100 ms, in px/ms, finger space.
    expect(flingVelocity([])).toBe(0);
    expect(flingVelocity([{ y: 0, t: 0 }])).toBe(0);
    expect(flingVelocity([{ y: 0, t: 0 }, { y: 100, t: 50 }])).toBe(2);
    // Older history leaves the window: only 150→200 ms counts.
    expect(
      flingVelocity([
        { y: 0, t: 0 },
        { y: 10, t: 150 },
        { y: 60, t: 200 },
      ]),
    ).toBe(1);
    // No time elapsed, no fling.
    expect(flingVelocity([{ y: 0, t: 100 }, { y: 50, t: 100 }])).toBe(0);
    // Faster than 0.3 px/ms starts a fling; at 0.3 it stays put.
    expect(shouldStartFling(0.31)).toBe(true);
    expect(shouldStartFling(-0.31)).toBe(true);
    expect(shouldStartFling(0.3)).toBe(false);
    expect(shouldStartFling(0)).toBe(false);
    // A 0.95 decay per frame until under 0.05 px/ms.
    expect(decayFlingVelocity(2)).toBeCloseTo(1.9, 10);
    expect(decayFlingVelocity(-2)).toBeCloseTo(-1.9, 10);
    expect(shouldContinueFling(0.05)).toBe(true);
    expect(shouldContinueFling(0.049)).toBe(false);
    expect(shouldContinueFling(-0.05)).toBe(true);
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

  it("focuses the terminal when the pane itself is tapped", () => {
    const { parent, view, handles } = setup();
    view.mount(parent, 80, 24);
    // A tap on the pane padding (not the terminal) still focuses xterm.
    parent.dispatchEvent(new Event("click", { bubbles: true }));
    expect(handles[0]?.focused).toBe(1);
    // Dispose removes the pane listener: a later tap focuses nothing new.
    view.dispose();
    parent.dispatchEvent(new Event("click", { bubbles: true }));
    expect(handles[0]?.focused).toBe(1);
  });

  it("focuses once open when tapped behind the font gate", async () => {
    const { parent, view, handles } = setup();
    let release: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: () => loaded, ready: Promise.resolve() },
    });
    try {
      view.mount(parent, 80, 24);
      expect(view.fitted).toBe(false);
      // The tap lands before xterm exists; the keyboard still opens once it does.
      parent.dispatchEvent(new Event("click", { bubbles: true }));
      expect(handles).toHaveLength(0);
      release();
      await view.ready();
      expect(handles).toHaveLength(1);
      expect(handles[0]?.focused).toBe(1);
    } finally {
      Reflect.deleteProperty(document, "fonts");
      view.dispose();
    }
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

  it("follows the viewport's own scroll event, which wheels funnel through", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const handle = new FakeHandle(80, 24);
    const follows: boolean[] = [];
    const view = new TerminalView(
      (host) => {
        // Real xterm builds its viewport inside host at open; the view
        // attaches its follow listener to it (xterm's onScroll never fires
        // for wheel or touch scrolling: that path suppresses the event).
        const viewport = document.createElement("div");
        viewport.className = "xterm-viewport";
        host.appendChild(viewport);
        return handle;
      },
      { onUserInput: () => {}, onFollowChange: ({ following }) => follows.push(following) },
    );
    view.mount(parent, 80, 24);
    const viewport = parent.querySelector(".xterm-viewport");
    expect(viewport).not.toBeNull();
    expect(view.isFollowing).toBe(true);
    // Scrolled up: follow drops and the latest button shows.
    handle.atBottom = false;
    viewport?.dispatchEvent(new Event("scroll"));
    expect(view.isFollowing).toBe(false);
    expect(follows).toEqual([false]);
    // Back at the bottom: follow resumes.
    handle.atBottom = true;
    viewport?.dispatchEvent(new Event("scroll"));
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
    // Always fit-to-width, so the expected scale is pane / content.
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
    expect(parent.style.getPropertyValue("--term-visual-h")).toBe("240px");
    view.dispose();
  });

  it("always fits the pane width and anchors the line start", () => {
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
    expect(host.style.transform).toBe(`scale(${fitted})`);
    expect(scaler.style.width).toBe(`${672 * fitted}px`);
    expect(672 * fitted).toBeCloseTo(356, 6);
    expect(parent.scrollLeft).toBe(0);
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

  it("measures the real .xterm-screen width, never the wrapper", () => {
    const { parent, view } = setup();
    view.mount(parent, 80, 24);
    const fit = parent.querySelector<HTMLElement>(".term-fit");
    const host = parent.querySelector<HTMLElement>(".term-host");
    if (!fit || !host) {
      throw new Error("missing scaffold");
    }
    // The wrapper (.xterm) is narrower than the screen it holds: a scale
    // from the wrapper would overflow the panel on the right.
    const wrapper = document.createElement("div");
    wrapper.className = "xterm";
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    wrapper.appendChild(screen);
    host.appendChild(wrapper);
    Object.defineProperty(fit, "clientWidth", { value: 340, configurable: true });
    Object.defineProperty(wrapper, "scrollWidth", { value: 300, configurable: true });
    Object.defineProperty(screen, "scrollWidth", { value: 700, configurable: true });
    Object.defineProperty(screen, "offsetHeight", { value: 408, configurable: true });
    view.refit();
    expect(host.style.transform).toBe(`scale(${340 / 700})`);
    expect(fit.dataset.buffer).toBe("normal");
    view.dispose();
  });

  it("frames the whole screen and switches follow off in the alternate buffer", () => {
    const { parent, view, handles, follows } = setup();
    view.mount(parent, 80, 24);
    const fit = parent.querySelector<HTMLElement>(".term-fit");
    const scaler = parent.querySelector<HTMLElement>(".term-scale");
    const host = parent.querySelector<HTMLElement>(".term-host");
    if (!fit || !scaler || !host) {
      throw new Error("missing scaffold");
    }
    // 80×24 at 8.4 px cells in a 340×100 box: the height binds, so the
    // alternate scale sits below the width fit.
    Object.defineProperty(fit, "clientWidth", { value: 340, configurable: true });
    Object.defineProperty(fit, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(host, "scrollWidth", { value: 672, configurable: true });
    Object.defineProperty(host, "scrollHeight", { value: 408, configurable: true });
    view.refit();
    const widthFit = 340 / 672;
    expect(view.isAlternate).toBe(false);
    expect(view.isFollowing).toBe(true);
    expect(host.style.transform).toBe(`scale(${widthFit})`);
    expect(fit.dataset.buffer).toBe("normal");
    // A stale bottom scroll from the shell tail: entering fullscreen must
    // drop it so the frame paints from the top.
    parent.scrollTop = 120;
    handles[0]?.emitBufferChange(true);
    const fitAll = Math.min(340 / 672, 100 / 408);
    expect(fitAll).toBeLessThan(widthFit);
    expect(view.isAlternate).toBe(true);
    expect(view.isFollowing).toBe(false);
    expect(follows).toEqual([false]);
    expect(host.style.transform).toBe(`scale(${fitAll})`);
    expect(fit.dataset.buffer).toBe("alternate");
    expect(parseFloat(scaler.style.width)).toBeCloseTo(672 * fitAll, 6);
    expect(parseFloat(scaler.style.height)).toBeCloseTo(100, 6);
    expect(parent.scrollTop).toBe(0);
    // Scroll noise while fullscreen never re-enables follow.
    handles[0]?.emitScroll(true);
    expect(view.isFollowing).toBe(false);
    expect(follows).toEqual([false]);
    // Back to the shell: the width fit plus follow-bottom resume.
    handles[0]?.emitBufferChange(false);
    expect(view.isAlternate).toBe(false);
    expect(host.style.transform).toBe(`scale(${widthFit})`);
    expect(fit.dataset.buffer).toBe("normal");
    expect(view.isFollowing).toBe(true);
    expect(follows).toEqual([false, true]);
    view.dispose();
  });

  it("keeps follow off when latest is tapped in the alternate buffer", () => {
    const { parent, view, handles, follows } = setup();
    view.mount(parent, 80, 24);
    const fit = parent.querySelector<HTMLElement>(".term-fit");
    const host = parent.querySelector<HTMLElement>(".term-host");
    if (!fit || !host) {
      throw new Error("missing scaffold");
    }
    Object.defineProperty(fit, "clientWidth", { value: 340, configurable: true });
    Object.defineProperty(fit, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(host, "scrollWidth", { value: 672, configurable: true });
    Object.defineProperty(host, "scrollHeight", { value: 408, configurable: true });
    handles[0]?.emitBufferChange(true);
    expect(view.isAlternate).toBe(true);
    expect(view.isFollowing).toBe(false);
    // A zoomed pan away from the frame top: latest re-shows the frame…
    parent.scrollTop = 60;
    view.scrollToLatest();
    expect(parent.scrollTop).toBe(0);
    // …without re-enabling follow: no new callback, still off.
    expect(view.isFollowing).toBe(false);
    expect(follows).toEqual([false]);
    view.dispose();
  });

  // happy-dom has no layout: a panel of panelW × panelH and a grid whose
  // natural size follows the handle's cols × rows at 8 × 16 px cells.
  function layOut(
    parent: HTMLElement,
    handle: FakeHandle,
    panelW: number,
    panelH: number,
  ): { fit: HTMLElement; host: HTMLElement } {
    const fit = parent.querySelector<HTMLElement>(".term-fit");
    const host = parent.querySelector<HTMLElement>(".term-host");
    if (!fit || !host) {
      throw new Error("missing scaffold");
    }
    Object.defineProperty(fit, "clientWidth", { value: panelW, configurable: true });
    Object.defineProperty(fit, "clientHeight", { value: panelH, configurable: true });
    Object.defineProperty(host, "scrollWidth", { get: () => handle.cols * 8, configurable: true });
    Object.defineProperty(host, "scrollHeight", { get: () => handle.rows * 16, configurable: true });
    return { fit, host };
  }

  it("computes the size that fits its panel from the measured cell", () => {
    const { parent, view, handles } = setup();
    expect(view.ownedSize()).toBeNull();
    view.mount(parent, 80, 24);
    const handle = handles[0]!;
    layOut(parent, handle, 400, 320);
    // 400 / 8 and 320 / 16, whatever size the host had.
    expect(view.ownedSize()).toEqual({ cols: 50, rows: 20 });
    // The zoom grows the cell, so fewer fit.
    view.setZoom(2);
    expect(view.ownedSize()).toEqual({ cols: 25, rows: 10 });
    // The DPR-1 double-size face shows at its base scale, not its own size.
    view.setZoom(1);
    handle.baseScale = 0.5;
    expect(view.ownedSize()).toEqual({ cols: 100, rows: 40 });
    view.dispose();
  });

  it("resizes the local terminal in place and refits", () => {
    const { parent, view, handles } = setup();
    view.mount(parent, 80, 24);
    const handle = handles[0]!;
    const { host } = layOut(parent, handle, 400, 320);
    expect(view.resize(50, 20)).toBe(true);
    expect(handle.resizes).toEqual([{ cols: 50, rows: 20 }]);
    expect(view.size).toEqual({ cols: 50, rows: 20 });
    // Fitted to the width as before: 400 / (50 × 8).
    expect(host.style.transform).toBe("scale(1)");
    // Unchanged or invalid sizes are no-ops.
    expect(view.resize(50, 20)).toBe(false);
    expect(view.resize(0, 20)).toBe(false);
    expect(view.resize(50.5, 20)).toBe(false);
    expect(handles).toHaveLength(1);
    expect(handle.resizes).toHaveLength(1);
    view.dispose();
  });

  it("opens a terminal still behind the font gate at the resized grid", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: () => gate, ready: Promise.resolve() },
    });
    try {
      const { parent, view, handles } = setup();
      view.mount(parent, 80, 24);
      expect(handles).toHaveLength(0);
      view.resize(50, 20);
      release();
      await view.ready();
      expect(handles[0]?.cols).toBe(50);
      expect(handles[0]?.rows).toBe(20);
      view.dispose();
    } finally {
      Reflect.deleteProperty(document, "fonts");
    }
  });

  it("renders a size owner at its base scale times the zoom, never width-fitted", () => {
    const { parent, view, handles } = setup();
    view.mount(parent, 80, 24);
    const handle = handles[0]!;
    const { host } = layOut(parent, handle, 400, 320);
    view.refit();
    expect(host.style.transform).toBe(`scale(${400 / 640})`);
    view.setSizeOwner(true);
    expect(view.isSizeOwner).toBe(true);
    expect(parent.dataset.sizeOwner).toBe("true");
    expect(host.style.transform).toBe("scale(1)");
    handle.baseScale = 0.5;
    view.setZoom(1.5);
    expect(host.style.transform).toBe("scale(0.75)");
    // Off again: back to following the host's size, fitted to the width.
    view.setSizeOwner(false);
    expect(parent.dataset.sizeOwner).toBeUndefined();
    expect(host.style.transform).toBe(`scale(${(400 / 640) * 1.5})`);
    view.setSizeOwner(true);
    view.dispose();
    expect(parent.dataset.sizeOwner).toBeUndefined();
    expect(view.isSizeOwner).toBe(false);
  });

  it("reports every zoom change", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let zooms = 0;
    const view = new TerminalView((_host, cols, rows) => new FakeHandle(cols, rows), {
      onUserInput: () => {},
      onZoomChange: () => {
        zooms += 1;
      },
    });
    view.mount(parent, 80, 24);
    view.zoomIn();
    view.zoomOut();
    view.setZoom(2);
    expect(zooms).toBe(3);
    view.dispose();
  });
});
