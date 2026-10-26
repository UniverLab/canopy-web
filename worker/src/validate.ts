// SPDX-License-Identifier: Apache-2.0
/**
 * Document validation for the worker, wired to the one contract in `schema/`.
 *
 * The root `src/validate.ts` also reads the filesystem, which does not exist
 * in a Worker, so this module keeps only the schema check itself — the same
 * `@cfworker/json-schema` validators over the same imported `schema/*.json`,
 * never a copied version of the rules.
 */
import { type Schema, Validator } from "@cfworker/json-schema";
import { graphSchema, nodeSchema, type DocumentKind } from "../../src/schema.js";
import { isRecord, type ParsedJson, parseJson } from "./json.js";

interface SchemaResult {
  valid?: unknown;
}

const validators: Record<DocumentKind, Validator> = {
  graph: new Validator(graphSchema as Schema),
  node: new Validator(nodeSchema as Schema),
};

/** True when the value is a document of `kind` that matches `schema/<kind>`. */
export function isValidDocument(
  kind: DocumentKind,
  document: unknown,
): boolean {
  return (validators[kind].validate(document) as SchemaResult).valid !== false;
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
