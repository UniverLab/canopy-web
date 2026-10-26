// SPDX-License-Identifier: Apache-2.0
/**
 * The reference a document installs by.
 *
 * Official documents install by slug alone — the registry repository is
 * implicit — while community documents install by `owner/repo/slug`. This
 * module is the one place that decides, and it reuses the data layer's own
 * notion of "official" (`isOfficialRepo`) so a page and an install command
 * can never disagree.
 */
import type { DocumentKind } from "../../../src/schema.js";
import type { Doc } from "../documents.js";
import { isOfficialRepo } from "../lib.js";

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
    repoUrl: `https://github.com/${owner}/${repo}`,
  };
}

/**
 * The catalogue path for a document. Official documents use the short
 * form; community documents carry the repository.
 */
export function pagePath(ref: PageRef): string {
  const verb = ref.kind === "graph" ? "g" : "n";
  return ref.official ? `/${verb}/${ref.slug}` : `/${verb}/${ref.owner}/${ref.repo}/${ref.slug}`;
}

/** The reference of a listed document, whose repo is the `owner/repo` pair. */
export function docRef(doc: Doc): PageRef {
  const [owner = "", repo = ""] = doc.repo.split("/");
  return pageRef(doc.kind, owner, repo, doc.slug);
}

/** The catalogue path of a listed document. */
export function docPath(doc: Doc): string {
  return pagePath(docRef(doc));
}
