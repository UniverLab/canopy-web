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
import reviewPanel from "./fixtures/patterns/review-panel.figure.json" with { type: "json" };
import resilientMembers from "./fixtures/patterns/resilient-members.figure.json" with { type: "json" };
import {
  structureOf,
  type GraphDocument,
  type NodeDocument,
} from "../../../packages/plate/document.js";
import { renderNodePlate, renderPlate } from "../../../packages/plate/render.js";
import { PLATE_SCALE, layoutPlate } from "../../../packages/plate/layout.js";
import { layoutPlateVertical } from "../../../packages/plate/vertical.js";
import { mulberry32 } from "../../../packages/plate/walk.js";
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

  it("hello-graph: the error destination leaves the column for the lane", () => {
    const svg = renderPlate(helloGraph as unknown as GraphDocument);
    const boxes = nodeBoxes(svg);
    // `tests` is the infra node and an error destination: the lane wins, and
    // no unit keeps the lower row.
    expect(boxes.filter((box) => box.lane === "handler").map((box) => box.name)).toEqual(["tests"]);
    expect(boxes.some((box) => box.lane === "infra")).toBe(false);
    const mainLeft = Math.min(
      ...boxes.filter((box) => box.lane === "main").map((box) => box.cx - box.w / 2),
    );
    const tests = boxes.find((box) => box.name === "tests") as Box;
    expect(tests.cx + tests.w / 2).toBeLessThan(mainLeft);
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

  it("canopy-tui-polish: resilience leaves the column, Commit is filled", () => {
    const svg = renderPlate(TUI_POLISH_GRAPH);
    const boxes = nodeBoxes(svg);
    expect(boxes.filter((box) => box.lane === "handler").map((box) => box.name)).toEqual([
      "resilience",
    ]);
    const mainLeft = Math.min(
      ...boxes.filter((box) => box.lane === "main").map((box) => box.cx - box.w / 2),
    );
    const resilience = boxes.find((box) => box.name === "resilience") as Box;
    expect(resilience.cx + resilience.w / 2).toBeLessThan(mainLeft);
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
      `.plate-svg #horizontal-plate-arrow-error path{fill:var(--attention,#ffb454);fill-opacity:.7}`,
    );
    expect(svg).not.toContain(`#horizontal-plate-arrow-error path{fill:#e8f6f1`);
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

describe("the vertical orientation", () => {
  it("runs ranks top to bottom with labels right of nodes", () => {
    const document: GraphDocument = {
      name: "chain",
      nodes: [
        { name: "first", kind: "agent", position: 1, config: {} },
        { name: "second", kind: "agent", position: 2, config: {} },
        { name: "third", kind: "agent", position: 3, config: {} },
      ],
      edges: [
        { from_node: "first", to_node: "second", condition: "pass" },
        { from_node: "second", to_node: "third", condition: "pass" },
      ],
    };
    const layout = layoutPlateVertical(document);
    expect(layout).not.toBeNull();
    const byName = new Map((layout?.nodes ?? []).map((node) => [node.name, node]));
    expect(byName.get("first")?.y).toBeLessThan(byName.get("second")?.y ?? 0);
    expect(byName.get("second")?.y).toBeLessThan(byName.get("third")?.y ?? 0);
    const svg = renderPlate(document, "vertical");
    expect(svg).toContain(`<svg class="plate-svg plate-v"`);
    expect(svg).toContain(`text-anchor="start"`);
    expect(svg).not.toContain(`text-anchor="middle">first</text>`);
  });

  it("fits every plate inside 360 px wide", () => {
    const documents: Array<[string, GraphDocument]> = [
      ...GRAPHS,
      ["round-robin", ROUND_ROBIN_GRAPH],
      ["sixty", sixtyNodeGraph()],
    ];
    for (const [name, document] of documents) {
      const layout = layoutPlateVertical(document);
      expect(layout).not.toBeNull();
      expect(Math.round((layout?.width ?? 0) * PLATE_SCALE), name).toBeLessThanOrEqual(360);
    }
  });

  it("draws nothing readable from an unreadable document", () => {
    expect(renderPlate("nope" as unknown as GraphDocument, "vertical")).toBe("");
    expect(renderNodePlate({} as unknown as NodeDocument, "vertical")).toBe("");
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

  it("fills nothing white, in either orientation", () => {
    for (const [name, document] of GRAPHS) {
      for (const orientation of ["horizontal", "vertical"] as const) {
        const svg = renderPlate(document, orientation);
        expect(svg, `${name} ${orientation}`).not.toContain("#fff");
        expect(svg, `${name} ${orientation}`).not.toContain("#FFF");
        expect(svg, `${name} ${orientation}`).not.toContain("var(--bg");
        expect(svg, `${name} ${orientation}`).not.toContain('fill="#fff"');
      }
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
      expect(svg).toContain(`<marker id="horizontal-plate-arrow"`);
      expect(svg).toContain(`<marker id="horizontal-plate-arrow-fail"`);
      expect(svg).toContain(`<marker id="horizontal-plate-arrow-error"`);
      const paths = drawnPaths(svg);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path.marker, `${path.cls} marker`).toBe(markerOf("horizontal-plate", path.cls));
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

    it(`${name}: the vertical plate carries arrowheads too`, () => {
      const vertical = renderPlate(document, "vertical");
      expect(vertical).toContain(`<marker id="vertical-plate-arrow"`);
      const paths = drawnPaths(vertical);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path.marker, `${path.cls} marker`).toBe(markerOf("vertical-plate", path.cls));
      }
    });
  }
});

describe("marker scoping", () => {
  // documentPage's figure: both orientations of one figure under one
  // seed. The horizontal twin is display:none under 640 px (the vertical
  // one above it), and Chrome paints no marker from a hidden subtree —
  // while url(#…) resolves to the FIRST marker in the document. So the
  // visible plate's ids must not be defined by its hidden twin.
  const figureOf = (seed: string): { figure: string; horizontal: string; vertical: string } => {
    const horizontal = renderPlate(helloGraph as unknown as GraphDocument, "horizontal", undefined, mulberry32(7), seed);
    const vertical = renderPlate(helloGraph as unknown as GraphDocument, "vertical", undefined, mulberry32(7), seed);
    return { figure: `<figure class="plate">${horizontal}${vertical}</figure>`, horizontal, vertical };
  };

  it("every flow edge of the visible plate resolves to a marker inside its own svg", () => {
    const { figure, horizontal, vertical } = figureOf("9f3");
    expect(horizontal).not.toBe("");
    expect(vertical).not.toBe("");
    // Both views: the phone hides the horizontal twin, the desktop the
    // vertical one — in each, the first definition of every marker an
    // edge points at lies inside the visible plate, never the hidden one.
    for (const [visible, hidden] of [[vertical, horizontal], [horizontal, vertical]] as const) {
      const start = figure.indexOf(visible);
      const end = start + visible.length;
      expect(start).toBeGreaterThanOrEqual(0);
      let flow = 0;
      for (const path of drawnPaths(visible)) {
        if (path.marker === null) {
          continue;
        }
        flow += 1;
        const first = figure.indexOf(`<marker id="${path.marker}"`);
        expect(first, `${path.cls} → ${path.marker}`).toBeGreaterThanOrEqual(start);
        expect(first, `${path.cls} → ${path.marker}`).toBeLessThan(end);
        expect(hidden, `${path.cls} → ${path.marker}`).not.toContain(`<marker id="${path.marker}"`);
      }
      expect(flow).toBeGreaterThan(0);
    }
  });

  it("scopes distinct marker ids to two renders with different seeds", () => {
    const one = renderPlate(helloGraph as unknown as GraphDocument, "horizontal", undefined, mulberry32(7), "seed-one");
    const two = renderPlate(helloGraph as unknown as GraphDocument, "horizontal", undefined, mulberry32(7), "seed-two");
    const ids = (svg: string): string[] =>
      [...svg.matchAll(/<marker id="([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(ids(one)).toEqual([
      "horizontal-seed-one-arrow",
      "horizontal-seed-one-arrow-fail",
      "horizontal-seed-one-arrow-error",
    ]);
    expect(ids(two)).toEqual([
      "horizontal-seed-two-arrow",
      "horizontal-seed-two-arrow-fail",
      "horizontal-seed-two-arrow-error",
    ]);
    expect(ids(one).some((id) => ids(two).includes(id))).toBe(false);
    // The stylesheet follows the ids into the plate's own style block.
    expect(one).toContain(`.plate-svg #horizontal-seed-one-arrow path{`);
    expect(one).not.toContain(`#plate-arrow`);
  });
});

describe("the pattern figures", () => {
  /** The eight numbers of a cubic edge path: endpoints and control points. */
  function cubic(d: string): number[] {
    return (d.match(/-?[\d.]+/g) ?? []).map(Number);
  }

  it("review-panel: the panel fail edge arcs above the row, never through it", () => {
    const layout = layoutPlate(reviewPanel as unknown as GraphDocument);
    expect(layout).not.toBeNull();
    const fail = layout?.edges.find((edge) => edge.from === "review-panel" && edge.to === "implement");
    expect(fail?.cls).toBe("fail");
    // An arc: both control points share the rise, at the endpoints' own x —
    // an S-curve through the row would share the midpoint's x instead.
    const [ax, , c1x, c1y, c2x, c2y, bx] = cubic(fail?.d ?? "");
    expect(c1x).toBe(ax);
    expect(c2x).toBe(bx);
    expect(c1y).toBe(c2y);
    const rowTop = Math.min(
      ...(layout?.nodes ?? []).filter((node) => node.lane === "main").map((node) => node.y - node.h / 2),
    );
    expect(c1y ?? Number.POSITIVE_INFINITY).toBeLessThan(rowTop);
  });

  it("review-panel: the panel fail edge arcs left of the column when vertical", () => {
    const layout = layoutPlateVertical(reviewPanel as unknown as GraphDocument);
    expect(layout).not.toBeNull();
    const fail = layout?.edges.find((edge) => edge.from === "review-panel" && edge.to === "implement");
    expect(fail?.cls).toBe("fail");
    const [, ay, c1x, c1y, c2x, c2y, , by] = cubic(fail?.d ?? "");
    expect(c1y).toBe(ay);
    expect(c2y).toBe(by);
    expect(c1x).toBe(c2x);
    const columnLeft = Math.min(
      ...(layout?.nodes ?? []).filter((node) => node.lane === "main").map((node) => node.x - node.w / 2),
    );
    expect(c1x ?? Number.POSITIVE_INFINITY).toBeLessThan(columnLeft);
  });

  it("resilient-members: resilience ranks after start, the fail arcs parted", () => {
    const layout = layoutPlate(resilientMembers as unknown as GraphDocument);
    expect(layout).not.toBeNull();
    const rank = new Map((layout?.nodes ?? []).map((node) => [node.name, node.rank]));
    expect(rank.get("resilience") ?? -1).toBeGreaterThan(rank.get("start") ?? Number.MAX_SAFE_INTEGER);
    expect(layout?.order).toEqual(["start", "resilience", "gate", "review"]);
    // All three fail edges draw as arcs, and the two into start part lifts.
    const fails = (layout?.edges ?? []).filter((edge) => edge.cls === "fail");
    expect(fails).toHaveLength(3);
    for (const edge of fails) {
      const [ax, , c1x, c1y, c2x, c2y, bx] = cubic(edge.d);
      expect([c1x, c2x, c1y, c2y], `${edge.from}→${edge.to}`).toEqual([ax, bx, c1y, c1y]);
    }
    const rises = fails.filter((edge) => edge.to === "start").map((edge) => cubic(edge.d)[3]);
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
    for (const layout of [layoutPlate(twoSinks), layoutPlateVertical(twoSinks)]) {
      expect(layout).not.toBeNull();
      const rank = new Map((layout?.nodes ?? []).map((node) => [node.name, node.rank]));
      expect(rank.get("left")).toBe(1);
      expect(rank.get("sink-left")).toBe(2);
      expect(rank.get("sink-right")).toBe(2);
      const order = layout?.order ?? [];
      expect(order.indexOf("sink-left")).toBeLessThan(order.indexOf("sink-right"));
    }
  });
});
