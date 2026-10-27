// SPDX-License-Identifier: Apache-2.0
/**
 * Community search for graphs.univerlab.org.
 *
 * One GitHub Search call over `topic:canopy-graph` plus the user's free
 * text, then one git-trees call per repository to find document folders.
 * GitHub's own ordering (stargazers or updated) is preserved exactly: the
 * catalogue never re-sorts. The document cap keeps a request bounded, and a
 * bounded-away page is reported with `truncated: true`.
 */
import type { DocumentKind } from "../../../src/schema.js";
import type { ApiError, GitHub, Log } from "./github.js";
import { isApiError } from "./github.js";
import { isArray, isNumber, isRecord, isString, readJson, stringField } from "./json.js";
import type { DocumentSource } from "./documents.js";
import {
  type CatalogEntry,
  type Doc,
  documentDirectory,
  pathsFromTree,
  sourcesFromTree,
} from "./documents.js";
import { loadDocument } from "./documents.js";

/** Repositories per page, matching the spec's 20-per-page contract. */
export const SEARCH_PAGE_SIZE = 20;

/** Upper bound on documents one search will render. */
export const SEARCH_DOC_CAP = 20;

export type SearchSort = "top" | "new";

export interface SearchInput {
  q: string;
  sort: SearchSort;
  page: number;
}

export interface SearchOutcome {
  items: Doc[];
  q: string;
  sort: SearchSort;
  page: number;
  total: number;
  truncated: boolean;
}

/** One repository as the Search API describes it. */
interface RepoHit {
  owner: string;
  repo: string;
  defaultBranch: string;
  stars: number | null;
}

function hitOf(value: unknown): RepoHit | null {
  if (!isRecord(value)) {
    return null;
  }
  const owner = isRecord(value["owner"]) ? stringField(value["owner"], "login") : "";
  const repo = stringField(value, "name");
  if (owner === "" || repo === "") {
    return null;
  }
  const stars = isNumber(value["stargazers_count"]) ? value["stargazers_count"] : null;
  return {
    owner,
    repo,
    defaultBranch: stringField(value, "default_branch").trim() || "HEAD",
    stars,
  };
}

export function searchUrl(options: SearchInput): string {
  const text = options.q.trim();
  const q = `topic:canopy-graph${text === "" ? "" : ` ${text}`}`;
  const params = new URLSearchParams({
    q,
    sort: options.sort === "new" ? "updated" : "stars",
    order: "desc",
    per_page: String(SEARCH_PAGE_SIZE),
    page: String(options.page),
  });
  return `https://api.github.com/search/repositories?${params.toString()}`;
}

/** The dirs of `graphs/`/`nodes/`, the fallback when a tree is truncated. */
async function directoriesFallback(
  github: GitHub,
  owner: string,
  repo: string,
  branch: string,
  log: Log,
): Promise<DocumentSource[]> {
  const sources: DocumentSource[] = [];
  const prefix = branch === "" ? "" : `?ref=${encodeURIComponent(branch)}`;
  for (const kind of ["graph", "node"] as const) {
    const listing = await github.get(
      `https://api.github.com/repos/${owner}/${repo}/contents/${kind}s${prefix}`,
      "contents",
    );
    if (isApiError(listing)) {
      if (listing.kind !== "not-found") {
        log(`search: ${owner}/${repo} listing ${kind}s failed: ${listing.kind}`);
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
          directory: documentDirectory(owner, repo, kind, entry["name"]),
          kind: kind as DocumentKind,
          slug: entry["name"],
          stars: null,
        });
      }
    }
  }
  return sources;
}

/**
 * Community search. Bounded by design: one search call, at most
 * `SEARCH_PAGE_SIZE` tree calls (one fewer when the tree is truncated),
 * at most `SEARCH_DOC_CAP` documents.
 */
export async function searchCommunity(
  github: GitHub,
  options: SearchInput,
  log: Log,
): Promise<SearchOutcome | ApiError> {
  const response = await github.get(searchUrl(options), "search");
  if (isApiError(response)) {
    return response;
  }
  const body = await readJson(response);
  if (!body.ok || !isRecord(body.value)) {
    return {
      kind: "upstream",
      message: "GitHub search answered an unexpected shape",
      status: 502,
    };
  }
  const payload = body.value;
  const items = payload["items"];
  if (!isArray(items)) {
    return {
      kind: "upstream",
      message: "GitHub search answered an unexpected shape",
      status: 502,
    };
  }
  const total = isNumber(payload["total_count"]) ? payload["total_count"] : 0;

  const entries: CatalogEntry[] = [];
  let truncated = false;
  for (const item of items.slice(0, SEARCH_PAGE_SIZE)) {
    const hit = hitOf(item);
    if (hit === null) {
      continue;
    }
    const treeResponse = await github.get(
      `https://api.github.com/repos/${hit.owner}/${hit.repo}/git/trees/${encodeURIComponent(hit.defaultBranch)}?recursive=1`,
      "contents",
    );
    if (isApiError(treeResponse)) {
      if (treeResponse.kind === "rate-limit") {
        return treeResponse;
      }
      log(`search: ${hit.owner}/${hit.repo} skipped: ${treeResponse.kind}`);
      continue;
    }
    const treeBody = await readJson(treeResponse);
    if (!treeBody.ok) {
      log(`search: ${hit.owner}/${hit.repo} tree did not parse as JSON, skipped`);
      continue;
    }
    const tree = treeBody.value;
    let sources = sourcesFromTree(hit.owner, hit.repo, pathsFromTree(tree));
    const truncatedTree = isRecord(tree) && tree["truncated"] === true;
    if (truncatedTree && sources.length === 0) {
      sources = await directoriesFallback(github, hit.owner, hit.repo, hit.defaultBranch, log);
    }
    if (sources.length === 0) {
      log(`search: ${hit.owner}/${hit.repo} tree has no document folders`);
      continue;
    }
    if (sources.length > SEARCH_DOC_CAP - entries.length) {
      truncated = true;
      sources = sources.slice(0, Math.max(0, SEARCH_DOC_CAP - entries.length));
    }
    for (const source of sources) {
      source.stars = hit.stars;
      const loaded = await loadDocument(github, source, log);
      if (loaded.kind === "doc") {
        entries.push(loaded.entry);
      }
      if (entries.length >= SEARCH_DOC_CAP) {
        break;
      }
    }
    if (entries.length >= SEARCH_DOC_CAP) {
      truncated = true;
      break;
    }
  }

  return {
    items: entries.map((entry) => entry.doc),
    q: options.q,
    sort: options.sort,
    page: options.page,
    total,
    truncated,
  };
}
