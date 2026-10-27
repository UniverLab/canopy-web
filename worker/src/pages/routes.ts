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
 *
 * Every route reads the catalogue through the data layer (official.ts,
 * documents.ts, search.ts) and only renders what comes back. A typed
 * data-layer error answers a calm page with status 503, a missing
 * document a calm 404, and nothing here ever shows a stack trace. Any
 * path this router does not claim answers NOT_PAGE, so index.ts keeps the
 * install redirector exactly as it was.
 */
import { type ApiDeps, type ApiEnv } from "../api.js";
import { attachDownloads, createAnalytics, type Downloads } from "../analytics.js";
import { type Log, createGitHub, isApiError } from "../github.js";
import { OFFICIAL_OWNER, OFFICIAL_REPO, OWNER_RE, REPO_RE, SLUG_RE } from "../lib.js";
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import type { Doc } from "../documents.js";
import { documentDirectory, loadDocument } from "../documents.js";
import { listOfficial, loadOfficialDocument } from "../official.js";
import { type SearchSort, searchCommunity } from "../search.js";
import { isArray, isRecord, isString, stringField } from "../json.js";
import {
  AGENT_NODES_HEADING,
  AGENT_NODES_NOTE,
  BUSY_BODY,
  BUSY_HEADING,
  DOWNLOADS_LABEL,
  DRAWING_HEADING,
  EMPTY_LIST,
  GRAPHS_HEADING,
  INSTALL_HEADING,
  LLMS_HEADER,
  NEW_TAB,
  NO_RESULTS,
  NODES_HEADING,
  NOT_FOUND_BODY,
  NOT_FOUND_HEADING,
  OFFICIAL_HEADING,
  README_HEADING,
  REPO_LABEL,
  REF_LABEL,
  SEARCH_BUTTON,
  SEARCH_LABEL,
  SEARCH_PLACEHOLDER,
  SITE_NAME,
  STARS_LABEL,
  STAR_BUTTON,
  TAGLINE,
  TOP_TAB,
  countLine,
  installCommand,
  llmsLine,
  resultsFor,
} from "./copy.js";
import { page, type Page } from "./layout.js";
import { escapeHtml, renderMarkdown } from "./md.js";
import { docPath, docRef, pageRef, type PageRef } from "./ref.js";
import { renderGraph } from "./svg.js";
import { copyButton } from "./theme.js";

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

/** The pages' GitHub transport and analytics, wired like the API's. */
function readers(env: PageEnv, deps: PageDeps) {
  const log = deps.log ?? NO_LOG;
  const github = createGitHub({
    fetchImpl: deps.fetchImpl,
    cache: deps.cache,
    token: env.GITHUB_TOKEN,
    log,
  });
  const volumes = async (): Promise<Downloads | null> =>
    createAnalytics({
      fetchImpl: deps.fetchImpl,
      cache: deps.cache,
      accountId: env.CF_ACCOUNT_ID,
      token: env.CF_ANALYTICS_TOKEN,
      log,
    }).volume();
  return { github, log, volumes };
}

/** The calm 503: the data layer failed, and the page says so, calmly. */
function busy(req: Request): Response {
  return page(req, calmPage(BUSY_HEADING, BUSY_BODY), 503);
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

function searchForm(q: string): string {
  return (
    `<form class="search" action="/search" method="get">` +
    `<div><label for="q">${SEARCH_LABEL}</label>` +
    `<input id="q" name="q" type="search" value="${escapeHtml(q)}" ` +
    `placeholder="${SEARCH_PLACEHOLDER}"></div>` +
    `<button type="submit" class="button">${SEARCH_BUTTON}</button>` +
    `</form>`
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

function docItem(doc: Doc): string {
  const stats: string[] = [];
  if (doc.stars !== null) {
    stats.push(countLine(STARS_LABEL, doc.stars));
  }
  if (doc.downloads !== undefined) {
    stats.push(countLine(DOWNLOADS_LABEL, doc.downloads));
  }
  const meta = stats.length === 0 ? "" : ` — ${escapeHtml(stats.join(" · "))}`;
  return (
    `<li><a class="doc-name" href="${docPath(doc)}">${escapeHtml(doc.name)}</a>${meta}` +
    `<span class="doc-description">${escapeHtml(doc.description)}</span></li>`
  );
}

function docList(docs: Doc[]): string {
  if (docs.length === 0) {
    return `<p>${EMPTY_LIST}</p>`;
  }
  return `<ul class="doc-list">${docs.map(docItem).join("")}</ul>`;
}

/** Backslash the markdown punctuation one line of text may carry. */
function mdText(text: string): string {
  return text.replace(/([[\]])/g, "\\$1");
}

function docListMarkdown(docs: Doc[]): string {
  if (docs.length === 0) {
    return `${EMPTY_LIST}\n`;
  }
  const lines = docs.map(
    (doc) => `- [${mdText(doc.name)}](${docPath(doc)}) — ${mdText(doc.description)} — ${docRef(doc).ref}`,
  );
  return `${lines.join("\n")}\n`;
}

/** One document page: name, meta, star button, install, drawing, README. */
function documentPage(doc: Doc, document: JsonValue, ref: PageRef): Page {
  const install = installCommand(ref.kind, ref.ref);
  const stats: string[] = [];
  if (doc.stars !== null) {
    stats.push(countLine(STARS_LABEL, doc.stars));
  }
  if (doc.downloads !== undefined) {
    stats.push(countLine(DOWNLOADS_LABEL, doc.downloads));
  }
  const meta = stats.length === 0 ? "" : ` — ${escapeHtml(stats.join(" · "))}`;
  const agents = ref.kind === "graph" ? agentNames(document) : [];

  const html = [
    `<h1>${escapeHtml(doc.name)}</h1>`,
    `<p class="description">${escapeHtml(doc.description)}</p>`,
    `<p class="meta"><a href="${ref.repoUrl}">${escapeHtml(doc.repo)}</a>${meta}</p>`,
    `<p><a class="button" href="${ref.repoUrl}">${STAR_BUTTON}</a></p>`,
    `<h2>${INSTALL_HEADING}</h2>`,
    `<div class="install"><code>${escapeHtml(install)}</code>${copyButton(install)}</div>`,
    ref.kind === "graph" ? `<h2>${DRAWING_HEADING}</h2>${renderGraph(document, ref.ref)}` : "",
    agents.length === 0
      ? ""
      : `<h2>${AGENT_NODES_HEADING}</h2><p class="agent-nodes">${escapeHtml(agents.join(", "))}</p>` +
        `<p>${AGENT_NODES_NOTE}</p>`,
    `<h2>${README_HEADING}</h2>`,
    `<div class="readme">${renderMarkdown(doc.readme)}</div>`,
  ].join("\n");

  const markdown = [
    `# ${doc.name}`,
    ``,
    doc.description,
    ``,
    `- ${REPO_LABEL}: ${ref.repoUrl}`,
    `- ${REF_LABEL}: ${ref.ref}`,
    ...stats.map((stat) => `- ${stat}`),
    ``,
    `## ${INSTALL_HEADING}`,
    ``,
    `    ${install}`,
    ``,
    agents.length === 0
      ? ""
      : `## ${AGENT_NODES_HEADING}\n\n${agents.join(", ")}\n\n${AGENT_NODES_NOTE}\n`,
    `## ${README_HEADING}`,
    ``,
    doc.readme.endsWith("\n") || doc.readme === "" ? doc.readme : `${doc.readme}\n`,
  ].join("\n");

  return { title: doc.name, description: doc.description, html, markdown };
}

function homePage(graphs: Doc[], nodes: Doc[]): Page {
  const html = [
    searchForm(""),
    tabs("", null),
    `<h2>${OFFICIAL_HEADING}</h2>`,
    `<h3>${GRAPHS_HEADING}</h3>`,
    docList(graphs),
    `<h3>${NODES_HEADING}</h3>`,
    docList(nodes),
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
    docListMarkdown(graphs),
    `### ${NODES_HEADING}`,
    ``,
    docListMarkdown(nodes),
  ].join("\n");
  return { title: SITE_NAME, description: TAGLINE, html, markdown };
}

function searchPage(q: string, sort: SearchSort, items: Doc[]): Page {
  const heading = resultsFor(q);
  const html = [
    searchForm(q),
    tabs(q, sort),
    `<h2>${escapeHtml(heading)}</h2>`,
    items.length === 0 ? `<p>${NO_RESULTS}</p>` : docList(items),
  ].join("\n");
  const markdown = [
    `# ${heading}`,
    ``,
    `## ${TOP_TAB} / ${NEW_TAB}`,
    ``,
    items.length === 0 ? `${NO_RESULTS}\n` : docListMarkdown(items),
  ].join("\n");
  return { title: heading, description: TAGLINE, html, markdown };
}

/** The document route: load through the data layer, then render. */
async function documentResponse(req: Request, env: PageEnv, deps: PageDeps, ref: PageRef): Promise<Response> {
  const { github, log, volumes } = readers(env, deps);
  const loaded = ref.official
    ? await loadOfficialDocument(github, ref.kind, ref.slug, log)
    : await loadDocument(
        github,
        {
          owner: ref.owner,
          repo: ref.repo,
          directory: documentDirectory(ref.owner, ref.repo, ref.kind, ref.slug),
          kind: ref.kind,
          slug: ref.slug,
          stars: null,
        },
        log,
      );
  // The load result is a tagged union, not an ApiError: "doc" wins first.
  if (loaded.kind === "absent") {
    return notFound(req);
  }
  if (loaded.kind !== "doc") {
    return busy(req);
  }
  const [doc] = attachDownloads([loaded.entry.doc], await volumes());
  return page(req, documentPage(doc, loaded.entry.document, ref));
}

async function homeResponse(req: Request, env: PageEnv, deps: PageDeps): Promise<Response> {
  const { github, log, volumes } = readers(env, deps);
  const listing = await listOfficial(github, log);
  if (isApiError(listing)) {
    return busy(req);
  }
  const counts = await volumes();
  return page(req, homePage(attachDownloads(listing.graphs, counts), attachDownloads(listing.nodes, counts)));
}

async function searchResponse(req: Request, url: URL, env: PageEnv, deps: PageDeps): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").slice(0, 256);
  const sort: SearchSort = url.searchParams.get("sort") === "new" ? "new" : "top";
  const { github, log, volumes } = readers(env, deps);
  const outcome = await searchCommunity(github, { q, sort, page: 1 }, log);
  if (isApiError(outcome)) {
    return busy(req);
  }
  return page(req, searchPage(q, sort, attachDownloads(outcome.items, await volumes())));
}

/** llms.txt: plain text, one tab-separated line per official document. */
async function llmsResponse(env: PageEnv, deps: PageDeps): Promise<Response> {
  const { github, log, volumes } = readers(env, deps);
  const listing = await listOfficial(github, log);
  if (isApiError(listing)) {
    return textResponse(`${BUSY_BODY}\n`, 503);
  }
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
    return llmsResponse(env, deps);
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
