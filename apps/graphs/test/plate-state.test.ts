// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's live overlay: `renderPlate` without a state draws exactly
 * the catalogue's own plate (the snapshots in plate.test.ts prove the
 * bytes), and with a state it lights the running unit, badges the passed
 * and failed ones, stops the walking token, and names every marked unit
 * in a `<title>` — nodes and ensemble members alike.
 */
import { describe, expect, it } from "vitest";
import type { GraphDocument } from "../../../packages/plate/document.js";
import { renderPlate } from "../../../packages/plate/render.js";
import { TUI_POLISH_GRAPH } from "./plate-fixture.js";

/** Two agents in a pass chain: the smallest plate with a walking token. */
const CHAIN: GraphDocument = {
  name: "chain",
  nodes: [
    { name: "first", kind: "agent", position: 1, config: {} },
    { name: "second", kind: "agent", position: 2, config: {} },
  ],
  edges: [{ from_node: "first", to_node: "second", condition: "pass" }],
};

/** The opening tag of the drawn node or member the pattern names. */
function tagOf(svg: string, pattern: RegExp): string {
  return svg.match(pattern)?.[0] ?? "";
}

/** A member's drawn label ("1·codex"), read back from a stateless plate. */
function memberLabel(svg: string, group: string, index: number): string {
  const pattern = new RegExp(
    `<g class="member" data-name="${group}" data-i="${index}"[^>]*>` +
      `[\\s\\S]*?<text class="member-label"[^>]*>([^<]+)</text>`,
  );
  return svg.match(pattern)?.[1] ?? "";
}

describe("renderPlate without a state", () => {
  it("is the catalogue's own drawing, with or without the third argument", () => {
    expect(renderPlate(CHAIN, "horizontal", undefined)).toBe(renderPlate(CHAIN));
    expect(renderPlate(TUI_POLISH_GRAPH, "vertical", undefined)).toBe(
      renderPlate(TUI_POLISH_GRAPH, "vertical"),
    );
  });

  it("carries no overlay markup at all", () => {
    for (const svg of [renderPlate(CHAIN), renderPlate(TUI_POLISH_GRAPH, "vertical")]) {
      expect(svg).not.toContain("state-");
      expect(svg).not.toContain("data-state");
      expect(svg).not.toContain("plate-ring-pulse");
    }
  });

  it("walks the token and titles nodes the catalogue way", () => {
    const svg = renderPlate(CHAIN);
    expect(svg).toContain(`<circle class="token"`);
    expect(svg).toContain(`<animateMotion dur="`);
    expect(svg).toContain(`<title>first (agent)</title>`);
  });
});

describe("renderPlate with a state", () => {
  it("lights the running node and stops the token on it", () => {
    const svg = renderPlate(CHAIN, "horizontal", {
      nodes: { first: "pass", second: "running" },
      current: "second",
    });
    expect(tagOf(svg, /<g class="node[^"]*" data-name="second"[^>]*>/)).toContain(
      `data-state="running"`,
    );
    expect(svg).toContain(`<title>second — running</title>`);
    expect(svg).toContain(`class="state-ring"`);
    expect(svg).toContain(`plate-ring-pulse`);
    expect(svg).toContain(`prefers-reduced-motion`);
    // The token no longer walks the chain: one static dot, no motion.
    expect(svg).toContain(`<circle class="token" r="1.1"`);
    expect(svg).not.toContain(`<animateMotion`);
  });

  it("reads a current with no entry of its own as running", () => {
    const svg = renderPlate(CHAIN, "horizontal", { nodes: {}, current: "first" });
    expect(tagOf(svg, /<g class="node[^"]*" data-name="first"[^>]*>/)).toContain(
      `data-state="running"`,
    );
    expect(svg).toContain(`<title>first — running</title>`);
    expect(svg).toContain(`class="state-ring"`);
    expect(svg).not.toContain(`<animateMotion`);
  });

  it("badges a passed node with a check", () => {
    const svg = renderPlate(CHAIN, "horizontal", { nodes: { first: "pass" } });
    expect(tagOf(svg, /<g class="node[^"]*" data-name="first"[^>]*>/)).toContain(`state-pass`);
    expect(tagOf(svg, /<g class="node[^"]*" data-name="first"[^>]*>/)).toContain(`data-state="pass"`);
    expect(svg).toContain(`<title>first — passed</title>`);
    expect(svg).toContain(`class="state-badge"`);
    // No ring without a running unit, and the token stays home.
    expect(svg).not.toContain(`class="state-ring"`);
    expect(svg).not.toContain(`<circle class="token"`);
  });

  it("badges a failed node with a cross and a red stroke", () => {
    const svg = renderPlate(CHAIN, "horizontal", { nodes: { second: "fail" } });
    const tag = tagOf(svg, /<g class="node[^"]*" data-name="second"[^>]*>/);
    expect(tag).toContain(`state-fail`);
    expect(tag).toContain(`data-state="fail"`);
    expect(svg).toContain(`<title>second — failed</title>`);
    expect(svg).toContain(`class="state-badge"`);
    expect(svg).toContain(`#ff6b6b`);
  });

  it("keys ensemble members by label or by ensemble#index", () => {
    const plain = renderPlate(TUI_POLISH_GRAPH);
    const label = memberLabel(plain, "proposers", 1);
    expect(label).not.toBe("");
    const svg = renderPlate(TUI_POLISH_GRAPH, "horizontal", {
      nodes: { [label]: "running", "proposers#2": "pass" },
    });
    const first = tagOf(svg, /<g class="member[^"]*" data-name="proposers" data-i="1"[^>]*>/);
    expect(first).toContain(`data-state="running"`);
    expect(svg).toContain(`<title>${label} — running</title>`);
    const second = tagOf(svg, /<g class="member[^"]*" data-name="proposers" data-i="2"[^>]*>/);
    expect(second).toContain(`data-state="pass"`);
    expect(svg).toContain(`class="state-ring"`);
    expect(svg).toContain(`class="state-badge"`);
    // The token stops on the running member instead of walking the chain.
    expect(svg).not.toContain(`<animateMotion`);
  });

  it("overlays the vertical plate the same way", () => {
    const svg = renderPlate(CHAIN, "vertical", {
      nodes: { second: "running" },
      current: "second",
    });
    expect(svg).toContain(`<svg class="plate-svg plate-v"`);
    expect(svg).toContain(`<title>second — running</title>`);
    expect(svg).toContain(`class="state-ring"`);
    expect(svg).not.toContain(`<animateMotion`);
  });

  it("draws no ring and no token for a state that names nothing drawn", () => {
    const svg = renderPlate(CHAIN, "horizontal", { nodes: { nowhere: "running" } });
    expect(svg).not.toContain(`class="state-ring"`);
    expect(svg).not.toContain(`<circle class="token"`);
  });
});
