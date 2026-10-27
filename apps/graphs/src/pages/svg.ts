// SPDX-License-Identifier: Apache-2.0
/**
 * The drawing of a graph, as inline SVG in currentColor.
 *
 * Nodes are labelled boxes whose class carries their kind; edges follow
 * the document's conditions — `fail` edges dashed, everything else solid.
 * The layout is deliberately simple: a longest-path layering (relaxation
 * capped at one pass per node, so a cycle terminates) puts nodes in
 * left-to-right columns, and within a column each node takes the next row.
 * The whole drawing is static SVG: no script, no external anything.
 */
import type { JsonValue } from "../../../../src/schema.js";
import { isArray, isRecord, isString, stringField } from "../json.js";
import { DRAWING_ALT } from "./copy.js";
import { escapeHtml } from "./md.js";

/** Geometry in viewBox units: one box size, one column gap, one row height. */
const BOX_W = 150;
const BOX_H = 36;
const GAP_X = 70;
const ROW_H = 52;
const PAD = 16;

/** Labels longer than this are truncated; the box has a full-name title. */
const LABEL_MAX = 20;

interface DrawNode {
  name: string;
  kind: string;
}

interface DrawEdge {
  from: string;
  to: string;
  condition: string;
}

function nodesOf(document: Record<string, JsonValue>): DrawNode[] {
  const nodes = document["nodes"];
  if (!isArray(nodes)) {
    return [];
  }
  return nodes.flatMap((node) => {
    if (!isRecord(node) || !isString(node["name"])) {
      return [];
    }
    const kind = stringField(node, "kind") || "node";
    return [{ name: node["name"], kind: kind.replace(/[^a-z0-9-]/gi, "-").toLowerCase() }];
  });
}

function edgesOf(document: Record<string, JsonValue>): DrawEdge[] {
  const edges = document["edges"];
  if (!isArray(edges)) {
    return [];
  }
  return edges.flatMap((edge) => {
    if (!isRecord(edge) || !isString(edge["from_node"]) || !isString(edge["to_node"])) {
      return [];
    }
    const condition = edge["condition"];
    const label = isString(condition)
      ? condition
      : isRecord(condition) && isString(condition["route"])
        ? `route:${condition["route"]}`
        : "always";
    return [{ from: edge["from_node"], to: edge["to_node"], condition: label }];
  });
}

/**
 * Longest-path layers, left to right: a Kahn sweep assigns each node one
 * column past its deepest processed predecessor. Cycles (a fail edge back
 * to an earlier node) would keep every node waiting, so when the sweep
 * stalls it breaks the deadlock at the first unprocessed node in document
 * order and treats it as a root — deterministic, and every node is placed
 * exactly once.
 */
function layersOf(nodes: DrawNode[], edges: DrawEdge[]): number[] {
  const known = new Set(nodes.map((node) => node.name));
  const layer = new Map<string, number>(nodes.map((node) => [node.name, 0]));
  const pending = new Map<string, number>(
    nodes.map((node) => [node.name, edges.filter((edge) => edge.to === node.name).length]),
  );
  const done = new Set<string>();
  while (done.size < nodes.length) {
    const ready = nodes.find((node) => !done.has(node.name) && (pending.get(node.name) ?? 0) === 0);
    const next = ready ?? nodes.find((node) => !done.has(node.name));
    if (next === undefined) {
      break;
    }
    done.add(next.name);
    for (const edge of edges) {
      if (edge.from !== next.name || !known.has(edge.to)) {
        continue;
      }
      pending.set(edge.to, Math.max(0, (pending.get(edge.to) ?? 0) - 1));
      if (done.has(edge.to)) {
        continue;
      }
      const deeper = (layer.get(next.name) ?? 0) + 1;
      if (deeper > (layer.get(edge.to) ?? 0)) {
        layer.set(edge.to, deeper);
      }
    }
  }
  return nodes.map((node) => layer.get(node.name) ?? 0);
}

function truncate(name: string): string {
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}

/**
 * Render a validated graph document as inline SVG. `ref` names the graph
 * in the drawing's accessible label. An unreadable document simply draws
 * nothing: the pages only ever pass validated graphs.
 */
export function renderGraph(document: JsonValue, ref: string): string {
  if (!isRecord(document)) {
    return "";
  }
  const nodes = nodesOf(document);
  const edges = edgesOf(document);
  if (nodes.length === 0) {
    return "";
  }
  const layers = layersOf(nodes, edges);
  const rows = new Map<number, number>();
  const placed = nodes.map((node, index) => {
    const column = layers[index] ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      ...node,
      column,
      x: PAD + column * (BOX_W + GAP_X),
      y: PAD + row * ROW_H,
    };
  });
  const width = PAD * 2 + (Math.max(...placed.map((node) => node.column)) + 1) * BOX_W +
    Math.max(...placed.map((node) => node.column)) * GAP_X;
  const height = PAD * 2 + Math.max(...Array.from(rows.values())) * ROW_H - (ROW_H - BOX_H);
  const at = new Map(placed.map((node) => [node.name, node]));

  const shapes = placed.map((node) =>
    `<g class="node kind-${escapeHtml(node.kind)}">` +
      `<rect x="${node.x}" y="${node.y}" width="${BOX_W}" height="${BOX_H}" rx="4"></rect>` +
      `<text x="${node.x + BOX_W / 2}" y="${node.y + BOX_H / 2 + 4}" text-anchor="middle">` +
      `${escapeHtml(truncate(node.name))}</text>` +
      `</g>`,
  );

  const lines = edges.flatMap((edge) => {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) {
      return [];
    }
    const condition = edge.condition === "fail" ? "fail" : edge.condition === "pass" ? "pass" : "other";
    const x1 = from.x + BOX_W;
    const y1 = from.y + BOX_H / 2;
    const x2 = to.x;
    const y2 = to.y + BOX_H / 2;
    return [
      `<line class="edge ${condition}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`,
    ];
  });

  return (
    `<svg class="graph-svg" viewBox="0 0 ${width} ${height}" role="img" ` +
    `aria-label="${escapeHtml(ref)}: ${escapeHtml(DRAWING_ALT)}" ` +
    `xmlns="http://www.w3.org/2000/svg">` +
    lines.join("") +
    shapes.join("") +
    `</svg>`
  );
}
