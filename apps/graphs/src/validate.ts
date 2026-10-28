// SPDX-License-Identifier: Apache-2.0
/**
 * Document validation for the worker, wired to the one contract in `schema/`.
 *
 * The root `src/validate.ts` also reads the filesystem, which does not exist
 * in a Worker, so this module keeps only the schema check itself — the same
 * `@cfworker/json-schema` validators over the same imported `schema/*.json`,
 * never a copied version of the rules.
 *
 * Two questions live here. `documentProblems` is the catalogue's own question
 * — does this value match `schema/<kind>`? — and it is what the indexer and
 * the pages ask, so a published document that names a harness still lists.
 * `harnessProblems` is the stricter question a *draft* asks: a shared document
 * must not bind itself to `platform`, `model` or `cli`, because the person who
 * installs it chooses the harnesses. It looks where a graph can smuggle a
 * binding — a node's config and an ensemble member — as well as a node
 * document's own config.
 */
import { type Schema, Validator } from "@cfworker/json-schema";
import { graphSchema, nodeSchema, type DocumentKind } from "../../../src/schema.js";
import { isRecord, type ParsedJson, parseJson } from "./json.js";

/** One problem, with the JSON pointer of the value that caused it. */
export interface DocumentProblem {
  /** A JSON pointer, e.g. `#/nodes/0/config` or `#/config/platform`. */
  path: string;
  message: string;
}

interface SchemaError {
  instanceLocation?: unknown;
  error?: unknown;
  message?: unknown;
}

interface SchemaResult {
  valid?: unknown;
  errors?: unknown;
}

const validators: Record<DocumentKind, Validator> = {
  graph: new Validator(graphSchema as Schema),
  node: new Validator(nodeSchema as Schema),
};

function textOf(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * Schema problems for one document, each with the pointer the validator
 * reported. A document that matches answers nothing at all.
 */
export function documentProblems(kind: DocumentKind, document: unknown): DocumentProblem[] {
  const result = validators[kind].validate(document) as SchemaResult;
  if (result.valid !== false) {
    return [];
  }
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return (errors as SchemaError[]).map((entry) => ({
    path: textOf(entry.instanceLocation, "#"),
    message: textOf(entry.error, textOf(entry.message, "does not match schema")),
  }));
}

/** True when the value is a document of `kind` that matches `schema/<kind>`. */
export function isValidDocument(
  kind: DocumentKind,
  document: unknown,
): boolean {
  return documentProblems(kind, document).length === 0;
}

/** The config keys a shared document never carries: the installer picks. */
const HARNESS_KEYS = new Set(["platform", "model", "cli"]);

const HARNESS_MESSAGE = "config must not contain platform, model or cli bindings";

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Banned keys anywhere inside one config object, with their pointers. */
function configProblems(config: unknown, pointer: string): DocumentProblem[] {
  if (Array.isArray(config)) {
    return config.flatMap((item, index) => configProblems(item, `${pointer}/${index}`));
  }
  if (config === null || typeof config !== "object") {
    return [];
  }
  const found: DocumentProblem[] = [];
  for (const [key, child] of Object.entries(config as Record<string, unknown>)) {
    const childPointer = `${pointer}/${escapePointer(key)}`;
    if (HARNESS_KEYS.has(key)) {
      found.push({ path: childPointer, message: HARNESS_MESSAGE });
    }
    found.push(...configProblems(child, childPointer));
  }
  return found;
}

/**
 * The harness problems of a document: a node document's `config`, every graph
 * node's `config`, and every ensemble member (whose schema allows `platform`
 * and `model` outright). Empty for a harness-free document.
 */
export function harnessProblems(kind: DocumentKind, document: unknown): DocumentProblem[] {
  if (!isRecord(document)) {
    return [];
  }
  if (kind === "node") {
    return configProblems(document["config"], "#/config");
  }
  const found: DocumentProblem[] = [];
  const nodes = document["nodes"];
  if (Array.isArray(nodes)) {
    nodes.forEach((node, index) => {
      if (isRecord(node)) {
        found.push(...configProblems(node["config"], `#/nodes/${index}/config`));
      }
    });
  }
  const ensembles = document["ensembles"];
  if (Array.isArray(ensembles)) {
    ensembles.forEach((ensemble, index) => {
      if (!isRecord(ensemble)) {
        return;
      }
      const members = ensemble["members"];
      if (!Array.isArray(members)) {
        return;
      }
      members.forEach((member, memberIndex) => {
        if (!isRecord(member)) {
          return;
        }
        for (const key of Object.keys(member)) {
          if (HARNESS_KEYS.has(key)) {
            found.push({
              path: `#/ensembles/${index}/members/${memberIndex}/${escapePointer(key)}`,
              message: HARNESS_MESSAGE,
            });
          }
        }
      });
    });
  }
  return found;
}

/**
 * Parse and validate a document's JSON text against `schema/`.
 * `ok: false` means the catalogue leaves the document out.
 */
export function parseDocument(kind: DocumentKind, text: string): ParsedJson & { document?: unknown } {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value) || !isValidDocument(kind, parsed.value)) {
    return { ok: false };
  }
  return { ok: true, value: parsed.value, document: parsed.value };
}
