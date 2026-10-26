// SPDX-License-Identifier: Apache-2.0
/**
 * The official listing for graphs.univerlab.org.
 *
 * UniverLab/graphs is the database: `registry/graphs/` and `registry/nodes/`
 * hold one folder per document. This module lists the two directories, then
 * loads each folder through the same validate-and-render path as everything
 * else. Nothing is persisted beyond the Cache API.
 */
import type { DocumentKind, JsonValue } from "../../src/schema.js";
import {
  type ApiError,
  type GitHub,
  type Log,
  isApiError,
} from "./github.js";
import { OFFICIAL_OWNER, OFFICIAL_REPOSITORY, OFFICIAL_REPO } from "./lib.js";
import {
  type CatalogEntry,
  type Doc,
  documentDirectory,
  loadDocument,
  starsFromRepository,
} from "./documents.js";

/** Upper bound on documents one listing will render. */
export const OFFICIAL_DOC_CAP = 100;

export interface OfficialListing {
  graphs: Doc[];
  nodes: Doc[];
}

/** A directory from a GitHub contents listing response. */
interface ListedDir {
  directory: string;
}

/** The dirs in a contents listing; anything unreadable simply contributes none. */
function listedDirectories(value: unknown): ListedDir[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (entry !== null && typeof entry === "object" && "name" in entry && "type" in entry) {
      const record = entry as { name?: unknown; type?: unknown };
      if (typeof record.name === "string" && record.type === "dir") {
        return [{ directory: record.name }];
      }
    }
    return [];
  });
}

/** The repo body for stars; `null` when GitHub does not tell us. */
async function officialStars(github: GitHub): Promise<number | null> {
  const response = await github.get(
    `https://api.github.com/repos/${OFFICIAL_REPOSITORY}`,
    "contents",
  );
  if (isApiError(response)) {
    return null;
  }
  return starsFromRepository(await response.json() as unknown);
}

/**
 * List the official catalogue. Both directories are read with two calls and
 * the repository call gives stars once, so a warm cache costs three cache
 * hits and each document costs its own folder call.
 */
export async function listOfficial(
  github: GitHub,
  log: Log,
): Promise<OfficialListing | ApiError> {
  const directories: Record<DocumentKind, ListedDir[]> = {
    graph: [],
    node: [],
  };
  for (const kind of ["graph", "node"] as const) {
    const listing = await github.get(
      `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/contents/registry/${kind}s`,
      "contents",
    );
    if (isApiError(listing)) {
      return listing;
    }
    directories[kind] = listedDirectories(await listing.json() as unknown);
  }
  const stars = await officialStars(github);
  if (stars === null) {
    log("official: stars unavailable for the listing");
  }

  const graphs: CatalogEntry[] = [];
  const nodes: CatalogEntry[] = [];
  const buckets: Record<DocumentKind, CatalogEntry[]> = { graph: graphs, node: nodes };
  for (const kind of ["graph", "node"] as const) {
    for (const listed of directories[kind]) {
      if (graphs.length + nodes.length >= OFFICIAL_DOC_CAP) {
        log("official: document cap reached");
        break;
      }
      const source = {
        owner: OFFICIAL_OWNER,
        repo: OFFICIAL_REPO,
        directory: documentDirectory(OFFICIAL_OWNER, OFFICIAL_REPO, kind, listed.directory),
        kind,
        slug: listed.directory,
        stars,
      };
      const loaded = await loadDocument(github, source, log);
      if (loaded.kind === "doc") {
        buckets[kind].push(loaded.entry);
      }
    }
  }
  return { graphs: graphs.map((entry) => entry.doc), nodes: nodes.map((entry) => entry.doc) };
}

/**
 * Load one official document by slug, trying graphs before nodes so an
 * endpoint that does not say the kind still answers. `document` is the
 * validated JSON itself, for the pages' renderer.
 */
export async function loadOfficialDocument(
  github: GitHub,
  slug: string,
  log: Log,
): Promise<
  | { kind: "doc"; entry: CatalogEntry }
  | { kind: "absent" }
  | ApiError
> {
  const owner = OFFICIAL_OWNER;
  const repo = OFFICIAL_REPO;
  for (const kind of ["graph", "node"] as const) {
    const source = {
      owner,
      repo,
      directory: documentDirectory(owner, repo, kind, slug),
      kind,
      slug,
      stars: null,
    };
    const loaded = await loadDocument(github, source, log);
    if (loaded.kind !== "absent") {
      if (loaded.kind === "doc" && loaded.entry.doc.stars === null) {
        loaded.entry.doc.stars = await officialStars(github);
      }
      return loaded;
    }
  }
  return { kind: "absent" };
}

/** JSON value re-export so callers do not reach past this module. */
export type { JsonValue };
