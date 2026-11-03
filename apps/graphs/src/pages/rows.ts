// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue's index row, shared by every listing.
 *
 * The home page, the search results and a pattern page's Implemented-by
 * section all render documents through this module: the name in the
 * display face, the kind badge, the node count for graphs, harness dots,
 * stars, last updated and the install box, with the description as the
 * row's second block. `docRowInner` is the row's contents without its
 * `<li>`, for rows that carry one more block — a pattern page appends a
 * graph's small plate.
 */
import type { Doc } from "../documents.js";
import { harnessColor } from "../../../../packages/plate/vocabulary.js";
import { iconSvg } from "../../../../packages/look/icon-svg.js";
import { VERDICT_LABELS, type StoredReview, type StoredReviews } from "../review.js";
import { escapeHtml } from "./md.js";
import { copyButton } from "./look.js";
import { mdText } from "./document.js";
import { docPath, docRef } from "./ref.js";
import { reviewChip, reviewFor } from "./review-badge.js";
import {
  NODES_LABEL,
  OFFICIAL_BADGE,
  STARS_LABEL,
  countLine,
  installCommand,
} from "./copy.js";

/** The harness dots of an index row: one accent dot per known harness. */
export function harnessDots(harnesses: string[]): string {
  if (harnesses.length === 0) {
    return "";
  }
  const dots = harnesses.map((stem) => {
    const color = harnessColor(stem) ?? "var(--canopy)";
    return `<span class="dot" style="--nc:${color}" title="${escapeHtml(stem)}"></span>`;
  });
  return `<span class="dots" role="img" aria-label="harnesses: ${escapeHtml(harnesses.join(", "))}">${dots.join("")}</span>`;
}

/**
 * One index row's contents: the name in the display face, the kind badge,
 * the node count for graphs, harness dots, the verdict chip when reviewed,
 * stars, last updated and the install box. One flex line on desktop, three
 * stacked lines under 900 px; the description rides along as the row's
 * second block. Official rows carry the badge next to the name; community
 * rows show their source instead.
 */
export function docRowInner(doc: Doc, review: StoredReview | null = null): string {
  const install = installCommand(doc.kind, docRef(doc).ref);
  const standing = doc.official
    ? `<span class="badge-official">${iconSvg("badgeCheck")}<span>${OFFICIAL_BADGE}</span></span>`
    : `<span class="row-source">${escapeHtml(doc.repo)}</span>`;
  const kind = `<span class="kind">${iconSvg(doc.kind === "graph" ? "workflow" : "box")}<span>${escapeHtml(doc.kind)}</span></span>`;
  const nodes = doc.kind === "graph" ? `<span class="row-meta">${countLine(NODES_LABEL, doc.nodeCount)}</span>` : "";
  const stars = doc.stars === null
    ? ""
    : `<span class="row-meta">${iconSvg("star")} ${escapeHtml(countLine(STARS_LABEL, doc.stars))}</span>`;
  const updated = doc.updated === null
    ? ""
    : `<time class="row-meta" datetime="${escapeHtml(doc.updated)}">${escapeHtml(doc.updated)}</time>`;
  const description = doc.description === ""
    ? ""
    : `<span class="row-desc">${escapeHtml(doc.description)}</span>`;
  return (
    `<a class="row-name" href="${docPath(doc)}">${escapeHtml(doc.name)}</a>` +
    standing +
    kind +
    nodes +
    harnessDots(doc.harnesses) +
    (review === null ? "" : reviewChip(review)) +
    stars +
    updated +
    `<span class="row-install"><code>${escapeHtml(install)}</code>${copyButton(install)}</span>` +
    description
  );
}

/** One index row: the shared contents in its `<li>`. */
export function docItem(doc: Doc, review: StoredReview | null = null): string {
  return `<li class="row">${docRowInner(doc, review)}</li>`;
}

export function docList(docs: Doc[], emptyLine: string, reviews: StoredReviews | null = null): string {
  if (docs.length === 0) {
    return `<p>${emptyLine}</p>`;
  }
  return `<ol class="index">${docs.map((doc) => docItem(doc, reviewFor(reviews, doc))).join("")}</ol>`;
}

export function docListMarkdown(
  docs: Doc[],
  emptyLine: string,
  reviews: StoredReviews | null = null,
): string {
  if (docs.length === 0) {
    return `${emptyLine}\n`;
  }
  const lines = docs.map((doc) => {
    const line = `- [${mdText(doc.name)}](${docPath(doc)}) — ${mdText(doc.description)} — ${docRef(doc).ref}`;
    const review = reviewFor(reviews, doc);
    return review === null ? line : `${line} · Verdict: ${VERDICT_LABELS[review.verdict]}`;
  });
  return `${lines.join("\n")}\n`;
}
