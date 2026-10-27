// SPDX-License-Identifier: Apache-2.0
/**
 * The plate renderer: a laid-out graph becomes one self-contained `<svg>`
 * in the Canopy vocabulary — node kinds as shapes, pass edges as teal
 * S-curves, fail edges as red dashed arcs above the row (left of the column
 * in the vertical orientation), ensembles as dashed group outlines, the
 * infra node in a lower lane, and a walking token along the main pass chain.
 *
 * Node colours follow univerlab's GraphMorph: the shape fills with its
 * harness colour at 22% over the deep (`--nc`, the Canopy teal when the
 * harness is unknown), chips stay dark with a dim stroke, checks and gates
 * dark with a pale stroke, commits filled teal. A node or member with a
 * known platform or model family carries its harness stem under its label
 * and its `--nc` accent; unknown harnesses draw no label. Nothing in the
 * plate ever fills white.
 *
 * The svg carries its own `<style>`: colours come from the look kit tokens
 * (`--canopy`, `--ink-dim`, `--font-mono`) when the kit is present and fall
 * back to the Canopy values otherwise; the fail red stays `#ff6b6b`. The
 * token is a declarative SMIL animation hidden under
 * `prefers-reduced-motion`, so the static drawing is complete without motion
 * and without any script.
 */
import { type GraphDocument, type NodeDocument } from "./document.js";
import {
  MEMBER_GEOM,
  PLATE_SCALE,
  layoutPlate,
  plateLabel,
  type Orientation,
  type PlacedMember,
  type PlacedNode,
  type PlateLayout,
} from "./layout.js";
import { V_HARNESS_DY, V_LABEL_DX, V_LABEL_DY, layoutPlateVertical } from "./vertical.js";
import { GEOM, TYPE, harnessColor } from "./vocabulary.js";
import { isArray, isNumber, isRecord, isString } from "../json.js";

/** Baseline of a member's harness line under its chip (viewBox units). */
const MEMBER_HARNESS_DY = 3.4;

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
 * The svg's own stylesheet. Node fills follow the Canopy page's GraphMorph:
 * the harness accent at 22% over the deep, chips/checks/gates dark, commits
 * filled teal. Kind rules come after the base node rule so they win the
 * specificity tie.
 */
function plateStyle(): string {
  return (
    `.plate-svg text{font-family:var(--font-mono,"Sometype Mono","Courier New",monospace)}` +
    `.plate-svg .edge{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.45;opacity:.85}` +
    `.plate-svg .edge.fail{stroke:#ff6b6b;stroke-dasharray:1.4 1.1;opacity:.7}` +
    `.plate-svg .edge.error{stroke:currentColor;stroke-width:.3;stroke-dasharray:.4 .8;opacity:.45}` +
    `.plate-svg .edge.order{stroke:currentColor;stroke-width:.3;stroke-dasharray:.5 1.1;stroke-linecap:round;opacity:.9}` +
    `.plate-svg .node .shape{fill:color-mix(in srgb, var(--nc, var(--canopy)) 22%, #04110f);stroke:var(--nc, var(--canopy));stroke-width:.45}` +
    `.plate-svg .shape-chip .shape{fill:#0c1416;stroke:var(--ink-dim,#9a9890)}` +
    `.plate-svg .shape-check .shape,.plate-svg .shape-gate .shape{fill:#0c1416;stroke:#e8f6f1}` +
    `.plate-svg .shape-commit .shape{fill:color-mix(in srgb, var(--canopy) 35%, #04110f);stroke:var(--canopy)}` +
    `.plate-svg .label{font-size:2.3px;fill:#e8f6f1}` +
    `.plate-svg .harness{font-size:1.9px;fill:var(--nc, var(--canopy));opacity:.9}` +
    `.plate-svg .group-box{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.3;stroke-dasharray:1.2 .9;opacity:.8}` +
    `.plate-svg .group-title,.plate-svg .group-subtitle{font-size:1.9px;fill:var(--canopy,#00a9a0);letter-spacing:.14em;text-transform:uppercase}` +
    `.plate-svg .member-shape{fill:color-mix(in srgb, var(--nc, var(--canopy)) 22%, #04110f);stroke:var(--nc, var(--canopy));stroke-width:.3}` +
    `.plate-svg .member-label{font-size:1.9px;fill:#e8f6f1;text-anchor:middle}` +
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

/** The `--nc` accent of a harness stem, as a style attribute or nothing. */
function harnessStyle(harness: string | null): string {
  const color = harnessColor(harness);
  return color === null ? "" : ` style="--nc:${color}"`;
}

function renderMember(groupName: string, member: PlacedMember, index: number): string {
  const harness = member.harness === null
    ? ""
    : `<text class="harness" x="${member.x}" y="${member.y}" dy="${MEMBER_HARNESS_DY}" text-anchor="middle">${escape(member.harness)}</text>`;
  return (
    `<g class="member" data-name="${escape(groupName)}" data-i="${index + 1}" ` +
    `data-cx="${member.x}" data-cy="${member.y}"${harnessStyle(member.harness)}>` +
    `<rect class="member-shape" x="${member.x - MEMBER_GEOM.w / 2}" y="${member.y - MEMBER_GEOM.h / 2}" ` +
    `width="${MEMBER_GEOM.w}" height="${MEMBER_GEOM.h}" rx="1"/>` +
    `<text class="member-label" x="${member.x}" y="${member.y}" dy="0.7">${escape(member.label)}</text>` +
    harness +
    `</g>`
  );
}

function renderGroups(layout: PlateLayout): string {
  return layout.groups
    .map((group) => {
      const members = group.members
        .map((member, index) => renderMember(group.name, member, index))
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

function renderNode(node: PlacedNode, orientation: Orientation): string {
  const geom = GEOM[node.shape];
  const rotate = geom.rot === 0 ? "" : ` transform="rotate(${geom.rot} ${node.x} ${node.y})"`;
  const dataHarness = node.harness === null ? "" : ` data-harness="${escape(node.harness)}"`;
  const label = orientation === "vertical"
    ? `<text class="label" x="${num2(node.x + node.w / 2 + V_LABEL_DX)}" y="${node.y}" dy="${V_LABEL_DY}" text-anchor="start">${escape(plateLabel(node.name))}</text>`
    : `<text class="label" x="${node.x}" y="${node.y}" dy="${TYPE.labelDy}" text-anchor="middle">${escape(plateLabel(node.name))}</text>`;
  const harness = node.harness === null
    ? ""
    : orientation === "vertical"
      ? `<text class="harness" x="${num2(node.x + node.w / 2 + V_LABEL_DX)}" y="${node.y}" dy="${V_HARNESS_DY}" text-anchor="start">${escape(node.harness)}</text>`
      : `<text class="harness" x="${node.x}" y="${node.y}" dy="${TYPE.harnessDy}" text-anchor="middle">${escape(node.harness)}</text>`;
  return (
    `<g class="node shape-${node.shape}" data-name="${escape(node.name)}" ` +
    `data-cx="${node.x}" data-cy="${node.y}" data-w="${node.w}" data-h="${node.h}" ` +
    `data-rank="${node.rank}" data-lane="${node.infra ? "infra" : "main"}"${dataHarness}${harnessStyle(node.harness)}>` +
    `<title>${escape(node.name)} (${escape(node.docKind)})</title>` +
    `<rect class="shape" x="${node.x - geom.w / 2}" y="${node.y - geom.h / 2}" ` +
    `width="${geom.w}" height="${geom.h}" rx="${geom.rx}"${rotate}/>` +
    label +
    harness +
    `</g>`
  );
}

/** Round to two decimals so label positions print without float noise. */
function num2(value: number): number {
  return Math.round(value * 100) / 100;
}

function renderNodes(layout: PlateLayout): string {
  return layout.nodes.map((node) => renderNode(node, layout.orientation)).join("");
}

function renderToken(layout: PlateLayout): string {
  if (layout.walk === null) {
    return "";
  }
  // The circle rides at the animation path's point: its own centre stays at
  // the local origin, because the motion transform adds to cx/cy instead of
  // replacing them — a nonzero centre would offset the token off the path.
  return (
    `<circle class="token" r="1.1" cx="0" cy="0">` +
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
  const cls = layout.orientation === "vertical" ? "plate-svg plate-v" : "plate-svg plate-h";
  return (
    `<svg class="${cls}" viewBox="0 0 ${layout.width} ${layout.height}" ` +
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
 * Render a graph document as a self-contained Canopy plate, horizontal
 * (ranks left to right) or vertical (ranks top to bottom). An unreadable
 * document draws nothing: the pages only ever pass validated graphs.
 */
export function renderPlate(document: GraphDocument, orientation: Orientation = "horizontal"): string {
  const layout = orientation === "vertical" ? layoutPlateVertical(document) : layoutPlate(document);
  return layout === null ? "" : renderLayout(layout);
}

/**
 * Render one node document as a plate: the single node (or ensemble) drawn
 * with the same vocabulary, by running it through the same layout as a
 * one-unit graph. An unreadable document draws nothing.
 */
export function renderNodePlate(document: NodeDocument, orientation: Orientation = "horizontal"): string {
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
    return renderPlate(graph, orientation);
  }
  const graph: GraphDocument = {
    name,
    nodes: [{ name, kind, position: 1, config }],
    edges: [],
  };
  return renderPlate(graph, orientation);
}
