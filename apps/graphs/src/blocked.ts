// SPDX-License-Identifier: Apache-2.0
/**
 * The community blocked list, `blocked.json` at the root of the official
 * catalogue repository (UniverLab/canopy-graphs).
 *
 * A report files a GitHub issue on the official repository
 * (`report-document.yml`); a maintainer decides by pull request to
 * `blocked.json`. The file is a JSON array of entries: with a `slug` one
 * document is blocked, without one the whole repository is. The indexer
 * reads it once per run, records each entry under its own `blocked:v1:*`
 * key and never writes a blocked document to `doc:v1:*`; the request path
 * reads those keys before the index, so a stale index cannot serve a
 * document a later run removed.
 *
 * Everything here is pure and total: no network, no KV, no exception. Keys
 * lowercase `owner/repo` exactly as `docKey` does; the slug keeps its case.
 */
import type { DocumentKind } from "../../../src/schema.js";
import { isArray, isRecord, parseJson, stringField } from "./json.js";

/** Prefix of every blocked key, document and repository alike. */
export const BLOCKED_PREFIX = "blocked:v1:";

/** One entry of `blocked.json`, as README and issue describe it. */
export interface BlockedEntry {
  /** Ignored when the whole repository is blocked (no `slug`). */
  kind?: DocumentKind;
  /** `owner/repo`, exactly as the catalogue spells it. */
  repo: string;
  /** Without a slug the whole repository is blocked. */
  slug?: string;
  reason: string;
  /** The issue URL the report was decided on; it can be appealed there. */
  issue: string;
  /** `YYYY-MM-DD`, the day the pull request landed. */
  blocked_at: string;
}

function documentKind(value: unknown): DocumentKind | undefined {
  return value === "graph" || value === "node" ? value : undefined;
}

/** True for `owner/repo`: one slash, neither side empty or spaced. */
function repoShape(repo: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(repo);
}

/** The two halves of `owner/repo`; null when the string is not one. */
function splitRepo(repo: string): { owner: string; repo: string } | null {
  if (!repoShape(repo)) {
    return null;
  }
  const slash = repo.indexOf("/");
  return { owner: repo.slice(0, slash), repo: repo.slice(slash + 1) };
}

/**
 * Parse one list item or one stored value. A malformed entry is dropped
 * (null), never fatal: the reviewed file is checked by `npm run validate`,
 * so the runtime only has to stay total. A slug without its kind is dropped
 * too — the key and the match would have nothing to name.
 */
export function blockedEntryOf(value: unknown): BlockedEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const repo = stringField(value, "repo");
  const reason = stringField(value, "reason");
  const issue = stringField(value, "issue");
  const blockedAt = stringField(value, "blocked_at");
  if (repo === "" || reason === "" || issue === "" || blockedAt === "") {
    return null;
  }
  if (splitRepo(repo) === null) {
    return null;
  }
  const entry: BlockedEntry = { repo, reason, issue, blocked_at: blockedAt };
  const kind = documentKind(value["kind"]);
  if (kind !== undefined) {
    entry.kind = kind;
  }
  const slug = stringField(value, "slug");
  if (slug !== "") {
    if (kind === undefined) {
      return null;
    }
    entry.slug = slug;
  }
  return entry;
}

/**
 * Parse `blocked.json`: the entries, or null when the text is not a
 * JSON array. The indexer distinguishes null (unreadable: keep the previous
 * blocks) from `[]` (a real, empty list: delete every stale key).
 */
export function parseBlockedList(text: string): BlockedEntry[] | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isArray(parsed.value)) {
    return null;
  }
  return parsed.value.flatMap((item) => {
    const entry = blockedEntryOf(item);
    return entry === null ? [] : [entry];
  });
}

/** Parse one `blocked:v1:*` value: the entry stored under that key. */
export function parseBlockedValue(text: string): BlockedEntry | null {
  const parsed = parseJson(text);
  return parsed.ok ? blockedEntryOf(parsed.value) : null;
}

/** The KV key of a whole-repository block. */
export function blockedRepoKey(owner: string, repo: string): string {
  return `${BLOCKED_PREFIX}repo:${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** The KV key of one blocked document; mirrors `docKey`'s casing. */
export function blockedDocKey(
  kind: DocumentKind,
  owner: string,
  repo: string,
  slug: string,
): string {
  return `${BLOCKED_PREFIX}${kind}:${owner.toLowerCase()}/${repo.toLowerCase()}/${slug}`;
}

/** The KV key of a parsed entry; null when it cannot be stored. */
export function blockedKey(entry: BlockedEntry): string | null {
  const parts = splitRepo(entry.repo);
  if (parts === null) {
    return null;
  }
  if (entry.slug === undefined) {
    return blockedRepoKey(parts.owner, parts.repo);
  }
  if (entry.kind === undefined) {
    return null;
  }
  return blockedDocKey(entry.kind, parts.owner, parts.repo, entry.slug);
}

/** True when the entry names this repository, whatever the letter case. */
function sameRepo(entry: BlockedEntry, owner: string, repo: string): boolean {
  return entry.repo.toLowerCase() === `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * The entry that blocks this document, if any: its own document block, or a
 * block on its whole repository. Null means the document is listed.
 */
export function blockedDocument(
  entries: BlockedEntry[],
  kind: DocumentKind,
  owner: string,
  repo: string,
  slug: string,
): BlockedEntry | null {
  for (const entry of entries) {
    if (!sameRepo(entry, owner, repo)) {
      continue;
    }
    if (entry.slug === undefined) {
      return entry;
    }
    if (entry.kind === kind && entry.slug === slug) {
      return entry;
    }
  }
  return null;
}

/** The entry that blocks this whole repository, if any. */
export function blockedRepository(
  entries: BlockedEntry[],
  owner: string,
  repo: string,
): BlockedEntry | null {
  for (const entry of entries) {
    if (entry.slug === undefined && sameRepo(entry, owner, repo)) {
      return entry;
    }
  }
  return null;
}
