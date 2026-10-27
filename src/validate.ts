// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { type Schema, Validator } from "@cfworker/json-schema";
import blockedSchema from "../schema/blocked.schema.json" with { type: "json" };
import { graphSchema, nodeSchema, type DocumentKind } from "./schema.js";
import { folderMatchesName } from "./slug.js";

/** One validation failure: the file, a JSON pointer, and what is wrong. */
export interface ValidationFailure {
  file: string;
  pointer: string;
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

/** The removal list's structural schema; its cross-field rule lives below. */
const blockedValidator = new Validator(blockedSchema as Schema);

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** Turn one validator result into the failures the CLI prints. */
function schemaFailures(file: string, result: SchemaResult): ValidationFailure[] {
  if (result.valid !== false) {
    return [];
  }
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return (errors as SchemaError[]).map((entry) => ({
    file,
    pointer: asString(entry.instanceLocation, "#"),
    message: asString(entry.error, asString(entry.message, "does not match schema")),
  }));
}

/** Schema failures for one parsed document. */
export function validateDocument(
  file: string,
  kind: DocumentKind,
  doc: unknown,
): ValidationFailure[] {
  return schemaFailures(file, validators[kind].validate(doc) as SchemaResult);
}

/** The one shape rule JSON Schema cannot state across sibling fields. */
function blockedCrossField(file: string, list: unknown): ValidationFailure[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const failures: ValidationFailure[] = [];
  list.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    const slug = (entry as { slug?: unknown }).slug;
    const kind = (entry as { kind?: unknown }).kind;
    if (typeof slug === "string" && kind !== "graph" && kind !== "node") {
      failures.push({
        file,
        pointer: `#/${index}`,
        message: "slug requires kind (graph or node)",
      });
    }
  });
  return failures;
}

/**
 * Schema + cross-field failures for one parsed `registry/blocked.json`: an
 * entry may name one document only when it names its kind too.
 */
export function validateBlocked(file: string, list: unknown): ValidationFailure[] {
  return [
    ...schemaFailures(file, blockedValidator.validate(list) as SchemaResult),
    ...blockedCrossField(file, list),
  ];
}

/** Read and validate `registry/blocked.json`; a missing file is a failure. */
export function validateBlockedFile(file: string): ValidationFailure[] {
  if (!existsSync(file)) {
    return [{ file, pointer: "#", message: "missing blocked list" }];
  }
  const read = readJson(file);
  if ("failure" in read) {
    return [read.failure];
  }
  return validateBlocked(file, read.doc);
}

const BANNED_CONFIG_KEYS = new Set(["platform", "model", "cli"]);

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Pointers (under `#/config`) where a banned key occurs at any depth. */
export function findBannedConfigKeys(config: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        const childPointer = `${pointer}/${escapePointer(key)}`;
        if (BANNED_CONFIG_KEYS.has(key)) {
          found.push(childPointer);
        }
        walk(child, childPointer);
      }
    }
  };
  walk(config, "#/config");
  return found;
}

/** Node documents must not bind platform/model/cli anywhere in `config`. */
export function validateNodeConfig(file: string, doc: unknown): ValidationFailure[] {
  if (typeof doc !== "object" || doc === null) {
    return [];
  }
  const config = (doc as { config?: unknown }).config;
  if (typeof config !== "object" || config === null) {
    return [];
  }
  return findBannedConfigKeys(config).map((pointer) => ({
    file,
    pointer,
    message: `config must not contain platform, model or cli bindings`,
  }));
}

function readJson(file: string): { doc: unknown } | { failure: ValidationFailure } {
  try {
    return { doc: JSON.parse(readFileSync(file, "utf8")) as unknown };
  } catch (error) {
    return {
      failure: {
        file,
        pointer: "#",
        message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

function kindForFile(file: string): DocumentKind | null {
  const base = path.basename(file);
  if (base === "graph.json") {
    return "graph";
  }
  if (base === "node.json") {
    return "node";
  }
  return null;
}

/** Schema (+ node config) validation for one document file. */
export function validateDocumentFile(file: string): ValidationFailure[] {
  const kind = kindForFile(file);
  if (kind === null) {
    return [{ file, pointer: "#", message: "unknown document kind (want graph.json or node.json)" }];
  }
  const read = readJson(file);
  if ("failure" in read) {
    return [read.failure];
  }
  const failures = validateDocument(file, kind, read.doc);
  if (kind === "node") {
    failures.push(...validateNodeConfig(file, read.doc));
  }
  return failures;
}

/**
 * Full validation for one document folder: its document(s), the required
 * README.md, and folder-name-equals-document-name.
 */
export function validateFolder(folder: string): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const files = ["graph.json", "node.json"]
    .map((name) => path.join(folder, name))
    .filter((file) => existsSync(file) && statSync(file).isFile());
  if (files.length === 0) {
    return [{ file: folder, pointer: "#", message: "no graph.json or node.json document" }];
  }
  if (!existsSync(path.join(folder, "README.md"))) {
    failures.push({ file: path.join(folder, "README.md"), pointer: "#", message: "missing README.md" });
  }
  for (const file of files) {
    failures.push(...validateDocumentFile(file));
    const read = readJson(file);
    if ("failure" in read) {
      continue;
    }
    const name =
      typeof read.doc === "object" && read.doc !== null
        ? (read.doc as { name?: unknown }).name
        : undefined;
    if (typeof name === "string" && !folderMatchesName(folder, name)) {
      failures.push({
        file,
        pointer: "#/name",
        message: `folder name must equal the document name "${name}"`,
      });
    }
  }
  return failures;
}

function collectFolders(root: string, out: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  if (entries.includes("graph.json") || entries.includes("node.json")) {
    out.push(root);
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry);
    try {
      if (statSync(full).isDirectory()) {
        collectFolders(full, out);
      }
    } catch {
      continue;
    }
  }
}

/** Validate every document folder under a registry root. */
export function validateRegistry(registryDir: string): ValidationFailure[] {
  const folders: string[] = [];
  collectFolders(registryDir, folders);
  return folders.sort().flatMap((folder) => validateFolder(folder));
}

/** Validate one CLI target: a file, a folder, or a registry root. */
export function validateTarget(target: string): ValidationFailure[] {
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) {
    return [{ file: target, pointer: "#", message: "no such file or directory" }];
  }
  if (statSync(resolved).isFile()) {
    // A document file is always validated as its folder: the publish layout
    // requires the README.md and folder-name-equals-document-name rules too.
    if (kindForFile(resolved) !== null) {
      return validateFolder(path.dirname(resolved));
    }
    return validateDocumentFile(resolved);
  }
  const entries = readdirSync(resolved);
  if (entries.includes("graph.json") || entries.includes("node.json")) {
    return validateFolder(resolved);
  }
  return validateRegistry(resolved);
}

function report(failures: ValidationFailure[]): void {
  for (const failure of failures) {
    process.stdout.write(`${failure.file} ${failure.pointer} ${failure.message}\n`);
  }
}

function run(argv: string[]): number {
  const cwd = process.cwd();
  const targets = argv.length > 0 ? argv : [path.join(cwd, "registry")];
  const failures = targets.flatMap((target) => validateTarget(path.resolve(cwd, target)));
  // The default run also checks the removal list, at the registry root.
  // Explicit targets stay document-only, so a focused check costs nothing.
  if (argv.length === 0) {
    failures.push(...validateBlockedFile(path.join(cwd, "registry", "blocked.json")));
  }
  report(failures);
  if (failures.length > 0) {
    process.stderr.write(`${failures.length} failure(s)\n`);
    return 1;
  }
  process.stdout.write("all documents valid\n");
  return 0;
}

const invokedAsCli = process.argv[1] !== undefined && process.argv[1].endsWith("validate.ts");
if (invokedAsCli) {
  process.exitCode = run(process.argv.slice(2));
}
