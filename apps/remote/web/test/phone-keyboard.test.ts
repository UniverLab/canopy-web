// SPDX-License-Identifier: Apache-2.0
// The phone-keyboard helpers: the keyboard-open threshold and the two
// focus rules the key bar and the terminal pane use.
import { afterEach, describe, expect, it, vi } from "vitest";
import { dropIdleFocus, followKeyboard, keyboardOpen, openPhoneKeyboard } from "../src/phone-keyboard.js";

interface Call {
  name: "focus" | "blur";
}

function fakeView(): { calls: Call[]; focus(): void; blur(): void } {
  const calls: Call[] = [];
  return {
    calls,
    focus() {
      calls.push({ name: "focus" });
    },
    blur() {
      calls.push({ name: "blur" });
    },
  };
}

function setPointer(fine: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: fine && query === "(pointer: fine)",
  }));
}

function setViewport(height: number | null, layoutHeight: number): void {
  vi.stubGlobal("visualViewport", height === null ? null : { height });
  vi.stubGlobal("innerHeight", layoutHeight);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("keyboardOpen", () => {
  it("is true only once the keyboard hides more than 120 px", () => {
    expect(keyboardOpen({ height: 640 - 121 }, 640)).toBe(true);
    expect(keyboardOpen({ height: 640 - 120 }, 640)).toBe(false);
    expect(keyboardOpen({ height: 640 }, 640)).toBe(false);
  });

  it("is false when visualViewport is missing", () => {
    expect(keyboardOpen(null, 640)).toBe(false);
    expect(keyboardOpen(undefined, 640)).toBe(false);
  });

  it("reads window.visualViewport and window.innerHeight by default", () => {
    setViewport(340, 640);
    expect(keyboardOpen()).toBe(true);
    setViewport(600, 640);
    expect(keyboardOpen()).toBe(false);
    setViewport(null, 640);
    expect(keyboardOpen()).toBe(false);
  });
});

describe("dropIdleFocus", () => {
  it("blurs a coarse pointer with the keyboard closed", () => {
    setPointer(false);
    setViewport(640, 640);
    const view = fakeView();
    dropIdleFocus(view);
    expect(view.calls).toEqual([{ name: "blur" }]);
  });

  it("does nothing with the keyboard open", () => {
    setPointer(false);
    setViewport(340, 640);
    const view = fakeView();
    dropIdleFocus(view);
    expect(view.calls).toEqual([]);
  });

  it("does nothing on a fine pointer", () => {
    setPointer(true);
    setViewport(640, 640);
    const view = fakeView();
    dropIdleFocus(view);
    expect(view.calls).toEqual([]);
  });
});

describe("openPhoneKeyboard", () => {
  it("blurs then focuses on a coarse pointer with the keyboard closed", () => {
    setPointer(false);
    setViewport(640, 640);
    const view = fakeView();
    openPhoneKeyboard(view);
    expect(view.calls).toEqual([{ name: "blur" }, { name: "focus" }]);
  });

  it("only focuses with the keyboard already open", () => {
    setPointer(false);
    setViewport(340, 640);
    const view = fakeView();
    openPhoneKeyboard(view);
    expect(view.calls).toEqual([{ name: "focus" }]);
  });

  it("only focuses on a fine pointer", () => {
    setPointer(true);
    setViewport(640, 640);
    const view = fakeView();
    openPhoneKeyboard(view);
    expect(view.calls).toEqual([{ name: "focus" }]);
  });
});

// A visualViewport stand-in: height/offsetTop plus the two listeners
// followKeyboard attaches, fired by hand.
function fakeVisualViewport(height: number, offsetTop = 0) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    height,
    offsetTop,
    addEventListener(type: string, listener: () => void): void {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: () => void): void {
      listeners.get(type)?.delete(listener);
    },
    fire(type: "resize" | "scroll"): void {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

// requestAnimationFrame captured, not run: the test flushes it.
function stubRaf(): { flush(): void; pending(): number } {
  const queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    flush() {
      for (const cb of queue.splice(0)) {
        cb(0);
      }
    },
    pending() {
      return queue.length;
    },
  };
}

function fakeSession(): { main: HTMLElement; pane: HTMLElement } {
  const main = document.createElement("main");
  main.className = "session-view";
  const pane = document.createElement("div");
  Object.defineProperty(pane, "scrollHeight", { value: 480, configurable: true });
  return { main, pane };
}

describe("followKeyboard", () => {
  it("does nothing without visualViewport", () => {
    vi.stubGlobal("visualViewport", null);
    vi.stubGlobal("innerHeight", 640);
    const { main, pane } = fakeSession();
    const dispose = followKeyboard(main, pane);
    expect(main.hasAttribute("data-keyboard")).toBe(false);
    dispose();
    expect(main.hasAttribute("data-keyboard")).toBe(false);
  });

  it("pins the view and scrolls the pane while the keyboard is open", () => {
    const viewport = fakeVisualViewport(340, 12);
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 640);
    stubRaf();
    const { main, pane } = fakeSession();
    const dispose = followKeyboard(main, pane);
    expect(main.getAttribute("data-keyboard")).toBe("");
    expect(main.style.getPropertyValue("--vv-top")).toBe("12px");
    expect(main.style.getPropertyValue("--vv-height")).toBe("340px");
    expect(pane.scrollTop).toBe(480);
    dispose();
  });

  it("coalesces resize and scroll through rAF, then clears on close", () => {
    const viewport = fakeVisualViewport(340);
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 640);
    const raf = stubRaf();
    const { main, pane } = fakeSession();
    const dispose = followKeyboard(main, pane);
    expect(main.hasAttribute("data-keyboard")).toBe(true);

    viewport.height = 500;
    viewport.fire("resize");
    viewport.fire("scroll");
    // Both events scheduled one frame; the attribute is still the old one.
    expect(raf.pending()).toBe(1);
    raf.flush();
    expect(main.style.getPropertyValue("--vv-height")).toBe("500px");
    expect(main.hasAttribute("data-keyboard")).toBe(true);

    viewport.height = 640;
    viewport.fire("resize");
    raf.flush();
    expect(main.hasAttribute("data-keyboard")).toBe(false);
    expect(main.style.getPropertyValue("--vv-top")).toBe("");
    expect(main.style.getPropertyValue("--vv-height")).toBe("");
    dispose();
  });

  it("dispose removes the listeners and leaves nothing behind", () => {
    const viewport = fakeVisualViewport(340);
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 640);
    stubRaf();
    const { main, pane } = fakeSession();
    const dispose = followKeyboard(main, pane);
    expect(viewport.listenerCount("resize")).toBe(1);
    expect(viewport.listenerCount("scroll")).toBe(1);
    dispose();
    expect(viewport.listenerCount("resize")).toBe(0);
    expect(viewport.listenerCount("scroll")).toBe(0);
    expect(main.hasAttribute("data-keyboard")).toBe(false);
    expect(main.style.getPropertyValue("--vv-top")).toBe("");
    expect(main.style.getPropertyValue("--vv-height")).toBe("");
    // A late event after dispose changes nothing.
    viewport.height = 640;
    viewport.fire("resize");
    expect(main.hasAttribute("data-keyboard")).toBe(false);
  });
});
