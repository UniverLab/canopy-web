// SPDX-License-Identifier: Apache-2.0
/**
 * The official listing for graphs.univerlab.org.
 *
 * UniverLab/canopy-web is the database: `registry/graphs/` and `registry/nodes/`
 * hold one folder per document. This module lists the two directories, then
 * loads each folder through the same validate-and-render path as everything
 * else. Nothing is persisted beyond the Cache API.
 */
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import {
  type ApiError,
  type GitHub,
  type Log,
  isApiError,
} from "./github.js";
import { OFFICIAL_OWNER, OFFICIAL_REPOSITORY, OFFICIAL_REPO } from "./lib.js";
import { readJson } from "./json.js";
import {
  type CatalogEntry,
  type Doc,
  branchFromRepository,
  documentDirectory,
  loadDocument,
  starsFromRepository,
  updatedFromRepository,
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

/** What one `/repos/...` call tells the catalogue: stars, updated, branch. */
export interface RepoInfo {
  stars: number | null;
  updated: string | null;
  branch: string;
}

/** The repo body for stars, updated and the default branch; blanks when GitHub stays silent. */
async function officialRepo(github: GitHub, repository: string): Promise<RepoInfo> {
  const blank: RepoInfo = { stars: null, updated: null, branch: "" };
  const response = await github.get(
    `https://api.github.com/repos/${repository}`,
    "contents",
  );
  if (isApiError(response)) {
    return blank;
  }
  const body = await readJson(response);
  if (!body.ok) {
    return blank;
  }
  return {
    stars: starsFromRepository(body.value),
    updated: updatedFromRepository(body.value),
    branch: branchFromRepository(body.value),
  };
}

/**
 * List the official catalogue. Both directories are read with two calls and
 * the repository call gives stars once, so a warm cache costs three cache
 * hits and each document costs its own folder call. A directory GitHub has
 * never heard of (404) is an empty list of that kind, not an outage: the
 * registry is empty until the first merge. Every other error still comes
 * back as the typed ApiError the pages turn into the calm 503.
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
      if (listing.kind === "not-found") {
        log(`official: registry/${kind}s is absent; listing it as empty`);
        continue;
      }
      return listing;
    }
    const body = await readJson(listing);
    if (!body.ok) {
      log(`official: registry/${kind}s listing did not parse as JSON`);
      return {
        kind: "upstream",
        message: `GitHub contents for registry/${kind}s answered something other than JSON`,
        status: 502,
      };
    }
    directories[kind] = listedDirectories(body.value);
  }
  const info = await officialRepo(github, OFFICIAL_REPOSITORY);
  if (info.stars === null) {
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
        stars: info.stars,
        updated: info.updated,
        ref: info.branch,
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
 * Load one official document of an explicit kind. A slug that only exists
 * under the other kind is simply absent: `GET /api/g` never answers with a
 * node, and the miss costs one folder probe instead of two. `document` is the
 * validated JSON itself, for the pages' renderer.
 */
export async function loadOfficialDocument(
  github: GitHub,
  kind: DocumentKind,
  slug: string,
  log: Log,
): Promise<
  | { kind: "doc"; entry: CatalogEntry }
  | { kind: "absent" }
  | ApiError
> {
  const info = await officialRepo(github, OFFICIAL_REPOSITORY);
  const source = {
    owner: OFFICIAL_OWNER,
    repo: OFFICIAL_REPO,
    directory: documentDirectory(OFFICIAL_OWNER, OFFICIAL_REPO, kind, slug),
    kind,
    slug,
    stars: info.stars,
    updated: info.updated,
    ref: info.branch,
  };
  return loadDocument(github, source, log);
}

/**
 * The community repo behind one document page: stars, updated and the
 * default branch, blanks when GitHub stays silent. The page reads the
 * document at that branch, so the sheet's Ref names a real ref.
 */
export async function communityRepo(github: GitHub, owner: string, repo: string): Promise<RepoInfo> {
  return officialRepo(github, `${owner}/${repo}`);
}

/** JSON value re-export so callers do not reach past this module. */
export type { JsonValue };
