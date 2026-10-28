// SPDX-License-Identifier: Apache-2.0
/**
 * The HTML pages of graphs.univerlab.org, and their markdown twins.
 *
 *   GET /                                     search box, Official first, Top and New tabs
 *   GET /search?q=&sort=top|new               community results
 *   GET /g/<slug>                             official graph page
 *   GET /g/<owner>/<repo>/<slug>              community graph page
 *   GET /n/<slug>, /n/<owner>/<repo>/<slug>   node pages likewise
 *   GET /d/<id>                               one unreviewed draft, until it expires or installs
 *   GET /llms.txt                             one line per document: name, description, ref
 *   GET /publish, /publish.md                 how to list a graph or node (page, markdown twin)
 *   GET /editor                               the hand-assembly canvas (server-rendered shell)
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
import { harnessColor } from "../../../../packages/plate/vocabulary.js";
import type { DocumentKind } from "../../../../src/schema.js";
import type { Doc } from "../documents.js";
import { docFromDocument } from "../documents.js";
import { readDraft } from "../drafts.js";
import { createStore, type BlockedEntry } from "../store.js";
import { documentFromStored, entryFor, officialFromIndex, searchFromIndex } from "../catalog.js";
import { type SearchSort } from "../search.js";
import {
  BLOCKED_HEADING,
  BLOCKED_ISSUE_LABEL,
  DRAFT_BANNER_LEAD,
  DRAFT_BANNER_TAIL,
  DRAFT_MISSING_BODY,
  DRAFT_MISSING_HEADING,
  EMPTY_OFFICIAL_GRAPHS,
  EMPTY_OFFICIAL_NODES,
  GRAPHS_HEADING,
  INDEXING_BODY,
  INDEXING_HEADING,
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
  SITE_NAME,
  STARS_LABEL,
  TAGLINE,
  TOP_TAB,
  countLine,
  draftBannerMarkdown,
  draftTime,
  homePublishLine,
  installCommand,
  llmsLine,
  resultsFor,
} from "./copy.js";
import { page, type Page, withMarkdownFooter } from "./layout.js";
import { renderBanner } from "../../../../packages/look/banner/banner.js";
import { iconSvg, type IconName } from "../../../../packages/look/icon-svg.js";
import { escapeHtml } from "./md.js";
import { publishPage } from "./publish.js";
import { editorPage } from "./editor.js";
import { docPath, docRef, pageRef, type PageRef } from "./ref.js";
import { copyButton } from "./look.js";
import { documentPage, mdText } from "./document.js";

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
  const response = page(req, calmPage(INDEXING_HEADING, INDEXING_BODY, "timer"), 503);
  const headers = new Headers(response.headers);
  headers.set("retry-after", "120");
  return new Response(response.body, { status: response.status, headers });
}

/** The calm 404: no document at this address. */
function notFound(req: Request): Response {
  return page(req, calmPage(NOT_FOUND_HEADING, NOT_FOUND_BODY), 404);
}

/**
 * The 410: the document was removed after a community report. It names the
 * reason and links the issue, so a reader can follow the decision — and an
 * author can appeal on it.
 */
function blockedPage(blocked: BlockedEntry): Page {
  return {
    title: BLOCKED_HEADING,
    description: BLOCKED_HEADING,
    html:
      `<section class="busy"><h1>${escapeHtml(BLOCKED_HEADING)}</h1>` +
      `<p>${escapeHtml(blocked.reason)}</p>` +
      `<p><a href="${escapeHtml(blocked.issue)}" rel="noopener noreferrer">${escapeHtml(BLOCKED_ISSUE_LABEL)}</a></p>` +
      `</section>`,
    markdown: `# ${BLOCKED_HEADING}\n\n${blocked.reason}\n\n${BLOCKED_ISSUE_LABEL}: ${blocked.issue}\n`,
  };
}

function calmPage(heading: string, body: string, icon: IconName | null = null): Page {
  const mark = icon === null ? "" : iconSvg(icon);
  return {
    title: heading,
    description: body,
    html: `<section class="busy-error"><h1>${mark}${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></section>`,
    markdown: `# ${heading}\n\n${body}\n`,
  };
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
    `<li class="row">` +
    `<a class="row-name" href="${docPath(doc)}">${escapeHtml(doc.name)}</a>` +
    standing +
    kind +
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

function docListMarkdown(docs: Doc[], emptyLine: string): string {
  if (docs.length === 0) {
    return `${emptyLine}\n`;
  }
  const lines = docs.map(
    (doc) => `- [${mdText(doc.name)}](${docPath(doc)}) — ${mdText(doc.description)} — ${docRef(doc).ref}`,
  );
  return `${lines.join("\n")}\n`;
}

/** The draft's banner: unreviewed, expiring at a `<time>`, gone after one install. */
function draftBanner(expiresAt: string): { html: string; markdown: string } {
  const when = draftTime(expiresAt);
  return {
    html:
      `<aside class="community-warning" role="note">` +
      `${iconSvg("triangleAlert")}<p>${escapeHtml(DRAFT_BANNER_LEAD)} ` +
      `<time datetime="${escapeHtml(expiresAt)}">${escapeHtml(when)}</time> ` +
      `${escapeHtml(DRAFT_BANNER_TAIL)}</p></aside>`,
    markdown: draftBannerMarkdown(when),
  };
}

/**
 * The draft page: the same document page as `/g` and `/n`, over a document
 * that lives in KV for 30 minutes. Viewing it never consumes it — only
 * `/i/draft/<id>` does — and it carries `noindex`, so no crawler keeps a copy
 * of something that will not exist next time it looks.
 */
async function draftResponse(req: Request, env: PageEnv, id: string): Promise<Response> {
  const kv = env.DRAFTS;
  const record = kv === undefined ? null : await readDraft(kv, id);
  if (record === null) {
    const missing = { ...calmPage(DRAFT_MISSING_HEADING, DRAFT_MISSING_BODY, "timer"), noindex: true };
    return page(req, missing, 404);
  }
  // A draft has no repository, no star count and no ref: `standalone` drops
  // those fields, and the install command names the draft instead of a slug.
  const ref: PageRef = {
    kind: record.kind,
    official: false,
    owner: "",
    repo: "",
    slug: id,
    ref: `draft:${id}`,
    repoUrl: "",
  };
  const doc = docFromDocument(
    { kind: record.kind, slug: id, owner: "", repo: "", stars: null, official: false },
    record.document,
    "",
  );
  const install = installCommand(record.kind, `draft:${id}`);
  return page(
    req,
    documentPage(doc, record.document, ref, {
      banner: draftBanner(record.expires_at),
      standalone: true,
      install,
    }),
    200,
    "no-store",
  );
}

function homePage(graphs: Doc[], nodes: Doc[]): Page {
  const html = [
    renderBanner("graphs"),
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
  // Before the index: a block outlives whatever the last run left behind.
  const blocked = await store.getBlocked(ref.kind, ref.owner, ref.repo, ref.slug);
  if (blocked !== null) {
    return page(req, blockedPage(blocked), 410);
  }
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
  if (segments.length === 1 && segments[0] === "editor") {
    return page(req, editorPage());
  }
  if (segments.length === 1 && segments[0] === "publish.md") {
    return new Response(withMarkdownFooter(publishPage().markdown), {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }
  if (segments.length === 2 && segments[0] === "d") {
    return draftResponse(req, env, segments[1] ?? "");
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
