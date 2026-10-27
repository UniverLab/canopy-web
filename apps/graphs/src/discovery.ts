// SPDX-License-Identifier: Apache-2.0
/**
 * Per-repository document discovery for the catalogue.
 *
 * One repository says where documents *might* live in two ways: its git
 * tree (one call, every path at once) or — when the tree is truncated —
 * two directory listings over `graphs/` and `nodes/`. The per-request
 * search (search.ts) and the scheduled indexer (indexer.ts) both read the
 * same folders through this module, so the publish rule has one reader.
 */
import type { ApiError, GitHub, Log } from "./github.js";
import { isApiError } from "./github.js";
import { isRecord, isString, readJson } from "./json.js";
import type { DocumentKind } from "../../../src/schema.js";
import type { DocumentSource } from "./documents.js";
import {
  communityDir,
  documentDirectory,
  pathsFromTree,
  sourcesFromTree,
} from "./documents.js";

/**
 * The GitHub topic that lists a repository in the catalogue. The Publish
 * page names it, so it lives here, next to the queries that read it.
 */
export const CATALOGUE_TOPIC = "canopy-graph";

/** The git-trees URL for one repository at one branch, paths included. */
export function treeUrl(owner: string, repo: string, branch: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
}

/** The dirs of `graphs/`/`nodes/`, the fallback when a tree is truncated. */
export async function directoriesFallback(
  github: GitHub,
  owner: string,
  repo: string,
  branch: string,
  log: Log,
): Promise<DocumentSource[] | ApiError> {
  const sources: DocumentSource[] = [];
  const prefix = branch === "" ? "" : `?ref=${encodeURIComponent(branch)}`;
  for (const kind of ["graph", "node"] as const) {
    const listing = await github.get(
      `https://api.github.com/repos/${owner}/${repo}/contents/${communityDir(kind)}${prefix}`,
      "contents",
    );
    if (isApiError(listing)) {
      if (listing.kind === "rate-limit") {
        return listing;
      }
      if (listing.kind !== "not-found") {
        log(`discovery: ${owner}/${repo} listing ${kind}s failed: ${listing.kind}`);
      }
      continue;
    }
    const body = await readJson(listing);
    if (!body.ok || !Array.isArray(body.value)) {
      continue;
    }
    for (const entry of body.value) {
      if (isRecord(entry) && entry["type"] === "dir" && isString(entry["name"])) {
        sources.push({
          owner,
          repo,
          directory: documentDirectory(kind, entry["name"]),
          kind: kind as DocumentKind,
          slug: entry["name"],
          stars: null,
          updated: null,
          ref: branch,
        });
      }
    }
  }
  return sources;
}

/**
 * Every document folder in one repository: the git tree first, the two
 * directory listings when the tree arrived truncated with nothing usable.
 * A rate limit comes back as the typed error (the caller stops); anything
 * else unreadable is a logged skip, an empty list of folders.
 */
export async function discoverSources(
  github: GitHub,
  owner: string,
  repo: string,
  branch: string,
  log: Log,
): Promise<DocumentSource[] | ApiError> {
  const treeResponse = await github.get(treeUrl(owner, repo, branch), "contents");
  if (isApiError(treeResponse)) {
    if (treeResponse.kind === "rate-limit") {
      return treeResponse;
    }
    log(`discovery: ${owner}/${repo} skipped: ${treeResponse.kind}`);
    return [];
  }
  const treeBody = await readJson(treeResponse);
  if (!treeBody.ok) {
    log(`discovery: ${owner}/${repo} tree did not parse as JSON, skipped`);
    return [];
  }
  const tree = treeBody.value;
  const sources = sourcesFromTree(owner, repo, pathsFromTree(tree));
  if (sources.length > 0) {
    return sources;
  }
  if (isRecord(tree) && tree["truncated"] === true) {
    return directoriesFallback(github, owner, repo, branch, log);
  }
  log(`discovery: ${owner}/${repo} tree has no document folders`);
  return [];
}
