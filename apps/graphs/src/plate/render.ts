// SPDX-License-Identifier: Apache-2.0
/**
 * The plate renderer: a laid-out graph becomes one self-contained `<svg>`
 * in the Canopy vocabulary — node kinds as shapes, pass edges as teal
 * S-curves, fail edges as red dashed arcs above the row, ensembles as
 * dashed group outlines, the infra node in a lower lane, and a walking
 * token along the main pass chain.
 *
 * The svg carries its own `<style>`: colours come from the look kit tokens
 * (`--canopy`, `--font-mono`) when the kit is present and fall back to the
 * Canopy teal otherwise; the fail red stays `#ff6b6b`. The token is a
 * declarative SMIL animation hidden under `prefers-reduced-motion`, so the
 * static drawing is complete without motion and without any script.
 */
import { type GraphDocument, type NodeDocument } from "./document.js";
import { MEMBER_GEOM, PLATE_SCALE, layoutPlate, plateLabel, type PlateLayout } from "./layout.js";
import { GEOM, TYPE } from "./vocabulary.js";
import { isArray, isNumber, isRecord, isString } from "../json.js";

/** Escape text for svg content and attribute values alike. */
function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function groupTitleY(group: { y: number; h: number }): number {
  return group.y - group.h / 2 + 3.4;
}

function groupSubtitleY(group: { y: number; h: number }): number {
  return group.y - group.h / 2 + 5.8;
}

function groupLabelX(group: { x: number; w: number }): number {
  return group.x - group.w / 2 + 2;
}

/**
 * The svg's own stylesheet. Everything structural (shapes, labels) follows
 * the page through `currentColor` and `--bg`; the pass teal and the mono
 * come from the look kit when it is present.
 */
function plateStyle(): string {
  return (
    `.plate-svg text{font-family:var(--font-mono,"Sometype Mono","Courier New",monospace)}` +
    `.plate-svg .edge{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.45;opacity:.85}` +
    `.plate-svg .edge.fail{stroke:#ff6b6b;stroke-dasharray:1.4 1.1;opacity:.7}` +
    `.plate-svg .edge.error{stroke:currentColor;stroke-width:.3;stroke-dasharray:.4 .8;opacity:.45}` +
    `.plate-svg .edge.order{stroke:currentColor;stroke-width:.3;stroke-dasharray:.5 1.1;stroke-linecap:round;opacity:.9}` +
    `.plate-svg .node .shape{fill:var(--bg,#fff);stroke:currentColor;stroke-width:.45}` +
    `.plate-svg .shape-agent .shape{stroke:var(--canopy,#00a9a0)}` +
    `.plate-svg .shape-commit .shape{fill:var(--canopy,#00a9a0);stroke:var(--canopy,#00a9a0)}` +
    `.plate-svg .label{font-size:2.3px;fill:currentColor;text-anchor:middle}` +
    `.plate-svg .group-box{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.3;stroke-dasharray:1.2 .9;opacity:.8}` +
    `.plate-svg .group-title,.plate-svg .group-subtitle{font-size:1.9px;fill:var(--canopy,#00a9a0);letter-spacing:.14em;text-transform:uppercase}` +
    `.plate-svg .member-shape{fill:var(--bg,#fff);stroke:currentColor;stroke-width:.3}` +
    `.plate-svg .member-label{font-size:1.9px;fill:currentColor;text-anchor:middle}` +
    `.plate-svg .token{fill:var(--canopy,#00a9a0)}` +
    `@media (prefers-reduced-motion:reduce){.plate-svg .token{display:none}}`
  );
}

const EDGE_ORDER = { error: 0, order: 1, pass: 2, fail: 3 } as const;

function renderEdges(layout: PlateLayout): string {
  const edges = [...layout.edges].sort(
    (a, b) =>
      EDGE_ORDER[a.cls] - EDGE_ORDER[b.cls] ||
      (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );
  return edges
    .map(
      (edge) =>
        `<path class="edge ${edge.cls}" d="${edge.d}" ` +
        `data-from="${escape(edge.from)}" data-to="${escape(edge.to)}"/>`,
    )
    .join("");
}

function renderGroups(layout: PlateLayout): string {
  return layout.groups
    .map((group) => {
      const members = group.members
        .map(
          (member, index) =>
            `<g class="member" data-name="${escape(group.name)}" data-i="${index + 1}" ` +
            `data-cx="${member.x}" data-cy="${member.y}">` +
            `<rect class="member-shape" x="${member.x - MEMBER_GEOM.w / 2}" y="${member.y - MEMBER_GEOM.h / 2}" ` +
            `width="${MEMBER_GEOM.w}" height="${MEMBER_GEOM.h}" rx="1"/>` +
            `<text class="member-label" x="${member.x}" y="${member.y}" dy="0.7">${escape(member.label)}</text>` +
            `</g>`,
        )
        .join("");
      return (
        `<g class="ensemble" data-name="${escape(group.name)}">` +
        `<rect class="group-box" x="${group.x - group.w / 2}" y="${group.y - group.h / 2}" ` +
        `width="${group.w}" height="${group.h}" rx="2"/>` +
        `<text class="group-title" x="${groupLabelX(group)}" y="${groupTitleY(group)}">${escape(group.title)}</text>` +
        `<text class="group-subtitle" x="${groupLabelX(group)}" y="${groupSubtitleY(group)}">${escape(group.subtitle)}</text>` +
        members +
        `</g>`
      );
    })
    .join("");
}

function renderNodes(layout: PlateLayout): string {
  return layout.nodes
    .map((node) => {
      const geom = GEOM[node.shape];
      const rotate = geom.rot === 0 ? "" : ` transform="rotate(${geom.rot} ${node.x} ${node.y})"`;
      return (
        `<g class="node shape-${node.shape}" data-name="${escape(node.name)}" ` +
        `data-cx="${node.x}" data-cy="${node.y}" data-w="${node.w}" data-h="${node.h}" ` +
        `data-rank="${node.rank}" data-lane="${node.infra ? "infra" : "main"}">` +
        `<title>${escape(node.name)} (${escape(node.docKind)})</title>` +
        `<rect class="shape" x="${node.x - geom.w / 2}" y="${node.y - geom.h / 2}" ` +
        `width="${geom.w}" height="${geom.h}" rx="${geom.rx}"${rotate}/>` +
        `<text class="label" x="${node.x}" y="${node.y}" dy="${TYPE.labelDy}">${escape(plateLabel(node.name))}</text>` +
        `</g>`
      );
    })
    .join("");
}

function renderToken(layout: PlateLayout): string {
  if (layout.walk === null) {
    return "";
  }
  const start = /^M(-?[\d.]+) (-?[\d.]+)/.exec(layout.walk);
  const cx = start?.[1] ?? 0;
  const cy = start?.[2] ?? 0;
  return (
    `<circle class="token" r="1.1" cx="${cx}" cy="${cy}">` +
    `<animateMotion dur="${layout.walkSeconds}s" repeatCount="indefinite" path="${layout.walk}"/>` +
    `</circle>`
  );
}

function renderLayout(layout: PlateLayout): string {
  const ensembles = layout.groups.map((group) => group.name);
  const parts = [
    layout.order.length === 0 ? null : `Nodes in order: ${layout.order.join(", ")}.`,
    ensembles.length === 0 ? null : `Ensembles: ${ensembles.join(", ")}.`,
  ].filter((part) => part !== null);
  const desc = parts.join(" ");
  return (
    `<svg class="plate-svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
    `width="${Math.round(layout.width * PLATE_SCALE)}" height="${Math.round(layout.height * PLATE_SCALE)}" ` +
    `role="img" xmlns="http://www.w3.org/2000/svg">` +
    `<title>${escape(layout.name)}</title>` +
    `<desc>${escape(desc)}</desc>` +
    `<style>${plateStyle()}</style>` +
    `<g class="edges">${renderEdges(layout)}</g>` +
    `<g class="groups">${renderGroups(layout)}</g>` +
    `<g class="nodes">${renderNodes(layout)}</g>` +
    renderToken(layout) +
    `</svg>`
  );
}

/**
 * Render a graph document as a self-contained Canopy plate. An unreadable
 * document draws nothing: the pages only ever pass validated graphs.
 */
export function renderPlate(document: GraphDocument): string {
  const layout = layoutPlate(document);
  return layout === null ? "" : renderLayout(layout);
}

/**
 * Render one node document as a plate: the single node (or ensemble) drawn
 * with the same vocabulary, by running it through the same layout as a
 * one-unit graph. An unreadable document draws nothing.
 */
export function renderNodePlate(document: NodeDocument): string {
  if (!isRecord(document) || !isString(document["name"]) || !isString(document["kind"])) {
    return "";
  }
  const config = isRecord(document["config"]) ? document["config"] : {};
  const name = document["name"];
  const kind = document["kind"];
  if (kind === "ensemble") {
    const members = config["members"];
    const graph: GraphDocument = {
      name,
      nodes: [],
      edges: [],
      ensembles: [
        {
          name,
          kind: isString(config["kind"]) ? config["kind"] : "parallel",
          min_pass: isNumber(config["min_pass"])
            ? config["min_pass"]
            : isArray(members)
            ? members.length
            : 0,
          members: isArray(members) ? members.filter((member) => isRecord(member)) : [],
        },
      ],
    };
    return renderPlate(graph);
  }
  const graph: GraphDocument = {
    name,
    nodes: [{ name, kind, position: 1, config }],
    edges: [],
  };
  return renderPlate(graph);
}
