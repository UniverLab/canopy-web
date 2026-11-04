// SPDX-License-Identifier: Apache-2.0
// The terminal controls' fullscreen button: rendered only where the
// browser can honour it, toggling through the Fullscreen API and
// following fullscreenchange (maximize when windowed, minimize while
// fullscreen). happy-dom ships no Fullscreen API, so every leg stubs it.
// The control-size toggle: the size that fits this device's panel, sent
// and applied locally on, re-asserted (debounced) while on, never off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { icon } from "../src/icons-dom.js";
import {
  SIZE_DEBOUNCE_MS,
  SIZE_TAKEN_NOTE,
  latestHidden,
  termControlsHtml,
  termLatestHtml,
  termSizeHtml,
  wireTermControls,
} from "../src/term-controls.js";
import type { TermControls, TermControlsDeps, TermControlsView } from "../src/term-controls.js";
import type { TermSize } from "../src/terminal.js";
import { readControlSize, writeControlSize } from "../src/terminal-prefs.js";

/** The icon markup as the DOM serializes it (paths gain close tags). */
function rendered(name: Parameters<typeof icon>[0]): string {
  const host = document.createElement("span");
  host.innerHTML = icon(name);
  return host.innerHTML;
}

function deps(root: HTMLElement): TermControlsDeps {
  return {
    root,
    sessionId: () => "s1",
    terminalView: () => null,
    onControlSize: () => {},
    onReleaseSize: () => {},
    onLocalSize: () => {},
    onBuilder: () => {},
    onCopy: () => {},
  };
}

function stubMatchMedia(standalone: boolean): () => void {
  const real = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => ({
    matches: standalone && query === "(display-mode: standalone)",
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia;
  return () => {
    globalThis.matchMedia = real;
  };
}

function stubFullscreenEnabled(value: boolean): () => void {
  Object.defineProperty(document, "fullscreenEnabled", {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    delete (document as unknown as Record<string, unknown>)["fullscreenEnabled"];
  };
}

describe("term fullscreen button", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    document.body.innerHTML = "";
    localStorage.clear();
  });

  const mount = (): { root: HTMLDivElement } => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    root.innerHTML = termControlsHtml();
    wireTermControls(deps(root));
    return { root };
  };

  it("is absent when fullscreenEnabled is false", () => {
    cleanups.push(stubFullscreenEnabled(false), stubMatchMedia(false));
    const { root } = mount();
    expect(root.querySelector("#term-fullscreen")).toBeNull();
    // The rest of the row still renders.
    expect(root.querySelector("#term-zoom-in")).not.toBeNull();
    expect(root.querySelector("#term-builder")).not.toBeNull();
  });

  it("is absent in standalone display mode", () => {
    cleanups.push(stubFullscreenEnabled(true), stubMatchMedia(true));
    const { root } = mount();
    expect(root.querySelector("#term-fullscreen")).toBeNull();
  });

  it("toggles through the stubbed API and follows fullscreenchange", () => {
    cleanups.push(stubFullscreenEnabled(true), stubMatchMedia(false));
    let current: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      get: () => current,
      configurable: true,
    });
    cleanups.push(() => {
      delete (document as unknown as Record<string, unknown>)["fullscreenElement"];
    });
    const requestFullscreen = vi.fn((): Promise<void> => {
      current = document.documentElement;
      return Promise.resolve();
    });
    const exitFullscreen = vi.fn((): Promise<void> => {
      current = null;
      return Promise.resolve();
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      value: requestFullscreen,
      configurable: true,
      writable: true,
    });
    cleanups.push(() => {
      delete (document.documentElement as unknown as Record<string, unknown>)[
        "requestFullscreen"
      ];
    });
    Object.defineProperty(document, "exitFullscreen", {
      value: exitFullscreen,
      configurable: true,
      writable: true,
    });
    cleanups.push(() => {
      delete (document as unknown as Record<string, unknown>)["exitFullscreen"];
    });

    const { root } = mount();
    const button = root.querySelector<HTMLButtonElement>("#term-fullscreen");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(button?.getAttribute("aria-label")).toBe("Enter fullscreen");
    expect(button?.innerHTML).toBe(rendered("maximize"));

    button?.click();
    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: "hide" });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(button?.getAttribute("aria-label")).toBe("Exit fullscreen");
    expect(button?.innerHTML).toBe(rendered("minimize"));

    button?.click();
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    expect(button?.getAttribute("aria-label")).toBe("Enter fullscreen");
    expect(button?.innerHTML).toBe(rendered("maximize"));
  });
});

/** The view slice the size toggle drives, with a panel size the test sets. */
class StubView implements TermControlsView {
  fitted = true;
  isAlternate = false;
  owner: boolean[] = [];
  fits: TermSize | null;
  private release: () => void = () => {};
  private readonly readyPromise: Promise<void>;

  constructor(fits: TermSize | null, open = true) {
    this.fits = fits;
    this.fitted = open;
    this.readyPromise = open
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          this.release = resolve;
        });
  }

  zoomIn = (): void => {};
  zoomOut = (): void => {};
  scrollToLatest = (): void => {};
  ready = (): Promise<void> => this.readyPromise;
  ownedSize = (): TermSize | null => this.fits;
  setSizeOwner = (owner: boolean): void => {
    this.owner.push(owner);
  };

  open(): void {
    this.fitted = true;
    this.release();
  }
}

describe("control-size toggle", () => {
  let root: HTMLDivElement;
  let view: StubView | null;
  let sent: TermSize[];
  let local: TermSize[];
  let released: number;
  let controls: TermControls;

  const toggle = (): HTMLInputElement => {
    const el = root.querySelector<HTMLInputElement>("#term-control-size");
    if (!el) {
      throw new Error("missing #term-control-size");
    }
    return el;
  };

  const flip = (checked: boolean): void => {
    toggle().checked = checked;
    toggle().dispatchEvent(new Event("change", { bubbles: true }));
  };

  const mount = (): void => {
    root = document.createElement("div");
    document.body.appendChild(root);
    root.innerHTML = `<div id="term-pane"></div>${termControlsHtml()}${termSizeHtml("s1")}`;
    controls = wireTermControls({
      ...deps(root),
      terminalView: () => view,
      onControlSize: (cols, rows) => sent.push({ cols, rows }),
      onReleaseSize: () => {
        released += 1;
      },
      onLocalSize: (cols, rows) => local.push({ cols, rows }),
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    view = new StubView({ cols: 44, rows: 19 });
    sent = [];
    local = [];
    released = 0;
    mount();
  });

  afterEach(() => {
    controls.dispose();
    vi.useRealTimers();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("sends and applies the size that fits the panel when turned on", () => {
    flip(true);
    expect(readControlSize("s1")).toBe(true);
    expect(view?.owner).toEqual([true]);
    // The panel's own size, never the host's: the local terminal takes it
    // too, so it renders at scale 1 instead of being fitted.
    expect(sent).toEqual([{ cols: 44, rows: 19 }]);
    expect(local).toEqual([{ cols: 44, rows: 19 }]);
  });

  it("re-sends once, debounced, while the panel keeps changing", () => {
    flip(true);
    view!.fits = { cols: 90, rows: 30 };
    globalThis.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS - 50);
    globalThis.dispatchEvent(new Event("orientationchange"));
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS - 1);
    expect(sent).toHaveLength(1);
    document.dispatchEvent(new Event("fullscreenchange"));
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS);
    expect(sent).toEqual([
      { cols: 44, rows: 19 },
      { cols: 90, rows: 30 },
    ]);
    expect(local).toEqual(sent);
    // A zoom reaches the same debounce through the shell.
    view!.fits = { cols: 72, rows: 24 };
    controls.schedule();
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS);
    expect(sent.at(-1)).toEqual({ cols: 72, rows: 24 });
  });

  it("never re-sends a size that did not change", () => {
    flip(true);
    globalThis.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS);
    controls.schedule();
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
  });

  it("stops asserting and follows the host again when turned off", () => {
    flip(true);
    flip(false);
    expect(readControlSize("s1")).toBe(false);
    expect(view?.owner).toEqual([true, false]);
    // The user's own toggle gives the size back exactly once.
    expect(released).toBe(1);
    view!.fits = { cols: 90, rows: 30 };
    globalThis.dispatchEvent(new Event("resize"));
    controls.schedule();
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS * 2);
    expect(sent).toHaveLength(1);
    expect(released).toBe(1);
  });

  it("re-asserts a remembered toggle on mount, even an unchanged size", () => {
    controls.reassert();
    // Off: nothing to re-assert.
    expect(sent).toEqual([]);
    writeControlSize("s1", true);
    controls.reassert();
    expect(toggle().checked).toBe(true);
    expect(sent).toEqual([{ cols: 44, rows: 19 }]);
    // A remount (reconnect) may face a host at any size: send it again.
    controls.reassert();
    expect(sent).toEqual([
      { cols: 44, rows: 19 },
      { cols: 44, rows: 19 },
    ]);
  });

  it("waits for a terminal behind the font gate before measuring", async () => {
    const gated = new StubView({ cols: 50, rows: 20 }, false);
    view = gated;
    flip(true);
    expect(sent).toEqual([]);
    gated.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([{ cols: 50, rows: 20 }]);
  });

  it("retries a panel that is not measured yet", () => {
    view!.fits = null;
    flip(true);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS);
    view!.fits = { cols: 60, rows: 22 };
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS);
    expect(sent).toEqual([{ cols: 60, rows: 22 }]);
  });

  it("asserts nothing without a terminal, until the mount re-asserts", () => {
    view = null;
    flip(true);
    expect(sent).toEqual([]);
    view = new StubView({ cols: 44, rows: 19 });
    controls.reassert();
    expect(sent).toEqual([{ cols: 44, rows: 19 }]);
  });

  it("stops watching the panel once disposed", () => {
    flip(true);
    controls.dispose();
    view!.fits = { cols: 90, rows: 30 };
    globalThis.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS * 2);
    expect(sent).toHaveLength(1);
    // Tearing the view down never gives the size back: the host releases
    // the sizes of a disconnecting device on its own.
    expect(released).toBe(0);
  });

  const note = (): string => root.querySelector(".term-size-note")?.textContent ?? "";

  it("follows the host's resized frame while off", () => {
    controls.handleResized(120, 40);
    expect(local).toEqual([{ cols: 120, rows: 40 }]);
    expect(sent).toEqual([]);
    // A follower holds nothing to give back.
    expect(released).toBe(0);
    expect(toggle().checked).toBe(false);
  });

  it("keeps the size when the host echoes this device's own", () => {
    flip(true);
    controls.handleResized(44, 19);
    expect(toggle().checked).toBe(true);
    expect(readControlSize("s1")).toBe(true);
    expect(local).toEqual([{ cols: 44, rows: 19 }]);
  });

  it("never mistakes a slow echo of an older size for a takeover", () => {
    flip(true);
    view!.fits = { cols: 90, rows: 30 };
    globalThis.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
    // The host answers both, the older one first.
    controls.handleResized(44, 19);
    controls.handleResized(90, 30);
    expect(toggle().checked).toBe(true);
    expect(note()).not.toBe(SIZE_TAKEN_NOTE);
  });

  it("lets go without fighting when another device takes the size over", () => {
    flip(true);
    expect(sent).toEqual([{ cols: 44, rows: 19 }]);
    controls.handleResized(120, 40);
    // Off and remembered off, said in the note; the local terminal follows
    // the new size and nothing is sent back.
    expect(toggle().checked).toBe(false);
    expect(readControlSize("s1")).toBe(false);
    expect(view?.owner).toEqual([true, false]);
    expect(note()).toBe(SIZE_TAKEN_NOTE);
    expect(root.querySelector(".term-size-note")?.classList.contains("is-notice")).toBe(true);
    expect(local.at(-1)).toEqual({ cols: 120, rows: 40 });
    expect(sent).toEqual([{ cols: 44, rows: 19 }]);
    // A takeover is not the user's toggle: nothing goes back.
    expect(released).toBe(0);
    // No longer watching: a panel change sends nothing.
    globalThis.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(SIZE_DEBOUNCE_MS * 2);
    expect(sent).toHaveLength(1);
    // Taking it back clears the notice and asserts again.
    flip(true);
    expect(note()).toBe("Only one client should control the size.");
    expect(sent).toHaveLength(2);
  });

  it("follows a resize that lands before its own first assert", () => {
    const gated = new StubView({ cols: 50, rows: 20 }, false);
    view = gated;
    flip(true);
    controls.handleResized(120, 40);
    expect(toggle().checked).toBe(true);
    expect(local).toEqual([{ cols: 120, rows: 40 }]);
  });
});

describe("the latest button", () => {
  it("renders outside the toolbar, icon-only and named", () => {
    const root = document.createElement("div");
    root.innerHTML = termControlsHtml();
    expect(root.querySelector("#term-latest")).toBeNull();
    root.innerHTML = termLatestHtml();
    const latest = root.querySelector<HTMLButtonElement>("#term-latest");
    expect(latest?.hidden).toBe(true);
    expect(latest?.getAttribute("aria-label")).toBe("Scroll to the latest output");
    expect(latest?.getAttribute("title")).toBe("Scroll to the latest output");
    expect(latest?.textContent?.trim()).toBe("");
  });

  it("shows on the shell while not following, in fullscreen while scrolled down", () => {
    expect(latestHidden(true, false, 0)).toBe(true);
    expect(latestHidden(false, false, 0)).toBe(false);
    expect(latestHidden(false, false, 300)).toBe(false);
    expect(latestHidden(false, true, 0)).toBe(true);
    expect(latestHidden(false, true, 1)).toBe(false);
  });
});
