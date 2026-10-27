// SPDX-License-Identifier: Apache-2.0
/**
 * The scheduled catalogue index.
 *
 * A Cron Trigger runs this every 15 minutes: it discovers every
 * repository tagged `topic:canopy-graph`, lists each one's document
 * folders through the same discovery the live search uses, fetches and
 * validates every document, indexes the official registry in the same
 * run, and writes the catalogue into KV — `index:v1` (entries, no full
 * documents), one `doc:v1:*` key per document plus its README, and
 * `index:meta` with the run's accounting. The request path then serves
 * everything from KV and never spends GitHub quota on traffic.
 *
 * The run is budgeted (1,200 GitHub calls authenticated, 50 without a
 * token). When the budget, a rate limit or a failed discovery page stops
 * the run early, the previous entries of the repositories it could not
 * visit are carried over, so a short run never shrinks the catalogue;
 * only documents in visited repositories that are truly gone — and
 * repositories absent from a completed discovery — have their keys
 * deleted.
 */
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import type { ApiError, GitHub, Log } from "./github.js";
import { isApiError } from "./github.js";
import { isArray, isNumber, isRecord, readJson, stringField } from "./json.js";
import { CATALOGUE_TOPIC, discoverSources } from "./discovery.js";
import {
  type CatalogEntry,
  type DocumentSource,
  branchFromRepository,
  documentDirectory,
  loadDocumentWithReason,
  starsFromRepository,
  updatedFromRepository,
} from "./documents.js";
import { OFFICIAL_OWNER, OFFICIAL_REPO, OFFICIAL_REPOSITORY } from "./lib.js";
import {
  DOC_PREFIX,
  INDEX_KEY,
  META_KEY,
  docKey,
  readIndex,
  type IndexEntry,
  type IndexInvalid,
  type IndexMeta,
  type KV,
  type StoredDoc,
} from "./store.js";

/**
 * The cron schedule, mirrored in `wrangler.toml` `[triggers]`. The two
 * must change together: the config sets when the Worker wakes, this
 * constant tells the pages what to promise.
 */
export const INDEX_CRON = "*/15 * * * *";

/** Minutes between index builds; the Publish page renders this number. */
export const INDEX_CRON_MINUTES = 15;

/** Discovery reads GitHub's maximum page: 100 repositories per call. */
export const DISCOVERY_PAGE_SIZE = 100;

/**
 * GitHub caps search at 1,000 results: 10 pages of 100, then discovery
 * is complete by definition, with `truncated` set in the meta.
 */
export const DISCOVERY_MAX_PAGES = 10;

/** GitHub calls one authenticated run may spend, at most. */
export const AUTHENTICATED_BUDGET = 1200;

/** GitHub calls one run without `GITHUB_TOKEN` may spend, at most. */
export const UNAUTHENTICATED_BUDGET = 50;

/**
 * `index:v1` stays far under KV's 25 MiB value limit: past 5 MiB every
 * description is cut to 280 characters first.
 */
export const INDEX_MAX_BYTES = 5 * 1024 * 1024;

/** Descriptions are cut to this length when the index would overshoot. */
export const DESCRIPTION_TRIM = 280;

/** The discovery query: the catalogue topic, best starred first. */
export function discoveryUrl(page: number): string {
  const params = new URLSearchParams({
    q: `topic:${CATALOGUE_TOPIC}`,
    sort: "stars",
    order: "desc",
    per_page: String(DISCOVERY_PAGE_SIZE),
    page: String(page),
  });
  return `https://api.github.com/search/repositories?${params.toString()}`;
}

export interface IndexerOptions {
  /** The GitHub transport, already wired with the token when there is one. */
  github: GitHub;
  /** The index namespace the catalogue reads. */
  index: KV;
  /** True when the run authenticates; false caps the budget at 50 calls. */
  authenticated: boolean;
  /** Budget override. Production never sets it; the tests force cut-offs. */
  budget?: number;
  /** Clock override; production reads the time. */
  now?: () => number;
  /** Where dropped or skipped things are noted; defaults to no-op. */
  log?: Log;
}

/** Thrown past the budget or a rate limit: stop the run, keep the rest. */
class StopRun {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

/** One repository as the discovery search describes it. */
interface RepoHit {
  owner: string;
  repo: string;
  branch: string;
  stars: number | null;
  updated: string | null;
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
  const stars = value["stargazers_count"];
  const updated = value["updated_at"];
  return {
    owner,
    repo,
    branch: stringField(value, "default_branch").trim() || "HEAD",
    stars: isNumber(stars) ? stars : null,
    updated: typeof updated === "string" && /^\d{4}-\d{2}-\d{2}/.test(updated)
      ? updated.slice(0, 10)
      : null,
  };
}

/** The repository key carry-over compares: lowercase `owner/repo`. */
function repoKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** The distinct node kinds of a graph document, sorted; empty otherwise. */
function nodeKinds(kind: DocumentKind, document: JsonValue): string[] {
  if (kind !== "graph" || !isRecord(document) || !isArray(document["nodes"])) {
    return [];
  }
  const kinds = new Set<string>();
  for (const node of document["nodes"]) {
    if (isRecord(node)) {
      const kindName = stringField(node, "kind");
      if (kindName !== "") {
        kinds.add(kindName);
      }
    }
  }
  return [...kinds].sort();
}

/** One index entry from a loaded document and what the listing knew. */
function entryFromLoaded(
  source: DocumentSource,
  loaded: CatalogEntry,
  official: boolean,
): IndexEntry {
  const doc = loaded.doc;
  return {
    kind: source.kind,
    owner: source.owner,
    repo: source.repo,
    slug: source.slug,
    name: doc.name,
    description: doc.description,
    official,
    stars: doc.stars,
    updated: doc.updated,
    ref: source.ref ?? "",
    node_count: doc.nodeCount,
    kinds: nodeKinds(source.kind, loaded.document),
    harness_hint: doc.harnesses,
  };
}

/**
 * Serialize the index, cutting descriptions past 280 characters when the
 * value would overshoot the byte cap. Pure, so the tests pin the trim
 * without building a 5 MiB fixture.
 */
export function buildIndexPayload(
  entries: IndexEntry[],
  builtAt: string,
  maxBytes: number = INDEX_MAX_BYTES,
): string {
  const payload = JSON.stringify({ built_at: builtAt, entries });
  if (new TextEncoder().encode(payload).length <= maxBytes) {
    return payload;
  }
  const trimmed = entries.map((entry) =>
    entry.description.length > DESCRIPTION_TRIM
      ? { ...entry, description: entry.description.slice(0, DESCRIPTION_TRIM) }
      : entry
  );
  return JSON.stringify({ built_at: builtAt, entries: trimmed });
}

/** The directory names in a contents listing; anything unreadable is none. */
function listedDirectories(value: unknown): string[] {
  if (!isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (isRecord(entry) && entry["type"] === "dir") {
      const name = entry["name"];
      return typeof name === "string" ? [name] : [];
    }
    return [];
  });
}

/** What one `/repos/...` call tells the index: stars, updated, branch. */
interface RepoInfo {
  stars: number | null;
  updated: string | null;
  branch: string;
}

async function repoInfo(github: GitHub, repository: string): Promise<RepoInfo> {
  const blank: RepoInfo = { stars: null, updated: null, branch: "" };
  const response = await github.get(`https://api.github.com/repos/${repository}`, "contents");
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

interface RunState {
  github: GitHub;
  log: Log;
  entries: IndexEntry[];
  documents: Map<string, StoredDoc>;
  invalid: IndexInvalid[];
  /** Repositories fully processed: their previous entries are replaced. */
  visited: Set<string>;
  /** Repositories the discovery search returned, visited or not. */
  discovered: Set<string>;
  truncated: boolean;
}

/** Load one source into the run, recording drops in the invalid list. */
async function indexSource(
  state: RunState,
  source: DocumentSource,
  official: boolean,
): Promise<void> {
  const loaded = await loadDocumentWithReason(state.github, source, state.log);
  if (loaded.kind === "doc") {
    state.entries.push(entryFromLoaded(source, loaded.entry, official));
    state.documents.set(
      docKey(source.kind, source.owner, source.repo, source.slug),
      { document: loaded.entry.document, readme: loaded.entry.doc.readme },
    );
    return;
  }
  if (loaded.kind !== "absent") {
    const error = loaded as ApiError;
    if (error.kind === "rate-limit") {
      throw new StopRun(`rate-limited loading ${source.owner}/${source.repo} ${source.slug}`);
    }
    state.log(`indexer: ${source.owner}/${source.repo} ${source.slug} failed: ${error.kind}`);
    state.invalid.push({
      repo: `${source.owner}/${source.repo}`,
      slug: source.slug,
      reason: `github ${error.kind}`,
    });
    return;
  }
  if (loaded.reason !== null) {
    state.invalid.push({
      repo: `${source.owner}/${source.repo}`,
      slug: source.slug,
      reason: loaded.reason,
    });
  }
}

/**
 * Index the official registry: both `registry/` directories, every folder
 * through validation. A missing directory is an empty kind, not an
 * outage; anything else unreadable logs and contributes nothing.
 */
async function indexOfficial(state: RunState): Promise<void> {
  const slugs: Record<DocumentKind, string[]> = { graph: [], node: [] };
  for (const kind of ["graph", "node"] as const) {
    const listing = await state.github.get(
      `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/contents/registry/${kind}s`,
      "contents",
    );
    if (isApiError(listing)) {
      if (listing.kind === "rate-limit") {
        throw new StopRun("rate-limited listing the official registry");
      }
      if (listing.kind !== "not-found") {
        state.log(`indexer: official registry/${kind}s failed: ${listing.kind}`);
      }
      continue;
    }
    const body = await readJson(listing);
    if (!body.ok) {
      state.log(`indexer: official registry/${kind}s did not parse as JSON`);
      continue;
    }
    slugs[kind] = listedDirectories(body.value);
  }
  const info = await repoInfo(state.github, OFFICIAL_REPOSITORY);
  for (const kind of ["graph", "node"] as const) {
    for (const slug of slugs[kind]) {
      await indexSource(
        state,
        {
          owner: OFFICIAL_OWNER,
          repo: OFFICIAL_REPO,
          directory: documentDirectory(OFFICIAL_OWNER, OFFICIAL_REPO, kind, slug),
          kind,
          slug,
          stars: info.stars,
          updated: info.updated,
          ref: info.branch,
        },
        true,
      );
    }
  }
}

/** Index one community repository discovered by the topic search. */
async function indexRepo(state: RunState, hit: RepoHit): Promise<void> {
  const sources = await discoverSources(state.github, hit.owner, hit.repo, hit.branch, state.log);
  if (isApiError(sources)) {
    throw new StopRun(`rate-limited discovering ${hit.owner}/${hit.repo}`);
  }
  for (const source of sources) {
    source.stars = hit.stars;
    source.updated = hit.updated;
    source.ref = hit.branch;
    await indexSource(state, source, false);
  }
}

/** Run one repository with rollback: a stop discards its partial entries. */
async function indexRepoAtomic(state: RunState, hit: RepoHit): Promise<boolean> {
  const entriesBefore = state.entries.length;
  const documentsBefore = new Map(state.documents);
  const invalidBefore = state.invalid.length;
  try {
    await indexRepo(state, hit);
  } catch (error) {
    state.entries.length = entriesBefore;
    state.documents = documentsBefore;
    state.invalid.length = invalidBefore;
    if (error instanceof StopRun) {
      state.log(`indexer: stopped at ${hit.owner}/${hit.repo}: ${error.reason}`);
      return false;
    }
    throw error;
  }
  return true;
}

/**
 * Build the index. Discovery pages the topic search to GitHub's 1,000
 * cap; every repository is indexed atomically, and a stop — budget,
 * rate limit, unreadable page — ends the run with carry-over rather
 * than a shrunken catalogue.
 */
export async function runIndexer(options: IndexerOptions): Promise<IndexMeta> {
  const now = options.now ?? Date.now;
  const started = now();
  const log = options.log ?? (() => undefined);
  const budget = options.budget ?? (options.authenticated ? AUTHENTICATED_BUDGET : UNAUTHENTICATED_BUDGET);
  let calls = 0;
  const guarded: GitHub = {
    get: async (url, cacheClass) => {
      if (calls >= budget) {
        throw new StopRun(`budget of ${budget} GitHub calls reached`);
      }
      calls += 1;
      return options.github.get(url, cacheClass);
    },
  };
  const state: RunState = {
    github: guarded,
    log,
    entries: [],
    documents: new Map(),
    invalid: [],
    visited: new Set(),
    discovered: new Set(),
    truncated: false,
  };
  const officialKey = repoKey(OFFICIAL_OWNER, OFFICIAL_REPO);
  const previous = await readIndex(options.index).catch(() => null);
  const previousEntries = previous?.entries ?? [];

  let discoveryComplete = false;
  try {
    const officialBefore = { entries: state.entries.length, invalid: state.invalid.length };
    const officialDocs = new Map(state.documents);
    try {
      await indexOfficial(state);
      state.visited.add(officialKey);
    } catch (error) {
      state.entries.length = officialBefore.entries;
      state.documents = officialDocs;
      state.invalid.length = officialBefore.invalid;
      throw error;
    }

    let page = 1;
    const queue: RepoHit[] = [];
    const queued = new Set<string>([officialKey]);
    let paging = true;
    while (paging && page <= DISCOVERY_MAX_PAGES) {
      const response = await guarded.get(discoveryUrl(page), "search");
      if (isApiError(response)) {
        if (response.kind === "rate-limit") {
          throw new StopRun("rate-limited discovering repositories");
        }
        log(`indexer: discovery page ${page} failed: ${response.kind}`);
        paging = false;
        break;
      }
      const body = await readJson(response);
      if (!body.ok || !isRecord(body.value) || !isArray(body.value["items"])) {
        log(`indexer: discovery page ${page} did not parse as JSON`);
        paging = false;
        break;
      }
      const items = body.value["items"];
      for (const item of items) {
        const hit = hitOf(item);
        if (hit === null) {
          continue;
        }
        const key = repoKey(hit.owner, hit.repo);
        state.discovered.add(key);
        if (!queued.has(key)) {
          queued.add(key);
          queue.push(hit);
        }
      }
      if (items.length < DISCOVERY_PAGE_SIZE) {
        discoveryComplete = true;
        paging = false;
      } else if (page >= DISCOVERY_MAX_PAGES) {
        discoveryComplete = true;
        state.truncated = true;
        paging = false;
      } else {
        page += 1;
      }
    }

    for (const hit of queue) {
      const done = await indexRepoAtomic(state, hit);
      if (!done) {
        state.truncated = true;
        break;
      }
      state.visited.add(repoKey(hit.owner, hit.repo));
    }
  } catch (error) {
    if (!(error instanceof StopRun)) {
      throw error;
    }
    log(`indexer: ${error.reason}`);
    state.truncated = true;
  }

  // Carry-over: the previous entries of repositories this run could not
  // visit stay, in their previous order, unless a completed discovery
  // proves the repository unlisted the topic and is truly gone.
  for (const entry of previousEntries) {
    const key = repoKey(entry.owner, entry.repo);
    if (state.visited.has(key)) {
      continue;
    }
    if (discoveryComplete && !entry.official && !state.discovered.has(key)) {
      continue;
    }
    state.entries.push(entry);
  }

  const builtAt = new Date(started).toISOString();
  for (const [key, stored] of state.documents) {
    await options.index.put(key, JSON.stringify(stored));
  }
  await options.index.put(INDEX_KEY, buildIndexPayload(state.entries, builtAt));
  const meta: IndexMeta = {
    built_at: builtAt,
    duration_ms: Math.max(0, now() - started),
    calls,
    repos_seen: state.visited.size,
    documents: state.entries.length,
    invalid: state.invalid,
    truncated: state.truncated,
    authenticated: options.authenticated,
  };
  await options.index.put(META_KEY, JSON.stringify(meta));

  // Vanished documents: keys no live entry points at anymore. Carried
  // entries keep their keys by construction.
  const live = new Set<string>([
    ...state.documents.keys(),
    ...state.entries.map((entry) => docKey(entry.kind, entry.owner, entry.repo, entry.slug)),
  ]);
  let cursor: string | undefined;
  do {
    const listed = await options.index.list({ prefix: DOC_PREFIX, cursor });
    for (const key of listed.keys) {
      if (!live.has(key.name)) {
        await options.index.delete(key.name);
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor !== undefined);

  return meta;
}
