// SPDX-License-Identifier: Apache-2.0
/**
 * The request path's queries over the scheduled index.
 *
 * Every listing the Worker serves — home, tabs, `/search`, `/api/search`,
 * `/api/official`, document pages, llms.txt — is answered here from one
 * `StoredIndex`, with no GitHub call. Free-text search is a
 * case-insensitive substring over name, slug, description and
 * `owner/repo`; `top` orders by stars, `new` by updated, paging stays at
 * 20 per page, and the response shapes are exactly the live search's.
 */
import type { DocumentKind } from "../../../src/schema.js";
import type { CatalogEntry, Doc } from "./documents.js";
import { docFromDocument } from "./documents.js";
import { SEARCH_PAGE_SIZE, type SearchInput, type SearchOutcome, type SearchSort } from "./search.js";
import type { IndexEntry, StoredDoc, StoredIndex } from "./store.js";

/** One listed row from its index entry. Listings carry no README text. */
export function rowFromEntry(entry: IndexEntry): Doc {
  return {
    kind: entry.kind,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    readme: "",
    nodeCount: entry.node_count ?? (entry.kind === "node" ? 1 : 0),
    repo: `${entry.owner}/${entry.repo}`,
    official: entry.official,
    stars: entry.stars,
    updated: entry.updated,
    harnesses: entry.harness_hint ?? [],
    sourceRef: entry.ref === "" ? null : entry.ref,
  };
}

/** The official listing: official entries split by kind, in index order. */
export function officialFromIndex(index: StoredIndex): { graphs: Doc[]; nodes: Doc[] } {
  const graphs: Doc[] = [];
  const nodes: Doc[] = [];
  for (const entry of index.entries) {
    if (!entry.official) {
      continue;
    }
    (entry.kind === "graph" ? graphs : nodes).push(rowFromEntry(entry));
  }
  return { graphs, nodes };
}

/** True when the entry matches the free text, case-insensitively. */
function matches(entry: IndexEntry, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") {
    return true;
  }
  const haystacks = [
    entry.name,
    entry.slug,
    entry.description,
    `${entry.owner}/${entry.repo}`,
  ];
  return haystacks.some((haystack) => haystack.toLowerCase().includes(text));
}

/** Stars or updated, descending, unknown last; name breaks the ties. */
function compareEntries(sort: SearchSort, left: IndexEntry, right: IndexEntry): number {
  if (sort === "top") {
    const leftStars = left.stars ?? -1;
    const rightStars = right.stars ?? -1;
    if (leftStars !== rightStars) {
      return rightStars - leftStars;
    }
  } else {
    const leftUpdated = left.updated ?? "";
    const rightUpdated = right.updated ?? "";
    if (leftUpdated !== rightUpdated) {
      return leftUpdated < rightUpdated ? 1 : -1;
    }
  }
  if (left.name !== right.name) {
    return left.name < right.name ? -1 : 1;
  }
  if (left.slug !== right.slug) {
    return left.slug < right.slug ? -1 : 1;
  }
  const leftRepo = `${left.owner}/${left.repo}`;
  const rightRepo = `${right.owner}/${right.repo}`;
  return leftRepo < rightRepo ? -1 : leftRepo > rightRepo ? 1 : 0;
}

/**
 * Community search over the index: filter, sort, page. The outcome shape
 * is the live search's — items, echoed filters, total matches — with
 * `truncated` true while later pages still hold matches.
 */
export function searchFromIndex(index: StoredIndex, input: SearchInput): SearchOutcome {
  const matched = index.entries.filter((entry) => matches(entry, input.q));
  matched.sort((left, right) => compareEntries(input.sort, left, right));
  const start = (input.page - 1) * SEARCH_PAGE_SIZE;
  const items = matched.slice(start, start + SEARCH_PAGE_SIZE).map(rowFromEntry);
  return {
    items,
    q: input.q,
    sort: input.sort,
    page: input.page,
    total: matched.length,
    truncated: matched.length > start + items.length,
  };
}

/** The index entry for one document, or null when not indexed. */
export function entryFor(
  index: StoredIndex,
  kind: DocumentKind,
  owner: string,
  repo: string,
  slug: string,
): IndexEntry | null {
  const wantedOwner = owner.toLowerCase();
  const wantedRepo = repo.toLowerCase();
  for (const entry of index.entries) {
    if (
      entry.kind === kind &&
      entry.slug === slug &&
      entry.owner.toLowerCase() === wantedOwner &&
      entry.repo.toLowerCase() === wantedRepo
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * One document page or API answer: the stored document and README joined
 * to its index entry, rendered through the same shape the live loader
 * serves.
 */
export function documentFromStored(entry: IndexEntry, stored: StoredDoc): CatalogEntry {
  const document = stored.document;
  return {
    document,
    doc: docFromDocument(
      {
        kind: entry.kind,
        slug: entry.slug,
        owner: entry.owner,
        repo: entry.repo,
        stars: entry.stars,
        updated: entry.updated,
        ref: entry.ref,
        official: entry.official,
      },
      document,
      stored.readme,
    ),
  };
}
