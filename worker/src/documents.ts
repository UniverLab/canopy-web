// SPDX-License-Identifier: Apache-2.0
/**
 * Folder-to-document composition for the catalogue.
 *
 * GitHub's contents API, a repo's git tree or a search hit all say where a
 * document *might* live: `<prefix>/<kind>s/<slug>/<kind>.json` plus a
 * README. This module turns that into a validated `Doc`, the shape the
 * pages render, using the fewest GitHub calls possible (the README is only
 * fetched once the document validated) and dropping anything invalid with a
 * note in the log instead of an error.
 */
import type { DocumentKind, JsonValue } from "../../src/schema.js";
import type { ApiError, GitHub } from "./github.js";
import { isApiError } from "./github.js";
import { decodeBase64, isArray, isNumber, isRecord, isString, parseJson, stringField } from "./json.js";
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
  /** GitHub stars, or null when nobody told us. Never zero-filled. */
  stars: number | null;
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
  /** Directory holding the document, e.g. `registry/graphs/hello-graph`. */
  directory: string;
  kind: DocumentKind;
  slug: string;
  /** Stars when the caller already knows them (a search hit, the repo call). */
  stars: number | null;
}

/** The document filename, by kind, following the publish convention. */
export function documentFile(kind: DocumentKind): string {
  return kind === "graph" ? "graph.json" : "node.json";
}

/** `registry/graphs` when the repository is the official one, else ``. */
export function prefixFor(owner: string, repo: string): string {
  return isOfficialRepo(owner, repo) ? "registry/" : "";
}

/** The document folder for a slug, given the repository's prefix. */
export function documentDirectory(
  owner: string,
  repo: string,
  kind: DocumentKind,
  slug: string,
): string {
  const prefix = prefixFor(owner, repo);
  return `${prefix}${kind}s/${slug}`;
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
 * `nodes/…/node.json` likewise, matching the publish rule registry follows).
 */
export function sourcesFromTree(
  owner: string,
  repo: string,
  files: TreeFile[],
): DocumentSource[] {
  const documentRe = /^(graphs|nodes)\/([a-z0-9-]{1,48})\/(?:graph|node)\.json$/;
  const readmeRe = /^(?:graphs|nodes)\/([a-z0-9-]{1,48})\/readme\.md$/i;
  return files.flatMap((file) => {
    const match = documentRe.exec(file.path);
    if (match === null) {
      return [];
    }
    const kind: DocumentKind = match[1] === "graphs" ? "graph" : "node";
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
  const body = await file.json() as unknown;
  if (isRecord(body) && body["content"] !== undefined && body["content"] !== null) {
    const decoded = decodeBase64(body["content"]);
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
  const { owner, repo, kind, slug } = source;
  const jsonPath = `${source.directory}/${documentFile(kind)}`;
  const documentText = await readText(github, owner, repo, jsonPath, "", log);
  if (documentText.kind === "absent") {
    log(`documents: dropped ${owner}/${repo} ${jsonPath}: missing document file`);
    return { kind: "absent" };
  }
  if (documentText.kind !== "text") {
    return documentText;
  }
  const parsed = parseJson(documentText.text);
  if (!parsed.ok || !isRecord(parsed.value) || !isValidDocument(kind, parsed.value)) {
    log(`documents: dropped ${owner}/${repo} ${jsonPath}: invalid document`);
    return { kind: "absent" };
  }
  const document = parsed.value;
  const readmePath = `${source.directory}/README.md`;
  const readme = await readText(github, owner, repo, readmePath, "", log);
  const readmeText = readme.kind === "text" ? readme.text : "";
  if (readme.kind === "absent") {
    log(`documents: ${owner}/${repo} ${jsonPath} listed without a README`);
  }
  return {
    kind: "doc",
    entry: {
      document,
      doc: {
        kind,
        slug,
        name: stringField(document, "name") || slug,
        description: stringField(document, "description"),
        readme: readmeText,
        nodeCount: nodeCountOf(kind, document),
        repo: `${owner}/${repo}`,
        stars: source.stars,
      },
    },
  };
}

/** Read `stargazers_count` from a `/repos/...` body, null when absent. */
export function starsFromRepository(value: unknown): number | null {
  if (isRecord(value)) {
    const stars = value["stargazers_count"];
    return isNumber(stars) ? stars : null;
  }
  return null;
}
