// SPDX-License-Identifier: Apache-2.0
/**
 * The scheduled index in KV, and the request path's read side of it.
 *
 * The indexer (indexer.ts) writes three shapes: `index:v1` (one JSON
 * value with every listed entry, no full documents), one `doc:v1:*` key
 * per validated document plus its README, and `index:meta` with the
 * run's accounting — plus one `blocked:v1:*` key per `registry/blocked.json`
 * entry, which the request path reads before the index. Every page and
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
  calls: number;
  repos_seen: number;
  documents: number;
  /** How many `registry/blocked.json` entries the run read. */
  blocked: number;
  invalid: IndexInvalid[];
  truncated: boolean;
  authenticated: boolean;
}

/** How long one isolate serves the index without re-reading KV. */
export const INDEX_MEMO_MS = 60_000;

let memo: { at: number; index: StoredIndex | null } | null = null;

/** Forget the memoised index. The tests seed a fresh KV per case. */
export function resetIndexMemo(): void {
  memo = null;
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
    authenticated: value["authenticated"],
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

/** The request path's read side: the index memoised, the rest fresh. */
export interface IndexStore {
  /** The catalogue index, memoised in the isolate for 60 seconds. */
  getIndex(): Promise<StoredIndex | null>;
  /** One validated document plus its README, or null when not indexed. */
  getDoc(kind: DocumentKind, owner: string, repo: string, slug: string): Promise<StoredDoc | null>;
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

  return { getIndex, getDoc, getBlocked, getMeta };
}
