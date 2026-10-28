// SPDX-License-Identifier: Apache-2.0
/**
 * The reference a document installs by.
 *
 * Official documents install by slug alone — the official repository is
 * implicit — while community documents install by `owner/repo/slug`. This
 * module is the one place that decides, and it reuses the data layer's own
 * notion of "official" (`isOfficialRepo`) so a page and an install command
 * can never disagree.
 */
import type { DocumentKind } from "../../../../src/schema.js";
import type { Doc } from "../documents.js";
import { isOfficialRepo } from "../lib.js";

/**
 * Encode one path segment for a URL. The route regexes (`SLUG_RE` et al.)
 * keep every *page* address safe, but a directory name is whatever the
 * repository chose — the listing paths render it into an href and a
 * markdown link, so it is encoded here, once, where every path starts.
 */
function segment(part: string): string {
  return encodeURIComponent(part);
}

export interface PageRef {
  kind: DocumentKind;
  official: boolean;
  owner: string;
  repo: string;
  slug: string;
  /** What the install command takes: the slug, or `owner/repo/slug`. */
  ref: string;
  /** Where the repository lives, for the repo link and the star button. */
  repoUrl: string;
}

/** The reference for a document of `kind` in `owner/repo`. */
export function pageRef(kind: DocumentKind, owner: string, repo: string, slug: string): PageRef {
  const official = isOfficialRepo(owner, repo);
  return {
    kind,
    official,
    owner,
    repo,
    slug,
    ref: official ? slug : `${owner}/${repo}/${slug}`,
    repoUrl: `https://github.com/${segment(owner)}/${segment(repo)}`,
  };
}

/**
 * The catalogue path for a document. Official documents use the short
 * form; community documents carry the repository. Every segment is
 * percent-encoded, so the path is safe both in an HTML attribute and
 * inside a markdown link.
 */
export function pagePath(ref: PageRef): string {
  const verb = ref.kind === "graph" ? "g" : "n";
  return ref.official
    ? `/${verb}/${segment(ref.slug)}`
    : `/${verb}/${segment(ref.owner)}/${segment(ref.repo)}/${segment(ref.slug)}`;
}

/** The reference of a listed document, whose repo is the `owner/repo` pair. */
export function docRef(doc: Doc): PageRef {
  const [owner = "", repo = ""] = doc.repo.split("/");
  return pageRef(doc.kind, owner, repo, doc.slug);
}

/**
 * The editor query one document opens with: `?from=` for a graph, `?node=`
 * for a node — both by the same ref the install command takes — and
 * `?draft=` for a draft, which has no repository. The editor reads exactly
 * these three keys, so this is the one place that spells them.
 */
export function editorQuery(ref: PageRef): string {
  if (ref.ref.startsWith("draft:")) {
    return `?draft=${segment(ref.slug)}`;
  }
  return `${ref.kind === "graph" ? "?from=" : "?node="}${segment(ref.ref)}`;
}

/** The catalogue path of a listed document. */
export function docPath(doc: Doc): string {
  return pagePath(docRef(doc));
}
