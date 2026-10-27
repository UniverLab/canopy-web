// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import {
  clampZoom,
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
});
