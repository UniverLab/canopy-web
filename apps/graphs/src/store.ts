// SPDX-License-Identifier: Apache-2.0
/**
 * The scheduled index in KV, and the request path's read side of it.
 *
 * The indexer (indexer.ts) writes three shapes: `index:v1` (one JSON
 * value with every listed entry, no full documents), one `doc:v1:*` key
 * per validated document plus its README, and `index:meta` with the
 * run's accounting — plus one `blocked:v1:*` key per `blocked.json`
 * entry, which the request path reads before the index, and the pattern
 * pages as `patterns:v1` (one JSON value with every listed pattern,
 * figures included) plus one `pattern:v1:*` key per page. Every page and
 * API answer reads through this module.
 * The index is memoised in the isolate for 60 seconds; documents and
 * meta are read fresh, one KV read each. Everything here is total: a
 * missing binding, a missing key or an unreadable value is `null`
 * (the cold start), never an exception.
 */
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import {
  blockedDocKey,
  blockedRepoKey,
  parseBlockedValue,
  type BlockedEntry,
} from "./blocked.js";
import { isArray, isNumber, isRecord, isString, parseJson, stringField } from "./json.js";
import type { PatternEntry, PatternRef, PatternSource, StoredPattern } from "./patterns.js";

export type { BlockedEntry } from "./blocked.js";

/**
 * The smallest KV surface the catalogue needs. The production binding
 * satisfies it, and the tests inject a Map-backed fake.
 */
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

/** The one JSON value holding every listed entry. */
export const INDEX_KEY = "index:v1";

/** The run accounting the operator reads at `/api/index-status`. */
export const META_KEY = "index:meta";

/** Prefix of the per-document keys. */
export const DOC_PREFIX = "doc:v1:";

/**
 * One document's key. Owner and repo are lowercased — GitHub treats
 * `Acme/Things` and `acme/things` as one repository, and so does the
 * catalogue — while the slug keeps its case, exactly as listed.
 */
export function docKey(kind: DocumentKind, owner: string, repo: string, slug: string): string {
  return `${DOC_PREFIX}${kind}:${owner.toLowerCase()}/${repo.toLowerCase()}/${slug}`;
}

/** The one JSON value holding every pattern card the list renders. */
export const PATTERNS_KEY = "patterns:v1";

/** Prefix of the per-pattern keys, holding body, sources and figure. */
export const PATTERN_PREFIX = "pattern:v1:";

/** One pattern's key. Slugs match the slug rule, so no encoding is needed. */
export function patternKey(slug: string): string {
  return `${PATTERN_PREFIX}${slug}`;
}

/**
 * One catalogue row in the index: everything a listing renders, and the
 * coordinates a document page joins its `doc:v1:*` value to. It holds no
 * full documents and no README text.
 */
export interface IndexEntry {
  kind: DocumentKind;
  owner: string;
  repo: string;
  slug: string;
  name: string;
  description: string;
  official: boolean;
  stars: number | null;
  updated: string | null;
  ref: string;
  node_count?: number;
  kinds?: string[];
  harness_hint?: string[];
}

/** The `index:v1` value: when it was built, and every listed entry. */
export interface StoredIndex {
  built_at: string;
  entries: IndexEntry[];
}

/** The `doc:v1:*` value: the validated document plus its README text. */
export interface StoredDoc {
  document: JsonValue;
  readme: string;
}

/** The `patterns:v1` value: when it was built, and every listed pattern. */
export interface StoredPatterns {
  built_at: string;
  entries: PatternEntry[];
}

/** One document the indexer left out, with the reason it gives. */
export interface IndexInvalid {
  repo: string;
  slug: string;
  reason: string;
}

/** The `index:meta` value: the last run's accounting. */
export interface IndexMeta {
  built_at: string;
  duration_ms: number;
  /** Outbound subrequests the run made. Kept as `calls` for older readers. */
  calls: number;
  /**
   * Outbound subrequests the run made: GitHub REST, GraphQL and search, with
   * Cache API operations counted too. `calls` carries the same number.
   */
  subrequests: number;
  repos_seen: number;
  documents: number;
  /** How many `blocked.json` entries the run read. */
  blocked: number;
  invalid: IndexInvalid[];
  truncated: boolean;
  /** Why the run stopped early, or null when it read everything it reached. */
  stopped: string | null;
  authenticated: boolean;
  /**
   * KV puts the run actually issued, `index:meta` included. An unchanged
   * catalogue costs one; the fingerprint map's own put is not counted.
   */
  kv_writes: number;
  /** KV puts the run skipped because their value was already stored. */
  kv_skipped: number;
}

/** How long one isolate serves the index without re-reading KV. */
export const INDEX_MEMO_MS = 60_000;

let memo: { at: number; index: StoredIndex | null } | null = null;

let patternsMemo: { at: number; patterns: StoredPatterns | null } | null = null;

/** Forget the memoised indexes. The tests seed a fresh KV per case. */
export function resetIndexMemo(): void {
  memo = null;
  patternsMemo = null;
}

function entryOf(value: unknown): IndexEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value["kind"];
  if (kind !== "graph" && kind !== "node") {
    return null;
  }
  const owner = value["owner"];
  const repo = value["repo"];
  const slug = value["slug"];
  if (!isString(owner) || !isString(repo) || !isString(slug)) {
    return null;
  }
  const stars = value["stars"];
  const updated = value["updated"];
  const ref = value["ref"];
  if (stars !== null && !isNumber(stars)) {
    return null;
  }
  if (updated !== null && !isString(updated)) {
    return null;
  }
  if (!isString(ref)) {
    return null;
  }
  const entry: IndexEntry = {
    kind,
    owner,
    repo,
    slug,
    name: stringField(value, "name") || slug,
    description: stringField(value, "description"),
    official: value["official"] === true,
    stars,
    updated,
    ref,
  };
  if (isNumber(value["node_count"])) {
    entry.node_count = value["node_count"];
  }
  if (isArray(value["kinds"]) && value["kinds"].every(isString)) {
    entry.kinds = [...value["kinds"]];
  }
  if (isArray(value["harness_hint"]) && value["harness_hint"].every(isString)) {
    entry.harness_hint = [...value["harness_hint"]];
  }
  return entry;
}

/** Parse an `index:v1` body; malformed entries are dropped, never fatal. */
export function parseIndex(text: string): StoredIndex | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const built = parsed.value["built_at"];
  const entries = parsed.value["entries"];
  if (!isString(built) || !isArray(entries)) {
    return null;
  }
  return {
    built_at: built,
    entries: entries.flatMap((entry) => {
      const parsedEntry = entryOf(entry);
      return parsedEntry === null ? [] : [parsedEntry];
    }),
  };
}

/** Parse a `doc:v1:*` body: a validated document object plus README text. */
export function parseStoredDoc(text: string): StoredDoc | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const document = parsed.value["document"];
  const readme = parsed.value["readme"];
  if (!isRecord(document) || !isString(readme)) {
    return null;
  }
  return { document, readme };
}

function patternRefOf(value: unknown): PatternRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value["kind"];
  const slug = value["slug"];
  if ((kind !== "graph" && kind !== "node") || !isString(slug) || slug === "") {
    return null;
  }
  return { kind, slug };
}

function patternSourceOf(value: unknown): PatternSource | null {
  if (!isRecord(value)) {
    return null;
  }
  const title = value["title"];
  const url = value["url"];
  if (!isString(title) || title === "" || !isString(url) || url === "") {
    return null;
  }
  return { title, url };
}

function patternStatusOf(value: unknown): PatternEntry["status"] | null {
  return value === "standard" || value === "in use" || value === "experiment" ? value : null;
}

function patternEntryOf(value: unknown): PatternEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const slug = value["slug"];
  const title = value["title"];
  const summary = value["summary"];
  const status = patternStatusOf(value["status"]);
  const refs = value["implements"];
  const figure = value["figure"];
  if (
    !isString(slug) || slug === "" || !isString(title) || title === "" ||
    !isString(summary) || status === null || !isArray(refs) || !isRecord(figure)
  ) {
    return null;
  }
  const implementsRefs: PatternRef[] = [];
  for (const ref of refs) {
    const parsed = patternRefOf(ref);
    if (parsed === null) {
      return null;
    }
    implementsRefs.push(parsed);
  }
  return { slug, title, summary, status, implements: implementsRefs, figure };
}

/** Parse a `patterns:v1` body; malformed entries are dropped, never fatal. */
export function parsePatterns(text: string): StoredPatterns | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const built = parsed.value["built_at"];
  const entries = parsed.value["entries"];
  if (!isString(built) || !isArray(entries)) {
    return null;
  }
  return {
    built_at: built,
    entries: entries.flatMap((entry) => {
      const parsedEntry = patternEntryOf(entry);
      return parsedEntry === null ? [] : [parsedEntry];
    }),
  };
}

/** Parse a `pattern:v1:*` body: the page fields plus its figure. */
export function parseStoredPattern(text: string): StoredPattern | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const value = parsed.value;
  const title = value["title"];
  const summary = value["summary"];
  const status = patternStatusOf(value["status"]);
  const refs = value["implements"];
  const sources = value["sources"];
  const body = value["body"];
  const figure = value["figure"];
  if (
    !isString(title) || title === "" || !isString(summary) || status === null ||
    !isArray(refs) || !isArray(sources) || !isString(body) || !isRecord(figure)
  ) {
    return null;
  }
  const implementsRefs: PatternRef[] = [];
  for (const ref of refs) {
    const parsedRef = patternRefOf(ref);
    if (parsedRef === null) {
      return null;
    }
    implementsRefs.push(parsedRef);
  }
  const parsedSources: PatternSource[] = [];
  for (const source of sources) {
    const parsedSource = patternSourceOf(source);
    if (parsedSource === null) {
      return null;
    }
    parsedSources.push(parsedSource);
  }
  return {
    title,
    summary,
    status,
    implements: implementsRefs,
    sources: parsedSources,
    body,
    figure,
  };
}

function invalidOf(value: unknown): IndexInvalid | null {
  if (!isRecord(value)) {
    return null;
  }
  const repo = value["repo"];
  const slug = value["slug"];
  const reason = value["reason"];
  if (!isString(repo) || !isString(slug) || !isString(reason)) {
    return null;
  }
  return { repo, slug, reason };
}

/** Parse an `index:meta` body; anything off-shape is no meta at all. */
export function parseMeta(text: string): IndexMeta | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const value = parsed.value;
  const built = value["built_at"];
  const duration = value["duration_ms"];
  const calls = value["calls"];
  const repos = value["repos_seen"];
  const documents = value["documents"];
  const invalid = value["invalid"];
  if (
    !isString(built) || !isNumber(duration) || !isNumber(calls) ||
    !isNumber(repos) || !isNumber(documents) || !isArray(invalid) ||
    typeof value["truncated"] !== "boolean" || typeof value["authenticated"] !== "boolean"
  ) {
    return null;
  }
  return {
    built_at: built,
    duration_ms: duration,
    calls,
    // Written since the subrequest budget shipped; a meta from before it
    // carries the same count under `calls` instead.
    subrequests: isNumber(value["subrequests"]) ? value["subrequests"] : calls,
    repos_seen: repos,
    documents,
    // Written since the blocked list shipped; a meta from before it reads
    // as zero blocks instead of turning /api/index-status into a 503.
    blocked: isNumber(value["blocked"]) ? value["blocked"] : 0,
    invalid: invalid.flatMap((entry) => {
      const parsedEntry = invalidOf(entry);
      return parsedEntry === null ? [] : [parsedEntry];
    }),
    truncated: value["truncated"],
    stopped: isString(value["stopped"]) ? value["stopped"] : null,
    authenticated: value["authenticated"],
    // Written since the write budget shipped; a meta from before it reads as
    // zero on both counters instead of turning /api/index-status into a 503.
    kv_writes: isNumber(value["kv_writes"]) ? value["kv_writes"] : 0,
    kv_skipped: isNumber(value["kv_skipped"]) ? value["kv_skipped"] : 0,
  };
}

/** Read the index straight from KV, with no memo. The indexer uses this. */
export async function readIndex(kv: KV): Promise<StoredIndex | null> {
  let text: string | null;
  try {
    text = await kv.get(INDEX_KEY);
  } catch {
    return null;
  }
  return text === null ? null : parseIndex(text);
}

/** Read the patterns index straight from KV, with no memo. */
export async function readPatterns(kv: KV): Promise<StoredPatterns | null> {
  let text: string | null;
  try {
    text = await kv.get(PATTERNS_KEY);
  } catch {
    return null;
  }
  return text === null ? null : parsePatterns(text);
}

/** The request path's read side: the indexes memoised, the rest fresh. */
export interface IndexStore {
  /** The catalogue index, memoised in the isolate for 60 seconds. */
  getIndex(): Promise<StoredIndex | null>;
  /** The patterns index, memoised beside the catalogue index. */
  getPatterns(): Promise<StoredPatterns | null>;
  /** One validated document plus its README, or null when not indexed. */
  getDoc(kind: DocumentKind, owner: string, repo: string, slug: string): Promise<StoredDoc | null>;
  /** One pattern page plus its figure, or null when not indexed. */
  getPattern(slug: string): Promise<StoredPattern | null>;
  /**
   * The block that covers this document, if any: its own `blocked:v1:<kind>:*`
   * key first, then a whole-repository `blocked:v1:repo:*` block. The request
   * path reads this before the index, so a stale index cannot serve it.
   */
  getBlocked(
    kind: DocumentKind,
    owner: string,
    repo: string,
    slug: string,
  ): Promise<BlockedEntry | null>;
  /** The last run's accounting, or null when no run has written it. */
  getMeta(): Promise<IndexMeta | null>;
}

/** Build the read side over a KV binding, real or fake. */
export function createStore(kv: KV | undefined): IndexStore {
  async function getIndex(): Promise<StoredIndex | null> {
    const now = Date.now();
    if (memo !== null && now - memo.at < INDEX_MEMO_MS) {
      return memo.index;
    }
    let index: StoredIndex | null = null;
    if (kv !== undefined) {
      index = await readIndex(kv);
    }
    memo = { at: now, index };
    return index;
  }

  async function getPatterns(): Promise<StoredPatterns | null> {
    const now = Date.now();
    if (patternsMemo !== null && now - patternsMemo.at < INDEX_MEMO_MS) {
      return patternsMemo.patterns;
    }
    let patterns: StoredPatterns | null = null;
    if (kv !== undefined) {
      patterns = await readPatterns(kv);
    }
    patternsMemo = { at: now, patterns };
    return patterns;
  }

  async function getPattern(slug: string): Promise<StoredPattern | null> {
    if (kv === undefined) {
      return null;
    }
    let text: string | null;
    try {
      text = await kv.get(patternKey(slug));
    } catch {
      return null;
    }
    return text === null ? null : parseStoredPattern(text);
  }

  async function getDoc(
    kind: DocumentKind,
    owner: string,
    repo: string,
    slug: string,
  ): Promise<StoredDoc | null> {
    if (kv === undefined) {
      return null;
    }
    let text: string | null;
    try {
      text = await kv.get(docKey(kind, owner, repo, slug));
    } catch {
      return null;
    }
    return text === null ? null : parseStoredDoc(text);
  }

  async function getBlocked(
    kind: DocumentKind,
    owner: string,
    repo: string,
    slug: string,
  ): Promise<BlockedEntry | null> {
    if (kv === undefined) {
      return null;
    }
    for (const key of [
      blockedDocKey(kind, owner, repo, slug),
      blockedRepoKey(owner, repo),
    ]) {
      let text: string | null;
      try {
        text = await kv.get(key);
      } catch {
        continue;
      }
      if (text === null) {
        continue;
      }
      const entry = parseBlockedValue(text);
      if (entry !== null) {
        return entry;
      }
    }
    return null;
  }

  async function getMeta(): Promise<IndexMeta | null> {
    if (kv === undefined) {
      return null;
    }
    let text: string | null;
    try {
      text = await kv.get(META_KEY);
    } catch {
      return null;
    }
    return text === null ? null : parseMeta(text);
  }

  return { getIndex, getPatterns, getDoc, getPattern, getBlocked, getMeta };
}
