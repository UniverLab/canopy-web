// SPDX-License-Identifier: Apache-2.0
/**
 * The canopy-builder plate's orthogonal edges: every drawn edge is a
 * straight or right-angle line with rounded corners, no edge cuts through
 * a unit it does not touch, every channel above the flow carries exactly
 * one fail edge, and the token rides the drawn lines themselves.
 */
import { describe, expect, it } from "vitest";
import builder from "./fixtures/graphs/canopy-builder/graph.json" with { type: "json" };
import { parseDocument, type GraphDocument } from "../../../packages/plate/document.js";
import { layoutPlate } from "../../../packages/plate/layout.js";
import { nodeBox } from "../../../packages/plate/vocabulary.js";
import { generateWalk, plateWalk, walkUnits } from "../../../packages/plate/walk.js";

const DOC = builder as unknown as GraphDocument;

interface Box {
  name: string;
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

/** The drawn units' boxes: nodes by shape geometry, groups by outline. */
function boxesOf(layout: NonNullable<ReturnType<typeof layoutPlate>>): Box[] {
  const boxes: Box[] = layout.nodes.map((node) => {
    const { hw, hh } = nodeBox(node);
    return { name: node.name, cx: node.x, cy: node.y, hw, hh };
  });
  for (const group of layout.groups) {
    boxes.push({ name: group.name, cx: group.x, cy: group.y, hw: group.w / 2, hh: group.h / 2 });
  }
  return boxes;
}

/** A sampled point of a path, every M/L/H/V endpoint and 24 per Q corner. */
function samples(d: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let cursor: [number, number] = [0, 0];
  for (const part of d.matchAll(/([MLHVQ])([^MLHVQ]*)/g)) {
    const nums = (part[2] ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [];
    const cmd = part[1];
    if (cmd === "M" || cmd === "L") {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cursor = [nums[i] ?? 0, nums[i + 1] ?? 0];
        points.push(cursor);
      }
    } else if (cmd === "H") {
      for (const x of nums) {
        cursor = [x, cursor[1]];
        points.push(cursor);
      }
    } else if (cmd === "V") {
      for (const y of nums) {
        cursor = [cursor[0], y];
        points.push(cursor);
      }
    } else if (cmd === "Q") {
      for (let i = 0; i + 3 < nums.length; i += 4) {
        const [x0, y0] = cursor;
        const cx = nums[i] ?? 0;
        const cy = nums[i + 1] ?? 0;
        const x1 = nums[i + 2] ?? 0;
        const y1 = nums[i + 3] ?? 0;
        for (let step = 1; step <= 24; step += 1) {
          const t = step / 24;
          const u = 1 - t;
          points.push([
            u * u * x0 + 2 * u * t * cx + t * t * x1,
            u * u * y0 + 2 * u * t * cy + t * t * y1,
          ]);
        }
        cursor = [x1, y1];
      }
    }
  }
  return points;
}

/** The first and last endpoint of a path. */
function endsOf(d: string): { start: [number, number]; end: [number, number] } {
  const points = samples(d);
  return {
    start: points[0] ?? [Number.NaN, Number.NaN],
    end: points[points.length - 1] ?? [Number.NaN, Number.NaN],
  };
}

/** The smallest y a path reaches. */
function minYOf(d: string): number {
  return Math.min(...samples(d).map((point) => point[1]));
}

/** The largest y a path reaches. */
function maxYOf(d: string): number {
  return Math.max(...samples(d).map((point) => point[1]));
}

/** Whether a point sits strictly inside a box, a hair inside the border. */
function inside(box: Box, x: number, y: number): boolean {
  return (
    x > box.cx - box.hw + 0.01 &&
    x < box.cx + box.hw - 0.01 &&
    y > box.cy - box.hh + 0.01 &&
    y < box.cy + box.hh - 0.01
  );
}

/** The top of the main flow: the highest main-lane unit top. */
function mainTopOf(layout: NonNullable<ReturnType<typeof layoutPlate>>): number {
  const tops = [
    ...layout.nodes
      .filter((node) => node.lane === "main")
      .map((node) => node.y - nodeBox(node).hh),
    ...layout.groups.map((group) => group.y - group.h / 2),
  ];
  return Math.min(...tops);
}

describe("orthogonal edges", () => {
  const layout = layoutPlate(DOC, () => 0);
  expect(layout).not.toBeNull();
  if (layout === null) {
    throw new Error("the fixture must lay out");
  }
  const boxes = boxesOf(layout);
  const byName = new Map(boxes.map((box) => [box.name, box]));

  it("draws every edge and the walk with only M, L, H, V and Q commands", () => {
    const paths = [...layout.edges.map((edge) => edge.d)];
    if (layout.walk !== null) {
      paths.push(layout.walk);
    }
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) {
      const letters = d.match(/[A-Za-z]/g) ?? [];
      expect(letters.length).toBeGreaterThan(0);
      for (const letter of letters) {
        expect("MLHVQ", `${d}: command ${letter}`).toContain(letter);
      }
    }
  });

  it("keeps every straight segment axis-aligned", () => {
    for (const edge of layout.edges) {
      let cursor: [number, number] | null = null;
      for (const part of edge.d.matchAll(/([MLHVQ])([^MLHVQ]*)/g)) {
        const nums = (part[2] ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [];
        const cmd = part[1];
        if (cmd === "M") {
          cursor = [nums[0] ?? 0, nums[1] ?? 0];
        } else if (cmd === "L") {
          for (let i = 0; i + 1 < nums.length; i += 2) {
            const next: [number, number] = [nums[i] ?? 0, nums[i + 1] ?? 0];
            expect(
              next[0] === cursor?.[0] || next[1] === cursor?.[1],
              `${edge.from}→${edge.to}: L to ${next} from ${cursor}`,
            ).toBe(true);
            cursor = next;
          }
        } else if (cmd === "H") {
          for (const x of nums) {
            cursor = [x, cursor?.[1] ?? 0];
          }
        } else if (cmd === "V") {
          for (const y of nums) {
            cursor = [cursor?.[0] ?? 0, y];
          }
        } else if (cmd === "Q") {
          cursor = [nums[nums.length - 2] ?? 0, nums[nums.length - 1] ?? 0];
        }
      }
    }
  });

  it("never crosses a group or node box other than its own two ends", () => {
    const crossings: string[] = [];
    for (const edge of layout.edges) {
      for (const [x, y] of samples(edge.d)) {
        for (const box of boxes) {
          if (box.name === edge.from || box.name === edge.to) {
            continue;
          }
          if (inside(box, x, y)) {
            crossings.push(`${edge.cls} ${edge.from}→${edge.to} in ${box.name}`);
          }
        }
      }
    }
    expect([...new Set(crossings)]).toEqual([]);
  });

  it("rides every fail channel above the flow exactly once", () => {
    const mainTop = mainTopOf(layout);
    const mainBottom = Math.max(
      ...layout.nodes
        .filter((node) => node.lane === "main")
        .map((node) => node.y + node.h / 2),
      ...layout.groups.map((group) => group.y + group.h / 2),
    );
    const fails = layout.edges.filter((edge) => edge.cls === "fail");
    expect(fails.length).toBeGreaterThan(0);
    // Every fail edge leaves the flow band: a main-to-main fail tops out
    // through its channel above the flow, while a fail into the handler
    // band (here Designer→Resilience) dips below it. One that drew
    // in-flow would sit entirely inside the band and fail here.
    for (const edge of fails) {
      const leaves =
        minYOf(edge.d) < mainTop || maxYOf(edge.d) > mainBottom;
      expect(leaves, `${edge.from}→${edge.to}: fail edge leaves the flow`).toBe(true);
    }
    const channels = fails
      .map((edge) => minYOf(edge.d))
      .filter((top) => top < mainTop);
    expect(channels.length).toBeGreaterThan(0);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("starts and ends every seeded walk step on its drawn edge's endpoints", () => {
    const parsed = parseDocument(DOC);
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      return;
    }
    const drawn = new Set([...layout.nodes.map((node) => node.name), ...layout.groups.map((group) => group.name)]);
    const steps = generateWalk(parsed, "Start", drawn, () => 0);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.some((step) => step.fail)).toBe(true);
    expect(layout.walk).not.toBeNull();
    const edgeD = new Map(
      layout.edges.map((edge) => [`${edge.cls}:${edge.from}→${edge.to}`, edge.d] as const),
    );
    const walkPoints = samples(layout.walk ?? "");
    const near = (point: [number, number]): boolean =>
      walkPoints.some(
        (sample) => Math.abs(sample[0] - point[0]) < 1e-6 && Math.abs(sample[1] - point[1]) < 1e-6,
      );
    for (const step of steps) {
      const d = edgeD.get(`${step.fail ? "fail" : "pass"}:${step.from}→${step.to}`);
      if (d === undefined) {
        const centre = byName.get(step.to);
        expect(centre, `${step.from}→${step.to}: no drawn unit`).toBeDefined();
        if (centre !== undefined) {
          expect(near([centre.cx, centre.cy]), `${step.from}→${step.to}: walk reaches ${step.to}`).toBe(true);
        }
        continue;
      }
      const { start, end } = endsOf(d);
      expect(near(start), `${step.from}→${step.to}: walk starts on the edge`).toBe(true);
      expect(near(end), `${step.from}→${step.to}: walk ends on the edge`).toBe(true);
    }
    expect(walkUnits(parsed).has("Start")).toBe(true);
  });

  it("joins consecutive walk legs straight through the unit between them", () => {
    const centres = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 26, y: 0 }],
      ["c", { x: 52, y: 0 }],
    ]);
    const legs = new Map([
      ["a→b", "M3 0 L23 0"],
      ["b→c", "M29 0 L49 0"],
    ]);
    const walked = plateWalk(
      [
        { from: "a", to: "b", fail: false },
        { from: "b", to: "c", fail: false },
      ],
      centres,
      (step) => legs.get(`${step.from}→${step.to}`) ?? null,
    );
    // The first leg rides its edge whole; the second joins with a straight L
    // from the first edge's start through the middle unit, then its own edge.
    expect(walked.walk).toBe("M3 0 L23 0L29 0 L49 0");
    expect(walked.seconds).toBe(1.8);
    expect(walked.fails).toEqual([]);
  });

  it("walks a step with no placed edge straight to the unit's centre", () => {
    const centres = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 26, y: 0 }],
    ]);
    const walked = plateWalk([{ from: "a", to: "b", fail: false }], centres, () => null);
    expect(walked.walk).toBe("M0 0L26 0");
    expect(walked.seconds).toBe(0.9);
  });
});
