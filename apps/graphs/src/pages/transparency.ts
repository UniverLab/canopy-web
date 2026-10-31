// SPDX-License-Identifier: Apache-2.0
/**
 * The transparency page: how the catalogue is built, how the model review
 * works, the exact prompt it runs, and every verdict it gave.
 *
 * A pure `Page` over prose from copy.ts and the bundled review assets:
 * the indexing story (cron, discovery, per-repo fetch, validation, KV
 * writes, serve paths, where the review hooks in) with the mermaid
 * `sequenceDiagram` pre-rendered to static SVG at build time (no runtime
 * mermaid.js), the review rules, the versioned prompt verbatim, and the
 * stored verdicts with hash and date. Advisory only, said twice: once in
 * the review rules, once beside the verdicts.
 */
import { VERDICT_LABELS, type ReviewEntry } from "../review.js";
import {
  TRANSPARENCY_CRON_BODY,
  TRANSPARENCY_DESCRIPTION,
  TRANSPARENCY_DIAGRAM_HEADING,
  TRANSPARENCY_DISCOVERY_BODY,
  TRANSPARENCY_FETCH_BODY,
  TRANSPARENCY_HOOK_BODY,
  TRANSPARENCY_INDEX_HEADING,
  TRANSPARENCY_LEDE,
  TRANSPARENCY_NO_VERDICTS,
  TRANSPARENCY_PROMPT_HEADING,
  TRANSPARENCY_REVIEW_ADVISORY_BODY,
  TRANSPARENCY_REVIEW_BUDGET_BODY,
  TRANSPARENCY_REVIEW_HASH_BODY,
  TRANSPARENCY_REVIEW_HEADING,
  TRANSPARENCY_REVIEW_MODEL_BODY,
  TRANSPARENCY_SERVE_BODY,
  TRANSPARENCY_TITLE,
  TRANSPARENCY_VALIDATE_BODY,
  TRANSPARENCY_VERDICTS_HEADING,
  TRANSPARENCY_WRITES_BODY,
  VERDICT_DATE_LABEL,
  VERDICT_HASH_LABEL,
  transparencyPromptLine,
  verdictOf,
} from "./copy.js";
import { fencedBlock } from "./document.js";
import { type Page } from "./layout.js";
import { escapeHtml } from "./md.js";
import { iconSvg } from "../../../../packages/look/icon-svg.js";

/** What the page renders: the bundled assets plus the stored verdicts. */
export interface TransparencyInput {
  /** The pre-rendered indexing diagram, static SVG. */
  svg: string;
  /** The diagram source, for the markdown twin's fenced block. */
  mmd: string;
  /** The exact prompt text, shown verbatim. */
  prompt: string;
  /** The prompt version the page names. */
  promptVersion: string;
  /** Every stored verdict, in aggregate order. */
  reviews: ReviewEntry[];
}

/** One prose paragraph, escaped. */
function para(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

/** One section heading with its icon. */
function heading(text: string): string {
  return `<h2 class="kicker">${iconSvg("bookOpen")}<span>${escapeHtml(text)}</span></h2>`;
}

/** The catalogue path of one reviewed document. */
function reviewPath(entry: ReviewEntry): string {
  const verb = entry.kind === "graph" ? "g" : "n";
  const slug = encodeURIComponent(entry.slug);
  const official = entry.owner.toLowerCase() === "univerlab" &&
    entry.repo.toLowerCase() === "canopy-graphs";
  return official
    ? `/${verb}/${slug}`
    : `/${verb}/${encodeURIComponent(entry.owner)}/${encodeURIComponent(entry.repo)}/${slug}`;
}

/** One verdict row: the document linked, the badge line, hash and date. */
function verdictItem(entry: ReviewEntry): string {
  const label = VERDICT_LABELS[entry.verdict];
  const reasons = entry.reasons === "" ? "" : ` — ${escapeHtml(entry.reasons)}`;
  return (
    `<li>` +
    `<a class="row-name" href="${reviewPath(entry)}">${escapeHtml(entry.slug)}</a> ` +
    `<span class="verdict-meta">${escapeHtml(entry.kind)} ${escapeHtml(entry.owner)}/${escapeHtml(entry.repo)}</span><br>` +
    `<span>${escapeHtml(verdictOf(entry.model))} · ${escapeHtml(label)}</span>${reasons}<br>` +
    `<span class="verdict-meta">${VERDICT_HASH_LABEL}: ${escapeHtml(entry.hash)} · ` +
    `${VERDICT_DATE_LABEL}: ${escapeHtml(entry.reviewed_at)}</span>` +
    `</li>`
  );
}

/** One verdict row for the twin: link, badge line, hash and date. */
function verdictMarkdown(entry: ReviewEntry): string {
  const label = VERDICT_LABELS[entry.verdict];
  const head = `- [${entry.slug}](${reviewPath(entry)}) — ${entry.kind} ${entry.owner}/${entry.repo}`;
  const badge = `  ${verdictOf(entry.model)} · ${label}${entry.reasons === "" ? "" : ` — ${entry.reasons}`}`;
  const meta = `  ${VERDICT_HASH_LABEL}: ${entry.hash} · ${VERDICT_DATE_LABEL}: ${entry.reviewed_at}`;
  return [head, badge, meta].join("\n");
}

/**
 * The transparency page and its markdown twin. The HTML inlines the
 * pre-rendered SVG and the prompt verbatim in a mono block; the twin
 * carries the diagram source as a fenced mermaid block and the prompt as
 * a fenced XML block, so agents read the same facts.
 */
export function transparencyPage(input: TransparencyInput): Page {
  const indexParas = [
    TRANSPARENCY_CRON_BODY,
    TRANSPARENCY_DISCOVERY_BODY,
    TRANSPARENCY_FETCH_BODY,
    TRANSPARENCY_VALIDATE_BODY,
    TRANSPARENCY_WRITES_BODY,
    TRANSPARENCY_SERVE_BODY,
    TRANSPARENCY_HOOK_BODY,
  ];
  const reviewParas = [
    TRANSPARENCY_REVIEW_MODEL_BODY,
    TRANSPARENCY_REVIEW_HASH_BODY,
    TRANSPARENCY_REVIEW_BUDGET_BODY,
    TRANSPARENCY_REVIEW_ADVISORY_BODY,
  ];
  const html = [
    `<h1 class="index-title">${escapeHtml(TRANSPARENCY_TITLE)}</h1>`,
    `<p class="description">${escapeHtml(TRANSPARENCY_LEDE)}</p>`,
    heading(TRANSPARENCY_INDEX_HEADING),
    ...indexParas.map(para),
    heading(TRANSPARENCY_DIAGRAM_HEADING),
    `<figure class="diagram">${input.svg}</figure>`,
    heading(TRANSPARENCY_REVIEW_HEADING),
    ...reviewParas.map(para),
    heading(TRANSPARENCY_PROMPT_HEADING),
    para(transparencyPromptLine(input.promptVersion)),
    `<pre class="prompt"><code>${escapeHtml(input.prompt)}</code></pre>`,
    heading(TRANSPARENCY_VERDICTS_HEADING),
    input.reviews.length === 0
      ? para(TRANSPARENCY_NO_VERDICTS)
      : `<ol class="verdict-list">${input.reviews.map(verdictItem).join("")}</ol>`,
  ].join("\n");

  const markdown = [
    `# ${TRANSPARENCY_TITLE}`,
    ``,
    TRANSPARENCY_LEDE,
    ``,
    `## ${TRANSPARENCY_INDEX_HEADING}`,
    ``,
    ...indexParas.flatMap((body) => [body, ``]),
    `## ${TRANSPARENCY_DIAGRAM_HEADING}`,
    ``,
    ...fencedBlock("mermaid", input.mmd),
    `## ${TRANSPARENCY_REVIEW_HEADING}`,
    ``,
    ...reviewParas.flatMap((body) => [body, ``]),
    `## ${TRANSPARENCY_PROMPT_HEADING}`,
    ``,
    transparencyPromptLine(input.promptVersion),
    ``,
    ...fencedBlock("xml", input.prompt),
    `## ${TRANSPARENCY_VERDICTS_HEADING}`,
    ``,
    ...(input.reviews.length === 0
      ? [TRANSPARENCY_NO_VERDICTS, ``]
      : [...input.reviews.map(verdictMarkdown), ``]),
  ].join("\n");

  return { title: TRANSPARENCY_TITLE, description: TRANSPARENCY_DESCRIPTION, html, markdown };
}
