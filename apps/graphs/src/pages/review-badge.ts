// SPDX-License-Identifier: Apache-2.0
/**
 * The verdict badge: the pill on a document page's datasheet and the chip
 * on a catalogue row, both drawn from one reviewed verdict.
 *
 * A pill names its reviewer short ("Muse · Looks safe", body font) and
 * links to the transparency page; the full model id rides the `title`, the
 * same "Verdict of <model>" the transparency list shows. A chip is the
 * same icon and short label without the reviewer, beside the harness dots.
 * `reviewFor` matches a listed document against the `reviews:v1` aggregate
 * by kind and `owner/repo/slug`, the same coordinates the review keys use.
 */
import { iconSvg, type IconName } from "../../../../packages/look/icon-svg.js";
import type { Doc } from "../documents.js";
import { VERDICT_LABELS, type StoredReview, type StoredReviews, type Verdict } from "../review.js";
import { TRANSPARENCY_HREF, verdictOf } from "./copy.js";
import { escapeHtml } from "./md.js";
import { docRef } from "./ref.js";

/** The shield per verdict: check, question, alert. */
export const VERDICT_ICON: Record<Verdict, IconName> = {
  "looks-safe": "shieldCheck",
  "needs-look": "shieldQuestion",
  flagged: "shieldAlert",
};

/**
 * The reviewer short label for a model id: the vendor word for a known
 * prefix, the full id otherwise — never wrong, just longer.
 */
export function reviewerOf(model: string): string {
  const lower = model.toLowerCase();
  if (lower.startsWith("muse-")) {
    return "Muse";
  }
  if (lower.startsWith("meta-")) {
    return "Meta";
  }
  if (lower.startsWith("claude-") || lower.startsWith("anthropic-")) {
    return "Claude";
  }
  return model;
}

/**
 * The datasheet pill: shield, "reviewer · label", a link to the
 * transparency page with the full "Verdict of <model>" as its title.
 */
export function reviewPill(review: StoredReview): string {
  return (
    `<a class="review-pill review-${review.verdict}" href="${TRANSPARENCY_HREF}"` +
    ` title="${escapeHtml(verdictOf(review.model))}">` +
    `${iconSvg(VERDICT_ICON[review.verdict])}` +
    `<span>${escapeHtml(reviewerOf(review.model))} · ${escapeHtml(VERDICT_LABELS[review.verdict])}</span></a>`
  );
}

/**
 * The catalogue-row chip: the same shield and short label, no reviewer,
 * beside the harness dots. A link like the pill, for consistency.
 */
export function reviewChip(review: StoredReview): string {
  return (
    `<a class="review-chip review-${review.verdict}" href="${TRANSPARENCY_HREF}"` +
    ` title="${escapeHtml(verdictOf(review.model))}">` +
    `${iconSvg(VERDICT_ICON[review.verdict])}` +
    `<span>${escapeHtml(VERDICT_LABELS[review.verdict])}</span></a>`
  );
}

/**
 * The aggregate's review for a listed document, or null when the aggregate
 * is missing or carries no row for it — then the row renders exactly as an
 * unreviewed one. Owner and repo compare lowercased, kind and slug exact.
 */
export function reviewFor(reviews: StoredReviews | null, doc: Doc): StoredReview | null {
  if (reviews === null) {
    return null;
  }
  const ref = docRef(doc);
  const owner = ref.owner.toLowerCase();
  const repo = ref.repo.toLowerCase();
  for (const entry of reviews.reviews) {
    if (
      entry.kind === doc.kind && entry.owner.toLowerCase() === owner &&
      entry.repo.toLowerCase() === repo && entry.slug === doc.slug
    ) {
      return {
        verdict: entry.verdict,
        reasons: entry.reasons,
        patterns: [...entry.patterns],
        hash: entry.hash,
        prompt: entry.prompt,
        model: entry.model,
        reviewed_at: entry.reviewed_at,
      };
    }
  }
  return null;
}
