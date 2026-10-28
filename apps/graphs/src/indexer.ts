// SPDX-License-Identifier: Apache-2.0
/**
 * The scheduled catalogue index.
 *
 * A Cron Trigger runs this every 15 minutes: it reads the community
 * removal list (`blocked.json` in the official repository) first,
 * discovers every repository tagged `topic:canopy-graph`, and reads each
 * repository's document folders — one GraphQL answer per repository when it
 * has a token, folder by folder over REST when it does not — validating
 * every document and indexing the official repository in the same run. It
 * writes the catalogue into KV — `index:v1` (entries, no full documents),
 * one `doc:v1:*` key per document plus its README, one `blocked:v1:*` key
 * per blocked entry, and `index:meta` with the run's accounting. The
 * official `patterns/` directory lands in `patterns:v1` plus one
 * `pattern:v1:*` key per page; a malformed page or a figure that fails the
 * graph schema is skipped with a reason in the run's invalid list, never a
 * failed run. A blocked document or repository is never written to
 * `doc:v1:*`, and a stale `doc:v1:*` key is deleted. The request path then
 * serves everything from KV and never spends GitHub quota on traffic.
 *
 * The run is budgeted: 45 outbound subrequests, which is the Workers Free
 * plan's 50 minus a margin. An authenticated run reads each repository's
 * whole catalogue — every document, README, pattern page and figure — in one
 * GitHub GraphQL request, so the official repository costs one subrequest
 * and the machine-generated discovery search the rest; without a token it
 * falls back to the REST path. When the budget, a rate limit or a failed
 * discovery page stops the run early, the previous entries of the
 * repositories it could not visit are carried over, so a short run never
 * shrinks the catalogue; only documents in visited repositories that are
 * truly gone — and repositories absent from a completed discovery — have
 * their keys deleted. The meta records how many subrequests the run spent
 * and why it stopped, so a truncated run is visible from outside.
 */
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import {
  BLOCKED_PREFIX,
  blockedDocument,
  blockedKey,
  blockedRepository,
  type BlockedEntry,
} from "./blocked.js";
import type { ApiError, GitHub, Log } from "./github.js";
import { isApiError } from "./github.js";
import { isArray, isNumber, isRecord, readJson, stringField } from "./json.js";
import { CATALOGUE_TOPIC, discoverSources } from "./discovery.js";
import {
  type CatalogEntry,
  type DocumentLoad,
  type DocumentSource,
  loadDocumentWithReason,
} from "./documents.js";
import { OFFICIAL_OWNER, OFFICIAL_REPO } from "./lib.js";
import {
  type PatternEntry,
  type StoredPattern,
  PatternsHalt,
  fetchOfficialPatterns,
} from "./patterns.js";
import { officialSources, readBlocked } from "./rest.js";
import {
  documentOfSnapshot,
  fetchSnapshot,
  officialCatalogueOf,
  snapshotSources,
} from "./snapshot.js";
import {
  DOC_PREFIX,
  INDEX_KEY,
  META_KEY,
  PATTERN_PREFIX,
  PATTERNS_KEY,
  docKey,
  patternKey,
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
 * GitHub caps search at 1,000 results: 10 pages of 100, then the run stops
 * paging with `truncated` set. Discovery stays incomplete — repositories
 * beyond the cap were not proven gone, so their previous entries carry
 * over instead of being deleted.
 */
export const DISCOVERY_MAX_PAGES = 10;

/**
 * Outbound subrequests one run may spend, at most: GitHub REST, GraphQL and
 * the discovery search alike, with Cache API operations counting too (which
 * is why the cron path builds its transport with `cache: null`). The plan
 * allows 50 per invocation; 45 leaves room for the KV writes and the answer.
 */
export const SUBREQUEST_BUDGET = 45;

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
  /**
   * True when the run authenticates. GitHub's GraphQL API needs a token, so
   * this picks the transport as well as the account: authenticated runs take
   * each repository in one GraphQL request, unauthenticated runs use REST.
   */
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

interface RunState {
  github: GitHub;
  log: Log;
  /** True when each repository arrives as one GraphQL snapshot. */
  graphql: boolean;
  entries: IndexEntry[];
  documents: Map<string, StoredDoc>;
  patterns: PatternEntry[];
  patternDocs: Map<string, StoredPattern>;
  /** True once the official `patterns/` directory read end to end. */
  patternsComplete: boolean;
  invalid: IndexInvalid[];
  /** The entries `blocked.json` held at the start of this run. */
  blocked: BlockedEntry[];
  /** Repositories fully processed: their previous entries are replaced. */
  visited: Set<string>;
  /** Repositories the discovery search returned, visited or not. */
  discovered: Set<string>;
  truncated: boolean;
}

/** How one document folder is read, whatever the transport. */
type DocumentLoader = (source: DocumentSource) => Promise<DocumentLoad | ApiError>;

/** Load one source into the run, recording drops in the invalid list. */
async function indexSource(
  state: RunState,
  source: DocumentSource,
  official: boolean,
  load: DocumentLoader,
): Promise<void> {
  const block = blockedDocument(
    state.blocked,
    source.kind,
    source.owner,
    source.repo,
    source.slug,
  );
  if (block !== null) {
    state.log(
      `indexer: blocked ${source.kind} ${source.owner}/${source.repo}/${source.slug}: ${block.reason}`,
    );
    return;
  }
  const loaded = await load(source);
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
 * Index the official repository over REST, without a token: both `graphs/`
 * and `nodes/` directories, every folder through validation. A missing
 * directory is an empty kind, not an outage; anything else unreadable logs
 * and contributes nothing.
 */
async function indexOfficialRest(state: RunState): Promise<void> {
  const repoBlock = blockedRepository(state.blocked, OFFICIAL_OWNER, OFFICIAL_REPO);
  if (repoBlock !== null) {
    state.log(`indexer: blocked the official repository: ${repoBlock.reason}`);
    return;
  }
  const read = await officialSources(state.github, state.log);
  if (read.kind === "halt") {
    throw new StopRun(read.reason);
  }
  for (const source of read.sources) {
    await indexSource(
      state,
      source,
      true,
      (one) => loadDocumentWithReason(state.github, one, state.log),
    );
  }
}

/**
 * Index the official repository from one GraphQL answer: the removal list,
 * every document and README, and every pattern page with its figure, all in
 * the run's second subrequest. Returns whether the removal list was readable,
 * so the caller keeps the previous blocks when it was not.
 */
async function indexOfficialSnapshot(state: RunState): Promise<boolean> {
  const snapshot = await fetchSnapshot(state.github, OFFICIAL_OWNER, OFFICIAL_REPO, state.log);
  if (isApiError(snapshot)) {
    throw new StopRun(
      snapshot.kind === "rate-limit"
        ? "rate-limited reading the official repository"
        : `official repository ${snapshot.kind}`,
    );
  }
  if (snapshot.tree === null) {
    // No tree is a repository the answer could not read: stopping here keeps
    // the previous entries instead of replacing them with nothing.
    throw new StopRun("official repository unavailable");
  }
  const catalogue = await officialCatalogueOf(snapshot, state.log);
  if (catalogue.blocked !== null) {
    state.blocked = catalogue.blocked;
  }
  for (const item of catalogue.documents) {
    await indexSource(state, item.source, true, () => documentOfSnapshot(item, state.log));
  }
  state.invalid.push(...catalogue.patterns.invalid);
  state.patterns = catalogue.patterns.entries;
  state.patternDocs = catalogue.patterns.documents;
  state.patternsComplete = catalogue.patterns.complete;
  return catalogue.blocked !== null;
}

/** Index one community repository over REST: a tree, then two calls per folder. */
async function indexRepoRest(state: RunState, hit: RepoHit): Promise<void> {
  const sources = await discoverSources(state.github, hit.owner, hit.repo, hit.branch, state.log);
  if (isApiError(sources)) {
    throw new StopRun(`rate-limited discovering ${hit.owner}/${hit.repo}`);
  }
  for (const source of sources) {
    source.stars = hit.stars;
    source.updated = hit.updated;
    source.ref = hit.branch;
    await indexSource(
      state,
      source,
      false,
      (one) => loadDocumentWithReason(state.github, one, state.log),
    );
  }
}

/**
 * Index one community repository discovered by the topic search. The
 * authenticated run takes its whole catalogue in one GraphQL request; the
 * REST path discovers the folders first. Returns false when the repository
 * could not be read, so its previous entries carry over.
 */
async function indexRepo(state: RunState, hit: RepoHit): Promise<boolean> {
  const repoBlock = blockedRepository(state.blocked, hit.owner, hit.repo);
  if (repoBlock !== null) {
    // Skip before the snapshot call: a blocked repository costs one discovery
    // hit and no contents call, and still counts as visited so its previous
    // entries are dropped.
    state.log(`indexer: blocked repository ${hit.owner}/${hit.repo}: ${repoBlock.reason}`);
    return true;
  }
  if (!state.graphql) {
    await indexRepoRest(state, hit);
    return true;
  }
  const snapshot = await fetchSnapshot(state.github, hit.owner, hit.repo, state.log);
  if (isApiError(snapshot)) {
    if (snapshot.kind === "rate-limit") {
      throw new StopRun(`rate-limited reading ${hit.owner}/${hit.repo}`);
    }
    state.log(`indexer: ${hit.owner}/${hit.repo} unavailable: ${snapshot.kind}`);
    return false;
  }
  if (snapshot.tree === null) {
    state.log(`indexer: ${hit.owner}/${hit.repo} answered no tree; keeping its previous entries`);
    return false;
  }
  for (const item of snapshotSources(snapshot, hit.owner, hit.repo)) {
    await indexSource(state, item.source, false, () => documentOfSnapshot(item, state.log));
  }
  return true;
}

/** What one community repository's visit proved. */
type RepoOutcome =
  | { status: "indexed" }
  | { status: "unavailable" }
  | { status: "stopped"; reason: string };

/** Run one repository with rollback: a stop discards its partial entries. */
async function indexRepoAtomic(state: RunState, hit: RepoHit): Promise<RepoOutcome> {
  const entriesBefore = state.entries.length;
  const documentsBefore = new Map(state.documents);
  const invalidBefore = state.invalid.length;
  try {
    return { status: (await indexRepo(state, hit)) ? "indexed" : "unavailable" };
  } catch (error) {
    state.entries.length = entriesBefore;
    state.documents = documentsBefore;
    state.invalid.length = invalidBefore;
    if (error instanceof StopRun) {
      state.log(`indexer: stopped at ${hit.owner}/${hit.repo}: ${error.reason}`);
      return { status: "stopped", reason: error.reason };
    }
    throw error;
  }
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
  const budget = options.budget ?? SUBREQUEST_BUDGET;
  let calls = 0;
  /** Spend one subrequest, or stop the run when the budget is gone. */
  const spend = (): void => {
    if (calls >= budget) {
      throw new StopRun(`budget of ${budget} subrequests reached`);
    }
    calls += 1;
  };
  const guarded: GitHub = {
    get: async (url, cacheClass) => {
      spend();
      return options.github.get(url, cacheClass);
    },
    graphql: async (query, variables) => {
      spend();
      return options.github.graphql(query, variables);
    },
  };
  const state: RunState = {
    github: guarded,
    log,
    graphql: options.authenticated,
    entries: [],
    documents: new Map(),
    patterns: [],
    patternDocs: new Map(),
    patternsComplete: false,
    invalid: [],
    blocked: [],
    visited: new Set(),
    discovered: new Set(),
    truncated: false,
  };
  const officialKey = repoKey(OFFICIAL_OWNER, OFFICIAL_REPO);
  const previous = await readIndex(options.index).catch(() => null);
  const previousEntries = previous?.entries ?? [];

  let blocksLoaded = false;
  let discoveryComplete = false;
  let stopped: string | null = null;
  try {
    // The removal list and the official catalogue in one request when the run
    // authenticates: nothing is indexed before the run knows what must not be,
    // and the whole repository costs a single subrequest. Without a token the
    // list is the run's first REST call, so the same order holds.
    const officialEntries = state.entries.length;
    const officialDocuments = new Map(state.documents);
    const officialInvalid = state.invalid.length;
    try {
      if (options.authenticated) {
        blocksLoaded = await indexOfficialSnapshot(state);
      } else {
        const read = await readBlocked(guarded, log);
        if (read.kind === "halt") {
          throw new StopRun(read.reason);
        }
        if (read.kind === "read") {
          state.blocked = read.entries;
          blocksLoaded = true;
        }
        await indexOfficialRest(state);
      }
    } catch (error) {
      state.entries.length = officialEntries;
      state.documents = officialDocuments;
      state.invalid.length = officialInvalid;
      throw error;
    }
    state.visited.add(officialKey);

    // The REST path reads the pattern pages after the documents, one file per
    // call. A halt (a rate limit mid-read) or a spent budget stops the run like
    // any other stop — truncated with carry-over, the catalogue still
    // committed — and the previous patterns stay because this run never read
    // them end to end; an unreadable directory keeps them too instead of
    // emptying them. The snapshot path already holds them.
    if (!options.authenticated) {
      const patternsInvalid = state.invalid.length;
      try {
        const read = await fetchOfficialPatterns(state.github, state.log);
        state.invalid.push(...read.invalid);
        if (read.complete) {
          state.patterns = read.entries;
          state.patternDocs = read.documents;
          state.patternsComplete = true;
        }
      } catch (error) {
        state.invalid.length = patternsInvalid;
        if (error instanceof PatternsHalt) {
          throw new StopRun(error.reason);
        }
        throw error;
      }
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
        state.truncated = true;
        paging = false;
      } else {
        page += 1;
      }
    }

    for (const hit of queue) {
      const outcome = await indexRepoAtomic(state, hit);
      if (outcome.status === "stopped") {
        stopped = outcome.reason;
        state.truncated = true;
        break;
      }
      if (outcome.status === "unavailable") {
        // Unread, not empty: its previous entries carry over.
        state.truncated = true;
        continue;
      }
      state.visited.add(repoKey(hit.owner, hit.repo));
    }
  } catch (error) {
    if (!(error instanceof StopRun)) {
      throw error;
    }
    log(`indexer: ${error.reason}`);
    stopped = error.reason;
    state.truncated = true;
  }

  // Carry-over: the previous entries of repositories this run could not
  // visit stay, in their previous order, unless a completed discovery
  // proves the repository unlisted the topic and is truly gone — or the
  // removal list now blocks them, which a short run must not resurrect.
  for (const entry of previousEntries) {
    const key = repoKey(entry.owner, entry.repo);
    if (state.visited.has(key)) {
      continue;
    }
    if (discoveryComplete && !entry.official && !state.discovered.has(key)) {
      continue;
    }
    if (
      blockedDocument(state.blocked, entry.kind, entry.owner, entry.repo, entry.slug) !== null
    ) {
      continue;
    }
    state.entries.push(entry);
  }

  const builtAt = new Date(started).toISOString();
  for (const [key, stored] of state.documents) {
    await options.index.put(key, JSON.stringify(stored));
  }
  await options.index.put(INDEX_KEY, buildIndexPayload(state.entries, builtAt));

  // The pattern pages, only from a run that read them end to end: a short
  // run keeps the previous `patterns:v1` and its keys untouched.
  if (state.patternsComplete) {
    for (const [slug, stored] of state.patternDocs) {
      await options.index.put(patternKey(slug), JSON.stringify(stored));
    }
    await options.index.put(PATTERNS_KEY, JSON.stringify({ built_at: builtAt, entries: state.patterns }));
    const livePatterns = new Set([...state.patternDocs.keys()].map((slug) => patternKey(slug)));
    let patternCursor: string | undefined;
    do {
      const listed = await options.index.list({ prefix: PATTERN_PREFIX, cursor: patternCursor });
      for (const key of listed.keys) {
        if (!livePatterns.has(key.name)) {
          await options.index.delete(key.name);
        }
      }
      patternCursor = listed.list_complete ? undefined : listed.cursor;
    } while (patternCursor !== undefined);
  }

  // The removal list, one key per entry, so the request path can answer a
  // block without reading the whole file. Only a list that was actually
  // read replaces the keys: a failure keeps the previous blocks in force.
  const liveBlocks = new Set<string>();
  for (const entry of state.blocked) {
    const key = blockedKey(entry);
    if (key === null) {
      continue;
    }
    liveBlocks.add(key);
    await options.index.put(key, JSON.stringify(entry));
  }
  if (blocksLoaded) {
    let blocksCursor: string | undefined;
    do {
      const listed = await options.index.list({ prefix: BLOCKED_PREFIX, cursor: blocksCursor });
      for (const key of listed.keys) {
        if (!liveBlocks.has(key.name)) {
          await options.index.delete(key.name);
        }
      }
      blocksCursor = listed.list_complete ? undefined : listed.cursor;
    } while (blocksCursor !== undefined);
  }

  const meta: IndexMeta = {
    built_at: builtAt,
    duration_ms: Math.max(0, now() - started),
    calls,
    subrequests: calls,
    repos_seen: state.visited.size,
    documents: state.entries.length,
    blocked: state.blocked.length,
    invalid: state.invalid,
    truncated: state.truncated,
    stopped,
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
