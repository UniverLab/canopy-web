// SPDX-License-Identifier: Apache-2.0
/**
 * The remote's icon layer: static markup through the kit's iconSvgFrom over
 * the remote's own subset, and a morph slot that changes an icon's meaning
 * without moving its box.
 */
import { afterEach, describe, expect, it } from "vitest";
import { canonicalD } from "morphicons/dom";
import { icon, mountMorphSlot } from "../src/icons-dom.js";
import { iconSvg } from "../../../../packages/look/icon-svg.js";
import { loader, send, wifiOff } from "../../../../packages/look/icons.js";

describe("icon", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is the kit's iconSvg", () => {
    expect(icon("send")).toBe(iconSvg("send"));
    expect(icon("check", { size: 20 })).toContain(`width="20" height="20"`);
  });

  it("renders one svg, hidden from readers unless labelled", () => {
    const host = document.createElement("div");
    host.innerHTML = icon("wifiOff");
    const svg = host.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    const labelled = document.createElement("div");
    labelled.innerHTML = icon("wifi", { label: "Connected" });
    expect(labelled.querySelector("svg")?.getAttribute("role")).toBe("img");
    expect(labelled.querySelector("title")?.textContent).toBe("Connected");
  });
});

describe("mountMorphSlot", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function slot(name: Parameters<typeof mountMorphSlot>[1]) {
    const host = document.createElement("span");
    document.body.appendChild(host);
    return { host, morph: mountMorphSlot(host, name, { reducedMotion: "always" }) };
  }

  it("draws the icon at rest as one path on the 24 grid", () => {
    const { host, morph } = slot("send");
    const svg = host.querySelector("svg");
    const paths = host.querySelectorAll("path");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("stroke-width")).toBe("1.75");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute("d")).toBe(canonicalD(send));
    expect(morph.name).toBe("send");
    expect(host.dataset["icon"]).toBe("send");
  });

  it("morphs to the next icon and says so on the host", () => {
    const { host, morph } = slot("send");
    morph.to("loader");
    expect(morph.name).toBe("loader");
    expect(host.dataset["icon"]).toBe("loader");
    expect(host.querySelector("path")?.getAttribute("d")).toBe(canonicalD(loader));
  });

  it("jumps with set", () => {
    const { host, morph } = slot("wifi");
    morph.set("wifiOff");
    expect(host.dataset["icon"]).toBe("wifiOff");
    expect(host.querySelector("path")?.getAttribute("d")).toBe(canonicalD(wifiOff));
  });

  it("keeps the box through a morph", () => {
    const { host, morph } = slot("check");
    const before = host.querySelector("svg")?.getBoundingClientRect();
    morph.to("loader");
    const after = host.querySelector("svg")?.getBoundingClientRect();
    expect(after?.width).toBe(before?.width);
    expect(after?.height).toBe(before?.height);
    // The slot still owns exactly one svg and one path.
    expect(host.querySelectorAll("svg")).toHaveLength(1);
    expect(host.querySelectorAll("path")).toHaveLength(1);
  });

  it("jumps under prefers-reduced-motion with the user policy", () => {
    const original = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    try {
      const host = document.createElement("span");
      document.body.appendChild(host);
      // The default policy is "user": the OS setting decides.
      const morph = mountMorphSlot(host, "send");
      morph.to("loader");
      // No in-between shape: the path is already the target's canonical d.
      expect(host.querySelector("path")?.getAttribute("d")).toBe(canonicalD(loader));
    } finally {
      globalThis.matchMedia = original;
    }
  });

  it("stops animating once destroyed", () => {
    const { host, morph } = slot("send");
    morph.destroy();
    expect(() => morph.to("check")).not.toThrow();
    expect(host.querySelector("path")).not.toBeNull();
  });
});
