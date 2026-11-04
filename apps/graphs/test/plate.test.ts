// SPDX-License-Identifier: Apache-2.0
/**
 * The Canopy plates: one snapshot per official example graph plus the
 * polish-shaped fixture, the structural invariants behind every snapshot
 * (no overlapping shapes, every edge endpoint drawn, fail routes dashed
 * red, the infra node in the lower lane), the node plate, and the
 * sixty-node render budget.
 */
import { describe, expect, it } from "vitest";
import helloGraph from "./fixtures/graphs/hello-graph/graph.json" with { type: "json" };
import qualityBubble from "./fixtures/graphs/quality-bubble/graph.json" with { type: "json" };
import singleCommitter from "./fixtures/graphs/single-committer/graph.json" with { type: "json" };
import specLoop from "./fixtures/graphs/spec-loop/graph.json" with { type: "json" };
import canopyBuilder from "./fixtures/graphs/canopy-builder/graph.json" with { type: "json" };
import adversarialDeveloper from "./fixtures/graphs/adversarial-developer/graph.json" with { type: "json" };
import reviewPanel from "./fixtures/patterns/review-panel.figure.json" with { type: "json" };
import resilientMembers from "./fixtures/patterns/resilient-members.figure.json" with { type: "json" };
import {
  structureOf,
  type GraphDocument,
  type NodeDocument,
} from "../../../packages/plate/document.js";
import { renderNodePlate, renderPlate } from "../../../packages/plate/render.js";
import { layoutPlate } from "../../../packages/plate/layout.js";
import { nodeBox } from "../../../packages/plate/vocabulary.js";
import { mulberry32 } from "../../../packages/plate/walk.js";
import { BUNDLED_PATTERNS } from "../src/patterns-data.generated.js";
import { ROUND_ROBIN_GRAPH, TUI_POLISH_GRAPH, sixtyNodeGraph } from "./plate-fixture.js";

const GRAPHS: Array<[string, GraphDocument]> = [
  ["hello-graph", helloGraph as unknown as GraphDocument],
  ["quality-bubble", qualityBubble as unknown as GraphDocument],
  ["single-committer", singleCommitter as unknown as GraphDocument],
  ["spec-loop", specLoop as unknown as GraphDocument],
  ["canopy-tui-polish", TUI_POLISH_GRAPH],
  ["review-panel", reviewPanel as unknown as GraphDocument],
  ["resilient-members", resilientMembers as unknown as GraphDocument],
];

interface Box {
  name: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  lane: string;
}

interface Edge {
  cls: string;
  from: string;
  to: string;
}

/** The drawn node shapes: centres, sizes and lanes from their data attributes. */
function nodeBoxes(svg: string): Box[] {
  const boxes: Box[] = [];
  const pattern =
    /<g class="node shape-[a-z]+" data-name="([^"]+)" data-cx="(-?[\d.]+)" data-cy="(-?[\d.]+)" data-w="(-?[\d.]+)" data-h="(-?[\d.]+)" data-rank="\d+" data-lane="(main|infra|handler)"[^>]*>/g;
  for (const match of svg.matchAll(pattern)) {
    boxes.push({
      name: match[1] ?? "",
      cx: Number(match[2]),
      cy: Number(match[3]),
      w: Number(match[4]),
      h: Number(match[5]),
      lane: match[6] ?? "main",
    });
  }
  return boxes;
}

/** The drawn edges: classes and endpoints from their data attributes. */
function drawnEdges(svg: string): Edge[] {
  const edges: Edge[] = [];
  const pattern =
    /<path class="edge ([a-z]+)" d="[^"]*"( marker-end="url\(#[a-z0-9-]+\)")? data-from="([^"]+)" data-to="([^"]+)"\/>/g;
  for (const match of svg.matchAll(pattern)) {
    edges.push({ cls: match[1] ?? "", from: match[3] ?? "", to: match[4] ?? "" });
  }
  return edges;
}

interface DrawnPath {
  cls: string;
  d: string;
  marker: string | null;
  to: string;
}

/** The drawn edge paths with their marker-end and data, for arrowhead checks. */
function drawnPaths(svg: string): DrawnPath[] {
  const paths: DrawnPath[] = [];
  const pattern =
    /<path class="edge ([a-z]+)" d="([^"]*)"( marker-end="url\(#([a-z0-9-]+)\)")? data-from="[^"]+" data-to="([^"]+)"\/>/g;
  for (const match of svg.matchAll(pattern)) {
    paths.push({ cls: match[1] ?? "", d: match[2] ?? "", marker: match[4] ?? null, to: match[5] ?? "" });
  }
  return paths;
}

/** The drawn ensemble boxes: name and outline rect. */
function groupBoxes(svg: string): Box[] {
  const boxes: Box[] = [];
  const pattern =
    /<g class="ensemble" data-name="([^"]+)"><rect class="group-box" x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)"[^>]*>/g;
  for (const match of svg.matchAll(pattern)) {
    const x = Number(match[2]);
    const y = Number(match[3]);
    const w = Number(match[4]);
    const h = Number(match[5]);
    boxes.push({ name: match[1] ?? "", cx: x + w / 2, cy: y + h / 2, w, h, lane: "main" });
  }
  return boxes;
}

/** The last endpoint of a cubic path string. */
function pathEnd(d: string): [number, number] {
  const nums = (d.match(/-?[\d.]+/g) ?? []).map(Number);
  return [nums[nums.length - 2] ?? Number.NaN, nums[nums.length - 1] ?? Number.NaN];
}

/**
 * Whether a point sits inside a box. The box shrinks by a hair so a tip
 * exactly on the border (a group endpoint, already exact) counts as out,
 * while a tip at the centre — the bug this guards — still counts as in.
 */
function inside(box: Box, x: number, y: number): boolean {
  const w = box.w / 2 - 0.05;
  const h = box.h / 2 - 0.05;
  return x >= box.cx - w && x <= box.cx + w && y >= box.cy - h && y <= box.cy + h;
}

/** The drawn ensemble names. */
function drawnGroups(svg: string): string[] {
  return [...svg.matchAll(/<g class="ensemble" data-name="([^"]+)">/g)].map((match) => match[1] ?? "");
}

/** The member-chip centres inside the group outlines. */
function memberCentres(svg: string): number[] {
  return [...svg.matchAll(/<g class="member" data-name="[^"]+" data-i="\d+" data-cx="(-?[\d.]+)" data-cy="(-?[\d.]+)"[^>]*>/g)]
    .map((match) => Number(match[2]));
}

function overlaps(a: Box, b: Box): boolean {
  return Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2;
}

describe("plate snapshots", () => {
  for (const [name, document] of GRAPHS) {
    it(`draws ${name} as a plate`, () => {
      expect(renderPlate(document)).toMatchSnapshot();
    });
  }
});

describe("plate invariants", () => {
  for (const [name, document] of GRAPHS) {
    const svg = renderPlate(document);
    it(`${name}: no two node shapes overlap`, () => {
      const boxes = nodeBoxes(svg);
      expect(boxes.length).toBeGreaterThan(0);
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          expect(overlaps(boxes[a] as Box, boxes[b] as Box), `${(boxes[a] as Box).name} vs ${(boxes[b] as Box).name}`).toBe(false);
        }
      }
    });

    it(`${name}: every edge endpoint is a drawn node`, () => {
      const drawn = new Set([...nodeBoxes(svg).map((box) => box.name), ...drawnGroups(svg)]);
      const edges = drawnEdges(svg);
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(drawn.has(edge.from), `from ${edge.from}`).toBe(true);
        expect(drawn.has(edge.to), `to ${edge.to}`).toBe(true);
      }
    });

    it(`${name}: fail routes carry the fail class, and only they do`, () => {
      const routes = structureOf(document)?.routes ?? [];
      const failRoutes = new Set(
        routes.filter((route) => route.via === "fail").map((route) => `${route.from}→${route.to}`),
      );
      expect(failRoutes.size).toBeGreaterThan(0);
      const rendered = new Map<string, string[]>();
      for (const edge of drawnEdges(svg)) {
        if (edge.cls === "order") {
          continue;
        }
        const key = `${edge.from}→${edge.to}`;
        rendered.set(key, [...(rendered.get(key) ?? []), edge.cls]);
      }
      for (const key of failRoutes) {
        expect(rendered.get(key), key).toContain("fail");
      }
      for (const [key, classes] of rendered) {
        expect(classes.includes("fail") ? failRoutes.has(key) : true, key).toBe(true);
      }
    });

    it(`${name}: the svg is labelled`, () => {
      expect(svg).toContain(`<svg class="plate-svg plate-h" viewBox="0 0 `);
      expect(svg).toContain(`role="img"`);
      expect(svg).toContain(`<title>${name}</title>`);
      expect(svg).toMatch(/<desc>Nodes in order: [^<]+<\/desc>/);
    });
  }

  it("hello-graph: the error destination leaves the flow for the band below", () => {
    const svg = renderPlate(helloGraph as unknown as GraphDocument);
    const boxes = nodeBoxes(svg);
    // `tests` is the infra node and an error destination: the band wins, and
    // no unit keeps the lower row.
    expect(boxes.filter((box) => box.lane === "handler").map((box) => box.name)).toEqual(["tests"]);
    expect(boxes.some((box) => box.lane === "infra")).toBe(false);
    const mainBottom = Math.max(
      ...boxes.filter((box) => box.lane === "main").map((box) => box.cy),
    );
    const tests = boxes.find((box) => box.name === "tests") as Box;
    expect(tests.cy).toBeGreaterThan(mainBottom);
  });

  it("an infra node the flow still passes draws in the lower lane", () => {
    const document: GraphDocument = {
      name: "infra-lane",
      nodes: [
        { name: "start", kind: "check", position: 1, config: {} },
        { name: "work", kind: "agent", position: 2, config: {} },
        { name: "monitor", kind: "agent", position: 3, config: {} },
      ],
      edges: [
        { from_node: "start", to_node: "work", condition: "pass" },
        { from_node: "work", to_node: "monitor", condition: "always" },
      ],
      infra_node: "monitor",
    };
    const svg = renderPlate(document);
    const boxes = nodeBoxes(svg);
    expect(boxes.filter((box) => box.lane === "infra").map((box) => box.name)).toEqual(["monitor"]);
    const mainBottom = Math.max(
      ...boxes.filter((box) => box.lane === "main").map((box) => box.cy),
      ...memberCentres(svg),
    );
    const monitor = boxes.find((box) => box.name === "monitor") as Box;
    expect(monitor.cy).toBeGreaterThan(mainBottom);
  });

  it("draws the handler band between the main flow and the infra lane", () => {
    const document: GraphDocument = {
      name: "band-infra",
      nodes: [
        { name: "start", kind: "check", position: 1, config: {} },
        { name: "work", kind: "agent", position: 2, config: {} },
        { name: "retry", kind: "agent", position: 3, config: {} },
        { name: "monitor", kind: "agent", position: 4, config: {} },
      ],
      edges: [
        { from_node: "start", to_node: "work", condition: "pass" },
        { from_node: "work", to_node: "retry", condition: "fail" },
        { from_node: "work", to_node: "monitor", condition: "always" },
      ],
      infra_node: "monitor",
    };
    const svg = renderPlate(document);
    const boxes = nodeBoxes(svg);
    expect(boxes.filter((box) => box.lane === "handler").map((box) => box.name)).toEqual(["retry"]);
    expect(boxes.filter((box) => box.lane === "infra").map((box) => box.name)).toEqual(["monitor"]);
    const mainBottom = Math.max(
      ...boxes.filter((box) => box.lane === "main").map((box) => box.cy),
    );
    const retry = boxes.find((box) => box.name === "retry") as Box;
    const monitor = boxes.find((box) => box.name === "monitor") as Box;
    expect(retry.cy).toBeGreaterThan(mainBottom);
    expect(monitor.cy).toBeGreaterThan(retry.cy + retry.h / 2);
  });

  it("canopy-tui-polish: resilience leaves the flow, Commit is filled", () => {
    const svg = renderPlate(TUI_POLISH_GRAPH);
    const boxes = nodeBoxes(svg);
    expect(boxes.filter((box) => box.lane === "handler").map((box) => box.name)).toEqual([
      "resilience",
    ]);
    const mainBottom = Math.max(
      ...boxes.filter((box) => box.lane === "main").map((box) => box.cy),
    );
    const resilience = boxes.find((box) => box.name === "resilience") as Box;
    expect(resilience.cy).toBeGreaterThan(mainBottom);
    expect(svg).toContain(`<g class="node shape-commit" data-name="Commit"`);
    expect(svg).toContain("PARALLEL · 2/3");
    expect(svg).toContain("CASCADE · 2");
    expect(svg).toContain(`<g class="member" data-name="proposers" data-i="1"`);
    expect(svg).toContain(`<g class="member" data-name="proposers" data-i="3"`);
  });

  it("hello-graph: the escalate route reads as pass, the error as a mark and a bus", () => {
    const svg = renderPlate(helloGraph as unknown as GraphDocument);
    const edges = drawnEdges(svg);
    const escalate = edges.find((edge) => edge.from === "triage" && edge.to === "implementer");
    expect(escalate?.cls).toBe("pass");
    // implementer → tests is an error into the error destination: grouped as
    // one short mark and one amber bus, never a drawn edge across the plate.
    expect(edges.some((edge) => edge.cls === "error" && edge.to === "tests")).toBe(false);
    expect(svg).toContain(`<text class="mark mark-error"`);
    expect(svg).toContain(`data-from="implementer">⚡</text>`);
    expect(svg).toContain(`<path class="edge error bus"`);
    expect(svg).toContain(`data-bus="tests"`);
  });

  it("single-committer: the entry check is a chip, the router-less gate a diamond", () => {
    const svg = renderPlate(singleCommitter as unknown as GraphDocument);
    expect(svg).toContain(`<g class="node shape-chip" data-name="start-check"`);
    expect(svg).toContain(`<g class="node shape-agent" data-name="committer"`);
    expect(svg).toContain("PARALLEL · 2/2");
  });

  it("paints the error arrowhead amber over the flow's teal", () => {
    const svg = renderPlate(TUI_POLISH_GRAPH);
    expect(svg).toContain(
      `.plate-svg #plate-arrow-error path{fill:var(--attention,#ffb454);fill-opacity:.7}`,
    );
    expect(svg).not.toContain(`#plate-arrow-error path{fill:#e8f6f1`);
  });

  it("draws a round-robin group's third subtitle shape", () => {
    const svg = renderPlate(ROUND_ROBIN_GRAPH);
    expect(svg).toContain("ROUND ROBIN · 2 members");
    expect(svg).toMatchSnapshot();
  });

  it("the token walks the main pass chain and rests under reduced motion", () => {
    const svg = renderPlate(specLoop as unknown as GraphDocument);
    expect(svg).toContain(`<circle class="token"`);
    expect(svg).toContain(`<animateMotion dur="`);
    expect(svg).toContain(`repeatCount="indefinite"`);
    expect(svg).toContain(`@media (prefers-reduced-motion:reduce){.plate-svg .token{display:none}}`);
  });

  it("draws nothing readable from an unreadable document", () => {
    expect(renderPlate("nope" as unknown as GraphDocument)).toBe("");
    expect(renderPlate({} as unknown as GraphDocument)).toBe("");
    expect(renderPlate({ nodes: [], edges: [] } as unknown as GraphDocument)).toBe("");
  });
});

describe("the node plate", () => {
  it("draws one agent node with its label below", () => {
    const svg = renderNodePlate({
      name: "hello-node",
      kind: "agent",
      config: { prompt_template: "Draft a plan." },
    });
    expect(svg).toContain(`<title>hello-node</title>`);
    expect(svg).toContain(`<g class="node shape-agent" data-name="hello-node"`);
    expect(svg).toContain(`>hello-node</text>`);
    expect(nodeBoxes(svg)).toHaveLength(1);
    expect(svg).toMatchSnapshot();
  });

  it("draws an ensemble node as a group of numbered member chips", () => {
    const ensemble: NodeDocument = {
      name: "ensemble-proposers",
      kind: "ensemble",
      config: { members: [{}, {}, {}] },
    };
    const svg = renderNodePlate(ensemble);
    expect(drawnGroups(svg)).toEqual(["ensemble-proposers"]);
    expect(nodeBoxes(svg)).toHaveLength(0);
    expect(svg).toContain(`data-i="1"`);
    expect(svg).toContain(`data-i="3"`);
    expect(svg).toContain("PARALLEL · 3/3");
    expect(svg).toMatchSnapshot();
  });

  it("draws a check with commit rights filled", () => {
    const svg = renderNodePlate({
      name: "commit-check",
      kind: "check",
      config: { command: "test HEAD", commit_rights: true },
    });
    expect(svg).toContain(`<g class="node shape-commit" data-name="commit-check"`);
  });
});

describe("the render budget", () => {
  it("renders a sixty-node graph in under fifty milliseconds", () => {
    const document = sixtyNodeGraph();
    const start = performance.now();
    const svg = renderPlate(document);
    const elapsed = performance.now() - start;
    expect(svg.length).toBeGreaterThan(0);
    expect(nodeBoxes(svg)).toHaveLength(60);
    expect(elapsed).toBeLessThan(50);
  });
});

describe("plate centring", () => {
  it("centres a single node in its viewBox", () => {
    const svg = renderNodePlate({ name: "solo", kind: "agent", config: {} });
    const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    expect(viewBox).not.toBeNull();
    const boxes = nodeBoxes(svg);
    expect(boxes).toHaveLength(1);
    // Symmetric padding on a symmetric drawing: the node sits at the centre.
    expect(boxes[0]?.cx).toBe(Number(viewBox?.[1]) / 2);
  });

  it("centres a single rank horizontally", () => {
    const document: GraphDocument = {
      name: "rank",
      nodes: [
        { name: "aaa", kind: "agent", position: 1, config: {} },
        { name: "bbb", kind: "agent", position: 2, config: {} },
        { name: "ccc", kind: "agent", position: 3, config: {} },
      ],
      edges: [],
    };
    const layout = layoutPlate(document);
    expect(layout).not.toBeNull();
    for (const node of layout?.nodes ?? []) {
      expect(node.x).toBe((layout?.width ?? 0) / 2);
    }
  });
});

describe("plate rank geometry", () => {
  it("canopy-builder: no two groups overlap, and no group overlaps a main node", () => {
    const svg = renderPlate(canopyBuilder as unknown as GraphDocument);
    const mains = nodeBoxes(svg).filter((box) => box.lane === "main");
    const ensembles = groupBoxes(svg);
    expect(ensembles.length).toBeGreaterThan(1);
    for (let a = 0; a < ensembles.length; a += 1) {
      for (let b = a + 1; b < ensembles.length; b += 1) {
        expect(
          overlaps(ensembles[a] as Box, ensembles[b] as Box),
          `${ensembles[a]?.name} vs ${ensembles[b]?.name}`,
        ).toBe(false);
      }
      for (const node of mains) {
        expect(overlaps(ensembles[a] as Box, node), `${ensembles[a]?.name} vs ${node.name}`).toBe(
          false,
        );
      }
    }
  });

  it("canopy-builder: every single-unit rank sits on the flow axis", () => {
    const layout = layoutPlate(canopyBuilder as unknown as GraphDocument);
    expect(layout).not.toBeNull();
    const byRank = new Map<number, number[]>();
    for (const node of layout?.nodes ?? []) {
      if (node.lane !== "main") {
        continue;
      }
      byRank.set(node.rank, [...(byRank.get(node.rank) ?? []), node.y]);
    }
    for (const group of layout?.groups ?? []) {
      byRank.set(group.rank, [...(byRank.get(group.rank) ?? []), group.y]);
    }
    const singles = [...byRank.values()]
      .filter((ys) => ys.length === 1)
      .map((ys) => ys[0] ?? 0);
    expect(singles.length).toBeGreaterThan(1);
    for (const y of singles) {
      expect(y).toBe(singles[0]);
    }
  });

  it("a node-only plate keeps the 26-unit rank step", () => {
    const document = {
      name: "node-chain",
      nodes: [
        { name: "a", kind: "agent", position: 1, config: {} },
        { name: "b", kind: "agent", position: 2, config: {} },
        { name: "c", kind: "agent", position: 3, config: {} },
      ],
      edges: [
        { from_node: "a", to_node: "b", condition: "pass" },
        { from_node: "b", to_node: "c", condition: "pass" },
      ],
    } as unknown as GraphDocument;
    const layout = layoutPlate(document);
    expect(layout).not.toBeNull();
    const xs = (layout?.nodes ?? []).sort((a, b) => a.rank - b.rank).map((node) => node.x);
    expect(xs).toHaveLength(3);
    expect((xs[1] ?? 0) - (xs[0] ?? 0)).toBe(26);
    expect((xs[2] ?? 0) - (xs[1] ?? 0)).toBe(26);
  });
});

/**
 * The extent a drawn path actually reaches: its absolute M, L, H and V
 * points, and each Q by its control and end — the quadratic stays inside
 * its control hull, so the hull bounds the curve.
 */
function pathExtent(d: string): { minX: number; maxX: number; minY: number; maxY: number } {
  const extent = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const take = (x0: number, x1: number, y0: number, y1: number): void => {
    extent.minX = Math.min(extent.minX, x0);
    extent.maxX = Math.max(extent.maxX, x1);
    extent.minY = Math.min(extent.minY, y0);
    extent.maxY = Math.max(extent.maxY, y1);
  };
  let pen = { x: 0, y: 0 };
  for (const match of d.matchAll(/([MLHVQ])([^MLHVQ]*)/g)) {
    const values = (match[2] ?? "").trim().split(/[\s,]+/).filter((v) => v !== "").map(Number);
    if (match[1] === "Q") {
      for (let i = 0; i + 3 < values.length; i += 4) {
        const cx = values[i] ?? 0;
        const cy = values[i + 1] ?? 0;
        const x = values[i + 2] ?? 0;
        const y = values[i + 3] ?? 0;
        take(Math.min(pen.x, cx, x), Math.max(pen.x, cx, x), Math.min(pen.y, cy, y), Math.max(pen.y, cy, y));
        pen = { x, y };
      }
    } else if (match[1] === "H") {
      for (const x of values) {
        pen = { x, y: pen.y };
        take(pen.x, pen.x, pen.y, pen.y);
      }
    } else if (match[1] === "V") {
      for (const y of values) {
        pen = { x: pen.x, y };
        take(pen.x, pen.x, pen.y, pen.y);
      }
    } else {
      for (let i = 0; i + 1 < values.length; i += 2) {
        pen = { x: values[i] ?? 0, y: values[i + 1] ?? 0 };
        take(pen.x, pen.x, pen.y, pen.y);
      }
    }
  }
  return extent;
}

describe("plate bounds", () => {
  const documents: Array<[string, GraphDocument]> = [
    ...GRAPHS,
    ["canopy-builder", canopyBuilder as unknown as GraphDocument],
    ["adversarial-developer", adversarialDeveloper as unknown as GraphDocument],
    ["round-robin", ROUND_ROBIN_GRAPH],
    ...BUNDLED_PATTERNS.map((pattern): [string, GraphDocument] => [
      `pattern ${pattern.slug}`,
      JSON.parse(pattern.figure) as GraphDocument,
    ]),
  ];

  it("keeps every edge and the walk inside the viewBox, channels included", () => {
    for (const [name, document] of documents) {
      const layout = layoutPlate(document, mulberry32(7));
      expect(layout, name).not.toBeNull();
      if (layout === null) {
        continue;
      }
      const paths = [
        ...layout.edges.map((edge) => [`${edge.from}→${edge.to}`, edge.d] as const),
        ...(layout.walk === null ? [] : [["walk", layout.walk] as const]),
      ];
      for (const [label, d] of paths) {
        const reach = pathExtent(d);
        const where = `${name} ${label}: ${d}`;
        expect(reach.minX, where).toBeGreaterThanOrEqual(0);
        expect(reach.minY, where).toBeGreaterThanOrEqual(0);
        expect(reach.maxX, where).toBeLessThanOrEqual(layout.width);
        expect(reach.maxY, where).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  it("canopy-builder: the highest fail channel tops out one padding below the viewBox top", () => {
    const layout = layoutPlate(canopyBuilder);
    const top = Math.min(
      ...(layout?.edges ?? []).filter((edge) => edge.cls === "fail").map((edge) => pathExtent(edge.d).minY),
    );
    expect(top).toBeCloseTo(10, 0);
  });
});

describe("harness colours", () => {
  it("paints a known harness stem and labels it", () => {
    const svg = renderNodePlate({ name: "impl", kind: "agent", config: { platform: "claude" } });
    expect(svg).toContain(`style="--nc:#d97757"`);
    expect(svg).toContain(`>claude</text>`);
    const model = renderNodePlate({ name: "impl", kind: "agent", config: { model: "deepseek-chat" } });
    expect(model).toContain(`style="--nc:#4d6bfe"`);
    expect(model).toContain(`>deepseek</text>`);
  });

  it("falls back to the Canopy teal with no label for an unknown harness", () => {
    const svg = renderNodePlate({ name: "impl", kind: "agent", config: { platform: "mystery" } });
    expect(svg).not.toContain("--nc:");
    expect(svg).not.toContain(`class="harness"`);
    expect(svg).toContain(`var(--nc, var(--canopy, #00a9a0))`);
  });

  it("paints ensemble members by their platform", () => {
    const svg = renderPlate(TUI_POLISH_GRAPH);
    expect(svg).toContain(`style="--nc:#57c7c3"`);
    expect(svg).toContain(`>codex</text>`);
  });

  it("fills nothing white", () => {
    for (const [name, document] of GRAPHS) {
      const svg = renderPlate(document);
      expect(svg, name).not.toContain("#fff");
      expect(svg, name).not.toContain("#FFF");
      expect(svg, name).not.toContain("var(--bg");
      expect(svg, name).not.toContain('fill="#fff"');
    }
  });
});

describe("fallback colours", () => {
  it("gives every look-kit token in the svg style its Canopy fallback", () => {
    for (const [name, document] of GRAPHS) {
      const svg = renderPlate(document);
      const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? "";
      expect(style.length, name).toBeGreaterThan(0);
      expect(style, `${name} --canopy`).not.toMatch(/var\(--canopy(?!,)/);
      expect(style, `${name} --ink-dim`).not.toMatch(/var\(--ink-dim(?!,)/);
      expect(style, `${name} --font-mono`).not.toMatch(/var\(--font-mono(?!,)/);
      expect(style, `${name} --attention`).not.toMatch(/var\(--attention(?!,)/);
    }
  });

  it("fills and strokes harness-free agents and members teal without the look kit", () => {
    const svg = renderNodePlate({ name: "impl", kind: "agent", config: {} });
    const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? "";
    expect(style).toContain(".plate-svg .node .shape{fill:color-mix(in srgb, var(--nc, var(--canopy, #00a9a0)) 22%, #04110f)");
    expect(style).toContain(".plate-svg .member-shape{fill:color-mix(in srgb, var(--nc, var(--canopy, #00a9a0)) 22%, #04110f)");
    expect(style).toContain(".plate-svg .shape-commit .shape{fill:color-mix(in srgb, var(--canopy, #00a9a0) 35%, #04110f)");
  });
});

describe("plate arrowheads", () => {
  const MARKER_SUFFIX: Record<string, string | null> = {
    pass: "arrow",
    fail: "arrow-fail",
    error: "arrow-error",
    order: null,
  };
  /** The marker id a class ends in under a plate's own id prefix. */
  const markerOf = (prefix: string, cls: string): string | null => {
    const suffix = MARKER_SUFFIX[cls];
    return suffix === null ? null : `${prefix}-${suffix}`;
  };
  for (const [name, document] of GRAPHS) {
    const svg = renderPlate(document);
    it(`${name}: every flow edge carries its class marker, order edges none`, () => {
      expect(svg).toContain(`<marker id="plate-arrow"`);
      expect(svg).toContain(`<marker id="plate-arrow-fail"`);
      expect(svg).toContain(`<marker id="plate-arrow-error"`);
      const paths = drawnPaths(svg);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path.marker, `${path.cls} marker`).toBe(markerOf("plate", path.cls));
      }
    });

    it(`${name}: arrow tips land outside the target shape`, () => {
      const boxes = new Map(
        [...nodeBoxes(svg), ...groupBoxes(svg)].map((box) => [box.name, box] as const),
      );
      for (const path of drawnPaths(svg)) {
        if (path.cls === "order") {
          continue;
        }
        const box = boxes.get(path.to);
        expect(box, `target box ${path.to}`).toBeDefined();
        if (box === undefined) {
          continue;
        }
        const [x, y] = pathEnd(path.d);
        expect(inside(box, x, y), `${path.to} tip at ${x},${y}`).toBe(false);
      }
    });
  }
});

describe("marker scoping", () => {
  const ids = (svg: string): string[] =>
    [...svg.matchAll(/<marker id="([^"]+)"/g)].map((match) => match[1] ?? "");

  it("scopes distinct marker ids to two renders with different seeds", () => {
    const one = renderPlate(helloGraph as unknown as GraphDocument, undefined, mulberry32(7), "seed-one");
    const two = renderPlate(helloGraph as unknown as GraphDocument, undefined, mulberry32(7), "seed-two");
    expect(ids(one)).toEqual([
      "seed-one-arrow",
      "seed-one-arrow-fail",
      "seed-one-arrow-error",
    ]);
    expect(ids(two)).toEqual([
      "seed-two-arrow",
      "seed-two-arrow-fail",
      "seed-two-arrow-error",
    ]);
    expect(ids(one).some((id) => ids(two).includes(id))).toBe(false);
    // The stylesheet follows the ids into the plate's own style block.
    expect(one).toContain(`.plate-svg #seed-one-arrow path{`);
    expect(one).not.toContain(`#plate-arrow`);
  });
});

describe("the pattern figures", () => {
  /** The command letters of an edge path. */
  function commands(d: string): string[] {
    return d.match(/[A-Za-z]/g) ?? [];
  }

  /** The first endpoint of an edge path. */
  function pathStart(d: string): [number, number] {
    const nums = (d.match(/-?[\d.]+/g) ?? []).map(Number);
    return [nums[0] ?? Number.NaN, nums[1] ?? Number.NaN];
  }

  /** The last endpoint of an edge path. */
  function pathEnd(d: string): [number, number] {
    const nums = (d.match(/-?[\d.]+/g) ?? []).map(Number);
    return [nums[nums.length - 2] ?? Number.NaN, nums[nums.length - 1] ?? Number.NaN];
  }

  it("review-panel: the panel fail edge runs a channel above the row, never through it", () => {
    const layout = layoutPlate(reviewPanel as unknown as GraphDocument);
    expect(layout).not.toBeNull();
    const fail = layout?.edges.find((edge) => edge.from === "review-panel" && edge.to === "implement");
    expect(fail?.cls).toBe("fail");
    // A channel: only straight runs and rounded corners, from the source's
    // top corner to the target's top corner, topping out above the row.
    for (const letter of commands(fail?.d ?? "")) {
      expect("MLQ").toContain(letter);
    }
    const panel = layout?.groups.find((group) => group.name === "review-panel");
    const implement = layout?.nodes.find((node) => node.name === "implement");
    expect(panel).toBeDefined();
    expect(implement).toBeDefined();
    if (panel === undefined || implement === undefined || fail === undefined) {
      return;
    }
    const box = nodeBox(implement);
    const round = (value: number): number => Math.round(value * 100) / 100;
    expect([
      [round(panel.x - panel.w / 2), round(panel.y - panel.h / 2)],
      [round(panel.x + panel.w / 2), round(panel.y - panel.h / 2)],
    ]).toContainEqual(pathStart(fail.d));
    expect([
      [round(implement.x - box.hw), round(implement.y - box.hh)],
      [round(implement.x + box.hw), round(implement.y - box.hh)],
    ]).toContainEqual(pathEnd(fail.d));
    const rowTop = Math.min(
      ...(layout?.nodes ?? [])
        .filter((node) => node.lane === "main")
        .map((node) => node.y - nodeBox(node).hh),
    );
    expect(pathExtent(fail.d).minY).toBeLessThan(rowTop);
  });

  it("resilient-members: resilience ranks after start, the fail channels parted", () => {
    const layout = layoutPlate(resilientMembers as unknown as GraphDocument);
    expect(layout).not.toBeNull();
    const rank = new Map((layout?.nodes ?? []).map((node) => [node.name, node.rank]));
    expect(rank.get("resilience") ?? -1).toBeGreaterThan(rank.get("start") ?? Number.MAX_SAFE_INTEGER);
    expect(layout?.order).toEqual(["start", "resilience", "gate", "review"]);
    // All three fail edges draw as channels, and the two into start part lifts.
    const fails = (layout?.edges ?? []).filter((edge) => edge.cls === "fail");
    expect(fails).toHaveLength(3);
    for (const edge of fails) {
      for (const letter of commands(edge.d)) {
        expect("MLQ", `${edge.from}→${edge.to}: command ${letter}`).toContain(letter);
      }
    }
    const rises = fails.filter((edge) => edge.to === "start").map((edge) => pathExtent(edge.d).minY);
    expect(rises).toHaveLength(2);
    expect(new Set(rises).size).toBe(2);
  });

  it("sinks failed into from one rank share the rank after it, in document order", () => {
    const twoSinks = {
      name: "two-sinks",
      nodes: [
        { name: "start", kind: "chip", position: 1, config: {} },
        { name: "left", kind: "agent", position: 2, config: {} },
        { name: "right", kind: "agent", position: 3, config: {} },
        { name: "sink-left", kind: "agent", position: 4, config: {} },
        { name: "sink-right", kind: "agent", position: 5, config: {} },
      ],
      edges: [
        { from_node: "start", to_node: "left", condition: "pass" },
        { from_node: "start", to_node: "right", condition: "pass" },
        { from_node: "left", to_node: "sink-left", condition: "fail" },
        { from_node: "right", to_node: "sink-right", condition: "fail" },
        { from_node: "sink-left", to_node: "start", condition: "pass" },
        { from_node: "sink-right", to_node: "start", condition: "pass" },
      ],
    } as unknown as GraphDocument;
    const layout = layoutPlate(twoSinks);
    expect(layout).not.toBeNull();
    const rank = new Map((layout?.nodes ?? []).map((node) => [node.name, node.rank]));
    expect(rank.get("left")).toBe(1);
    expect(rank.get("sink-left")).toBe(2);
    expect(rank.get("sink-right")).toBe(2);
    const order = layout?.order ?? [];
    expect(order.indexOf("sink-left")).toBeLessThan(order.indexOf("sink-right"));
  });
});
