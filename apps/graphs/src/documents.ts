// SPDX-License-Identifier: Apache-2.0
/**
 * Folder-to-document composition for the catalogue.
 *
 * GitHub's contents API, a repo's git tree or a search hit all say where a
 * document *might* live: `<kind>s/<slug>/<kind>.json` plus a
 * README. This module turns that into a validated `Doc`, the shape the
 * pages render, using the fewest GitHub calls possible (the README is only
 * fetched once the document validated) and dropping anything invalid with a
 * note in the log instead of an error.
 */
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import type { ApiError, GitHub } from "./github.js";
import { isApiError } from "./github.js";
import { decodeBase64, isArray, isNumber, isRecord, isString, parseJson, readJson, stringField } from "./json.js";
import { harnessOf } from "../../../packages/plate/document.js";
import { isValidDocument } from "./validate.js";
import { isOfficialRepo } from "./lib.js";

/** One rendered row: no HTML, no storage, just the fields the pages show. */
export interface Doc {
  kind: DocumentKind;
  slug: string;
  name: string;
  description: string;
  readme: string;
  /** Graph: the number of nodes. Node: 1. */
  nodeCount: number;
  repo: string;
  /** True when the document ships in the official repository. */
  official: boolean;
  /** GitHub stars, or null when nobody told us. Never zero-filled. */
  stars: number | null;
  /** Last updated, `YYYY-MM-DD`, or null when nobody told us. */
  updated: string | null;
  /** The distinct harness stems the document runs on, sorted, possibly empty. */
  harnesses: string[];
  /** The commit or branch the page was read from, or null when unknown. */
  sourceRef: string | null;
  /** Install counts from the Analytics Engine, present only when configured. */
  downloads?: number;
}

/** A validated document plus its rendered shape (for the SVG pages later). */
export interface CatalogEntry {
  doc: Doc;
  document: JsonValue;
}

/** Where one document lives inside its repository. */
export interface DocumentSource {
  owner: string;
  repo: string;
  /** Directory holding the document, e.g. `graphs/hello-graph`. */
  directory: string;
  kind: DocumentKind;
  slug: string;
  /** Stars when the caller already knows them (a search hit, the repo call). */
  stars: number | null;
  /** Last updated (`YYYY-MM-DD`) when the caller already knows it. */
  updated?: string | null;
  /** The git ref to read at: a branch, a commit, or "" for the default. */
  ref?: string;
}

/** The document filename, by kind, following the publish convention. */
export function documentFile(kind: DocumentKind): string {
  return kind === "graph" ? "graph.json" : "node.json";
}

/**
 * The folders the search reads documents from, at the repository root:
 * `graphs/<slug>/graph.json` and `nodes/<slug>/node.json`. The Publish
 * page states these paths, so they live here, not in prose. Every
 * repository — the official one included — uses this layout.
 */
export const GRAPH_DIR = "graphs";

export const NODE_DIR = "nodes";

/** The community folder holding documents of `kind`. */
export function communityDir(kind: DocumentKind): string {
  return kind === "graph" ? GRAPH_DIR : NODE_DIR;
}

/** The document folder for a slug: the community layout, for everyone. */
export function documentDirectory(kind: DocumentKind, slug: string): string {
  return `${communityDir(kind)}/${slug}`;
}

function contentsUrl(owner: string, repo: string, path: string, ref: string): string {
  const clean = path.replace(/^\/+/, "");
  const question = ref === "" ? "" : `?ref=${encodeURIComponent(ref)}`;
  return `https://api.github.com/repos/${owner}/${repo}/contents/${clean}${question}`;
}

function rawUrl(owner: string, repo: string, path: string, ref: string): string {
  const branch = ref === "" ? "HEAD" : ref;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

/** An entry from a contents listing or a git tree we only need paths of. */
export interface TreeFile {
  path: string;
  type?: string;
}

/** Read the visible paths out of a git-trees response body. */
export function pathsFromTree(value: unknown): TreeFile[] {
  if (!isRecord(value)) {
    return [];
  }
  const tree = value["tree"];
  if (!isArray(tree)) {
    return [];
  }
  return tree.flatMap((entry) => {
    if (!isRecord(entry) || !isString(entry["path"])) {
      return [];
    }
    return [{ path: entry["path"], type: isString(entry["type"]) ? entry["type"] : undefined }];
  });
}

/**
 * The document folders a tree implies. A path counts when it is a
 * document file next to its folder: `graphs/<slug>/graph.json` (and
 * `nodes/…/node.json` likewise, matching the publish rule every
 * repository follows).
 */
export function sourcesFromTree(
  owner: string,
  repo: string,
  files: TreeFile[],
): DocumentSource[] {
  const documentRe = new RegExp(`^(${GRAPH_DIR}|${NODE_DIR})/([a-z0-9-]{1,48})/(?:graph|node)\\.json$`);
  return files.flatMap((file) => {
    const match = documentRe.exec(file.path);
    if (match === null) {
      return [];
    }
    const kind: DocumentKind = match[1] === GRAPH_DIR ? "graph" : "node";
    return [{ owner, repo, directory: `${match[1]}/${match[2]}`, kind, slug: match[2], stars: null }];
  });
}

type Text =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | ApiError;

/**
 * Read one file as text: the contents API first (inline base64), falling
 * back to the raw URL when the content is absent (files over 1 MB) or the
 * path looks gone at the contents API but exists raw. Cached per class:
 * contents 30 minutes, raw 30 minutes.
 */
async function readText(
  github: GitHub,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  log: (message: string) => void,
): Promise<Text> {
  const file = await github.get(contentsUrl(owner, repo, path, ref), "contents");
  if (isApiError(file)) {
    if (file.kind !== "not-found") {
      return file;
    }
    log(`documents: ${path} absent at the contents API, trying raw`);
    return rawText(github, owner, repo, path, ref);
  }
  const body = await readJson(file);
  if (!body.ok) {
    log(`documents: ${path} answered something other than JSON, trying raw`);
    return rawText(github, owner, repo, path, ref);
  }
  const content = isRecord(body.value) ? body.value["content"] : undefined;
  const encoding = isRecord(body.value) ? stringField(body.value, "encoding") : "";
  // Files over 1 MB arrive with `content: ""` and `encoding: "none"`; an empty
  // inline body is never the file, so it goes to the raw URL as well.
  if (isString(content) && content !== "" && encoding !== "none") {
    const decoded = decodeBase64(content);
    if (decoded !== null) {
      return { kind: "text", text: decoded };
    }
  }
  log(`documents: ${path} has no inline content, trying raw`);
  return rawText(github, owner, repo, path, ref);
}

/** The raw fallback: same file straight from raw.githubusercontent.com. */
async function rawText(
  github: GitHub,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<Text> {
  const raw = await github.get(rawUrl(owner, repo, path, ref), "raw");
  if (isApiError(raw)) {
    if (raw.kind === "not-found") {
      return { kind: "absent" };
    }
    return raw;
  }
  return { kind: "text", text: await raw.text() };
}

/** The count of nodes in a graph document (0 when malformed); a node is 1. */
function nodeCountOf(kind: DocumentKind, document: JsonValue): number {
  if (kind === "node") {
    return 1;
  }
  if (!isRecord(document) || !isArray(document["nodes"])) {
    return 0;
  }
  return document["nodes"].length;
}

/**
 * The distinct harness stems a validated document runs on, sorted: every
 * node's config plus every ensemble member's platform/model. Unknown
 * harnesses contribute nothing — the dots only show what the map knows.
 */
function harnessesOf(kind: DocumentKind, document: JsonValue): string[] {
  if (!isRecord(document)) {
    return [];
  }
  const found = new Set<string>();
  if (kind === "node") {
    const stem = harnessOf(document["config"]);
    if (stem !== null) {
      found.add(stem);
    }
    return [...found];
  }
  const nodes = document["nodes"];
  if (isArray(nodes)) {
    for (const node of nodes) {
      const stem = isRecord(node) ? harnessOf(node["config"]) : null;
      if (stem !== null) {
        found.add(stem);
      }
    }
  }
  const ensembles = document["ensembles"];
  if (isArray(ensembles)) {
    for (const ensemble of ensembles) {
      const members = isRecord(ensemble) ? ensemble["members"] : undefined;
      if (isArray(members)) {
        for (const member of members) {
          const stem = harnessOf(member);
          if (stem !== null) {
            found.add(stem);
          }
        }
      }
    }
  }
  return [...found].sort();
}

/** The fields a rendered Doc needs beyond the document and README. */
export interface DocContext {
  kind: DocumentKind;
  slug: string;
  owner: string;
  repo: string;
  stars: number | null;
  updated?: string | null;
  ref?: string;
  /** The index's official flag; the repo address decides when absent. */
  official?: boolean;
}

/**
 * Render one validated document and its README into the row and page
 * shape. The live loader and the scheduled index share it, so a document
 * reads identically however it was reached.
 */
export function docFromDocument(
  context: DocContext,
  document: JsonValue,
  readme: string,
): Doc {
  const ref = context.ref ?? "";
  return {
    kind: context.kind,
    slug: context.slug,
    name: isRecord(document) ? stringField(document, "name") || context.slug : context.slug,
    description: isRecord(document) ? stringField(document, "description") : "",
    readme,
    nodeCount: nodeCountOf(context.kind, document),
    repo: `${context.owner}/${context.repo}`,
    official: context.official ?? isOfficialRepo(context.owner, context.repo),
    stars: context.stars,
    updated: context.updated ?? null,
    harnesses: harnessesOf(context.kind, document),
    sourceRef: ref === "" ? null : ref,
  };
}

/**
 * Load, validate and render one document, carrying the drop reason. An
 * `absent` miss is ordinary (no folder, no file) and carries no reason;
 * an invalid document carries why it failed to validate, for the
 * indexer's meta. A typed error means GitHub itself is the problem.
 */
export async function loadDocumentWithReason(
  github: GitHub,
  source: DocumentSource,
  log: (message: string) => void,
): Promise<
  | { kind: "doc"; entry: CatalogEntry }
  | { kind: "absent"; reason: string | null }
  | ApiError
> {
  const { owner, repo, kind } = source;
  const ref = source.ref ?? "";
  const jsonPath = `${source.directory}/${documentFile(kind)}`;
  const documentText = await readText(github, owner, repo, jsonPath, ref, log);
  if (documentText.kind === "absent") {
    log(`documents: dropped ${owner}/${repo} ${jsonPath}: missing document file`);
    return { kind: "absent", reason: null };
  }
  if (documentText.kind !== "text") {
    return documentText;
  }
  const parsed = parseJson(documentText.text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    log(`documents: dropped ${owner}/${repo} ${jsonPath}: unparseable JSON`);
    return { kind: "absent", reason: "unparseable JSON" };
  }
  if (!isValidDocument(kind, parsed.value)) {
    log(`documents: dropped ${owner}/${repo} ${jsonPath}: invalid document`);
    return { kind: "absent", reason: "schema validation failed" };
  }
  const document = parsed.value;
  const readmePath = `${source.directory}/README.md`;
  const readme = await readText(github, owner, repo, readmePath, ref, log);
  const readmeText = readme.kind === "text" ? readme.text : "";
  if (readme.kind === "absent") {
    log(`documents: ${owner}/${repo} ${jsonPath} listed without a README`);
  }
  return { kind: "doc", entry: { document, doc: docFromDocument(source, document, readmeText) } };
}

/**
 * Load, validate and render one document. Returns `absent` for the ordinary
 * misses (no folder, no file, README only missing), a typed error when
 * GitHub itself is the problem (rate limit, upstream), and a note in the
 * log for every dropped document.
 */
export async function loadDocument(
  github: GitHub,
  source: DocumentSource,
  log: (message: string) => void,
): Promise<
  | { kind: "doc"; entry: CatalogEntry }
  | { kind: "absent" }
  | ApiError
> {
  const loaded = await loadDocumentWithReason(github, source, log);
  if (loaded.kind === "absent") {
    return { kind: "absent" };
  }
  return loaded;
}

/** Read `stargazers_count` from a `/repos/...` body, null when absent. */
export function starsFromRepository(value: unknown): number | null {
  if (isRecord(value)) {
    const stars = value["stargazers_count"];
    return isNumber(stars) ? stars : null;
  }
  return null;
}

/** A GitHub timestamp as the catalogue shows it: `YYYY-MM-DD`, or null. */
export function toDateOnly(value: unknown): string | null {
  if (!isString(value)) {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/** Read `updated_at` from a `/repos/...` body as `YYYY-MM-DD`, null when absent. */
export function updatedFromRepository(value: unknown): string | null {
  return isRecord(value) ? toDateOnly(value["updated_at"]) : null;
}

/** Read `default_branch` from a `/repos/...` body, "" when absent. */
export function branchFromRepository(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const branch = value["default_branch"];
  return isString(branch) ? branch.trim() : "";
}
