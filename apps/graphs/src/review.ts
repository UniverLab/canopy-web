// SPDX-License-Identifier: Apache-2.0
/**
 * The index-time model review: patterns and a fuzzy verdict per document.
 *
 * Community graphs and nodes run prompts and shell commands on the
 * installer's machine, and the only gate is the human install review. This
 * pass adds a worker-side model opinion at index time with two jobs: it
 * names which bundled patterns each graph uses (driving the patterns
 * pages' links dynamically), and it gives a fuzzy security verdict —
 * "Verdict of <model>", never a certification. Advisory only: verdicts
 * never block installs or delist documents.
 *
 * The provider interface is `ReviewProvider.review(document)`; the `Muse`
 * implementation lives in review-claude.ts and calls the Muse API with
 * the key from worker secrets. `off` (or no provider) disables the pass
 * entirely: `runReview` with a null provider touches no KV key and the
 * index path is unaffected.
 *
 * The pass never blocks index writes: `scheduled()` runs it after the
 * indexer flushed, and every failure — API errors, timeouts, missing
 * credits — leaves those documents `unreviewed` (no badge) without
 * touching the index keys. It is budgeted by a per-run scan cap that
 * takes the newest unscanned documents first, and hash-gated: a document
 * is reviewed only when its content hash differs from the last reviewed
 * hash. The verdict, detected patterns, scanned hash, model name and
 * review date live in KV alongside the document (`review:v1:*`) plus two
 * aggregates (`reviews:v1` for the transparency page, `review-patterns:v1`
 * for the patterns pages), refreshed on content change only.
 */
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import type { Log } from "./github.js";
import { sha256 } from "./hashes.js";
import { isArray, isRecord, isString, parseJson } from "./json.js";
import { INDEX_KEY, docKey, parseIndex, parseStoredDoc, type KV } from "./store.js";
import { HASHES_KEY, parseHashes } from "./hashes.js";
import { attentionFor, runsOf } from "./pages/runs.js";

/** The three fuzzy verdicts, in display order. */
export type Verdict = "looks-safe" | "needs-look" | "flagged";

/** The short opinion label per verdict, as the badge shows it. */
export const VERDICT_LABELS: Record<Verdict, string> = {
  "looks-safe": "Looks safe",
  "needs-look": "Needs a look",
  flagged: "Flagged",
};

/** True when the value is one of the three verdicts. */
export function isVerdict(value: unknown): value is Verdict {
  return value === "looks-safe" || value === "needs-look" || value === "flagged";
}

/** What the provider reads: coordinates plus the validated document. */
export interface ReviewDocument {
  kind: DocumentKind;
  owner: string;
  repo: string;
  slug: string;
  name: string;
  document: JsonValue;
}

/** What the provider answers: a verdict, its reasons, and pattern slugs. */
export interface ReviewResult {
  verdict: Verdict;
  reasons: string;
  patterns: string[];
}

/**
 * The review provider: one model behind `review()`. `model` is the name
 * the badge shows ("Verdict of <model>"). A throw means the document
 * stays `unreviewed` — the runner catches it and writes nothing.
 */
export interface ReviewProvider {
  readonly model: string;
  review(document: ReviewDocument): Promise<ReviewResult>;
}

/** Prefix of the per-document review keys. */
export const REVIEW_PREFIX = "review:v1:";

/** The aggregate every verdict, for the transparency page. */
export const REVIEWS_KEY = "reviews:v1";

/** The pattern-to-documents relations, for the patterns pages. */
export const REVIEW_PATTERNS_KEY = "review-patterns:v1";

/** Documents one review run may scan, at most, when no cap is configured. */
export const REVIEW_DEFAULT_CAP = 5;

/**
 * One document's review key. Coordinates follow the document key's own
 * rule: owner and repo lowercased, the slug as listed.
 */
export function reviewKey(kind: DocumentKind, owner: string, repo: string, slug: string): string {
  return `${REVIEW_PREFIX}${kind}:${owner.toLowerCase()}/${repo.toLowerCase()}/${slug}`;
}

/** The coordinates a review key carries. */
export interface ReviewCoords {
  kind: DocumentKind;
  owner: string;
  repo: string;
  slug: string;
}

/** Parse a review key back to coordinates; null when off-shape. */
export function parseReviewKey(key: string): ReviewCoords | null {
  if (!key.startsWith(REVIEW_PREFIX)) {
    return null;
  }
  const rest = key.slice(REVIEW_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const kind = rest.slice(0, colon);
  if (kind !== "graph" && kind !== "node") {
    return null;
  }
  const path = rest.slice(colon + 1);
  const slash = path.indexOf("/");
  if (slash < 0) {
    return null;
  }
  const owner = path.slice(0, slash);
  const tail = path.slice(slash + 1);
  const second = tail.indexOf("/");
  if (second < 0) {
    return null;
  }
  const repo = tail.slice(0, second);
  const slug = tail.slice(second + 1);
  if (owner === "" || repo === "" || slug === "") {
    return null;
  }
  return { kind, owner, repo, slug };
}

/** The `review:v1:*` value: verdict, patterns, and what was scanned. */
export interface StoredReview {
  verdict: Verdict;
  reasons: string;
  patterns: string[];
  /** The SHA-256 hex of the `doc:v1:*` value the model saw. */
  hash: string;
  /** The model name the badge shows. */
  model: string;
  /** When the model answered, ISO-8601. */
  reviewed_at: string;
}

/** Parse a `review:v1:*` body; anything off-shape is no review at all. */
export function parseStoredReview(text: string): StoredReview | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const value = parsed.value;
  const verdict = value["verdict"];
  const reasons = value["reasons"];
  const patterns = value["patterns"];
  const hash = value["hash"];
  const model = value["model"];
  const reviewedAt = value["reviewed_at"];
  if (
    !isVerdict(verdict) || !isString(reasons) || !isArray(patterns) ||
    !patterns.every(isString) || !isString(hash) || hash === "" ||
    !isString(model) || model === "" || !isString(reviewedAt) || reviewedAt === ""
  ) {
    return null;
  }
  return {
    verdict,
    reasons,
    patterns: [...patterns],
    hash,
    model,
    reviewed_at: reviewedAt,
  };
}

/** One aggregate row: coordinates plus the stored review. */
export type ReviewEntry = ReviewCoords & StoredReview;

/** The `reviews:v1` value: when built, and every verdict. */
export interface StoredReviews {
  built_at: string;
  reviews: ReviewEntry[];
}

function entryOf(value: unknown): ReviewEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value["kind"];
  const owner = value["owner"];
  const repo = value["repo"];
  const slug = value["slug"];
  if (
    (kind !== "graph" && kind !== "node") || !isString(owner) || !isString(repo) ||
    !isString(slug)
  ) {
    return null;
  }
  const verdict = value["verdict"];
  const reasons = value["reasons"];
  const patterns = value["patterns"];
  const hash = value["hash"];
  const model = value["model"];
  const reviewedAt = value["reviewed_at"];
  if (
    !isVerdict(verdict) || !isString(reasons) || !isArray(patterns) ||
    !patterns.every(isString) || !isString(hash) || !isString(model) ||
    !isString(reviewedAt)
  ) {
    return null;
  }
  return {
    kind,
    owner,
    repo,
    slug,
    verdict,
    reasons,
    patterns: [...patterns],
    hash,
    model,
    reviewed_at: reviewedAt,
  };
}

/** Parse a `reviews:v1` body; malformed rows are dropped, never fatal. */
export function parseReviewsAggregate(text: string): StoredReviews | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const built = parsed.value["built_at"];
  const reviews = parsed.value["reviews"];
  if (!isString(built) || !isArray(reviews)) {
    return null;
  }
  return {
    built_at: built,
    reviews: reviews.flatMap((entry) => {
      const parsedEntry = entryOf(entry);
      return parsedEntry === null ? [] : [parsedEntry];
    }),
  };
}

/** The `review-patterns:v1` value: pattern slug to implementing graphs. */
export interface StoredReviewPatterns {
  built_at: string;
  relations: Record<string, ReviewCoords[]>;
}

function coordsOf(value: unknown): ReviewCoords | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value["kind"];
  const owner = value["owner"];
  const repo = value["repo"];
  const slug = value["slug"];
  if (
    (kind !== "graph" && kind !== "node") || !isString(owner) || !isString(repo) ||
    !isString(slug)
  ) {
    return null;
  }
  return { kind, owner, repo, slug };
}

/** Parse a `review-patterns:v1` body; malformed rows are dropped. */
export function parseReviewPatterns(text: string): StoredReviewPatterns | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const built = parsed.value["built_at"];
  const relations = parsed.value["relations"];
  if (!isString(built) || !isRecord(relations)) {
    return null;
  }
  const clean: Record<string, ReviewCoords[]> = {};
  for (const [slug, rows] of Object.entries(relations)) {
    if (!isArray(rows)) {
      continue;
    }
    const coords = rows.flatMap((row) => {
      const parsedRow = coordsOf(row);
      return parsedRow === null ? [] : [parsedRow];
    });
    clean[slug] = coords;
  }
  return { built_at: built, relations: clean };
}

/** The install-review facts one prompt is built from, as prompt lines. */
export interface ReviewFacts {
  commands: string;
  prompts: string;
  attention: string;
}

/**
 * Read the install-review facts out of a validated document: every shell
 * command verbatim with where it runs, every agent instruction excerpted,
 * and the attention marks per command. Total like `runsOf`: anything
 * unreadable is "(none)", never an exception.
 */
export function reviewFactsOf(kind: DocumentKind, document: JsonValue): ReviewFacts {
  const runs = runsOf(kind, document);
  const commands = runs.commands.length === 0
    ? "(none)"
    : runs.commands.map((command) => `${command.where} || ${command.text}`).join("\n---\n").slice(0, 8000);
  const prompts = runs.prompts.length === 0
    ? "(none)"
    : runs.prompts.map((prompt) => {
      const excerpt = prompt.text.split(/\r?\n/).slice(0, 12).join("\n").slice(0, 800);
      return `${prompt.where} [${prompt.source}] || ${excerpt}`;
    }).join("\n---\n").slice(0, 12000);
  const marked = runs.commands.flatMap((command) => {
    const marks = attentionFor(command.text);
    return marks.length === 0 ? [] : [`${command.where} || ${marks.join(", ")}`];
  });
  return {
    commands: commands === "" ? "(none)" : commands,
    prompts: prompts === "" ? "(none)" : prompts,
    attention: marked.length === 0 ? "(none)" : marked.join("\n"),
  };
}

/** What one review run did: candidates seen, reviews written, failures kept unreviewed. */
export interface ReviewRunStats {
  candidates: number;
  reviewed: number;
  failed: number;
  pruned: number;
}

/** What `runReview` reads and writes. */
export interface ReviewRunOptions {
  /** The index namespace the catalogue reads. */
  index: KV;
  /** Null disables the pass entirely: no KV key is touched. */
  provider: ReviewProvider | null;
  /** The bundled pattern slugs the model may name. */
  patternSlugs: string[];
  /** Documents scanned per run; production configures it, tests force it. */
  cap?: number;
  /** Clock override; production reads the time. */
  now?: () => number;
  /** Where dropped or skipped things are noted; defaults to no-op. */
  log?: Log;
}

/**
 * Run one review pass after the index writes landed. Newest unscanned
 * documents first (index `updated` descending, unknown last), at most
 * `cap` provider calls; a document whose content hash matches its last
 * reviewed hash is never re-reviewed. Failures stay `unreviewed`: no key
 * is written for them. Orphaned reviews (no live index entry) are pruned,
 * and the two aggregates rebuilt only when something changed and the
 * listing completed — never from a partial view. Total: it never throws
 * past the caller, so the index path stays untouched.
 */
export async function runReview(options: ReviewRunOptions): Promise<ReviewRunStats> {
  const quiet: ReviewRunStats = { candidates: 0, reviewed: 0, failed: 0, pruned: 0 };
  const provider = options.provider;
  if (provider === null) {
    return quiet;
  }
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const cap = options.cap ?? REVIEW_DEFAULT_CAP;
  if (!Number.isInteger(cap) || cap <= 0) {
    return quiet;
  }
  const known = new Set(options.patternSlugs);
  try {
    let indexText: string | null;
    try {
      indexText = await options.index.get(INDEX_KEY);
    } catch {
      return quiet;
    }
    const index = indexText === null ? null : parseIndex(indexText);
    if (index === null) {
      return quiet;
    }
    const hashesText = await options.index.get(HASHES_KEY).catch(() => null);
    const hashes = parseHashes(hashesText);
    const aggregateText = await options.index.get(REVIEWS_KEY).catch(() => null);
    const aggregate = aggregateText === null ? null : parseReviewsAggregate(aggregateText);
    const lastHash = new Map<string, string>();
    for (const entry of aggregate?.reviews ?? []) {
      lastHash.set(reviewKey(entry.kind, entry.owner, entry.repo, entry.slug), entry.hash);
    }
    const live = new Set(
      index.entries.map((entry) => reviewKey(entry.kind, entry.owner, entry.repo, entry.slug)),
    );
    const candidates = index.entries.filter((entry) => {
      const key = reviewKey(entry.kind, entry.owner, entry.repo, entry.slug);
      const last = lastHash.get(key);
      if (last === undefined) {
        return true;
      }
      const current = hashes[docKey(entry.kind, entry.owner, entry.repo, entry.slug)];
      // A missing fingerprint proves nothing: the candidate is re-hashed
      // from its document below and skipped when it matches after all.
      return current === undefined || current !== last;
    });
    candidates.sort((left, right) => {
      const leftUpdated = left.updated ?? "";
      const rightUpdated = right.updated ?? "";
      if (leftUpdated !== rightUpdated) {
        if (leftUpdated === "") {
          return 1;
        }
        if (rightUpdated === "") {
          return -1;
        }
        return leftUpdated < rightUpdated ? 1 : -1;
      }
      const leftKey = `${left.owner}/${left.repo}/${left.slug}`;
      const rightKey = `${right.owner}/${right.repo}/${right.slug}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const chosen = candidates.slice(0, cap);
    const stats: ReviewRunStats = { candidates: candidates.length, reviewed: 0, failed: 0, pruned: 0 };
    const reviewedAt = new Date(now()).toISOString();
    for (const entry of chosen) {
      const key = reviewKey(entry.kind, entry.owner, entry.repo, entry.slug);
      let raw: string | null;
      try {
        raw = await options.index.get(docKey(entry.kind, entry.owner, entry.repo, entry.slug));
      } catch {
        continue;
      }
      if (raw === null) {
        continue;
      }
      const hash = await sha256(raw);
      if (lastHash.get(key) === hash) {
        continue;
      }
      const stored = parseStoredDoc(raw);
      if (stored === null) {
        continue;
      }
      const name = isRecord(stored.document) && isString(stored.document["name"])
        ? (stored.document["name"] as string)
        : entry.slug;
      let result: ReviewResult;
      try {
        result = await provider.review({
          kind: entry.kind,
          owner: entry.owner,
          repo: entry.repo,
          slug: entry.slug,
          name,
          document: stored.document,
        });
      } catch {
        log(`review: ${entry.owner}/${entry.repo} ${entry.slug} failed; leaving unreviewed`);
        stats.failed += 1;
        continue;
      }
      if (!isVerdict(result.verdict) || !isString(result.reasons) || !isArray(result.patterns)) {
        log(`review: ${entry.owner}/${entry.repo} ${entry.slug} answered off-shape; leaving unreviewed`);
        stats.failed += 1;
        continue;
      }
      // Nodes carry no patterns, whatever the model named; graphs name
      // only bundled slugs, deduplicated and sorted.
      const patterns = entry.kind === "node"
        ? []
        : [...new Set(result.patterns.filter((slug) => isString(slug) && known.has(slug)))].sort();
      const storedReview: StoredReview = {
        verdict: result.verdict,
        reasons: result.reasons.trim().slice(0, 1000),
        patterns,
        hash,
        model: provider.model,
        reviewed_at: reviewedAt,
      };
      try {
        await options.index.put(key, JSON.stringify(storedReview));
      } catch {
        log(`review: ${entry.owner}/${entry.repo} ${entry.slug} could not be stored; leaving unreviewed`);
        stats.failed += 1;
        continue;
      }
      lastHash.set(key, hash);
      stats.reviewed += 1;
    }
    // Orphans: reviews whose index entry is gone lose their keys, so the
    // transparency page never lists a document the catalogue dropped. A
    // listing that fails leaves the aggregates alone: they are rebuilt
    // from a complete view only, and the next run retries.
    let cursor: string | undefined;
    let listedAll = true;
    const survivors = new Set<string>();
    do {
      let listed: { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string };
      try {
        listed = await options.index.list({ prefix: REVIEW_PREFIX, cursor });
      } catch {
        listedAll = false;
        break;
      }
      for (const key of listed.keys) {
        if (!live.has(key.name)) {
          try {
            await options.index.delete(key.name);
          } catch {
            continue;
          }
          stats.pruned += 1;
        } else {
          survivors.add(key.name);
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor !== undefined);
    if (!listedAll || (stats.reviewed === 0 && stats.pruned === 0)) {
      return stats;
    }
    const reviews: ReviewEntry[] = [];
    for (const key of [...survivors].sort()) {
      const coords = parseReviewKey(key);
      if (coords === null) {
        continue;
      }
      let text: string | null;
      try {
        text = await options.index.get(key);
      } catch {
        continue;
      }
      if (text === null) {
        continue;
      }
      const review = parseStoredReview(text);
      if (review === null) {
        continue;
      }
      reviews.push({ ...coords, ...review });
    }
    reviews.sort((left, right) => {
      const leftKey = `${left.owner}/${left.repo}/${left.slug}`;
      const rightKey = `${right.owner}/${right.repo}/${right.slug}`;
      if (left.kind !== right.kind) {
        return left.kind < right.kind ? -1 : 1;
      }
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const relations: Record<string, ReviewCoords[]> = {};
    for (const slug of options.patternSlugs) {
      relations[slug] = [];
    }
    for (const entry of reviews) {
      if (entry.kind !== "graph") {
        continue;
      }
      for (const slug of entry.patterns) {
        if (known.has(slug)) {
          (relations[slug] ??= []).push({
            kind: entry.kind,
            owner: entry.owner,
            repo: entry.repo,
            slug: entry.slug,
          });
        }
      }
    }
    for (const rows of Object.values(relations)) {
      rows.sort((left, right) => {
        const leftKey = `${left.owner}/${left.repo}/${left.slug}`;
        const rightKey = `${right.owner}/${right.repo}/${right.slug}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
    }
    try {
      await options.index.put(REVIEWS_KEY, JSON.stringify({ built_at: reviewedAt, reviews }));
      await options.index.put(REVIEW_PATTERNS_KEY, JSON.stringify({ built_at: reviewedAt, relations }));
    } catch {
      log("review: the aggregates could not be stored");
    }
    return stats;
  } catch {
    return quiet;
  }
}
