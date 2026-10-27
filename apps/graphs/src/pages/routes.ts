// SPDX-License-Identifier: Apache-2.0
/**
 * The HTML pages of graphs.univerlab.org, and their markdown twins.
 *
 *   GET /                                     search box, Official first, Top and New tabs
 *   GET /search?q=&sort=top|new               community results
 *   GET /g/<slug>                             official graph page
 *   GET /g/<owner>/<repo>/<slug>              community graph page
 *   GET /n/<slug>, /n/<owner>/<repo>/<slug>   node pages likewise
 *   GET /llms.txt                             one line per document: name, description, ref
 *   GET /publish, /publish.md                 how to list a graph or node (page, markdown twin)
 *
 * Every route reads the catalogue through the scheduled index (store.ts,
 * catalog.ts) and only renders what comes back: no page reaches GitHub,
 * so traffic never spends quota. Before the first scheduled run builds
 * the index, data routes answer the indexing page with status 503, a
 * missing document a calm 404, and nothing here ever shows a stack
 * trace. Any path this router does not claim answers NOT_PAGE, so
 * index.ts keeps the install redirector exactly as it was.
 */
import { type ApiDeps, type ApiEnv } from "../api.js";
import { attachDownloads, createAnalytics, type Downloads } from "../analytics.js";
import { type Log } from "../github.js";
import { OFFICIAL_OWNER, OFFICIAL_REPO, OWNER_RE, REPO_RE, SLUG_RE } from "../lib.js";
import { structureOf, type GraphDocument, type NodeDocument } from "../plate/document.js";
import { renderNodePlate, renderPlate } from "../plate/render.js";
import { harnessColor } from "../plate/vocabulary.js";
import type { DocumentKind, JsonValue } from "../../../../src/schema.js";
import type { Doc } from "../documents.js";
import { createStore } from "../store.js";
import { documentFromStored, entryFor, officialFromIndex, searchFromIndex } from "../catalog.js";
import { type SearchSort } from "../search.js";
import { isArray, isRecord, isString, stringField } from "../json.js";
import {
  EMPTY_OFFICIAL_GRAPHS,
  EMPTY_OFFICIAL_NODES,
  GRAPHS_HEADING,
  INDEXING_BODY,
  INDEXING_HEADING,
  INSTALL_HEADING,
  LLMS_HEADER,
  NEW_TAB,
  NODES_HEADING,
  NODES_LABEL,
  NO_RESULTS,
  NOT_FOUND_BODY,
  NOT_FOUND_HEADING,
  OFFICIAL_BADGE,
  OFFICIAL_HEADING,
  PUBLISH_HREF,
  PUBLISH_LABEL,
  PUBLISH_TITLE,
  README_HEADING,
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
  TAGLINE,
  TOP_TAB,
  attentionChip,
  builtinPresetLine,
  communityWarningHtml,
  communityWarningMarkdown,
  countLine,
  edgesLine,
  ensembleLine,
  homePublishLine,
  installCommand,
  llmsLine,
  nodesByKindLine,
  resultsFor,
  runsSummary,
} from "./copy.js";
import { page, type Page } from "./layout.js";
import { escapeHtml, renderMarkdown } from "./md.js";
import { publishPage } from "./publish.js";
import { docPath, docRef, pageRef, type PageRef } from "./ref.js";
import { copyButton } from "./look.js";
import { attentionFor, runsOf, type RunCommand, type RunPrompt } from "./runs.js";

/** A non-page request: index.ts keeps routing it to the redirector. */
export const NOT_PAGE = true as const;

/** The environment the pages read: the API's three optional values. */
export type PageEnv = ApiEnv;

/** Dependency injection for tests; identical to the API's. */
export type PageDeps = ApiDeps;

const NO_LOG: Log = () => undefined;

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function splitPath(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") {
    return [];
  }
  return trimmed.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

/** The pages' index reads and analytics, wired like the API's. */
function readers(env: PageEnv, deps: PageDeps) {
  const log = deps.log ?? NO_LOG;
  const store = createStore(env.INDEX);
  const volumes = async (): Promise<Downloads | null> =>
    createAnalytics({
      fetchImpl: deps.fetchImpl,
      cache: deps.cache,
      accountId: env.CF_ACCOUNT_ID,
      token: env.CF_ANALYTICS_TOKEN,
      log,
    }).volume();
  return { store, log, volumes };
}

/** The cold-start 503: no index yet, back once the first run lands. */
function indexing(req: Request): Response {
  const response = page(req, calmPage(INDEXING_HEADING, INDEXING_BODY), 503);
  const headers = new Headers(response.headers);
  headers.set("retry-after", "120");
  return new Response(response.body, { status: response.status, headers });
}

/** The calm 404: no document at this address. */
function notFound(req: Request): Response {
  return page(req, calmPage(NOT_FOUND_HEADING, NOT_FOUND_BODY), 404);
}

function calmPage(heading: string, body: string): Page {
  return {
    title: heading,
    description: body,
    html: `<section class="busy"><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></section>`,
    markdown: `# ${heading}\n\n${body}\n`,
  };
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

function searchHref(q: string, sort: SearchSort): string {
  const base = q === "" ? "?" : `?q=${encodeURIComponent(q)}&`;
  return `/search${base}sort=${sort}`;
}

function tabs(q: string, active: SearchSort | null): string {
  const tab = (sort: SearchSort, label: string): string =>
    `<a href="${searchHref(q, sort)}"${active === sort ? ` aria-current="page"` : ""}>${label}</a>`;
  return `<nav class="tabs">${tab("top", TOP_TAB)}${tab("new", NEW_TAB)}</nav>`;
}

/** The harness dots of an index row: one accent dot per known harness. */
function harnessDots(harnesses: string[]): string {
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
 * One index row: the name in the display face, the kind badge, the node
 * count for graphs, harness dots, stars, last updated and the install box.
 * One flex line on desktop, three stacked lines under 900 px; the
 * description rides along as the row's second block. Official rows carry
 * the badge next to the name; community rows show their source instead.
 */
function docItem(doc: Doc): string {
  const install = installCommand(doc.kind, docRef(doc).ref);
  const standing = doc.official
    ? `<span class="badge-official">${OFFICIAL_BADGE}</span>`
    : `<span class="row-source">${escapeHtml(doc.repo)}</span>`;
  const nodes = doc.kind === "graph" ? `<span class="row-meta">${countLine(NODES_LABEL, doc.nodeCount)}</span>` : "";
  const stars = doc.stars === null ? "" : `<span class="row-meta">${escapeHtml(countLine(STARS_LABEL, doc.stars))}</span>`;
  const updated = doc.updated === null
    ? ""
    : `<time class="row-meta" datetime="${escapeHtml(doc.updated)}">${escapeHtml(doc.updated)}</time>`;
  const description = doc.description === ""
    ? ""
    : `<span class="row-desc">${escapeHtml(doc.description)}</span>`;
  return (
    `<li class="row">` +
    `<a class="row-name" href="${docPath(doc)}">${escapeHtml(doc.name)}</a>` +
    standing +
    `<span class="kind">${escapeHtml(doc.kind)}</span>` +
    nodes +
    harnessDots(doc.harnesses) +
    stars +
    updated +
    `<span class="row-install"><code>${escapeHtml(install)}</code>${copyButton(install)}</span>` +
    description +
    `</li>`
  );
}

function docList(docs: Doc[], emptyLine: string): string {
  if (docs.length === 0) {
    return `<p>${emptyLine}</p>`;
  }
  return `<ol class="index">${docs.map(docItem).join("")}</ol>`;
}

/** One line of twin text: flattened, with markdown punctuation backslashed. */
function mdText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ").replace(/([[\]])/g, "\\$1");
}

function docListMarkdown(docs: Doc[], emptyLine: string): string {
  if (docs.length === 0) {
    return `${emptyLine}\n`;
  }
  const lines = docs.map(
    (doc) => `- [${mdText(doc.name)}](${docPath(doc)}) — ${mdText(doc.description)} — ${docRef(doc).ref}`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The plate figure for a document page: the graph plate, or the one node —
 * rendered in both orientations, with CSS showing the vertical one under
 * 640 px and the horizontal one above. No JavaScript is involved.
 */
function plateFigure(document: JsonValue, kind: PageRef["kind"]): string {
  // The data layer only serves validated documents, so the cast is honest;
  // the renderers stay total and draw nothing when it is not.
  const horizontal = kind === "graph"
    ? renderPlate(document as unknown as GraphDocument, "horizontal")
    : renderNodePlate(document as unknown as NodeDocument, "horizontal");
  const vertical = kind === "graph"
    ? renderPlate(document as unknown as GraphDocument, "vertical")
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
 */
function runsSectionHtml(kind: DocumentKind, document: JsonValue): string {
  const runs = runsOf(kind, document);
  return [
    `<section class="runs" id="${RUNS_SECTION_ID}">`,
    `<h2 class="kicker">${RUNS_HEADING}</h2>`,
    `<p class="runs-summary">${escapeHtml(runsSummary(runs.commands.length, runs.prompts.length))}</p>`,
    ...runs.commands.map(commandBlock),
    ...runs.prompts.map(promptBlock),
    `</section>`,
  ].join("\n");
}

/**
 * One fenced block for the twin: the fence outgrows any backtick run the
 * text carries, so a command containing ``` stays one block.
 */
function fencedBlock(info: string, text: string): string[] {
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

/**
 * The datasheet beside the plate: kind, name, source, ref and stars, then —
 * for graphs — nodes by kind, edges with the fail count, ensembles and the
 * agent nodes a harness must run, then install. A field with no data is
 * omitted, never printed as a placeholder.
 */
function datasheet(doc: Doc, document: JsonValue, ref: PageRef): { html: string; lines: string[] } {
  const install = installCommand(ref.kind, ref.ref);
  const fields: string[] = [
    sheetField(SHEET_KIND, escapeHtml(ref.kind)),
    sheetField(SHEET_NAME, escapeHtml(doc.name)),
    sheetField(SHEET_SOURCE, `<a href="${ref.repoUrl}">${escapeHtml(doc.repo)}</a>`),
  ];
  const lines = [
    `- ${SHEET_KIND}: ${ref.kind}`,
    `- ${SHEET_NAME}: ${mdText(doc.name)}`,
    `- ${SHEET_SOURCE}: ${ref.repoUrl}`,
  ];
  if (doc.sourceRef !== null) {
    fields.push(sheetField(SHEET_REF, escapeHtml(doc.sourceRef)));
    lines.push(`- ${SHEET_REF}: ${doc.sourceRef}`);
  }
  if (doc.stars !== null) {
    fields.push(sheetField(SHEET_STARS, escapeHtml(countLine(STARS_LABEL, doc.stars))));
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
  const installBox =
    `<span class="row-install"><code>${escapeHtml(install)}</code>${copyButton(install)}</span>` +
    (doc.official ? "" : `<p class="install-review">${escapeHtml(RUNS_REVIEW_LINE)}</p>`);
  fields.push(sheetField(INSTALL_HEADING, installBox));
  return { html: `<dl class="sheet">${fields.join("")}</dl>`, lines };
}

/**
 * One document page: title, star button, the community warning above the
 * install box, the plate beside its datasheet, what the document runs,
 * then the README. Official pages carry the badge and no warning.
 */
function documentPage(doc: Doc, document: JsonValue, ref: PageRef): Page {
  const install = installCommand(ref.kind, ref.ref);
  const sheet = datasheet(doc, document, ref);
  const badge = doc.official ? ` <span class="badge-official">${OFFICIAL_BADGE}</span>` : "";
  const warning = doc.official
    ? ""
    : `<aside class="community-warning" role="note"><p>${communityWarningHtml(`#${RUNS_SECTION_ID}`)}</p></aside>`;
  const runs = runsSectionHtml(ref.kind, document);
  const readme = doc.readme.trim() === ""
    ? ""
    : `<h2 class="kicker">${README_HEADING}</h2>\n<div class="readme">${renderMarkdown(doc.readme)}</div>`;

  const html = [
    `<h1 class="doc-title">${escapeHtml(doc.name)}${badge}</h1>`,
    `<p class="description">${escapeHtml(doc.description)}</p>`,
    `<p><a class="button" href="${ref.repoUrl}">${STAR_BUTTON}</a></p>`,
    warning,
    `<div class="doc-cols">`,
    plateFigure(document, ref.kind),
    sheet.html,
    `</div>`,
    runs,
    readme,
  ].filter((block) => block !== "").join("\n");

  const markdown = [
    `# ${doc.name}`,
    ``,
    doc.description,
    ``,
    ...(doc.official ? [] : [communityWarningMarkdown(`#${RUNS_SECTION_ID}`), ``]),
    ...sheet.lines,
    ``,
    `## ${INSTALL_HEADING}`,
    ``,
    `    ${install}`,
    ...(doc.official ? [] : [RUNS_REVIEW_LINE]),
    ``,
    runsSectionMarkdown(ref.kind, document),
    ``,
    readme === ""
      ? ""
      : `## ${README_HEADING}\n\n${doc.readme.endsWith("\n") ? doc.readme : `${doc.readme}\n`}`,
  ].join("\n");

  return { title: doc.name, description: doc.description, html, markdown };
}

function homePage(graphs: Doc[], nodes: Doc[]): Page {
  const html = [
    `<h1 class="index-title">${escapeHtml(TAGLINE)}</h1>`,
    tabs("", null),
    `<h2 class="kicker">${OFFICIAL_HEADING}</h2>`,
    `<h3 class="kicker">${GRAPHS_HEADING}</h3>`,
    docList(graphs, EMPTY_OFFICIAL_GRAPHS),
    `<h3 class="kicker">${NODES_HEADING}</h3>`,
    docList(nodes, EMPTY_OFFICIAL_NODES),
  ].join("\n");
  const markdown = [
    `# ${SITE_NAME}`,
    ``,
    TAGLINE,
    ``,
    `## ${OFFICIAL_HEADING}`,
    ``,
    `### ${GRAPHS_HEADING}`,
    ``,
    docListMarkdown(graphs, EMPTY_OFFICIAL_GRAPHS),
    `### ${NODES_HEADING}`,
    ``,
    docListMarkdown(nodes, EMPTY_OFFICIAL_NODES),
    `## ${PUBLISH_TITLE}`,
    ``,
    `${homePublishLine(PUBLISH_LABEL, PUBLISH_HREF)}\n`,
  ].join("\n");
  return { title: SITE_NAME, description: TAGLINE, html, markdown };
}

function searchPage(q: string, sort: SearchSort, items: Doc[]): Page {
  const heading = resultsFor(q);
  const html = [
    `<h1 class="index-title">${escapeHtml(heading)}</h1>`,
    tabs(q, sort),
    items.length === 0 ? `<p>${NO_RESULTS}</p>` : docList(items, NO_RESULTS),
  ].join("\n");
  const markdown = [
    `# ${heading}`,
    ``,
    `## ${TOP_TAB} / ${NEW_TAB}`,
    ``,
    items.length === 0 ? `${NO_RESULTS}\n` : docListMarkdown(items, NO_RESULTS),
  ].join("\n");
  return { title: heading, description: TAGLINE, html, markdown };
}

/** The document route: join the index entry to its stored document, then render. */
async function documentResponse(req: Request, env: PageEnv, deps: PageDeps, ref: PageRef): Promise<Response> {
  const { store, volumes } = readers(env, deps);
  const index = await store.getIndex();
  if (index === null) {
    return indexing(req);
  }
  const entry = entryFor(index, ref.kind, ref.owner, ref.repo, ref.slug);
  if (entry === null) {
    return notFound(req);
  }
  const stored = await store.getDoc(ref.kind, ref.owner, ref.repo, ref.slug);
  if (stored === null) {
    return notFound(req);
  }
  const loaded = documentFromStored(entry, stored);
  const [doc] = attachDownloads([loaded.doc], await volumes());
  return page(req, documentPage(doc, loaded.document, ref));
}

async function homeResponse(req: Request, env: PageEnv, deps: PageDeps): Promise<Response> {
  const { store, volumes } = readers(env, deps);
  const index = await store.getIndex();
  if (index === null) {
    return indexing(req);
  }
  const listing = officialFromIndex(index);
  const counts = await volumes();
  return page(req, homePage(attachDownloads(listing.graphs, counts), attachDownloads(listing.nodes, counts)));
}

async function searchResponse(req: Request, url: URL, env: PageEnv, deps: PageDeps): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").slice(0, 256);
  const sort: SearchSort = url.searchParams.get("sort") === "new" ? "new" : "top";
  const { store, volumes } = readers(env, deps);
  const index = await store.getIndex();
  if (index === null) {
    return indexing(req);
  }
  const outcome = searchFromIndex(index, { q, sort, page: 1 });
  return page(req, searchPage(q, sort, attachDownloads(outcome.items, await volumes())));
}

/** llms.txt: plain text, one tab-separated line per official document. */
async function llmsResponse(req: Request, env: PageEnv, deps: PageDeps): Promise<Response> {
  const { store, volumes } = readers(env, deps);
  const index = await store.getIndex();
  if (index === null) {
    return new Response(`${INDEXING_BODY}\n`, {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "120",
      },
    });
  }
  const listing = officialFromIndex(index);
  const docs = attachDownloads([...listing.graphs, ...listing.nodes], await volumes());
  const lines = [LLMS_HEADER, ""];
  for (const doc of docs) {
    lines.push(llmsLine(doc, docRef(doc).ref));
  }
  return textResponse(`${lines.join("\n")}\n`, 200);
}

/**
 * The page router. A Response for every page route, NOT_PAGE for anything
 * else (the install paths, unknown shapes) so index.ts decides.
 */
export async function handlePage(
  req: Request,
  env: PageEnv,
  deps: PageDeps = {},
): Promise<Response | typeof NOT_PAGE> {
  if (req.method !== "GET") {
    return NOT_PAGE;
  }
  const url = new URL(req.url);
  const segments = splitPath(url.pathname);
  if (segments.length === 0) {
    return homeResponse(req, env, deps);
  }
  if (segments.length === 1 && segments[0] === "search") {
    return searchResponse(req, url, env, deps);
  }
  if (segments.length === 1 && segments[0] === "llms.txt") {
    return llmsResponse(req, env, deps);
  }
  if (segments.length === 1 && segments[0] === "publish") {
    return page(req, publishPage());
  }
  if (segments.length === 1 && segments[0] === "publish.md") {
    return new Response(publishPage().markdown, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }
  const verb = segments[0];
  if ((verb === "g" || verb === "n") && (segments.length === 2 || segments.length === 4)) {
    const kind: DocumentKind = verb === "g" ? "graph" : "node";
    const parts = segments.slice(1);
    const slug = parts[parts.length - 1] ?? "";
    if (parts.length === 1) {
      return SLUG_RE.test(slug)
        ? documentResponse(req, env, deps, pageRef(kind, OFFICIAL_OWNER, OFFICIAL_REPO, slug))
        : notFound(req);
    }
    const owner = parts[0] ?? "";
    const repo = parts[1] ?? "";
    return OWNER_RE.test(owner) && REPO_RE.test(repo) && SLUG_RE.test(slug)
      ? documentResponse(req, env, deps, pageRef(kind, owner, repo, slug))
      : notFound(req);
  }
  return NOT_PAGE;
}
