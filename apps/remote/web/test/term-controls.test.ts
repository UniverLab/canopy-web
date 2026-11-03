// SPDX-License-Identifier: Apache-2.0
// The terminal controls' fullscreen button: rendered only where the
// browser can honour it, toggling through the Fullscreen API and
// following fullscreenchange (maximize when windowed, minimize while
// fullscreen). happy-dom ships no Fullscreen API, so every leg stubs it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { icon } from "../src/icons-dom.js";
import { termControlsHtml, wireTermControls } from "../src/term-controls.js";
import type { TermControlsDeps } from "../src/term-controls.js";

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
    sessionSize: () => ({ cols: 80, rows: 24 }),
    onControlSize: () => {},
    onBuilder: () => {},
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
