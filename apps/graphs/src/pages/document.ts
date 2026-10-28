// SPDX-License-Identifier: Apache-2.0
/**
 * The document page: the plate, the datasheet, "what this runs" and the
 * README, rendered from one validated document.
 *
 * `/g`, `/n` and `/d` all come through `documentPage`, so a shared document
 * reads the same wherever it is reached. A route passes what only it knows:
 * a draft hands in a banner, `standalone` (no Star/Source/Ref/Stars/Report,
 * because a draft has no repository) and its own install command. Everything
 * else is the document itself.
 */
import { type GraphDocument, type NodeDocument, structureOf } from "../../../../packages/plate/document.js";
import { renderNodePlate, renderPlate } from "../../../../packages/plate/render.js";
import { mulberry32 } from "../../../../packages/plate/walk.js";
import { iconSvg } from "../../../../packages/look/icon-svg.js";
import type { DocumentKind, JsonValue } from "../../../../src/schema.js";
import type { Doc } from "../documents.js";
import { isArray, isRecord, isString, stringField } from "../json.js";
import { escapeHtml, renderMarkdown } from "./md.js";
import { copyButton } from "./look.js";
import { editorQuery, pagePath, type PageRef } from "./ref.js";
import { reportUrl, REPORT_REPOSITORY_HREF } from "./report.js";
import { linkAttrs, type Page } from "./layout.js";
import { attentionFor, type RunCommand, type RunPrompt, runsOf } from "./runs.js";
import {
  EDITOR_ADD_TO_GRAPH,
  EDITOR_EDIT_COPY,
  INSTALL_HEADING,
  OFFICIAL_BADGE,
  PATTERNS_SHEET_LABEL,
  README_HEADING,
  REPORT_LABEL,
  REPORT_REPO_LABEL,
  RUNS_HEADING,
  RUNS_REVIEW_LINE,
  RUNS_SECTION_ID,
  SHEET_AGENTS,
  SHEET_EDGES,
  SHEET_ENSEMBLES,
  SHEET_KIND,
  SHEET_NAME,
  SHEET_NODES,
  SHEET_REF,
  SHEET_SOURCE,
  SHEET_STARS,
  SITE_NAME,
  STARS_LABEL,
  STAR_BUTTON,
  attentionChip,
  builtinPresetLine,
  communityWarningHtml,
  communityWarningMarkdown,
  countLine,
  edgesLine,
  ensembleLine,
  installCommand,
  nodesByKindLine,
  runsSummary,
} from "./copy.js";

/** One line of twin text: flattened, with markdown punctuation backslashed. */
export function mdText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ").replace(/([[\]])/g, "\\$1");
}

/** An external link: its words, then the arrow that says it leaves the site. */
function externalLink(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}"${linkAttrs(href)}>${escapeHtml(label)}${iconSvg("arrowUpRight")}</a>`;
}

/** The agent nodes a harness will have to run; empty for node documents. */
function agentNames(document: unknown): string[] {
  if (!isRecord(document) || !isArray(document["nodes"])) {
    return [];
  }
  return document["nodes"].flatMap((node) =>
    isRecord(node) && stringField(node, "kind") === "agent" && isString(node["name"])
      ? [node["name"]]
      : [],
  );
}

/**
 * The plate figure for a document page: the graph plate, or the one node —
 * rendered in both orientations, with CSS showing the vertical one under
 * 640 px and the horizontal one above. No JavaScript is involved.
 */
function plateFigure(document: JsonValue, kind: PageRef["kind"]): string {
  // The data layer only serves validated documents, so the cast is honest;
  // the renderers stay total and draw nothing when it is not.
  // One seed per figure, shared by the horizontal and vertical plate, so
  // both orientations walk the same fail edges — and a fresh one every
  // render, so the walk looks alive across reloads.
  const random = mulberry32(Date.now() >>> 0);
  const horizontal = kind === "graph"
    ? renderPlate(document as unknown as GraphDocument, "horizontal", undefined, random)
    : renderNodePlate(document as unknown as NodeDocument, "horizontal");
  const vertical = kind === "graph"
    ? renderPlate(document as unknown as GraphDocument, "vertical", undefined, random)
    : renderNodePlate(document as unknown as NodeDocument, "vertical");
  return horizontal === "" && vertical === ""
    ? ""
    : `<figure class="plate">${horizontal}${vertical}</figure>`;
}

/** One datasheet field: the label and its already-escaped HTML value. */
function sheetField(label: string, value: string): string {
  return `<div class="field"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

/** A graph's node counts by kind, in first-appearance order. */
function nodesByKind(document: JsonValue): Array<{ kind: string; count: number }> {
  const structure = structureOf(document);
  if (structure === null) {
    return [];
  }
  const counts = new Map<string, number>();
  for (const node of structure.nodes) {
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

/**
 * One command of the runs section: its node or hook title, the attention
 * chips it earned, and its verbatim text in a mono block, always expanded.
 */
function commandBlock(command: RunCommand): string {
  const chips = attentionFor(command.text)
    .map((label) => `<span class="attention-chip">${escapeHtml(attentionChip(label))}</span>`)
    .join(" ");
  const marks = chips === "" ? "" : ` ${chips}`;
  return (
    `<div class="run">` +
    `<p class="run-where">${escapeHtml(command.where)}${marks}</p>` +
    `<pre class="run-command"><code>${escapeHtml(command.text)}</code></pre>` +
    `</div>`
  );
}

/**
 * One agent instruction of the runs section: a disclosure titled by node,
 * its first three lines as the summary, the full text inside. A builtin
 * preset has no text in the document, so it names itself instead.
 */
function promptBlock(prompt: RunPrompt): string {
  const preview = prompt.source === "builtin"
    ? builtinPresetLine(prompt.text)
    : prompt.text.split(/\r?\n/).slice(0, 3).join("\n");
  const body = prompt.source === "builtin"
    ? `<p class="run-builtin">${escapeHtml(builtinPresetLine(prompt.text))}</p>`
    : `<pre class="run-prompt-text"><code>${escapeHtml(prompt.text)}</code></pre>`;
  return (
    `<details class="run-prompt">` +
    `<summary><span class="run-where">${escapeHtml(prompt.where)}</span>` +
    `<span class="run-preview">${escapeHtml(preview)}</span></summary>` +
    body +
    `</details>`
  );
}

/**
 * The transparency section, before the README: the summary line, every
 * command verbatim, every agent instruction readable. Even an empty
 * document states its counts, so the absence of runs is visible too.
 * On community documents the summary carries the warn tint.
 */
function runsSectionHtml(kind: DocumentKind, document: JsonValue, community: boolean): string {
  const runs = runsOf(kind, document);
  const summaryClass = community ? "runs-summary runs-community" : "runs-summary";
  return [
    `<section class="runs" id="${RUNS_SECTION_ID}">`,
    `<h2 class="kicker">${iconSvg("terminal")}<span>${RUNS_HEADING}</span></h2>`,
    `<p class="${summaryClass}">${escapeHtml(runsSummary(runs.commands.length, runs.prompts.length))}</p>`,
    ...runs.commands.map(commandBlock),
    ...runs.prompts.map(promptBlock),
    `</section>`,
  ].join("\n");
}

/**
 * One fenced block for the twin: the fence outgrows any backtick run the
 * text carries, so a command containing ``` stays one block.
 */
export function fencedBlock(info: string, text: string): string[] {
  const longest = (text.match(/`+/g) ?? []).reduce((found, run) => Math.max(found, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${info}`, text, fence, ``];
}

/**
 * The same section for the markdown twin: commands and prompts in fenced
 * blocks under their titles, attention marks as plain lines, so an agent
 * reading the twin sees what the page shows.
 */
function runsSectionMarkdown(kind: DocumentKind, document: JsonValue): string {
  const runs = runsOf(kind, document);
  const lines = [
    `## ${RUNS_HEADING}`,
    ``,
    runsSummary(runs.commands.length, runs.prompts.length),
    ``,
  ];
  for (const command of runs.commands) {
    lines.push(`### ${mdText(command.where)}`, ``, ...fencedBlock("sh", command.text));
    const marks = attentionFor(command.text);
    if (marks.length > 0) {
      lines.push(`Attention: ${marks.join(", ")}.`, ``);
    }
  }
  for (const prompt of runs.prompts) {
    const text = prompt.source === "builtin" ? builtinPresetLine(prompt.text) : prompt.text;
    lines.push(`### ${mdText(prompt.where)}`, ``, ...fencedBlock("text", text));
  }
  return lines.join("\n").trimEnd();
}

/** The public address of a document page: the URL a report names. */
function pageUrlOf(ref: PageRef): string {
  return `https://${SITE_NAME}${pagePath(ref)}`;
}

/**
 * The options one document page takes beyond its document. The catalogue's
 * `/g` and `/n` pages pass none of them; a draft page passes all three, so it
 * renders through the same plate, datasheet and runs section instead of a
 * forked template.
 */
export interface DocumentPageOptions {
  /** A block above the title: the draft's "unreviewed, expiring" banner. */
  banner?: { html: string; markdown: string };
  /** True for a draft: no Star, Source, Ref, Stars, Report or community warning. */
  standalone?: boolean;
  /** The exact install command, when it is not the ref's own. */
  install?: string;
  /** The pattern pages whose `implements` names this document, if any. */
  patterns?: Array<{ slug: string; title: string }>;
}

/**
 * The datasheet beside the plate: kind, name, source, ref and stars, then —
 * for graphs — nodes by kind, edges with the fail count, ensembles and the
 * agent nodes a harness must run, then install and the report link. A field
 * with no data is omitted, never printed as a placeholder. A standalone page
 * (a draft) keeps kind, name, the graph fields and the install box, and drops
 * everything that only makes sense for a published, sourced document.
 */
function datasheet(
  doc: Doc,
  document: JsonValue,
  ref: PageRef,
  options: { install: string; standalone: boolean; patterns: Array<{ slug: string; title: string }> },
): { html: string; lines: string[] } {
  const install = options.install;
  const kindMark = iconSvg(ref.kind === "graph" ? "workflow" : "box");
  const fields: string[] = [
    sheetField(SHEET_KIND, `${kindMark} ${escapeHtml(ref.kind)}`),
    sheetField(SHEET_NAME, escapeHtml(doc.name)),
  ];
  const lines = [
    `- ${SHEET_KIND}: ${ref.kind}`,
    `- ${SHEET_NAME}: ${mdText(doc.name)}`,
  ];
  if (!options.standalone) {
    fields.push(sheetField(SHEET_SOURCE, externalLink(ref.repoUrl, doc.repo)));
    lines.push(`- ${SHEET_SOURCE}: ${ref.repoUrl}`);
  }
  if (doc.sourceRef !== null) {
    fields.push(sheetField(SHEET_REF, escapeHtml(doc.sourceRef)));
    lines.push(`- ${SHEET_REF}: ${doc.sourceRef}`);
  }
  if (doc.stars !== null) {
    fields.push(sheetField(SHEET_STARS, `${iconSvg("star")} ${escapeHtml(countLine(STARS_LABEL, doc.stars))}`));
    lines.push(`- ${SHEET_STARS}: ${countLine(STARS_LABEL, doc.stars)}`);
  }
  if (ref.kind === "graph") {
    const kinds = nodesByKind(document);
    if (kinds.length > 0) {
      fields.push(sheetField(SHEET_NODES, escapeHtml(nodesByKindLine(kinds))));
      lines.push(`- ${SHEET_NODES}: ${nodesByKindLine(kinds)}`);
    }
    const structure = structureOf(document);
    if (structure !== null) {
      const fail = structure.routes.filter((route) => route.via === "fail").length;
      fields.push(sheetField(SHEET_EDGES, escapeHtml(edgesLine(structure.routes.length, fail))));
      lines.push(`- ${SHEET_EDGES}: ${edgesLine(structure.routes.length, fail)}`);
    }
    const ensembles = structure?.ensembles ?? [];
    if (ensembles.length > 0) {
      const text = ensembles
        .map((ensemble) => ensembleLine(ensemble.name, ensemble.strategy, ensemble.members))
        .join(", ");
      fields.push(sheetField(SHEET_ENSEMBLES, escapeHtml(text)));
      lines.push(`- ${SHEET_ENSEMBLES}: ${mdText(text)}`);
    }
    const agents = agentNames(document);
    if (agents.length > 0) {
      fields.push(sheetField(SHEET_AGENTS, escapeHtml(agents.join(", "))));
      lines.push(`- ${SHEET_AGENTS}: ${agents.join(", ")}`);
    }
  }
  if (options.patterns.length > 0) {
    const links = options.patterns
      .map((pattern) => `<a href="/patterns/${escapeHtml(pattern.slug)}">${escapeHtml(pattern.title)}</a>`)
      .join(", ");
    fields.push(sheetField(PATTERNS_SHEET_LABEL, links));
    lines.push(
      `- ${PATTERNS_SHEET_LABEL}: ${options.patterns.map((pattern) => `[${mdText(pattern.title)}](/patterns/${pattern.slug})`).join(", ")}`,
    );
  }
  const installBox =
    `<span class="row-install"><code>${escapeHtml(install)}</code>${copyButton(install)}</span>` +
    (doc.official || options.standalone ? "" : `<p class="install-review">${escapeHtml(RUNS_REVIEW_LINE)}</p>`);
  fields.push(sheetField(INSTALL_HEADING, installBox));

  if (options.standalone) {
    return { html: `<dl class="sheet">${fields.join("")}</dl>`, lines };
  }

  // Reporting is GitHub's: the link pre-fills the issue form with this
  // page's address, kind and source. A community page also points at
  // GitHub's own report form for the repository behind the document.
  const report = reportUrl(ref.kind, ref.owner, ref.repo, ref.slug, pageUrlOf(ref));
  fields.push(sheetField(REPORT_LABEL, `${iconSvg("flag")} ${externalLink(report, REPORT_LABEL)}`));
  lines.push(`- ${REPORT_LABEL}: [${REPORT_LABEL}](${report})`);
  if (!doc.official) {
    fields.push(
      sheetField(REPORT_REPO_LABEL, externalLink(REPORT_REPOSITORY_HREF, REPORT_REPO_LABEL)),
    );
    lines.push(`- ${REPORT_REPO_LABEL}: ${REPORT_REPOSITORY_HREF}`);
  }
  return { html: `<dl class="sheet">${fields.join("")}</dl>`, lines };
}

/**
 * One document page: title, star button, the community warning above the
 * install box, the plate beside its datasheet, what the document runs,
 * then the README. Official pages carry the badge and no warning. A draft
 * page passes a banner and `standalone`, so the same renderer draws it
 * without the GitHub furniture.
 */
export function documentPage(
  doc: Doc,
  document: JsonValue,
  ref: PageRef,
  options: DocumentPageOptions = {},
): Page {
  const standalone = options.standalone === true;
  const install = options.install ?? installCommand(ref.kind, ref.ref);
  const sheet = datasheet(doc, document, ref, {
    install,
    standalone,
    patterns: options.patterns ?? [],
  });
  const badge = doc.official
    ? ` <span class="badge-official">${iconSvg("badgeCheck")}<span>${OFFICIAL_BADGE}</span></span>`
    : "";
  const warning = doc.official || standalone
    ? ""
    : `<aside class="community-warning" role="note">` +
      `${iconSvg("triangleAlert")}<p>${communityWarningHtml(`#${RUNS_SECTION_ID}`)}</p></aside>`;
  const runs = runsSectionHtml(ref.kind, document, !doc.official && !standalone);
  const readme = doc.readme.trim() === ""
    ? ""
    : `<h2 class="kicker">${iconSvg("bookOpen")}<span>${README_HEADING}</span></h2>\n` +
      `<div class="readme">${renderMarkdown(doc.readme)}</div>`;
  const banner = options.banner?.html ?? "";
  // Two actions under the description: Star (published pages only) and the
  // editor link every graph and node page carries — "Edit a copy" opens a
  // copy of the graph, "Add to a graph" starts one with this node on it.
  const star = standalone
    ? ""
    : `<a class="button" href="${ref.repoUrl}"${linkAttrs(ref.repoUrl)}>${iconSvg("star")}<span>${STAR_BUTTON}</span></a>`;
  const edit =
    `<a class="button" href="/editor${editorQuery(ref)}">${iconSvg("pencilRuler")}<span>` +
    `${ref.kind === "graph" ? EDITOR_EDIT_COPY : EDITOR_ADD_TO_GRAPH}</span></a>`;
  const actions = `<p>${[star, edit].filter((part) => part !== "").join(" ")}</p>`;

  const html = [
    banner,
    `<h1 class="doc-title">${escapeHtml(doc.name)}${badge}</h1>`,
    `<p class="description">${escapeHtml(doc.description)}</p>`,
    actions,
    warning,
    `<div class="doc-cols">`,
    plateFigure(document, ref.kind),
    sheet.html,
    `</div>`,
    runs,
    readme,
  ].filter((block) => block !== "").join("\n");

  const markdown = [
    ...(options.banner === undefined ? [] : [options.banner.markdown, ``]),
    `# ${doc.name}`,
    ``,
    doc.description,
    ``,
    ...(doc.official || standalone ? [] : [communityWarningMarkdown(`#${RUNS_SECTION_ID}`), ``]),
    ...sheet.lines,
    ``,
    `## ${INSTALL_HEADING}`,
    ``,
    `    ${install}`,
    ...(doc.official || standalone ? [] : [RUNS_REVIEW_LINE]),
    ``,
    runsSectionMarkdown(ref.kind, document),
    ``,
    readme === ""
      ? ""
      : `## ${README_HEADING}\n\n${doc.readme.endsWith("\n") ? doc.readme : `${doc.readme}\n`}`,
  ].join("\n");

  return {
    title: doc.name,
    description: doc.description,
    html,
    markdown,
    ...(standalone ? { noindex: true } : {}),
  };
}
