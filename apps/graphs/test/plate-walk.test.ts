// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's walk generator: every fail edge the walk rides comes from
 * the injected draws, never from chance in the test — the pure happy
 * path, one draw taking its fail edge, three fails then the run home, a
 * node without a fail edge never taking one, and an ensemble's
 * `on_fail_to` counting as its fail edge. Plus the seeded PRNG's replay
 * and the lit twin the renderer leaves behind for the legs a walk rode —
 * string assertions on the svg, no DOM.
 */
import { describe, expect, it } from "vitest";
import { parseDocument, type GraphDocument } from "../../../packages/plate/document.js";
import { renderPlate } from "../../../packages/plate/render.js";
import {
  generateWalk,
  mulberry32,
  walkUnits,
  type WalkStep,
} from "../../../packages/plate/walk.js";

/** The loop fixture: a gate that may fail back to fix, then gets through. */
const LOOP: GraphDocument = {
  name: "walk-loop",
  nodes: [
    { name: "start", kind: "check", position: 1, config: {} },
    { name: "gate", kind: "gate", position: 2, config: {} },
    { name: "fix", kind: "agent", position: 3, config: {} },
    { name: "done", kind: "check", position: 4, config: {} },
  ],
  edges: [
    { from_node: "start", to_node: "gate", condition: "pass" },
    { from_node: "gate", to_node: "fix", condition: "fail" },
    { from_node: "gate", to_node: "done", condition: "pass" },
    { from_node: "fix", to_node: "gate", condition: "pass" },
  ],
};

/** A figure whose ensemble carries the only fail edge, out of its box. */
const PANEL: GraphDocument = {
  name: "walk-panel",
  nodes: [
    { name: "start", kind: "check", position: 1, config: {} },
    { name: "repair", kind: "agent", position: 2, config: {} },
    { name: "done", kind: "check", position: 3, config: {} },
  ],
  edges: [{ from_node: "repair", to_node: "done", condition: "pass" }],
  ensembles: [
    {
      name: "panel",
      members: [{}, {}],
      entry_from_node: "start",
      entry_condition: "pass",
      on_pass_to: "done",
      on_fail_to: "repair",
    },
  ],
};

/** A gate with two fail edges: the second draw picks which one the walk rides. */
const FORK: GraphDocument = {
  name: "walk-fork",
  nodes: [
    { name: "start", kind: "check", position: 1, config: {} },
    { name: "gate", kind: "gate", position: 2, config: {} },
    { name: "left", kind: "agent", position: 3, config: {} },
    { name: "right", kind: "agent", position: 4, config: {} },
    { name: "done", kind: "check", position: 5, config: {} },
  ],
  edges: [
    { from_node: "start", to_node: "gate", condition: "pass" },
    { from_node: "gate", to_node: "left", condition: "fail" },
    { from_node: "gate", to_node: "right", condition: "fail" },
    { from_node: "gate", to_node: "done", condition: "pass" },
    { from_node: "left", to_node: "done", condition: "pass" },
    { from_node: "right", to_node: "done", condition: "pass" },
  ],
};

/** Walk one fixture with injected draws; the sequence repeats when spent. */
function walkWith(draws: number[], document: GraphDocument = LOOP): WalkStep[] {
  const parsed = parseDocument(document);
  if (parsed === null) {
    throw new Error("the fixture must parse");
  }
  let used = 0;
  return generateWalk(parsed, "start", walkUnits(parsed), () => {
    const draw = draws[used] ?? draws[draws.length - 1] ?? 1;
    used += 1;
    return draw;
  });
}

/** The walk as "from→to" words, with the fail legs marked. */
function words(steps: WalkStep[]): string[] {
  return steps.map((step) => `${step.from}→${step.to}${step.fail === true ? " (fail)" : ""}`);
}

describe("the walk generator", () => {
  it("takes the pure happy path when every draw stays at or above 0.2", () => {
    const steps = walkWith([0.2, 1, 0.9, 0.5]);
    expect(words(steps)).toEqual(["start→gate", "gate→done"]);
    expect(steps.every((step) => step.fail === false)).toBe(true);
  });

  it("takes the fail edge when the draw at a fail-carrying node dips below 0.2", () => {
    // start consumes no draw — it carries no fail edge — and gate's own
    // draw dips below the chance, so the very next step rides the fail.
    const steps = walkWith([0.1, 1]);
    expect(words(steps)).toEqual([
      "start→gate",
      "gate→fix (fail)",
      "fix→gate",
      "gate→done",
    ]);
    expect(steps[1]).toEqual({ from: "gate", to: "fix", fail: true });
  });

  it("rides exactly three fails when every draw dips, then runs home", () => {
    const steps = walkWith([0]);
    expect(steps.filter((step) => step.fail === true)).toHaveLength(3);
    expect(words(steps)).toEqual([
      "start→gate",
      "gate→fix (fail)",
      "fix→gate",
      "gate→fix (fail)",
      "fix→gate",
      "gate→fix (fail)",
      "fix→gate",
      "gate→done",
    ]);
    // Past the loop, at the dead end: the walk always reaches the end.
    expect(steps[steps.length - 1]?.to).toBe("done");
  });

  it("never takes a fail edge from a node that has none", () => {
    const steps = walkWith([0]);
    const froms = steps.filter((step) => step.fail === true).map((step) => step.from);
    expect(froms).toEqual(["gate", "gate", "gate"]);
  });

  it("counts an ensemble's on_fail_to exit as the ensemble's fail edge", () => {
    // The walker enters the box in one pass step, and the box's own draw
    // below the chance rides its on_fail_to exit like a node's fail edge.
    expect(words(walkWith([0], PANEL))).toEqual([
      "start→panel",
      "panel→repair (fail)",
      "repair→done",
    ]);
    expect(words(walkWith([0.5], PANEL))).toEqual(["start→panel", "panel→done"]);
  });

  it("picks uniformly among several fail edges with a second draw", () => {
    // The first draw dips below the chance, so the walk fails; the second
    // draw indexes the two fail edges — 0.0 rides the first, 0.6 the second.
    expect(words(walkWith([0.1, 0.0], FORK))).toEqual([
      "start→gate",
      "gate→left (fail)",
      "left→done",
    ]);
    expect(words(walkWith([0.1, 0.6], FORK))).toEqual([
      "start→gate",
      "gate→right (fail)",
      "right→done",
    ]);
  });

  it("walks both orientations the same fail edges from one shared seed", () => {
    // The pages replay one seed per orientation's own generator, so the
    // H/V pair carries the same walk — same length, same lit windows.
    const horizontal = renderPlate(LOOP, "horizontal", undefined, mulberry32(7));
    const vertical = renderPlate(LOOP, "vertical", undefined, mulberry32(7));
    const duration = (svg: string): string | undefined =>
      /<animateMotion[^>]*dur="([^"]+)"/.exec(svg)?.[1];
    const lit = (svg: string): string | undefined => /values="([^"]+)"/.exec(svg)?.[1];
    expect(duration(horizontal)).toBe("5.4s");
    expect(duration(vertical)).toBe(duration(horizontal));
    expect(lit(horizontal)).toBeDefined();
    expect(lit(vertical)).toBe(lit(horizontal));
  });

  it("replays the same walk from the same seed, in [0, 1)", () => {
    const parsed = parseDocument(LOOP);
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      return;
    }
    const units = walkUnits(parsed);
    const a = generateWalk(parsed, "start", units, mulberry32(1234));
    const b = generateWalk(parsed, "start", units, mulberry32(1234));
    expect(a).toEqual(b);
    const draws = Array.from({ length: 5 }, mulberry32(7));
    for (const draw of draws) {
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThan(1);
    }
    expect(draws[0]).toBe(mulberry32(7)());
  });
});

describe("the lit fail edges", () => {
  it("lights one window per leg the walk rode, and hides the light under reduced motion", () => {
    const svg = renderPlate(LOOP, "horizontal", undefined, () => 0);
    expect(svg).toContain(`<path class="edge-lit" `);
    expect(svg).toContain(` data-lit>`);
    expect(svg).toContain(`<animate attributeName="opacity" calcMode="discrete"`);
    expect(svg).toContain(`dur="7.2s" repeatCount="indefinite"`);
    expect(svg).toContain(`@media (prefers-reduced-motion:reduce){.plate-svg .edge-lit{display:none}}`);
    // The gate's fail edge rode on legs 1, 3 and 5 of the eight-leg walk.
    const values = /<path class="edge-lit"[\s\S]*?values="([^"]+)"/.exec(svg)?.[1] ?? "";
    expect(values.split(";")).toEqual(["0", "1", "0", "1", "0", "1", "0", "0", "0"]);
  });

  it("leaves the default plate alone: the happy path rides no fail edge", () => {
    const svg = renderPlate(LOOP);
    expect(svg).not.toContain("edge-lit");
    expect(svg).not.toContain("data-lit");
    expect(svg).not.toContain(`@media (prefers-reduced-motion:reduce){.plate-svg .edge-lit`);
  });
});
