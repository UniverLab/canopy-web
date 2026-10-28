// SPDX-License-Identifier: Apache-2.0
/**
 * The lab's pattern pages: `patterns/<slug>.md` in the official repository.
 *
 * Each page is front matter plus a markdown body, with a sibling
 * `patterns/<slug>.figure.json` — a harness-free graph document the plate
 * renderer draws. The front matter carries exactly six keys:
 *
 *   title: <one line>
 *   summary: <one line>
 *   status: standard | in use | experiment
 *   implements: [] | one `- <kind>:<slug>` line per catalogue ref
 *   figure: <the figure file's basename>
 *   sources: one `- title:` / `url:` pair per source, at least one
 *
 * `parsePatternFile` is a small strict parser for that shape — no YAML
 * dependency. Anything off-shape is `null`, and the indexer skips the page,
 * records why in the run's invalid list, and never fails the run.
 * `fetchOfficialPatterns` reads the whole `patterns/` directory from `main`
 * in the official repository only; a rate limit halts with `PatternsHalt`
 * so the indexer can stop the run like any other stop.
 */
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import type { GitHub, Log } from "./github.js";
import { isApiError } from "./github.js";
import {
  decodeBase64,
  isArray,
  isRecord,
  isString,
  parseJson,
  readJson,
} from "./json.js";
import { OFFICIAL_REPOSITORY, SLUG_RE } from "./lib.js";
import type { IndexInvalid } from "./store.js";
import { isValidDocument } from "./validate.js";

/** The three statuses a pattern page carries, in list order. */
export type PatternStatus = "standard" | "in use" | "experiment";

/** One `implements` ref: a catalogue document by kind and slug. */
export interface PatternRef {
  kind: DocumentKind;
  slug: string;
}

/** One `sources` entry: a title and the URL it points at. */
export interface PatternSource {
  title: string;
  url: string;
}

/** The six front-matter keys, parsed and checked. */
export interface PatternMeta {
  title: string;
  summary: string;
  status: PatternStatus;
  implements: PatternRef[];
  figure: string;
  sources: PatternSource[];
}

/** One parsed page: its front matter and its markdown body. */
export interface ParsedPattern {
  meta: PatternMeta;
  body: string;
}

/** One patterns-index entry: everything a card renders, plus the figure. */
export interface PatternEntry {
  slug: string;
  title: string;
  summary: string;
  status: PatternStatus;
  implements: PatternRef[];
  figure: JsonValue;
}

/** One stored pattern: the index fields, the body and the sources. */
export interface StoredPattern {
  title: string;
  summary: string;
  status: PatternStatus;
  implements: PatternRef[];
  sources: PatternSource[];
  body: string;
  figure: JsonValue;
}

const STATUSES: PatternStatus[] = ["standard", "in use", "experiment"];

/** List order: standard first, then in use, then experiment. */
export const PATTERN_STATUS_ORDER: Record<PatternStatus, number> = {
  standard: 0,
  "in use": 1,
  experiment: 2,
};

/** Cards sort by status rank, then slug. */
export function comparePatterns(left: PatternEntry, right: PatternEntry): number {
  const rank = PATTERN_STATUS_ORDER[left.status] - PATTERN_STATUS_ORDER[right.status];
  return rank !== 0 ? rank : left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0;
}

/** The patterns whose `implements` names this catalogue document. */
export function implementingPatterns(
  entries: PatternEntry[],
  kind: DocumentKind,
  slug: string,
): PatternEntry[] {
  return entries.filter((entry) =>
    entry.implements.some((ref) => ref.kind === kind && ref.slug === slug)
  );
}

/** A figure value names a JSON file inside `patterns/`, never a path. */
const FIGURE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/;

const KEY_RE = /^([A-Za-z]+):(.*)$/;
const IMPLEMENTS_ITEM_RE = /^ {2}- ([a-z]+):(\S+)$/;
const SOURCE_TITLE_RE = /^ {2}- title: (.+)$/;
const SOURCE_URL_RE = /^ {4}url: (.+)$/;

function isStatus(value: string): value is PatternStatus {
  return (STATUSES as string[]).includes(value);
}

function isRefKind(value: string): value is DocumentKind {
  return value === "graph" || value === "node";
}

interface HeadCursor {
  lines: string[];
  index: number;
}

function peek(cursor: HeadCursor): string | null {
  return cursor.index < cursor.lines.length ? (cursor.lines[cursor.index] as string) : null;
}

/** The `- kind:slug` lines under `implements:`, or null when off-shape. */
function implementsItems(cursor: HeadCursor): PatternRef[] | null {
  const refs: PatternRef[] = [];
  for (;;) {
    const line = peek(cursor);
    if (line === null || !line.startsWith("  - ")) {
      return refs;
    }
    const match = IMPLEMENTS_ITEM_RE.exec(line);
    if (match === null || !isRefKind(match[1] as string) || !SLUG_RE.test(match[2] as string)) {
      return null;
    }
    refs.push({ kind: match[1] as DocumentKind, slug: match[2] as string });
    cursor.index += 1;
  }
}

/** The `- title:` / `url:` pairs under `sources:`, or null when off-shape. */
function sourceItems(cursor: HeadCursor): PatternSource[] | null {
  const sources: PatternSource[] = [];
  for (;;) {
    const line = peek(cursor);
    if (line === null || !line.startsWith("  - ")) {
      return sources;
    }
    const title = SOURCE_TITLE_RE.exec(line);
    if (title === null || (title[1] as string).trim() === "") {
      return null;
    }
    cursor.index += 1;
    const url = cursor.index < cursor.lines.length ? (cursor.lines[cursor.index] as string) : null;
    const urlMatch = url === null ? null : SOURCE_URL_RE.exec(url);
    if (urlMatch === null || (urlMatch[1] as string).trim() === "") {
      return null;
    }
    cursor.index += 1;
    sources.push({ title: (title[1] as string).trim(), url: (urlMatch[1] as string).trim() });
  }
}

/**
 * Parse one `patterns/<slug>.md` file: front matter plus body. All six keys
 * are required, exactly once, in any order; list items sit at the indents
 * the official pages use. Anything else — no fences, a missing key, an
 * unknown key, an empty scalar, a bad status, a bare `implements:` with no
 * items, a sourceless `sources:` — is `null`.
 */
export function parsePatternFile(text: string): ParsedPattern | null {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") {
    return null;
  }
  const closing = lines.indexOf("---", 1);
  if (closing < 0) {
    return null;
  }
  const body = lines.slice(closing + 1).join("\n");
  const cursor: HeadCursor = { lines: lines.slice(1, closing), index: 0 };
  const seen = new Set<string>();
  const meta: Partial<Record<"title" | "summary" | "status" | "implements" | "figure" | "sources", unknown>> = {};
  for (;;) {
    const line = peek(cursor);
    if (line === null) {
      break;
    }
    cursor.index += 1;
    if (line.trim() === "") {
      continue;
    }
    const key = KEY_RE.exec(line);
    if (key === null || seen.has(key[1] as string)) {
      return null;
    }
    const name = key[1] as string;
    const rest = (key[2] as string).trim();
    seen.add(name);
    if (name === "title" || name === "summary") {
      if (rest === "") {
        return null;
      }
      meta[name] = rest;
    } else if (name === "status") {
      if (!isStatus(rest)) {
        return null;
      }
      meta.status = rest;
    } else if (name === "figure") {
      if (!FIGURE_RE.test(rest)) {
        return null;
      }
      meta.figure = rest;
    } else if (name === "implements") {
      if (rest === "[]") {
        meta.implements = [];
      } else if (rest === "") {
        const refs = implementsItems(cursor);
        if (refs === null || refs.length === 0) {
          return null;
        }
        meta.implements = refs;
      } else {
        return null;
      }
    } else if (name === "sources") {
      if (rest !== "") {
        return null;
      }
      const sources = sourceItems(cursor);
      if (sources === null || sources.length === 0) {
        return null;
      }
      meta.sources = sources;
    } else {
      return null;
    }
  }
  if (
    typeof meta.title !== "string" || typeof meta.summary !== "string" ||
    typeof meta.status !== "string" || !Array.isArray(meta.implements) ||
    typeof meta.figure !== "string" || !Array.isArray(meta.sources)
  ) {
    return null;
  }
  return {
    meta: {
      title: meta.title,
      summary: meta.summary,
      status: meta.status as PatternStatus,
      implements: meta.implements as PatternRef[],
      figure: meta.figure,
      sources: meta.sources as PatternSource[],
    },
    body,
  };
}

/** Thrown past a rate limit: the indexer stops the run, like any other stop. */
export class PatternsHalt {
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

/** What one full read of the official `patterns/` directory proved. */
export interface PatternsRead {
  entries: PatternEntry[];
  documents: Map<string, StoredPattern>;
  invalid: IndexInvalid[];
  /**
   * False when the directory itself could not be read (so the previous
   * patterns stay); a missing directory reads as complete and empty.
   */
  complete: boolean;
}

function contentsUrl(path: string): string {
  return `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/contents/${path}?ref=main`;
}

type FileText =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "halt"; reason: string }
  | { kind: "error"; reason: string };

/** One figure file as a transport found it. */
export type FigureText =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "error"; reason: string };

/** One page composed from its markdown and its figure. */
export type PatternLoad =
  | { kind: "pattern"; entry: PatternEntry; stored: StoredPattern }
  | { kind: "invalid"; reason: string };

/**
 * Parse one page and its figure into the card and the stored page. The REST
 * reader and the GraphQL snapshot both call this, so a malformed page, a
 * missing figure and a figure that fails the graph schema are reported the
 * same way on either transport. The figure name comes from the page's own
 * front matter, so the caller only says how to read a named file.
 */
export async function patternFromTexts(
  slug: string,
  page: string,
  figure: (name: string) => Promise<FigureText>,
  log: Log,
): Promise<PatternLoad> {
  const parsed = parsePatternFile(page);
  if (parsed === null) {
    log(`patterns: dropped ${slug}: malformed front matter`);
    return { kind: "invalid", reason: "malformed front matter" };
  }
  const found = await figure(parsed.meta.figure);
  if (found.kind === "absent") {
    log(`patterns: dropped ${slug}: the figure ${parsed.meta.figure} is missing`);
    return { kind: "invalid", reason: "missing figure" };
  }
  if (found.kind === "error") {
    return { kind: "invalid", reason: found.reason };
  }
  const figureJson = parseJson(found.text);
  if (!figureJson.ok || !isRecord(figureJson.value)) {
    log(`patterns: dropped ${slug}: the figure is not JSON`);
    return { kind: "invalid", reason: "unparseable figure JSON" };
  }
  if (!isValidDocument("graph", figureJson.value)) {
    log(`patterns: dropped ${slug}: the figure failed the graph schema`);
    return { kind: "invalid", reason: "figure failed the graph schema" };
  }
  return {
    kind: "pattern",
    entry: {
      slug,
      title: parsed.meta.title,
      summary: parsed.meta.summary,
      status: parsed.meta.status,
      implements: parsed.meta.implements,
      figure: figureJson.value,
    },
    stored: {
      title: parsed.meta.title,
      summary: parsed.meta.summary,
      status: parsed.meta.status,
      implements: parsed.meta.implements,
      sources: parsed.meta.sources,
      body: parsed.body,
      figure: figureJson.value,
    },
  };
}

/** One file from the official repo at `main`, through the contents API. */
async function readOfficialFile(github: GitHub, path: string, log: Log): Promise<FileText> {
  const response = await github.get(contentsUrl(path), "contents");
  if (isApiError(response)) {
    if (response.kind === "rate-limit") {
      return { kind: "halt", reason: `rate-limited reading patterns/${path}` };
    }
    if (response.kind === "not-found") {
      return { kind: "absent" };
    }
    return { kind: "error", reason: `github ${response.kind}` };
  }
  const body = await readJson(response);
  const content = body.ok && isRecord(body.value) ? body.value["content"] : undefined;
  const text = decodeBase64(content);
  if (text === null) {
    log(`patterns: ${path} has no readable inline content`);
    return { kind: "error", reason: "unreadable file" };
  }
  return { kind: "text", text };
}

/** The `patterns/*.md` slugs in a contents listing; anything else is none. */
function patternSlugs(value: unknown): string[] {
  if (!isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry) || entry["type"] !== "file") {
      return [];
    }
    const name = entry["name"];
    if (!isString(name) || !name.endsWith(".md") || name === "README.md") {
      return [];
    }
    const slug = name.slice(0, -".md".length);
    return SLUG_RE.test(slug) ? [slug] : [];
  });
}

/**
 * Read every pattern page from the official repository's `main`: the
 * directory listing, each `<slug>.md`, and the figure its front matter
 * names. A malformed page, an unreadable file or a figure that fails the
 * graph schema skips that page with a reason in `invalid`, never a failed
 * run; only a rate limit halts. No other repository's patterns are read.
 */
export async function fetchOfficialPatterns(github: GitHub, log: Log): Promise<PatternsRead> {
  const entries: PatternEntry[] = [];
  const documents = new Map<string, StoredPattern>();
  const invalid: IndexInvalid[] = [];
  const listing = await github.get(contentsUrl("patterns"), "contents");
  if (isApiError(listing)) {
    if (listing.kind === "rate-limit") {
      throw new PatternsHalt("rate-limited listing the official patterns");
    }
    if (listing.kind === "not-found") {
      return { entries, documents, invalid, complete: true };
    }
    log(`patterns: listing failed: ${listing.kind}; keeping the previous patterns`);
    return { entries, documents, invalid, complete: false };
  }
  const body = await readJson(listing);
  if (!body.ok) {
    log("patterns: listing did not parse as JSON; keeping the previous patterns");
    return { entries, documents, invalid, complete: false };
  }
  for (const slug of patternSlugs(body.value)) {
    const page = await readOfficialFile(github, `patterns/${slug}.md`, log);
    if (page.kind === "halt") {
      throw new PatternsHalt(page.reason);
    }
    if (page.kind === "absent") {
      log(`patterns: dropped ${slug}: the page vanished after the listing`);
      continue;
    }
    if (page.kind !== "text") {
      invalid.push({ repo: OFFICIAL_REPOSITORY, slug, reason: page.reason });
      continue;
    }
    const loaded = await patternFromTexts(slug, page.text, async (name) => {
      const found = await readOfficialFile(github, `patterns/${name}`, log);
      if (found.kind === "halt") {
        throw new PatternsHalt(found.reason);
      }
      if (found.kind === "text") {
        return { kind: "text", text: found.text };
      }
      return found.kind === "absent" ? { kind: "absent" } : { kind: "error", reason: found.reason };
    }, log);
    if (loaded.kind === "invalid") {
      invalid.push({ repo: OFFICIAL_REPOSITORY, slug, reason: loaded.reason });
      continue;
    }
    entries.push(loaded.entry);
    documents.set(slug, loaded.stored);
  }
  return { entries, documents, invalid, complete: true };
}
