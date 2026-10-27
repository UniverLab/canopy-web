// SPDX-License-Identifier: Apache-2.0
/**
 * The Canopy plates: one snapshot per official registry graph plus the
 * polish-shaped fixture, the structural invariants behind every snapshot
 * (no overlapping shapes, every edge endpoint drawn, fail routes dashed
 * red, the infra node in the lower lane), the node plate, and the
 * sixty-node render budget.
 */
import { describe, expect, it } from "vitest";
import helloGraph from "../../../registry/graphs/hello-graph/graph.json" with { type: "json" };
import qualityBubble from "../../../registry/graphs/quality-bubble/graph.json" with { type: "json" };
import singleCommitter from "../../../registry/graphs/single-committer/graph.json" with { type: "json" };
import specLoop from "../../../registry/graphs/spec-loop/graph.json" with { type: "json" };
import {
  structureOf,
  type GraphDocument,
  type NodeDocument,
} from "../src/plate/document.js";
import { renderNodePlate, renderPlate } from "../src/plate/render.js";
import { ROUND_ROBIN_GRAPH, TUI_POLISH_GRAPH, sixtyNodeGraph } from "./plate-fixture.js";

const GRAPHS: Array<[string, GraphDocument]> = [
  ["hello-graph", helloGraph as unknown as GraphDocument],
  ["quality-bubble", qualityBubble as unknown as GraphDocument],
  ["single-committer", singleCommitter as unknown as GraphDocument],
  ["spec-loop", specLoop as unknown as GraphDocument],
  ["canopy-tui-polish", TUI_POLISH_GRAPH],
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
    /<g class="node shape-[a-z]+" data-name="([^"]+)" data-cx="(-?[\d.]+)" data-cy="(-?[\d.]+)" data-w="(-?[\d.]+)" data-h="(-?[\d.]+)" data-rank="\d+" data-lane="(main|infra)">/g;
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
  const pattern = /<path class="edge ([a-z]+)" d="[^"]*" data-from="([^"]+)" data-to="([^"]+)"\/>/g;
  for (const match of svg.matchAll(pattern)) {
    edges.push({ cls: match[1] ?? "", from: match[2] ?? "", to: match[3] ?? "" });
  }
  return edges;
}

/** The drawn ensemble names. */
function drawnGroups(svg: string): string[] {
  return [...svg.matchAll(/<g class="ensemble" data-name="([^"]+)">/g)].map((match) => match[1] ?? "");
}

/** The member-chip centres inside the group outlines. */
function memberCentres(svg: string): number[] {
  return [...svg.matchAll(/<g class="member" data-name="[^"]+" data-i="\d+" data-cx="(-?[\d.]+)" data-cy="(-?[\d.]+)">/g)]
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
      expect(svg).toContain(`<svg class="plate-svg" viewBox="0 0 `);
      expect(svg).toContain(`role="img"`);
      expect(svg).toContain(`<title>${name}</title>`);
      expect(svg).toMatch(/<desc>Nodes in order: [^<]+<\/desc>/);
    });
  }

  it("hello-graph: the infra node sits alone in the lower lane", () => {
    const svg = renderPlate(helloGraph as unknown as GraphDocument);
    const boxes = nodeBoxes(svg);
    const infra = boxes.filter((box) => box.lane === "infra");
    expect(infra.map((box) => box.name)).toEqual(["tests"]);
    const mainBottom = Math.max(
      ...boxes.filter((box) => box.lane === "main").map((box) => box.cy),
      ...memberCentres(svg),
    );
    expect((infra[0] as Box).cy).toBeGreaterThan(mainBottom);
  });

  it("canopy-tui-polish: resilience sits in the lower lane, Commit is filled", () => {
    const svg = renderPlate(TUI_POLISH_GRAPH);
    const boxes = nodeBoxes(svg);
    expect(boxes.filter((box) => box.lane === "infra").map((box) => box.name)).toEqual(["resilience"]);
    const mainBottom = Math.max(
      ...boxes.filter((box) => box.lane === "main").map((box) => box.cy),
      ...memberCentres(svg),
    );
    const resilience = boxes.find((box) => box.name === "resilience") as Box;
    expect(resilience.cy).toBeGreaterThan(mainBottom);
    expect(svg).toContain(`<g class="node shape-commit" data-name="Commit"`);
    expect(svg).toContain("PARALLEL · 2/3");
    expect(svg).toContain("CASCADE · 2");
    expect(svg).toContain(`<g class="member" data-name="proposers" data-i="1"`);
    expect(svg).toContain(`<g class="member" data-name="proposers" data-i="3"`);
  });

  it("hello-graph: the escalate route reads as pass, the error as error", () => {
    const svg = renderPlate(helloGraph as unknown as GraphDocument);
    const edges = drawnEdges(svg);
    const escalate = edges.find((edge) => edge.from === "triage" && edge.to === "implementer");
    expect(escalate?.cls).toBe("pass");
    const error = edges.find((edge) => edge.from === "implementer" && edge.to === "tests");
    expect(error?.cls).toBe("error");
  });

  it("single-committer: the entry check is a chip, the router-less gate a diamond", () => {
    const svg = renderPlate(singleCommitter as unknown as GraphDocument);
    expect(svg).toContain(`<g class="node shape-chip" data-name="start-check"`);
    expect(svg).toContain(`<g class="node shape-agent" data-name="committer"`);
    expect(svg).toContain("PARALLEL · 2/2");
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
