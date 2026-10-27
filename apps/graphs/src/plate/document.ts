// SPDX-License-Identifier: Apache-2.0
/**
 * The plate's documents: the graph (format v6) and node (format v1) shapes
 * the catalogue serves, read totally into the views the layout engine and
 * the markdown twin share. Unknown fields are skipped, never thrown on —
 * the pages only ever pass validated documents, and anything else simply
 * draws nothing.
 */
import { isArray, isNumber, isRecord, isString } from "../json.js";
import type { JsonValue } from "../../../../src/schema.js";
import type { Kind } from "./vocabulary.js";

/** A graph document as `renderPlate` takes it: the registry's format v6. */
export interface GraphDocument {
  name: string;
  nodes: GraphNodeDoc[];
  edges: GraphEdgeDoc[];
  ensembles?: EnsembleDoc[];
  infra_node?: string | null;
}

/** One node of a graph document. */
export interface GraphNodeDoc {
  name: string;
  kind: string;
  position: number;
  config: Record<string, JsonValue>;
}

/** One edge of a graph document. */
export interface GraphEdgeDoc {
  from_node: string;
  to_node: string;
  condition: JsonValue;
}

/** One ensemble wiring target: a node name or another ensemble's quorum. */
export type EnsembleTarget = string | { ensemble: string };

/** One ensemble of a graph document. */
export interface EnsembleDoc {
  name: string;
  kind?: string;
  min_pass?: number;
  members?: Array<Record<string, JsonValue>>;
  entry_from_node?: EnsembleTarget;
  entry_condition?: JsonValue;
  extra_entry_sources?: Array<{ from_node: string; condition: JsonValue }>;
  on_pass_to?: EnsembleTarget;
  on_fail_to?: EnsembleTarget;
}

/** One node document as `renderNodePlate` takes it: the catalogue's format v1. */
export interface NodeDocument {
  name: string;
  kind: string;
  config: Record<string, JsonValue>;
}

export type Strategy = "parallel" | "cascade" | "round_robin";

/** The class an edge draws with. */
export type EdgeClass = "pass" | "fail" | "error" | "order";

/** One parsed node: the name, kind, position and commit rights the plate needs. */
export interface NodeView {
  name: string;
  docKind: string;
  position: number;
  commitRights: boolean;
}

/** One parsed ensemble: its strategy, member labels and wiring. */
export interface EnsembleView {
  name: string;
  strategy: Strategy;
  minPass: number;
  members: string[];
  entryFrom: string | null;
  entryCondition: JsonValue;
  extraEntries: Array<{ from: string; condition: JsonValue }>;
  onPassTo: string | null;
  onFailTo: string | null;
}

/** One parsed edge: endpoints by name and the raw condition. */
export interface EdgeView {
  from: string;
  to: string;
  condition: JsonValue;
}

/** A graph document read into the views the plate draws. */
export interface ParsedGraph {
  name: string;
  nodes: NodeView[];
  edges: EdgeView[];
  ensembles: EnsembleView[];
  infra: string | null;
}

/** The routing classes that move a unit forward a rank. */
export function isRankCondition(condition: JsonValue): boolean {
  if (condition === "pass" || condition === "always") {
    return true;
  }
  return isRecord(condition) && isString(condition["route"]);
}

/** The class an edge condition draws with: routes read as pass, break as error. */
export function classOf(condition: JsonValue): EdgeClass {
  if (condition === "fail") {
    return "fail";
  }
  if (condition === "error" || condition === "break") {
    return "error";
  }
  return "pass";
}

/** A wiring target as a unit id: nodes plain, ensembles prefixed. */
export function targetId(target: JsonValue | EnsembleTarget | undefined): string | null {
  if (isString(target)) {
    return target;
  }
  if (isRecord(target) && isString(target["ensemble"])) {
    return `ensemble:${target["ensemble"]}`;
  }
  return null;
}

function strategyOf(kind: unknown): Strategy {
  return kind === "cascade" || kind === "round_robin" ? kind : "parallel";
}

/** A member chip label: its try order, plus its platform or model when known. */
function memberLabel(member: unknown, index: number): string {
  const numeral = String(index + 1);
  if (!isRecord(member)) {
    return numeral;
  }
  const platform = member["platform"];
  const model = member["model"];
  const tag = isString(platform) && platform !== ""
    ? platform
    : isString(model) && model !== ""
    ? model
    : "";
  return tag === "" ? numeral : `${numeral}·${tag.slice(0, 9)}`;
}

/**
 * The vocabulary shape a node draws as: commits are checks with commit
 * rights or a `Commit` name, chips are checks named `Start` or holding the
 * entry, routers read as gates.
 */
export function shapeOf(docKind: string, name: string, commitRights: boolean, isEntry: boolean): Kind {
  if (docKind === "check") {
    if (commitRights || name.startsWith("Commit")) {
      return "commit";
    }
    if (name.toLowerCase() === "start" || isEntry) {
      return "chip";
    }
    return "check";
  }
  if (docKind === "gate" || docKind === "router") {
    return "gate";
  }
  if (docKind === "agent") {
    return "agent";
  }
  return "check";
}

/** Read a graph document into views, or null when it is unreadable. */
export function parseDocument(document: unknown): ParsedGraph | null {
  if (!isRecord(document)) {
    return null;
  }
  const rawNodes = document["nodes"];
  const rawEdges = document["edges"];
  if (!isArray(rawNodes) || !isArray(rawEdges)) {
    return null;
  }
  const nodes: NodeView[] = [];
  for (const node of rawNodes) {
    if (!isRecord(node) || !isString(node["name"])) {
      continue;
    }
    const kind = node["kind"];
    const position = node["position"];
    const config = node["config"];
    nodes.push({
      name: node["name"],
      docKind: isString(kind) ? kind : "check",
      position: isNumber(position) ? position : 0,
      commitRights: isRecord(config) && config["commit_rights"] === true,
    });
  }
  const edges: EdgeView[] = [];
  for (const edge of rawEdges) {
    if (!isRecord(edge) || !isString(edge["from_node"]) || !isString(edge["to_node"])) {
      continue;
    }
    edges.push({ from: edge["from_node"], to: edge["to_node"], condition: edge["condition"] ?? null });
  }
  const ensembles: EnsembleView[] = [];
  const rawEnsembles = document["ensembles"];
  if (isArray(rawEnsembles)) {
    for (const ensemble of rawEnsembles) {
      if (!isRecord(ensemble) || !isString(ensemble["name"])) {
        continue;
      }
      const rawMembers = ensemble["members"];
      const members = isArray(rawMembers)
        ? rawMembers.map((member, index) => memberLabel(member, index))
        : [];
      const extraEntries: Array<{ from: string; condition: JsonValue }> = [];
      const rawExtra = ensemble["extra_entry_sources"];
      if (isArray(rawExtra)) {
        for (const source of rawExtra) {
          if (isRecord(source) && isString(source["from_node"])) {
            extraEntries.push({ from: source["from_node"], condition: source["condition"] ?? null });
          }
        }
      }
      ensembles.push({
        name: ensemble["name"],
        strategy: strategyOf(ensemble["kind"]),
        minPass: isNumber(ensemble["min_pass"]) ? ensemble["min_pass"] : members.length,
        members,
        entryFrom: targetId(ensemble["entry_from_node"]),
        entryCondition: ensemble["entry_condition"] ?? null,
        extraEntries,
        onPassTo: targetId(ensemble["on_pass_to"]),
        onFailTo: targetId(ensemble["on_fail_to"]),
      });
    }
  }
  if (nodes.length === 0 && ensembles.length === 0) {
    return null;
  }
  const infra = document["infra_node"];
  const infraName = isString(infra) && nodes.some((node) => node.name === infra) ? infra : null;
  const name = document["name"];
  return { name: isString(name) ? name : "graph", nodes, edges, ensembles, infra: infraName };
}

/** One route of a graph document, in words, for the markdown twin. */
export interface PlateRoute {
  from: string;
  to: string;
  via: string;
}

/** The text twin of a plate: nodes, ensembles and routes in document order. */
export interface PlateStructure {
  nodes: Array<{ name: string; kind: string }>;
  ensembles: Array<{ name: string; strategy: Strategy; members: number; minPass: number }>;
  routes: PlateRoute[];
}

/** A condition in words: pass, fail, always, error, break, or route:label. */
function viaOf(condition: JsonValue): string {
  if (isRecord(condition) && isString(condition["route"])) {
    return `route:${condition["route"]}`;
  }
  if (
    condition === "pass" ||
    condition === "fail" ||
    condition === "always" ||
    condition === "error" ||
    condition === "break"
  ) {
    return condition;
  }
  return "pass";
}

function wiringName(target: string): string {
  return target.startsWith("ensemble:") ? target.slice("ensemble:".length) : target;
}

/**
 * Read a graph document as text structure: node names with kinds, ensemble
 * names with strategies, and every route — edges in document order, then
 * each ensemble's entry and exit wiring. Null when unreadable.
 */
export function structureOf(document: unknown): PlateStructure | null {
  const parsed = parseDocument(document);
  if (parsed === null) {
    return null;
  }
  const routes: PlateRoute[] = parsed.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    via: viaOf(edge.condition),
  }));
  for (const ensemble of parsed.ensembles) {
    if (ensemble.entryFrom !== null) {
      routes.push({ from: wiringName(ensemble.entryFrom), to: ensemble.name, via: viaOf(ensemble.entryCondition) });
    }
    for (const extra of ensemble.extraEntries) {
      routes.push({ from: extra.from, to: ensemble.name, via: viaOf(extra.condition) });
    }
    if (ensemble.onPassTo !== null) {
      routes.push({ from: ensemble.name, to: wiringName(ensemble.onPassTo), via: "pass" });
    }
    if (ensemble.onFailTo !== null) {
      routes.push({ from: ensemble.name, to: wiringName(ensemble.onFailTo), via: "fail" });
    }
  }
  return {
    nodes: parsed.nodes.map((node) => ({ name: node.name, kind: node.docKind })),
    ensembles: parsed.ensembles.map((ensemble) => ({
      name: ensemble.name,
      strategy: ensemble.strategy,
      members: ensemble.members.length,
      minPass: ensemble.minPass,
    })),
    routes,
  };
}
