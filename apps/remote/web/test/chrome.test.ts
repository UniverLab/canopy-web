// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderTopbar } from "../src/chrome.js";
import type { TopbarState } from "../src/chrome.js";

function state(overrides: Partial<TopbarState> = {}): TopbarState {
  return {
    login: "octo",
    hostLabel: "demo host",
    connectionState: "connected",
    link: "wifi",
    signOutError: null,
    accountOpen: false,
    ...overrides,
  };
}

describe("renderTopbar", () => {
  it("carries the honeycomb host as the band's first child", () => {
    const root = document.createElement("div");
    root.innerHTML = renderTopbar(state());
    const bar = root.querySelector(".topbar") as HTMLElement;
    const host = bar.firstElementChild as HTMLElement;
    expect(host.id).toBe("fondo");
    expect(host.className).toBe("fondo");
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(bar.querySelector(".topbar-inner")).not.toBeNull();
  });

  it("carries the host on the signed-out band too", () => {
    const root = document.createElement("div");
    root.innerHTML = renderTopbar(state({ login: null, hostLabel: "" }));
    expect(root.querySelector(".topbar > #fondo")).not.toBeNull();
  });
});
