// SPDX-License-Identifier: Apache-2.0
/**
 * The plate renderer: a laid-out graph becomes one self-contained `<svg>`
 * in the Canopy vocabulary — node kinds as shapes, pass edges as teal
 * S-curves, fail edges as red dashed arcs above the row (left of the column
 * in the vertical orientation), ensembles as dashed group outlines, the
 * infra node in a lower lane, and a walking token along the main pass
 * chain that may ride a red fail edge back before getting through.
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
  type PlacedEdge,
  type PlacedMember,
  type PlacedNode,
  type PlateLayout,
} from "./layout.js";
import { V_HARNESS_DY, V_LABEL_DX, V_LABEL_DY, layoutPlateVertical } from "./vertical.js";
import { GEOM, TYPE, harnessColor } from "./vocabulary.js";
import { happyRandom, STEP_SECONDS } from "./walk.js";
import { isArray, isNumber, isRecord, isString } from "./guards.js";

/** A node or ensemble member's run state, as the live overlay carries it. */
export type PlateNodeState = "running" | "pass" | "fail";

/**
 * The live overlay: each key is a node name, or an ensemble member's drawn
 * label (or `<ensemble>#<i>`, i from 1) — members are keyed the same way
 * nodes are. `current` names the unit the walking token stops on; a current
 * with no entry of its own reads as running.
 */
export interface PlateState {
  nodes: Record<string, PlateNodeState>;
  current?: string;
}

/** The `<title>` word of each state: the palette alone is too close to tell. */
const STATE_WORD: Record<PlateNodeState, string> = {
  running: "running",
  pass: "passed",
  fail: "failed",
};

/** One drawn unit's overlay: its state, and whether it is lit right now. */
interface Mark {
  status: PlateNodeState;
  lit: boolean;
}

/** The state of a key, honouring `current` as an implied running state. */
function statusOf(state: PlateState, key: string): PlateNodeState | null {
  const status = state.nodes[key];
  if (status === "running" || status === "pass" || status === "fail") {
    return status;
  }
  return key === state.current ? "running" : null;
}

/** The overlay of a unit keyed by the given names, or null without one. */
function markOf(state: PlateState | undefined, keys: string[]): Mark | null {
  if (state === undefined) {
    return null;
  }
  for (const key of keys) {
    const status = statusOf(state, key);
    if (status !== null) {
      return { status, lit: status === "running" };
    }
  }
  return null;
}

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
    `.plate-svg text{font-family:var(--font-mono,'Sometype Mono',ui-monospace,Menlo,monospace)}` +
    `.plate-svg .edge{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.45;opacity:.85}` +
    `.plate-svg .edge.fail{stroke:#ff6b6b;stroke-dasharray:1.4 1.1;opacity:.7}` +
    `.plate-svg .edge.error{stroke:currentColor;stroke-width:.3;stroke-dasharray:.4 .8;opacity:.45}` +
    `.plate-svg .edge.order{stroke:currentColor;stroke-width:.3;stroke-dasharray:.5 1.1;stroke-linecap:round;opacity:.9}` +
    `.plate-svg .node .shape{fill:color-mix(in srgb, var(--nc, var(--canopy, #00a9a0)) 22%, #04110f);stroke:var(--nc, var(--canopy, #00a9a0));stroke-width:.45}` +
    `.plate-svg .shape-chip .shape{fill:#0c1416;stroke:var(--ink-dim,#9a9890)}` +
    `.plate-svg .shape-check .shape,.plate-svg .shape-gate .shape{fill:#0c1416;stroke:#e8f6f1}` +
    `.plate-svg .shape-commit .shape{fill:color-mix(in srgb, var(--canopy, #00a9a0) 35%, #04110f);stroke:var(--canopy,#00a9a0)}` +
    `.plate-svg .label{font-size:2.3px;fill:#e8f6f1}` +
    `.plate-svg .harness{font-size:1.9px;fill:var(--nc, var(--canopy, #00a9a0));opacity:.9}` +
    `.plate-svg .group-box{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.3;stroke-dasharray:1.2 .9;opacity:.8}` +
    `.plate-svg .group-title,.plate-svg .group-subtitle{font-size:1.9px;fill:var(--canopy,#00a9a0);letter-spacing:.14em;text-transform:uppercase}` +
    `.plate-svg .member-shape{fill:color-mix(in srgb, var(--nc, var(--canopy, #00a9a0)) 22%, #04110f);stroke:var(--nc, var(--canopy, #00a9a0));stroke-width:.3}` +
    `.plate-svg .member-label{font-size:1.9px;fill:#e8f6f1;text-anchor:middle}` +
    `.plate-svg .token{fill:var(--canopy,#00a9a0)}` +
    `@media (prefers-reduced-motion:reduce){.plate-svg .token{display:none}}`
  );
}

/**
 * The overlay's own rules, appended to the svg's stylesheet only when a
 * state is passed: without one the drawing stays byte-identical to the
 * stateless plate. The ring pulses through a CSS animation, which
 * `prefers-reduced-motion` turns into a static ring; the badges and the
 * fail stroke carry no motion at all.
 */
function stateStyle(): string {
  return (
    `.plate-svg .state-ring{fill:none;stroke:var(--canopy,#00a9a0);stroke-width:.7;opacity:.9;` +
    `animation:plate-ring-pulse 1.6s ease-in-out infinite}` +
    `@keyframes plate-ring-pulse{0%,100%{opacity:1}50%{opacity:.3}}` +
    `@media (prefers-reduced-motion:reduce){.plate-svg .state-ring{animation:none}}` +
    `.plate-svg .state-fail .shape,.plate-svg .state-fail .member-shape{stroke:#ff6b6b}` +
    `.plate-svg .state-badge-bg{fill:#04110f;stroke:none;opacity:.9}` +
    `.plate-svg .state-badge-mark{fill:none;stroke-width:.9;stroke-linecap:round;stroke-linejoin:round}` +
    `.plate-svg .state-pass .state-badge-mark{stroke:var(--canopy,#00a9a0)}` +
    `.plate-svg .state-fail .state-badge-mark{stroke:#ff6b6b}`
  );
}

/**
 * The walk's lighting rules, appended only when the walk actually rode a
 * fail edge: the lit twin copies the fail edge's red dash at a thicker
 * stroke, and `prefers-reduced-motion` hides it whole — SMIL ignores
 * media queries, so hiding the twin is what keeps the resting plate
 * exactly like today's under reduce. Without a ridden fail edge the
 * stylesheet stays byte-identical to the plain plate's.
 */
function litStyle(): string {
  return (
    `.plate-svg .edge-lit{fill:none;stroke:#ff6b6b;stroke-width:.8;stroke-dasharray:1.4 1.1}` +
    `@media (prefers-reduced-motion:reduce){.plate-svg .edge-lit{display:none}}`
  );
}

const EDGE_ORDER = { error: 0, order: 1, pass: 2, fail: 3 } as const;

/**
 * The lit twin of a fail edge the walk rode: the same dashed curve a
 * touch brighter and thicker, carrying a discrete SMIL opacity animation
 * that lights it exactly while the walker rides its legs — one window
 * per leg, as many as the walk crossed the edge. The twin rides beside
 * the base edge, never in its place, so the static drawing stays whole.
 */
function renderLitEdge(edge: PlacedEdge, legs: number[], total: number, seconds: number): string {
  const values: string[] = [];
  const keyTimes: string[] = [];
  for (let index = 0; index <= total; index += 1) {
    keyTimes.push(String(Math.round((index / total) * 10000) / 10000));
    values.push(index < total && legs.includes(index) ? "1" : "0");
  }
  return (
    `<path class="edge-lit" d="${edge.d}" ` +
    `data-from="${escape(edge.from)}" data-to="${escape(edge.to)}" data-lit>` +
    `<animate attributeName="opacity" calcMode="discrete" values="${values.join(";")}" ` +
    `keyTimes="${keyTimes.join(";")}" dur="${seconds}s" repeatCount="indefinite"/>` +
    `</path>`
  );
}

function renderEdges(layout: PlateLayout): string {
  const litOf = new Map(layout.walkFails.map((lit) => [`${lit.from}→${lit.to}`, lit.legs]));
  const total = Math.round(layout.walkSeconds / STEP_SECONDS);
  const edges = [...layout.edges].sort(
    (a, b) =>
      EDGE_ORDER[a.cls] - EDGE_ORDER[b.cls] ||
      (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
  );
  return edges
    .map((edge) => {
      const base =
        `<path class="edge ${edge.cls}" d="${edge.d}" ` +
        `data-from="${escape(edge.from)}" data-to="${escape(edge.to)}"/>`;
      const legs = edge.cls === "fail" ? litOf.get(`${edge.from}→${edge.to}`) : undefined;
      return legs === undefined || legs.length === 0 || total <= 0
        ? base
        : base + renderLitEdge(edge, legs, total, layout.walkSeconds);
    })
    .join("");
}

/** The `--nc` accent of a harness stem, as a style attribute or nothing. */
function harnessStyle(harness: string | null): string {
  const color = harnessColor(harness);
  return color === null ? "" : ` style="--nc:${color}"`;
}

/** The small corner badge: a dark disc under a check or a cross. */
function renderBadge(mark: Mark, cx: number, cy: number): string {
  const d = mark.status === "pass"
    ? `M${num2(cx - 1.2)} ${num2(cy + 0.1)}l0.8 0.8l1.6 -1.8`
    : `M${num2(cx - 0.9)} ${num2(cy - 0.9)}l1.8 1.8M${num2(cx + 0.9)} ${num2(cy - 0.9)}l-1.8 1.8`;
  return (
    `<g class="state-badge">` +
    `<circle class="state-badge-bg" cx="${num2(cx)}" cy="${num2(cy)}" r="2.2"/>` +
    `<path class="state-badge-mark" d="${d}"/>` +
    `</g>`
  );
}

/** The lit unit's pulsing ring; static when motion is reduced. */
function renderRing(cx: number, cy: number, r: number): string {
  return `<circle class="state-ring" cx="${num2(cx)}" cy="${num2(cy)}" r="${num2(r)}"/>`;
}

function renderMember(
  groupName: string,
  member: PlacedMember,
  index: number,
  mark: Mark | null,
): string {
  const harness = member.harness === null
    ? ""
    : `<text class="harness" x="${member.x}" y="${member.y}" dy="${MEMBER_HARNESS_DY}" text-anchor="middle">${escape(member.harness)}</text>`;
  const stateCls = mark === null ? "" : ` state-${mark.status}`;
  const stateData = mark === null ? "" : ` data-state="${mark.status}"`;
  const title = mark === null
    ? ""
    : `<title>${escape(member.label)} — ${STATE_WORD[mark.status]}</title>`;
  const ring = mark?.lit === true
    ? renderRing(member.x, member.y, Math.max(MEMBER_GEOM.w, MEMBER_GEOM.h) / 2 + 1.7)
    : "";
  const badge = mark !== null && mark.status !== "running"
    ? renderBadge(mark, member.x + MEMBER_GEOM.w / 2, member.y - MEMBER_GEOM.h / 2)
    : "";
  return (
    `<g class="member${stateCls}" data-name="${escape(groupName)}" data-i="${index + 1}" ` +
    `data-cx="${member.x}" data-cy="${member.y}"${stateData}${harnessStyle(member.harness)}>` +
    title +
    `<rect class="member-shape" x="${member.x - MEMBER_GEOM.w / 2}" y="${member.y - MEMBER_GEOM.h / 2}" ` +
    `width="${MEMBER_GEOM.w}" height="${MEMBER_GEOM.h}" rx="1"/>` +
    ring +
    `<text class="member-label" x="${member.x}" y="${member.y}" dy="0.7">${escape(member.label)}</text>` +
    harness +
    badge +
    `</g>`
  );
}

function renderGroups(layout: PlateLayout, state: PlateState | undefined): string {
  return layout.groups
    .map((group) => {
      const members = group.members
        .map((member, index) =>
          renderMember(group.name, member, index, markOf(state, [member.label, `${group.name}#${index + 1}`])),
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

function renderNode(node: PlacedNode, orientation: Orientation, mark: Mark | null): string {
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
  // With a state the title names the state — the palette alone cannot tell
  // passed from failed — without one it keeps reading like the catalogue's.
  const title = mark === null
    ? `<title>${escape(node.name)} (${escape(node.docKind)})</title>`
    : `<title>${escape(node.name)} — ${STATE_WORD[mark.status]}</title>`;
  const stateCls = mark === null ? "" : ` state-${mark.status}`;
  const stateData = mark === null ? "" : ` data-state="${mark.status}"`;
  const ring = mark?.lit === true
    ? renderRing(node.x, node.y, Math.max(geom.w, geom.h) / 2 + 2.2)
    : "";
  const badge = mark !== null && mark.status !== "running"
    ? renderBadge(mark, node.x + geom.w / 2, node.y - geom.h / 2)
    : "";
  return (
    `<g class="node shape-${node.shape}${stateCls}" data-name="${escape(node.name)}" ` +
    `data-cx="${node.x}" data-cy="${node.y}" data-w="${node.w}" data-h="${node.h}" ` +
    `data-rank="${node.rank}" data-lane="${node.infra ? "infra" : "main"}"${stateData}${dataHarness}${harnessStyle(node.harness)}>` +
    title +
    `<rect class="shape" x="${node.x - geom.w / 2}" y="${node.y - geom.h / 2}" ` +
    `width="${geom.w}" height="${geom.h}" rx="${geom.rx}"${rotate}/>` +
    ring +
    label +
    harness +
    badge +
    `</g>`
  );
}

/** Round to two decimals so label positions print without float noise. */
function num2(value: number): number {
  return Math.round(value * 100) / 100;
}

function renderNodes(layout: PlateLayout, state: PlateState | undefined): string {
  return layout.nodes
    .map((node) => renderNode(node, layout.orientation, markOf(state, [node.name])))
    .join("");
}

/**
 * Where the token stops under a state: `current`, else the first unit the
 * map calls running, resolved against the drawn nodes and then the drawn
 * ensemble members. Null when the name is not on the drawing at all.
 */
function litPoint(layout: PlateLayout, state: PlateState): { x: number; y: number } | null {
  const key = state.current ?? Object.keys(state.nodes).find((name) => state.nodes[name] === "running");
  if (key === undefined) {
    return null;
  }
  const node = layout.nodes.find((placed) => placed.name === key);
  if (node !== undefined) {
    return { x: node.x, y: node.y };
  }
  for (const group of layout.groups) {
    for (const [index, member] of group.members.entries()) {
      if (member.label === key || `${group.name}#${index + 1}` === key) {
        return { x: member.x, y: member.y };
      }
    }
  }
  return null;
}

function renderToken(layout: PlateLayout, state: PlateState | undefined): string {
  // With a state the token stops on the running unit; without one it walks
  // the whole chain like the catalogue's plate.
  if (state !== undefined) {
    const at = litPoint(layout, state);
    return at === null
      ? ""
      : `<circle class="token" r="1.1" cx="${num2(at.x)}" cy="${num2(at.y)}"/>`;
  }
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

function renderLayout(layout: PlateLayout, state: PlateState | undefined): string {
  const ensembles = layout.groups.map((group) => group.name);
  const parts = [
    layout.order.length === 0 ? null : `Nodes in order: ${layout.order.join(", ")}.`,
    ensembles.length === 0 ? null : `Ensembles: ${ensembles.join(", ")}.`,
  ].filter((part) => part !== null);
  const desc = parts.join(" ");
  const cls = layout.orientation === "vertical" ? "plate-svg plate-v" : "plate-svg plate-h";
  // The overlays' CSS rides only on a stateful or a fail-lit render: a
  // plain plate stays byte-identical to the catalogue's own drawing.
  const style =
    plateStyle() +
    (state === undefined ? "" : stateStyle()) +
    (layout.walkFails.length === 0 ? "" : litStyle());
  return (
    `<svg class="${cls}" viewBox="0 0 ${layout.width} ${layout.height}" ` +
    `width="${Math.round(layout.width * PLATE_SCALE)}" height="${Math.round(layout.height * PLATE_SCALE)}" ` +
    `role="img" xmlns="http://www.w3.org/2000/svg">` +
    `<title>${escape(layout.name)}</title>` +
    `<desc>${escape(desc)}</desc>` +
    `<style>${style}</style>` +
    `<g class="edges">${renderEdges(layout)}</g>` +
    `<g class="groups">${renderGroups(layout, state)}</g>` +
    `<g class="nodes">${renderNodes(layout, state)}</g>` +
    renderToken(layout, state) +
    `</svg>`
  );
}

/**
 * Render a graph document as a self-contained Canopy plate, horizontal
 * (ranks left to right) or vertical (ranks top to bottom). An unreadable
 * document draws nothing: the pages only ever pass validated graphs.
 *
 * The optional state overlays a live run on the same drawing: running and
 * current units get a pulsing teal ring (static under reduced motion) with
 * the token stopped on them, passed units a check badge, failed ones a red
 * cross badge and a red stroke, and every marked unit a `<title>` naming
 * its state. Without the state the output is byte-identical to the plain
 * plate.
 *
 * The optional `random` decides the animated walk's fail edges: at a unit
 * carrying one, a draw below FAIL_CHANCE rides it, at most FAIL_CAP per
 * walk, and the ridden edge lights while the walker is on it. The default
 * draw never fails a unit — the pure happy path — so a caller that passes
 * none keeps the old walk, byte for byte.
 */
export function renderPlate(
  document: GraphDocument,
  orientation: Orientation = "horizontal",
  state?: PlateState,
  random: () => number = happyRandom,
): string {
  const layout =
    orientation === "vertical"
      ? layoutPlateVertical(document, random)
      : layoutPlate(document, random);
  return layout === null ? "" : renderLayout(layout, state);
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
