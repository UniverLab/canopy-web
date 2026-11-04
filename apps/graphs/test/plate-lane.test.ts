// SPDX-License-Identifier: Apache-2.0
/**
 * The canopy-builder plate's lanes: the reader must see the flow, and see
 * where failure goes without counting nine long lines that read as the main
 * path. These tests hold the drawing to the shape of the graph — handlers
 * below the flow in a band, one bus per class into each, one `✓ done` under
 * the flow's real end, and no edge crossing a node.
 */
import { describe, expect, it } from "vitest";
import builder from "./fixtures/graphs/canopy-builder/graph.json" with { type: "json" };
import qualityBubble from "./fixtures/graphs/quality-bubble/graph.json" with { type: "json" };
import { renderPlate } from "../../../packages/plate/render.js";
import type { GraphDocument } from "../../../packages/plate/document.js";

const DOC = builder as unknown as GraphDocument;

interface Box {
  name: string;
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  lane: string;
}

interface Path {
  cls: string;
  d: string;
  from: string;
  to: string;
  bus: string | null;
}

/** The drawn nodes: their centres, drawn half extents and lanes. */
function boxes(svg: string): Box[] {
  const pattern =
    /<g class="node shape-([a-z]+)" data-name="([^"]+)" data-cx="(-?[\d.]+)" data-cy="(-?[\d.]+)" data-w="(-?[\d.]+)" data-h="(-?[\d.]+)" data-rank="\d+" data-lane="(main|infra|handler)"[^>]*>/g;
  return [...svg.matchAll(pattern)].map((match) => {
    const rot = match[1] === "gate";
    const w = Number(match[5]);
    const h = Number(match[6]);
    return {
      name: match[2] ?? "",
      cx: Number(match[3]),
      cy: Number(match[4]),
      hw: (rot ? w * Math.SQRT2 : w) / 2,
      hh: (rot ? h * Math.SQRT2 : h) / 2,
      lane: match[7] ?? "main",
    };
  });
}

/** The drawn groups' outlines, as boxes. */
function groupBoxes(svg: string): Box[] {
  const pattern =
    /<g class="ensemble" data-name="([^"]+)"><rect class="group-box" x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)"/g;
  return [...svg.matchAll(pattern)].map((match) => {
    const w = Number(match[4]);
    const h = Number(match[5]);
    return {
      name: match[1] ?? "",
      cx: Number(match[2]) + w / 2,
      cy: Number(match[3]) + h / 2,
      hw: w / 2,
      hh: h / 2,
      lane: "main",
    };
  });
}

/** The drawn flow edges and buses, with their endpoints and data. */
function paths(svg: string): Path[] {
  const pattern =
    /<path class="edge ([a-z]+)( bus)?" d="([^"]*)"( marker-end="url\(#[a-z0-9-]+\)")? data-(?:bus="([^"]+)"|from="([^"]+)" data-to="([^"]+)")/g;
  return [...svg.matchAll(pattern)].map((match) => ({
    cls: match[1] ?? "",
    d: match[3] ?? "",
    from: match[6] ?? "",
    to: match[7] ?? match[5] ?? "",
    bus: match[5] ?? null,
  }));
}

/** The marks the grouped inputs carry: bolts and dashes, by source. */
function marks(svg: string): Array<{ cls: string; from: string }> {
  const all = [
    ...svg.matchAll(/<text class="mark mark-error"[^>]*data-mark="error" data-from="([^"]+)"/g),
  ].map((match) => ({ cls: "error", from: match[1] ?? "" }));
  for (const match of svg.matchAll(/<path class="mark mark-fail"[^>]*data-mark="fail" data-from="([^"]+)"/g)) {
    all.push({ cls: "fail", from: match[1] ?? "" });
  }
  return all;
}

/** The `✓ done` terminals, by the node they sit under. */
function dones(svg: string): string[] {
  return [...svg.matchAll(/<text class="done"[^>]*data-done="([^"]+)">✓ done<\/text>/g)].map(
    (match) => match[1] ?? "",
  );
}

/** Sample a path's points: every M/L/H/V endpoint and 24 points per Q corner. */
function samples(d: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let cursor: [number, number] = [0, 0];
  for (const part of d.matchAll(/([MLHVQ])([^MLHVQ]*)/g)) {
    const nums = (part[2] ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [];
    if (part[1] === "M" || part[1] === "L") {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cursor = [nums[i] ?? 0, nums[i + 1] ?? 0];
        points.push(cursor);
      }
    } else if (part[1] === "H") {
      for (const x of nums) {
        cursor = [x, cursor[1]];
        points.push(cursor);
      }
    } else if (part[1] === "V") {
      for (const y of nums) {
        cursor = [cursor[0], y];
        points.push(cursor);
      }
    } else if (part[1] === "Q") {
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

/** The last endpoint of a path. */
function endOf(d: string): [number, number] {
  const points = samples(d);
  return points[points.length - 1] ?? [Number.NaN, Number.NaN];
}

describe("canopy-builder", () => {
  const svg = renderPlate(DOC);
  const nodes = boxes(svg);
  const all = [...nodes, ...groupBoxes(svg)];
  const main = nodes.filter((node) => node.lane === "main");

  it("lays out only the failure terminals in the handler lane", () => {
    const handlers = nodes.filter((node) => node.lane === "handler");
    expect(handlers.map((node) => node.name)).toEqual(["Human verdict", "Resilience"]);
    const verdict = nodes.find((node) => node.name === "Human verdict") as Box;
    const resilience = nodes.find((node) => node.name === "Resilience") as Box;
    // The band below the flow: every handler at or right of Start, below
    // every main-lane node, and never left of the flow's left edge.
    const start = nodes.find((node) => node.name === "Start") as Box;
    const mainBottom = Math.max(...main.map((node) => node.cy));
    const flowLeft = Math.min(...main.map((node) => node.cx - node.hw));
    for (const node of handlers) {
      expect(node.cx, node.name).toBeGreaterThanOrEqual(start.cx);
      expect(node.cy, node.name).toBeGreaterThan(mainBottom);
      expect(node.cx - node.hw, node.name).toBeGreaterThanOrEqual(flowLeft);
    }
    // In unit order: Human verdict left of Resilience, sharing the band row.
    expect(verdict.cx).toBeLessThan(resilience.cx);
    expect(verdict.cy).toBe(resilience.cy);
    // No handler box intersects another node or group box.
    for (const handler of handlers) {
      for (const box of all) {
        if (box.name === handler.name) {
          continue;
        }
        const overlap =
          Math.abs(handler.cx - box.cx) < handler.hw + box.hw &&
          Math.abs(handler.cy - box.cy) < handler.hh + box.hh;
        expect(overlap, `${handler.name} vs ${box.name}`).toBe(false);
      }
    }
  });

  it("ends the flow with one done terminal under Relock repo", () => {
    expect(dones(svg)).toEqual(["Relock repo"]);
    const relock = nodes.find((node) => node.name === "Relock repo");
    expect(relock).toBeDefined();
    const done = /<text class="done" x="(-?[\d.]+)" y="(-?[\d.]+)"/.exec(svg);
    expect(Number(done?.[1])).toBe(relock?.cx);
    expect(Number(done?.[2])).toBeGreaterThan((relock?.cy ?? 0) + (relock?.hh ?? 0));
  });

  it("groups the errors into one bus per handler and class", () => {
    const buses = paths(svg).filter((path) => path.bus !== null);
    expect(buses.map((bus) => `${bus.bus}:${bus.cls}`).sort()).toEqual([
      "Human verdict:fail",
      "Resilience:error",
    ]);
    const into = buses.filter((bus) => bus.to === "Resilience");
    expect(into).toHaveLength(1);
    const resilience = nodes.find((node) => node.name === "Resilience");
    const [x, y] = endOf(into[0]?.d ?? "");
    expect(x).toBeCloseTo(resilience?.cx ?? 0, 1);
    expect(y).toBeCloseTo((resilience?.cy ?? 0) - (resilience?.hh ?? 0), 1);
  });

  it("marks every grouped source once per class, and draws no grouped edge", () => {
    const drawn = marks(svg);
    expect(drawn.filter((mark) => mark.cls === "error")).toHaveLength(8);
    expect(drawn.filter((mark) => mark.cls === "fail")).toHaveLength(6);
    expect(drawn.filter((mark) => mark.cls === "error").map((mark) => mark.from)).toEqual([
      "Lock repo",
      "Plan check",
      "Full gates",
      "Full gates after auditor",
      "Commit spec",
      "Unlock for documenter",
      "Check docs committed",
      "Relock repo",
    ]);
    const edges = paths(svg).filter((path) => path.bus === null);
    expect(edges.some((edge) => edge.cls === "error" && edge.to === "Resilience")).toBe(false);
    expect(edges.some((edge) => edge.cls === "fail" && edge.to === "Human verdict")).toBe(false);
  });

  it("keeps the fail edge from the Designer to Resilience, outside the flow", () => {
    const kept = paths(svg).find(
      (path) => path.bus === null && path.cls === "fail" && path.from === "Designer" && path.to === "Resilience",
    );
    expect(kept).toBeDefined();
    // The lane edge leaves the flow below the row into the band, never
    // across it.
    const points = samples(kept?.d ?? "");
    expect(Math.max(...points.map((point) => point[1]))).toBeGreaterThan(
      Math.max(...all.filter((box) => box.lane === "main").map((box) => box.cy + box.hh)),
    );
  });

  it("never crosses a drawn node or group", () => {
    const crossings: string[] = [];
    for (const edge of paths(svg)) {
      for (const [x, y] of samples(edge.d)) {
        for (const box of all) {
          if (box.name === edge.from || box.name === edge.to) {
            continue;
          }
          if (
            x > box.cx - box.hw + 0.01 &&
            x < box.cx + box.hw - 0.01 &&
            y > box.cy - box.hh + 0.01 &&
            y < box.cy + box.hh - 0.01
          ) {
            crossings.push(`${edge.cls} ${edge.from}→${edge.to} in ${box.name}`);
          }
        }
      }
    }
    expect([...new Set(crossings)]).toEqual([]);
  });

  it("paints errors in the attention amber, never currentColor", () => {
    expect(svg).toContain(".plate-svg .edge.error{stroke:var(--attention,#ffb454)");
    expect(svg).toContain(".plate-svg .mark-error{fill:var(--attention,#ffb454)");
    expect(svg).toContain(`data-bus="Resilience"`);
    expect(svg).not.toContain(".plate-svg .edge.error{stroke:currentColor");
  });
});

describe("no-handler plates", () => {
  it("keeps a handler-free svg byte-identical", async () => {
    // Re-pinned when the vertical layout went away and the marker ids lost
    // their orientation prefix, then again when the walk's unit twins joined
    // the catalogue plate.
    const svg = renderPlate(qualityBubble as unknown as GraphDocument);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(svg));
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("c954baa22c0d109fefd430e1d67ccccf54b30f1170437c88635db556e24a1130");
  });
});
