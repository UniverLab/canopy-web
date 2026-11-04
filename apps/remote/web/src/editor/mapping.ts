// SPDX-License-Identifier: Apache-2.0
/**
 * The document boundary: a graph document (format v6) becomes editor
 * state with fixed endpoints and editable ensembles, and back again.
 *
 * - `spec` exports as the graph's Start check node
 *   (`{command: "true"}`, position 1); its outgoing edges leave from
 *   Start. On import, Start becomes `spec`.
 * - An edge into `next` is never exported: a node whose pass leads to
 *   `next` simply has no outgoing pass edge, which is how canopy ends a
 *   spec. On import, every node with no outgoing pass or always edge
 *   gets a pass edge to `next`.
 * - Ensembles export in the document's `ensembles` shape: the shared
 *   prompt is `prompt_template`, member overrides ride as
 *   `prompt_override`, incoming edges are the entry sources, and the
 *   pass and fail exits are `on_pass_to` and `on_fail_to`.
 *
 * `exportGraph` assumes the app's gate held (Export stays disabled while
 * any problem stands); ensembles without entry or pass exit are left
 * out rather than written half-wired, so the function never emits a
 * document the validator refuses.
 */
import { isNodeKind } from "../../../../graphs/src/editor/kinds.js";
import { levelsOf, positionsOf } from "../../../../graphs/src/editor/order.js";
import { SLUG_RE } from "../../../../graphs/src/lib.js";
import { documentProblems, harnessProblems } from "../../../../graphs/src/validate.js";
import {
  isArray,
  isNumber,
  isRecord,
  isString,
} from "../../../../../packages/plate/guards.js";
import type { JsonValue } from "../../../../../src/schema.js";
import {
  blankEditorState,
  ENSEMBLE_MAX,
  ENSEMBLE_MIN,
  isEnsembleKind,
  isFixedId,
  NEXT_ID,
  SPEC_ID,
  uniqueEditorName,
  newEditorId,
  type EditorEdge,
  type EditorEnsemble,
  type EditorNode,
  type EditorState,
} from "./state.js";

/** The problems panel's words for the two fixed-endpoint failures. */
export const SPEC_PROBLEM = "spec is not connected";
export const NEXT_PROBLEM = "nothing reaches next";

/** The exported Start node: the graph's fixed entry. */
export const START_NAME = "Start";
export const START_COMMAND = "true";

/** The import refusals, over the validator's own detail. */
export const IMPORT_BAD = "That text is not a JSON graph document.";
export const IMPORT_HARNESS =
  "That document binds a harness: shared documents never carry platform, model or cli — " +
  "the person who installs chooses the harnesses.";

/** Column and row steps for an imported document's initial layout (world px). */
export const IMPORT_DX = 360;
export const IMPORT_PAD_X = 380;
export const IMPORT_PAD_Y = 100;
export const IMPORT_ROW_DY = 150;

/** Ensemble keys the inspector edits; everything else rides in `extra`. */
const EDITED_ENSEMBLE_KEYS = new Set([
  "name",
  "kind",
  "commit_rights",
  "prompt_template",
  "entry_from_node",
  "entry_condition",
  "extra_entry_sources",
  "on_pass_to",
  "on_fail_to",
  "min_pass",
  "timeout_minutes",
  "members",
]);

/** Top-level keys the editor edits; everything else is kept verbatim. */
const EDITED_KEYS = new Set([
  "format_version",
  "name",
  "description",
  "nodes",
  "edges",
  "ensembles",
]);

/** True when the text satisfies the slug rule node and graph names follow. */
export function isEditorSlug(text: string): boolean {
  return SLUG_RE.test(text);
}

/** True when the condition is `fail` — the one class that never ranks. */
export function isFailCondition(condition: JsonValue): boolean {
  return condition === "fail";
}

/** True when the condition ends a spec on its own: `pass` or `always`. */
function isEndingCondition(condition: JsonValue): boolean {
  return condition === "pass" || condition === "always";
}

/**
 * The fixed-endpoint problems: `spec` without an outgoing edge, and no
 * path from `spec` to `next` along any edges, ensembles included.
 */
export function flowProblems(state: EditorState): string[] {
  const found: string[] = [];
  if (!state.edges.some((edge) => edge.from === SPEC_ID)) {
    found.push(SPEC_PROBLEM);
  }
  const seen = new Set<string>([SPEC_ID]);
  const queue = [SPEC_ID];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const edge of state.edges) {
      if (edge.from === current && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  if (!seen.has(NEXT_ID)) {
    found.push(NEXT_PROBLEM);
  }
  return found;
}

/**
 * The ensemble problems: unwired entries and pass exits, and names the
 * document cannot carry twice. Export stays disabled while any stands.
 */
export function ensembleProblems(state: EditorState): string[] {
  const found: string[] = [];
  const taken = new Map<string, number>();
  for (const node of state.nodes) {
    if (!isFixedId(node.id)) {
      taken.set(node.name, (taken.get(node.name) ?? 0) + 1);
    }
  }
  for (const ensemble of state.ensembles) {
    taken.set(ensemble.name, (taken.get(ensemble.name) ?? 0) + 1);
    if (!state.edges.some((edge) => edge.to === ensemble.id)) {
      found.push(`ensemble ${ensemble.name} is not connected`);
    }
    const passExit = state.edges.some(
      (edge) => edge.from === ensemble.id && edge.condition === "pass" && edge.to !== NEXT_ID,
    );
    if (!passExit) {
      found.push(`ensemble ${ensemble.name} has no pass exit`);
    }
  }
  for (const [name, count] of taken) {
    if (count > 1) {
      found.push(`duplicate name ${name}`);
    }
  }
  return found;
}

/** Every problem that blocks Export: flow, ensembles, schema, harness. */
export function exportProblems(state: EditorState): string[] {
  const document = exportGraph(state);
  const schema = [...documentProblems("graph", document), ...harnessProblems("graph", document)];
  return [
    ...flowProblems(state),
    ...ensembleProblems(state),
    ...schema.map((problem) => `${problem.path}: ${problem.message}`),
  ];
}

/** Resolve an endpoint id to its exported wiring target. */
function targetOf(
  state: EditorState,
  id: string,
  byId: ReadonlyMap<string, EditorNode>,
  ensById: ReadonlyMap<string, EditorEnsemble>,
): JsonValue | null {
  if (id === SPEC_ID) {
    return START_NAME;
  }
  const node = byId.get(id);
  if (node !== undefined && !isFixedId(node.id)) {
    return node.name;
  }
  const ensemble = ensById.get(id);
  if (ensemble !== undefined) {
    return { ensemble: ensemble.name };
  }
  return null;
}

/**
 * Write the state back as a graph document. Start rides at position 1;
 * edges into `next` are dropped; ensembles carry their wiring.
 */
export function exportGraph(state: EditorState): Record<string, JsonValue> {
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const ensById = new Map(state.ensembles.map((ensemble) => [ensemble.id, ensemble]));
  const memberOf = new Set<string>();
  for (const ensemble of state.ensembles) {
    for (const member of ensemble.members) {
      memberOf.add(member);
    }
  }
  const plain = state.nodes.filter((node) => !isFixedId(node.id) && !memberOf.has(node.id));

  // Plain edges first: endpoints by name, ensemble wiring set aside.
  const edges: JsonValue[] = [];
  const rankEdges: Array<{ from: string; to: string }> = [];
  for (const edge of state.edges) {
    if (edge.to === NEXT_ID || edge.from === NEXT_ID || edge.to === SPEC_ID) {
      continue;
    }
    if (memberOf.has(edge.from) || memberOf.has(edge.to)) {
      continue;
    }
    if (ensById.has(edge.from) || ensById.has(edge.to)) {
      continue;
    }
    const from = edge.from === SPEC_ID ? START_NAME : byId.get(edge.from)?.name;
    const to = byId.get(edge.to)?.name;
    if (from === undefined || to === undefined) {
      continue;
    }
    edges.push({ from_node: from, to_node: to, condition: edge.condition });
    if (!isFailCondition(edge.condition)) {
      rankEdges.push({ from: edge.from, to: edge.to });
    }
  }

  // Positions: Start leads at 1, the rest follow the Kahn rank order.
  const orderNodes = [
    { id: SPEC_ID, x: -100_000, y: 0 },
    ...plain.map((node) => ({ id: node.id, x: node.x, y: node.y })),
  ];
  const ranks = positionsOf(orderNodes, rankEdges);
  const ordered = [...plain].sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
  const nodes: JsonValue[] = [
    { name: START_NAME, kind: "check", position: 1, config: { command: START_COMMAND } },
    ...ordered.map((node, index) => ({
      name: node.name,
      kind: node.kind,
      position: index + 2,
      config: node.config,
    })),
  ];

  // Ensembles, in canvas order; a half-wired one stays out entirely.
  const ensembles: JsonValue[] = [];
  const sorted = [...state.ensembles].sort((a, b) => a.x - b.x || a.y - b.y);
  for (const ensemble of sorted) {
    const incoming = state.edges.filter((edge) => edge.to === ensemble.id);
    const exits = state.edges.filter((edge) => edge.from === ensemble.id);
    const passTo = exits.find((edge) => edge.condition === "pass" && edge.to !== NEXT_ID);
    const failTo = exits.find((edge) => edge.condition === "fail" && edge.to !== NEXT_ID);
    const first = incoming[0];
    const entryTarget = first === undefined ? null : targetOf(state, first.from, byId, ensById);
    const passTarget =
      passTo === undefined ? null : targetOf(state, passTo.to, byId, ensById);
    if (first === undefined || entryTarget === null || passTo === undefined || passTarget === null) {
      continue;
    }
    const extra: JsonValue[] = [];
    for (const edge of incoming.slice(1)) {
      const target = targetOf(state, edge.from, byId, ensById);
      if (typeof target === "string") {
        extra.push({ from_node: target, condition: edge.condition });
      }
    }
    const failTarget =
      failTo === undefined ? null : targetOf(state, failTo.to, byId, ensById);
    const members: JsonValue[] = ensemble.members.map((id) => {
      const member: Record<string, JsonValue> = {};
      const override = ensemble.overrides[id];
      if (override !== undefined && override !== "") {
        member["prompt_override"] = override;
      }
      const timeout = ensemble.memberTimeouts[id];
      if (timeout !== undefined) {
        member["timeout_minutes"] = timeout;
      }
      return member;
    });
    ensembles.push({
      name: ensemble.name,
      kind: ensemble.kind,
      commit_rights: ensemble.commit_rights,
      prompt_template: ensemble.prompt,
      entry_from_node: entryTarget,
      entry_condition: first.condition,
      extra_entry_sources: extra,
      on_pass_to: passTarget,
      ...(failTarget === null ? {} : { on_fail_to: failTarget }),
      min_pass: ensemble.min_pass,
      timeout_minutes: ensemble.timeout_minutes,
      ...ensemble.extra,
      members,
    });
  }

  return {
    format_version: 6,
    name: state.name,
    description: state.description,
    nodes,
    edges,
    ...(ensembles.length === 0 ? {} : { ensembles }),
    ...state.sections,
  };
}

/** A refusal: the head line, then each problem as `path: message`. */
function refusalText(head: string, problems: Array<{ path: string; message: string }>): string {
  const detail = problems
    .slice(0, 3)
    .map((problem) => `${problem.path}: ${problem.message}`)
    .join(" · ");
  return detail === "" ? head : `${head} ${detail}`;
}

/** Slug-ify free text for a synthesized member name. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "member" : slug;
}

/**
 * Read a graph document into editor state. Start becomes `spec`, every
 * node without an outgoing pass or always edge gains a pass edge to
 * `next`, and ensembles arrive editable with their wiring.
 */
export function importGraph(document: unknown): { state: EditorState } | { error: string } {
  if (!isRecord(document)) {
    return { error: IMPORT_BAD };
  }
  const harness = harnessProblems("graph", document);
  if (harness.length > 0) {
    return { error: refusalText(IMPORT_HARNESS, harness) };
  }
  const schema = documentProblems("graph", document);
  if (schema.length > 0) {
    return { error: refusalText(IMPORT_BAD, schema) };
  }

  const state = blankEditorState();
  state.name = isString(document["name"]) ? document["name"] : state.name;
  state.description = isString(document["description"]) ? document["description"] : "";
  for (const [key, section] of Object.entries(document)) {
    if (!EDITED_KEYS.has(key)) {
      state.sections[key] = section;
    }
  }

  // Nodes in document order, Start aside for `spec`.
  const taken = new Set(["spec", "next"]);
  const rawNodes = isArray(document["nodes"]) ? document["nodes"] : [];
  const idOf = new Map<string, string>([
    [START_NAME, SPEC_ID],
    [START_NAME.toLowerCase(), SPEC_ID],
  ]);
  const startEdges: Array<{ to: string; condition: JsonValue }> = [];
  let startTaken = false;
  const rawEdges = isArray(document["edges"]) ? document["edges"] : [];
  for (const entry of rawNodes) {
    if (!isRecord(entry) || !isString(entry["name"]) || !isNodeKind(entry["kind"])) {
      continue; // unreachable: the schema check above guarantees both
    }
    if (entry["name"].toLowerCase() === START_NAME.toLowerCase() && !startTaken) {
      startTaken = true;
      for (const edge of rawEdges) {
        if (isRecord(edge) && edge["from_node"] === entry["name"] && isString(edge["to_node"])) {
          startEdges.push({ to: edge["to_node"], condition: edge["condition"] ?? "pass" });
        }
      }
      idOf.set(entry["name"], SPEC_ID);
      continue;
    }
    const name = uniqueEditorName(entry["name"], taken);
    taken.add(name);
    const node: EditorNode = {
      id: newEditorId(),
      name,
      kind: entry["kind"],
      config: isRecord(entry["config"]) ? { ...entry["config"] } : {},
      x: 0,
      y: 0,
    };
    state.nodes.push(node);
    if (!idOf.has(entry["name"])) {
      idOf.set(entry["name"], node.id);
    }
  }

  // Ensembles with their members as grouped agent nodes.
  const rawEnsembles = isArray(document["ensembles"]) ? document["ensembles"] : [];
  const ensOf = new Map<string, string>();
  for (const entry of rawEnsembles) {
    if (!isRecord(entry) || !isString(entry["name"])) {
      continue;
    }
    const rawMembers = isArray(entry["members"]) ? entry["members"] : [];
    const name = uniqueEditorName(entry["name"], taken);
    taken.add(name);
    const ensemble: EditorEnsemble = {
      id: newEditorId(),
      name,
      kind: isEnsembleKind(entry["kind"]) ? entry["kind"] : "parallel",
      min_pass: isNumber(entry["min_pass"]) ? entry["min_pass"] : Math.max(rawMembers.length, 1),
      prompt: isString(entry["prompt_template"]) ? entry["prompt_template"] : "",
      overrides: {},
      memberTimeouts: {},
      members: [],
      commit_rights: entry["commit_rights"] === true,
      timeout_minutes: isNumber(entry["timeout_minutes"]) ? entry["timeout_minutes"] : 30,
      extra: {},
      x: 0,
      y: 0,
    };
    for (const [key, value] of Object.entries(entry)) {
      if (!EDITED_ENSEMBLE_KEYS.has(key)) {
        ensemble.extra[key] = value;
      }
    }
    rawMembers.forEach((member, index) => {
      const memberName = uniqueEditorName(`${slugify(name)}-${index + 1}`, taken);
      taken.add(memberName);
      const node: EditorNode = {
        id: newEditorId(),
        name: memberName,
        kind: "agent",
        config: {},
        x: 0,
        y: 0,
      };
      state.nodes.push(node);
      ensemble.members.push(node.id);
      if (isRecord(member)) {
        if (isString(member["prompt_override"]) && member["prompt_override"] !== "") {
          ensemble.overrides[node.id] = member["prompt_override"];
        }
        if (isNumber(member["timeout_minutes"])) {
          ensemble.memberTimeouts[node.id] = member["timeout_minutes"];
        }
      }
    });
    state.ensembles.push(ensemble);
    if (!ensOf.has(entry["name"])) {
      ensOf.set(entry["name"], ensemble.id);
    }
  }

  // A wiring target as an endpoint id: nodes plain, ensembles by id.
  const targetId = (target: JsonValue | undefined): string | null => {
    if (isString(target)) {
      return idOf.get(target) ?? ensOf.get(target) ?? null;
    }
    if (isRecord(target) && isString(target["ensemble"])) {
      return ensOf.get(target["ensemble"]) ?? null;
    }
    return null;
  };

  // Plain edges, Start's leaving from `spec`.
  const plainEdges: Array<{ from: string; to: string; condition: JsonValue }> = [];
  for (const edge of rawEdges) {
    if (!isRecord(edge) || !isString(edge["from_node"]) || !isString(edge["to_node"])) {
      continue;
    }
    const from = idOf.get(edge["from_node"]);
    const to = idOf.get(edge["to_node"]);
    if (from === undefined || to === undefined || from === SPEC_ID || to === SPEC_ID) {
      continue;
    }
    if (from === to) {
      continue;
    }
    plainEdges.push({ from, to, condition: edge["condition"] ?? "pass" });
  }
  for (const edge of startEdges) {
    const to = idOf.get(edge.to) ?? ensOf.get(edge.to);
    if (to !== undefined && to !== SPEC_ID) {
      plainEdges.push({ from: SPEC_ID, to, condition: edge.condition });
    }
  }

  // Ensemble wiring: entries in, quorum exits out.
  const wiring: Array<{ from: string; to: string; condition: JsonValue }> = [];
  rawEnsembles.forEach((entry) => {
    if (!isRecord(entry) || !isString(entry["name"])) {
      return;
    }
    const id = ensOf.get(entry["name"]);
    if (id === undefined) {
      return;
    }
    const from = targetId(entry["entry_from_node"]);
    if (from !== null && from !== SPEC_ID) {
      wiring.push({ from, to: id, condition: entry["entry_condition"] ?? "pass" });
    } else if (from === SPEC_ID) {
      wiring.push({ from: SPEC_ID, to: id, condition: entry["entry_condition"] ?? "pass" });
    }
    const extra = entry["extra_entry_sources"];
    if (isArray(extra)) {
      for (const source of extra) {
        if (!isRecord(source) || !isString(source["from_node"])) {
          continue;
        }
        const extraFrom = targetId(source["from_node"]);
        if (extraFrom !== null) {
          wiring.push({ from: extraFrom, to: id, condition: source["condition"] ?? "pass" });
        }
      }
    }
    const passTo = targetId(entry["on_pass_to"]);
    if (passTo !== null && passTo !== SPEC_ID) {
      wiring.push({ from: id, to: passTo, condition: "pass" });
    }
    const failTo = entry["on_fail_to"] === undefined ? null : targetId(entry["on_fail_to"]);
    if (failTo !== null && failTo !== SPEC_ID) {
      wiring.push({ from: id, to: failTo, condition: "fail" });
    }
  });

  for (const edge of [...plainEdges, ...wiring]) {
    state.edges.push({ id: newEditorId(), ...edge });
  }

  // Every node without an outgoing pass or always edge ends at `next`.
  const plainIds = new Set(
    state.nodes.filter((node) => !isFixedId(node.id)).map((node) => node.id),
  );
  const memberIds = new Set(state.ensembles.flatMap((ensemble) => ensemble.members));
  for (const id of plainIds) {
    if (memberIds.has(id)) {
      continue;
    }
    const leads = state.edges.some(
      (edge) => edge.from === id && isEndingCondition(edge.condition),
    );
    if (!leads) {
      state.edges.push({ id: newEditorId(), from: id, to: NEXT_ID, condition: "pass" });
    }
  }

  layoutImported(state);
  return { state };
}

/**
 * Lay an imported document out in columns by level over the non-fail
 * edges, ensembles as units beside the nodes; `next` lands right of
 * everything, `spec` stays left.
 */
function layoutImported(state: EditorState): void {
  const memberIds = new Set(state.ensembles.flatMap((ensemble) => ensemble.members));
  const units = state.nodes.filter((node) => !isFixedId(node.id) && !memberIds.has(node.id));
  const orderNodes = [
    ...units.map((node, index) => ({ id: node.id, x: index, y: 0 })),
    ...state.ensembles.map((ensemble, index) => ({
      id: ensemble.id,
      x: units.length + index,
      y: 0,
    })),
  ];
  const known = new Set(orderNodes.map((node) => node.id));
  const rankEdges = state.edges
    .filter(
      (edge) =>
        !isFailCondition(edge.condition) &&
        known.has(edge.from) &&
        known.has(edge.to),
    )
    .map((edge) => ({ from: edge.from, to: edge.to }));
  const level = levelsOf(orderNodes, rankEdges);
  const cursor = new Map<number, number>();
  const place = (column: number, slot: number): number => {
    const y = cursor.get(column) ?? IMPORT_PAD_Y;
    cursor.set(column, y + slot);
    return y;
  };
  for (const node of units) {
    const column = level.get(node.id) ?? 0;
    node.x = IMPORT_PAD_X + column * IMPORT_DX;
    node.y = place(column, IMPORT_ROW_DY);
  }
  for (const ensemble of state.ensembles) {
    const column = level.get(ensemble.id) ?? 0;
    ensemble.x = IMPORT_PAD_X + column * IMPORT_DX;
    ensemble.y = place(column, 120 + ensemble.members.length * 84);
  }
  const next = state.nodes.find((node) => node.id === NEXT_ID);
  if (next !== undefined) {
    const rightmost = Math.max(
      IMPORT_PAD_X,
      ...units.map((node) => node.x),
      ...state.ensembles.map((ensemble) => ensemble.x),
    );
    next.x = rightmost + IMPORT_DX;
    next.y = 260;
  }
}

/**
 * Group 2–8 agent nodes as an ensemble. Incoming edges to the members
 * move to the ensemble (exact duplicates collapse to one); member exits
 * and inner edges go, since the ensemble owns the exits now.
 */
export function makeEnsemble(
  state: EditorState,
  memberIds: string[],
): { ensemble: EditorEnsemble } | { error: string } {
  const distinct = [...new Set(memberIds)];
  if (distinct.length < ENSEMBLE_MIN || distinct.length > ENSEMBLE_MAX) {
    return { error: `An ensemble needs ${ENSEMBLE_MIN}–${ENSEMBLE_MAX} agent nodes.` };
  }
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const grouped = new Set(state.ensembles.flatMap((ensemble) => ensemble.members));
  for (const id of distinct) {
    const node = byId.get(id);
    if (node === undefined || node.kind !== "agent" || isFixedId(id) || grouped.has(id)) {
      return { error: "An ensemble needs 2–8 agent nodes standing outside any ensemble." };
    }
  }
  const members = distinct
    .map((id) => byId.get(id))
    .filter((node): node is EditorNode => node !== undefined);
  const taken = new Set([
    ...state.nodes.map((node) => node.name),
    ...state.ensembles.map((ensemble) => ensemble.name),
  ]);
  const ensemble: EditorEnsemble = {
    id: newEditorId(),
    name: uniqueEditorName("ensemble", taken),
    kind: "parallel",
    min_pass: 1,
    prompt: "",
    overrides: {},
    memberTimeouts: {},
    members: distinct,
    commit_rights: false,
    timeout_minutes: 30,
    extra: {},
    x: Math.round(members.reduce((sum, node) => sum + node.x, 0) / members.length),
    y: Math.round(members.reduce((sum, node) => sum + node.y, 0) / members.length),
  };
  const inside = new Set(distinct);
  const seen = new Set<string>();
  const edges: EditorEdge[] = [];
  for (const edge of state.edges) {
    if (inside.has(edge.from)) {
      continue;
    }
    if (inside.has(edge.to)) {
      const key = `${edge.from} ${JSON.stringify(edge.condition)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({ ...edge, id: newEditorId(), to: ensemble.id });
      continue;
    }
    edges.push(edge);
  }
  state.edges = edges;
  state.ensembles.push(ensemble);
  return { ensemble };
}

/**
 * Remove a node and every edge touching it. A member leaves its
 * ensemble; an ensemble left with fewer than 2 members dissolves and
 * its survivors stand alone again.
 */
export function removeEditorNode(state: EditorState, id: string): { dissolved: string | null } {
  if (isFixedId(id)) {
    return { dissolved: null };
  }
  state.nodes = state.nodes.filter((node) => node.id !== id);
  state.edges = state.edges.filter((edge) => edge.from !== id && edge.to !== id);
  for (const ensemble of state.ensembles) {
    if (!ensemble.members.includes(id)) {
      continue;
    }
    ensemble.members = ensemble.members.filter((member) => member !== id);
    delete ensemble.overrides[id];
    delete ensemble.memberTimeouts[id];
    if (ensemble.members.length < ENSEMBLE_MIN) {
      dissolveEnsemble(state, ensemble.id);
      return { dissolved: ensemble.name };
    }
  }
  return { dissolved: null };
}

/**
 * Dissolve an ensemble: its edges go and its members stand alone again,
 * laid out in a row where the box stood. Answers the dissolved name.
 */
export function dissolveEnsemble(state: EditorState, id: string): string | null {
  const ensemble = state.ensembles.find((entry) => entry.id === id);
  if (ensemble === undefined) {
    return null;
  }
  state.ensembles = state.ensembles.filter((entry) => entry.id !== id);
  state.edges = state.edges.filter((edge) => edge.from !== id && edge.to !== id);
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  ensemble.members.forEach((member, index) => {
    const node = byId.get(member);
    if (node !== undefined) {
      node.x = ensemble.x - ((ensemble.members.length - 1) * 190) / 2 + index * 190;
      node.y = ensemble.y;
    }
  });
  return ensemble.name;
}

/** Connect two endpoints, collapsing an exact duplicate to the first edge. */
export function connectEditor(
  state: EditorState,
  from: string,
  to: string,
  condition: JsonValue,
): EditorEdge {
  const signature = JSON.stringify(condition);
  const existing = state.edges.find(
    (edge) => edge.from === from && edge.to === to && JSON.stringify(edge.condition) === signature,
  );
  if (existing !== undefined) {
    return existing;
  }
  const edge: EditorEdge = { id: newEditorId(), from, to, condition };
  state.edges.push(edge);
  return edge;
}

/** Remove one edge. */
export function removeEditorEdge(state: EditorState, id: string): void {
  state.edges = state.edges.filter((edge) => edge.id !== id);
}
