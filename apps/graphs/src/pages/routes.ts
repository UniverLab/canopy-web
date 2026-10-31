// SPDX-License-Identifier: Apache-2.0
/**
 * The HTML pages of graphs.univerlab.org, and their markdown twins.
 *
 *   GET /                                     search box, Official and Community lists, Top and New tabs
 *   GET /search?q=&sort=top|new               community results
 *   GET /g/<slug>                             official graph page
 *   GET /g/<owner>/<repo>/<slug>              community graph page
 *   GET /n/<slug>, /n/<owner>/<repo>/<slug>   node pages likewise
 *   GET /d/<id>                               one unreviewed draft, until it expires or installs
 *   GET /patterns                             the lab's pattern pages, as cards
 *   GET /patterns/<slug>                      one pattern: its figure, then its words
 *   GET /llms.txt                             one line per document: name, description, ref
 *   GET /publish, /publish.md                 how to list a graph or node (page, markdown twin)
 *   GET /editor                               the hand-assembly canvas (server-rendered shell)
 *   GET /transparency                         how the index and the review work, every verdict
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
import type { DocumentKind } from "../../../../src/schema.js";
import type { Doc } from "../documents.js";
import { docFromDocument } from "../documents.js";
import { readDraft } from "../drafts.js";
import { createStore, type BlockedEntry } from "../store.js";
import { communityFromIndex, documentFromStored, entryFor, officialFromIndex, rowFromEntry, searchFromIndex } from "../catalog.js";
import { type SearchSort } from "../search.js";
import { comparePatterns, implementingPatterns } from "../patterns.js";
import {
  BLOCKED_HEADING,
  BLOCKED_ISSUE_LABEL,
  COMMUNITY_GRAPHS_HEADING,
  COMMUNITY_NODES_HEADING,
  DRAFT_BANNER_LEAD,
  DRAFT_BANNER_TAIL,
  DRAFT_MISSING_BODY,
  DRAFT_MISSING_HEADING,
  EMPTY_OFFICIAL_GRAPHS,
  EMPTY_OFFICIAL_NODES,
  INDEXING_BODY,
  INDEXING_HEADING,
  LLMS_HEADER,
  LLMS_PATTERNS_HEADING,
  NEW_TAB,
  NO_RESULTS,
  NOT_FOUND_BODY,
  NOT_FOUND_HEADING,
  OFFICIAL_GRAPHS_HEADING,
  OFFICIAL_NODES_HEADING,
  PATTERNS_HOME_LEAD,
  PATTERNS_HREF,
  PATTERNS_LABEL,
  PUBLISH_HREF,
  PUBLISH_LABEL,
  PUBLISH_TITLE,
  SITE_NAME,
  TAGLINE,
  TOP_TAB,
  draftBannerMarkdown,
  draftTime,
  homePatternsLine,
  homePublishLine,
  installCommand,
  llmsLine,
  llmsPatternLine,
  resultsFor,
} from "./copy.js";
import { linkAttrs, page, type Page, withMarkdownFooter } from "./layout.js";
import { iconSvg, type IconName } from "../../../../packages/look/icon-svg.js";
import { escapeHtml } from "./md.js";
import { publishPage } from "./publish.js";
import { editorPage } from "./editor.js";
import { docRef, pageRef, type PageRef } from "./ref.js";
import { documentPage } from "./document.js";
import { docList, docListMarkdown } from "./rows.js";
import { patternPage, patternsIndexPage, type ImplementsRow } from "./patterns.js";
import { transparencyPage } from "./transparency.js";
import {
  INDEXING_MMD,
  INDEXING_SVG,
  REVIEW_PROMPT_V1,
  REVIEW_PROMPT_VERSION,
} from "../review-assets.generated.js";

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
      `<p><a href="${escapeHtml(blocked.issue)}"${linkAttrs(blocked.issue)}>${escapeHtml(BLOCKED_ISSUE_LABEL)}</a></p>` +
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

function homePage(graphs: Doc[], nodes: Doc[], communityGraphs: Doc[], communityNodes: Doc[]): Page {
  const communityHtml =
    communityGraphs.length === 0 && communityNodes.length === 0
      ? []
      : [
        ...(communityGraphs.length === 0
          ? []
          : [
            `<h2 class="kicker">${COMMUNITY_GRAPHS_HEADING}</h2>`,
            docList(communityGraphs, ""),
          ]),
        ...(communityNodes.length === 0
          ? []
          : [
            `<h2 class="kicker">${COMMUNITY_NODES_HEADING}</h2>`,
            docList(communityNodes, ""),
          ]),
      ];
  const html = [
    `<h1 class="index-title">${escapeHtml(TAGLINE)}</h1>`,
    tabs("", null),
    `<h2 class="kicker">${OFFICIAL_GRAPHS_HEADING}</h2>`,
    docList(graphs, EMPTY_OFFICIAL_GRAPHS),
    `<h2 class="kicker">${OFFICIAL_NODES_HEADING}</h2>`,
    docList(nodes, EMPTY_OFFICIAL_NODES),
    ...communityHtml,
    `<h2 class="kicker">${PATTERNS_LABEL}</h2>`,
    `<p>${escapeHtml(PATTERNS_HOME_LEAD)} <a href="${PATTERNS_HREF}">${escapeHtml(PATTERNS_LABEL)}</a></p>`,
  ].join("\n");
  const communityMarkdown =
    communityGraphs.length === 0 && communityNodes.length === 0
      ? []
      : [
        ...(communityGraphs.length === 0
          ? []
          : [
            `## ${COMMUNITY_GRAPHS_HEADING}`,
            ``,
            docListMarkdown(communityGraphs, ""),
          ]),
        ...(communityNodes.length === 0
          ? []
          : [
            `## ${COMMUNITY_NODES_HEADING}`,
            ``,
            docListMarkdown(communityNodes, ""),
          ]),
      ];
  const markdown = [
    `# ${SITE_NAME}`,
    ``,
    TAGLINE,
    ``,
    `## ${OFFICIAL_GRAPHS_HEADING}`,
    ``,
    docListMarkdown(graphs, EMPTY_OFFICIAL_GRAPHS),
    `## ${OFFICIAL_NODES_HEADING}`,
    ``,
    docListMarkdown(nodes, EMPTY_OFFICIAL_NODES),
    ...communityMarkdown,
    `## ${PATTERNS_LABEL}`,
    ``,
    `${homePatternsLine(PATTERNS_LABEL, PATTERNS_HREF)}\n`,
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
  const review = await store.getReview(ref.kind, ref.owner, ref.repo, ref.slug);
  // A reviewed graph links back from its stored patterns; anything else
  // falls back to the statically authored `implements`, which names
  // official documents by kind and slug, so only an official page can
  // carry that back-link. Nodes always fall back: they carry no patterns.
  const patterns = await store.getPatterns();
  const titles = new Map((patterns?.entries ?? []).map((pattern) => [pattern.slug, pattern.title]));
  const backlinks = ref.kind === "graph" && review !== null
    ? review.patterns.flatMap((slug) => {
      const title = titles.get(slug);
      return title === undefined ? [] : [{ slug, title }];
    })
    : patterns === null || !ref.official
      ? []
      : implementingPatterns(patterns.entries, ref.kind, ref.slug).map((pattern) => ({
        slug: pattern.slug,
        title: pattern.title,
      }));
  return page(req, documentPage(doc, loaded.document, ref, { patterns: backlinks, review }));
}

/** The patterns list: every card from the patterns index. */
async function patternsResponse(req: Request, env: PageEnv, deps: PageDeps): Promise<Response> {
  const { store } = readers(env, deps);
  const patterns = await store.getPatterns();
  if (patterns === null) {
    return indexing(req);
  }
  return page(req, patternsIndexPage(patterns.entries));
}

/**
 * One pattern page: the stored page joined to the catalogue index. Graphs
 * come from the stored review relations once any review landed (replacing
 * the statically authored graph links, community graphs included); nodes
 * always come from the static `implements`, since reviews carry none for
 * them. Before the first review the static links render as they always
 * did. A missing catalogue index is the cold start, not empty Implemented-by.
 */
async function patternResponse(
  req: Request,
  env: PageEnv,
  deps: PageDeps,
  slug: string,
): Promise<Response> {
  if (!SLUG_RE.test(slug)) {
    return notFound(req);
  }
  const { store } = readers(env, deps);
  const patterns = await store.getPatterns();
  if (patterns === null) {
    return indexing(req);
  }
  const stored = await store.getPattern(slug);
  if (stored === null) {
    return notFound(req);
  }
  const index = await store.getIndex();
  if (index === null) {
    return indexing(req);
  }
  const relations = await store.getReviewPatterns();
  const rows: ImplementsRow[] = [];
  if (relations !== null) {
    for (const coords of relations.relations[slug] ?? []) {
      const entry = entryFor(index, coords.kind, coords.owner, coords.repo, coords.slug);
      if (entry === null) {
        continue;
      }
      const graph = await store.getDoc(coords.kind, entry.owner, entry.repo, entry.slug);
      rows.push({
        ref: { kind: coords.kind, slug: coords.slug },
        doc: rowFromEntry(entry),
        figure: graph === null ? null : graph.document,
      });
    }
  }
  // The static refs: every ref before the first review landed, nodes only
  // after (a missing ref still lists as text beside the not-in-the-catalogue
  // line, exactly as it always did).
  const statics = relations === null
    ? stored.implements
    : stored.implements.filter((ref) => ref.kind === "node");
  for (const ref of statics) {
    const entry = entryFor(index, ref.kind, OFFICIAL_OWNER, OFFICIAL_REPO, ref.slug);
    if (entry === null) {
      rows.push({ ref, doc: null, figure: null });
      continue;
    }
    let figure = null;
    if (ref.kind === "graph") {
      const graph = await store.getDoc(ref.kind, entry.owner, entry.repo, entry.slug);
      figure = graph === null ? null : graph.document;
    }
    rows.push({ ref, doc: rowFromEntry(entry), figure });
  }
  return page(req, patternPage(stored, rows));
}

/**
 * The transparency page: the indexing story, the pre-rendered diagram, how
 * the review works, the exact prompt, and every stored verdict. It needs
 * no index, so it answers 200 on a cold KV with an empty verdict list.
 */
async function transparencyResponse(req: Request, env: PageEnv, deps: PageDeps): Promise<Response> {
  void deps;
  const { store } = readers(env, deps);
  const reviews = await store.getReviews();
  return page(req, transparencyPage({
    svg: INDEXING_SVG,
    mmd: INDEXING_MMD,
    prompt: REVIEW_PROMPT_V1,
    promptVersion: REVIEW_PROMPT_VERSION,
    reviews: reviews?.reviews ?? [],
  }));
}

async function homeResponse(req: Request, env: PageEnv, deps: PageDeps): Promise<Response> {
  const { store, volumes } = readers(env, deps);
  const index = await store.getIndex();
  if (index === null) {
    return indexing(req);
  }
  const listing = officialFromIndex(index);
  const community = communityFromIndex(index);
  const counts = await volumes();
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 256);
  return page(req, {
    ...homePage(
      attachDownloads(listing.graphs, counts),
      attachDownloads(listing.nodes, counts),
      attachDownloads(community.graphs, counts),
      attachDownloads(community.nodes, counts),
    ),
    search: q,
  });
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
  return page(req, { ...searchPage(q, sort, attachDownloads(outcome.items, await volumes())), search: q });
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
  const patterns = await store.getPatterns();
  const ordered = [...(patterns?.entries ?? [])].sort(comparePatterns);
  if (ordered.length > 0) {
    lines.push("", `## ${LLMS_PATTERNS_HEADING}`, "");
    for (const entry of ordered) {
      lines.push(llmsPatternLine(entry.title, entry.summary, entry.slug));
    }
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
  if (segments.length === 1 && segments[0] === "patterns") {
    return patternsResponse(req, env, deps);
  }
  if (segments.length === 2 && segments[0] === "patterns") {
    return patternResponse(req, env, deps, segments[1] ?? "");
  }
  if (segments.length === 1 && segments[0] === "transparency") {
    return transparencyResponse(req, env, deps);
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
