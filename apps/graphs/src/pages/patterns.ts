// SPDX-License-Identifier: Apache-2.0
/**
 * The pattern pages: the `/patterns` card grid and one `/patterns/<slug>`.
 *
 * A reader sees the shape drawn first: the list shows every figure as a
 * small plate on its card, and the page opens with the figure's full plate
 * — the same plate renderer and look as graph pages, the vertical plate
 * under 640 px and the horizontal one above, on the black stage. Then the
 * status badge, the body (the shared markdown renderer, no new HTML), the
 * sources as links, and Implemented-by: each `implements` ref as the
 * catalogue's index row, a graph's own small plate beneath its row.
 */
import { type GraphDocument } from "../../../../packages/plate/document.js";
import { renderPlate } from "../../../../packages/plate/render.js";
import { iconSvg } from "../../../../packages/look/icon-svg.js";
import type { JsonValue } from "../../../../src/schema.js";
import type { Doc } from "../documents.js";
import type { PatternEntry, PatternRef, PatternStatus, StoredPattern } from "../patterns.js";
import { comparePatterns } from "../patterns.js";
import { escapeHtml, isSafeUrl, renderMarkdown } from "./md.js";
import { fencedBlock, mdText } from "./document.js";
import type { Page } from "./layout.js";
import { docRowInner } from "./rows.js";
import { docPath, docRef } from "./ref.js";
import {
  EXPERIMENT_NOTICE,
  IMPLEMENTED_BY_HEADING,
  PATTERNS_DESCRIPTION,
  PATTERNS_EMPTY,
  PATTERNS_LEDE,
  PATTERNS_NO_IMPLEMENTS,
  PATTERNS_TITLE,
  PATTERN_FIGURE_HEADING,
  PATTERN_MISSING_REF,
  PATTERN_SOURCES_HEADING,
} from "./copy.js";

/** The badge modifier per status: the experiment one wears the warn tint. */
const STATUS_CLASS: Record<PatternStatus, string> = {
  standard: "status-standard",
  "in use": "status-in-use",
  experiment: "status-experiment",
};

/** One status badge: the status word in its tint. */
function statusBadge(status: PatternStatus): string {
  return `<span class="badge-status ${STATUS_CLASS[status]}">${escapeHtml(status)}</span>`;
}

/**
 * One figure as a thumbnail: the plate renderer at thumbnail size, in both
 * orientations like a full plate, so the small drawing shows on phones too.
 * The drawing is decorative beside the words around it, so it hides from
 * assistive tech; the page's own plate carries the labelled drawing.
 */
function thumbFigure(figure: JsonValue, label: string): string {
  const horizontal = renderPlate(figure as unknown as GraphDocument, "horizontal");
  const vertical = renderPlate(figure as unknown as GraphDocument, "vertical");
  return horizontal === "" && vertical === ""
    ? ""
    : `<figure class="plate thumb" aria-hidden="true">${horizontal}${vertical}<figcaption class="sr-only">${escapeHtml(label)}</figcaption></figure>`;
}

/** One card: the small plate, the title, the badge and the summary. */
function patternCard(entry: PatternEntry): string {
  const href = `/patterns/${entry.slug}`;
  return (
    `<li class="card">` +
    `<a class="card-link" href="${href}">${thumbFigure(entry.figure, entry.title)}` +
    `<span class="card-title">${escapeHtml(entry.title)}</span></a>` +
    statusBadge(entry.status) +
    `<span class="card-summary">${escapeHtml(entry.summary)}</span>` +
    `</li>`
  );
}

/** One card for the twin: title, summary and status, in card order. */
function cardMarkdown(entry: PatternEntry): string {
  return `- [${mdText(entry.title)}](/patterns/${entry.slug}) — ${mdText(entry.summary)} (${entry.status})`;
}

/**
 * The `/patterns` grid: standard first, then in use, then experiment —
 * each card its figure drawn small, non-interactive, above its words.
 */
export function patternsIndexPage(entries: PatternEntry[]): Page {
  const ordered = [...entries].sort(comparePatterns);
  const html = [
    `<h1 class="index-title">${escapeHtml(PATTERNS_TITLE)}</h1>`,
    `<p class="description">${escapeHtml(PATTERNS_LEDE)}</p>`,
    ordered.length === 0
      ? `<p>${escapeHtml(PATTERNS_EMPTY)}</p>`
      : `<ol class="cards">${ordered.map(patternCard).join("")}</ol>`,
  ].join("\n");
  const markdown = [
    `# ${PATTERNS_TITLE}`,
    ``,
    PATTERNS_LEDE,
    ``,
    ...(ordered.length === 0 ? [PATTERNS_EMPTY, ``] : [...ordered.map(cardMarkdown), ``]),
  ].join("\n");
  return { title: PATTERNS_TITLE, description: PATTERNS_DESCRIPTION, html, markdown };
}

/** One `implements` ref, resolved against the catalogue index (or not). */
export interface ImplementsRow {
  ref: PatternRef;
  /** The catalogue row when the ref is indexed; null when it is missing. */
  doc: Doc | null;
  /** A graph ref's own document, for its small plate; null otherwise. */
  figure: JsonValue | null;
}

/** One known ref: the catalogue's index row, a graph's small plate below. */
function implementsItem(row: ImplementsRow): string {
  const doc = row.doc as Doc;
  const thumb = row.figure === null ? "" : thumbFigure(row.figure, doc.name);
  return `<li class="row">${docRowInner(doc)}${thumb}</li>`;
}

/** One missing ref: the ref as text, with the not-in-the-catalogue line. */
function missingItem(ref: PatternRef): string {
  return (
    `<li class="row row-missing">` +
    `<span class="row-name">${escapeHtml(ref.kind)}:${escapeHtml(ref.slug)}</span>` +
    `<span class="row-meta">${escapeHtml(PATTERN_MISSING_REF)}</span>` +
    `</li>`
  );
}

/** One known ref for the twin, in the listing's own shape. */
function implementsMarkdown(row: ImplementsRow): string {
  const doc = row.doc as Doc;
  return `- [${mdText(doc.name)}](${docPath(doc)}) — ${mdText(doc.description)} — ${docRef(doc).ref}`;
}

/** One missing ref for the twin: the ref and the not-in-the-catalogue line. */
function missingMarkdown(ref: PatternRef): string {
  return `- ${ref.kind}:${ref.slug} — ${PATTERN_MISSING_REF}`;
}

/** One source: its title linked, or bare text when the URL is unsafe. */
function sourceItem(source: { title: string; url: string }): string {
  return isSafeUrl(source.url)
    ? `<li><a href="${escapeHtml(source.url)}" rel="nofollow">${escapeHtml(source.title)}</a></li>`
    : `<li>${escapeHtml(source.title)}</li>`;
}

/**
 * The body's leading `# Title` when it merely repeats the front-matter
 * title: the page already renders that title as its heading, so the second
 * copy goes. Only the first non-blank line is ever considered, and only a
 * level-1 heading whose text equals the title (trimmed, case-insensitive)
 * is dropped — any other first line, heading or not, comes through
 * untouched, and so does the body byte-for-byte when nothing matched.
 * Graph READMEs and the markdown twin keep their own titles.
 */
export function dropLeadingTitle(body: string, title: string): string {
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  const heading = first === -1 ? null : /^#\s+(.*)$/.exec(lines[first] ?? "");
  if (heading === null || (heading[1] ?? "").trim().toLowerCase() !== title.trim().toLowerCase()) {
    return body;
  }
  lines.splice(first, 1);
  return lines.join("\n");
}

/**
 * One pattern page: the figure's plate at the top, full width, then the
 * status badge (an experiment carries its one-line notice), the body, the
 * sources as links, and Implemented-by. The twin carries the same order,
 * with the figure as a fenced JSON block.
 */
export function patternPage(pattern: StoredPattern, rows: ImplementsRow[]): Page {
  const horizontal = renderPlate(pattern.figure as unknown as GraphDocument, "horizontal");
  const vertical = renderPlate(pattern.figure as unknown as GraphDocument, "vertical");
  const plate = horizontal === "" && vertical === ""
    ? ""
    : `<figure class="plate">${horizontal}${vertical}</figure>`;
  const badge = statusBadge(pattern.status);
  const notice = pattern.status === "experiment"
    ? `<aside class="community-warning" role="note">${iconSvg("triangleAlert")}<p>${escapeHtml(EXPERIMENT_NOTICE)}</p></aside>`
    : "";
  const body = `<div class="readme">${renderMarkdown(dropLeadingTitle(pattern.body, pattern.title))}</div>`;
  const sources =
    `<h2 class="kicker">${iconSvg("bookOpen")}<span>${escapeHtml(PATTERN_SOURCES_HEADING)}</span></h2>\n` +
    `<ul class="sources">${pattern.sources.map(sourceItem).join("")}</ul>`;
  const implementedBy = rows.length === 0
    ? `<h2 class="kicker">${iconSvg("blocks")}<span>${escapeHtml(IMPLEMENTED_BY_HEADING)}</span></h2>\n` +
      `<p>${escapeHtml(PATTERNS_NO_IMPLEMENTS)}</p>`
    : `<h2 class="kicker">${iconSvg("blocks")}<span>${escapeHtml(IMPLEMENTED_BY_HEADING)}</span></h2>\n` +
      `<ol class="index">${rows.map((row) => row.doc === null ? missingItem(row.ref) : implementsItem(row)).join("")}</ol>`;

  const html = [
    plate,
    `<h1 class="doc-title">${escapeHtml(pattern.title)} ${badge}</h1>`,
    `<p class="description">${escapeHtml(pattern.summary)}</p>`,
    notice,
    body,
    sources,
    implementedBy,
  ].filter((block) => block !== "").join("\n");

  const figureJson = JSON.stringify(pattern.figure, null, 2);
  const markdown = [
    `# ${pattern.title}`,
    ``,
    `Status: ${pattern.status}`,
    ...(pattern.status === "experiment" ? [EXPERIMENT_NOTICE, ``] : [``]),
    `## ${PATTERN_FIGURE_HEADING}`,
    ``,
    ...fencedBlock("json", figureJson),
    pattern.body.endsWith("\n") || pattern.body === "" ? pattern.body : `${pattern.body}\n`,
    `## ${PATTERN_SOURCES_HEADING}`,
    ``,
    // The twin degrades an unsafe URL to text like the page does: it
    // generates this link itself, so it never hands agents a target the
    // HTML side would have refused.
    ...pattern.sources.map((source) =>
      isSafeUrl(source.url) ? `- [${mdText(source.title)}](${source.url})` : `- ${mdText(source.title)}`),
    ``,
    `## ${IMPLEMENTED_BY_HEADING}`,
    ``,
    ...(rows.length === 0
      ? [PATTERNS_NO_IMPLEMENTS, ``]
      : [...rows.map((row) => row.doc === null ? missingMarkdown(row.ref) : implementsMarkdown(row)), ``]),
  ].join("\n");

  return { title: pattern.title, description: pattern.summary, html, markdown };
}
