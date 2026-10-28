// SPDX-License-Identifier: Apache-2.0
/**
 * The page shell: one wrapper every route renders through.
 *
 * A route builds a `Page` — a title, a meta description, the HTML body and
 * its markdown twin — and `page()` answers the request with one or the
 * other: a request sending `Accept: text/markdown` gets the twin (content
 * type `text/markdown`), everything else the full HTML document. The shell
 * is the technical index around the content: a header band with the mono
 * wordmark, a full-width search form and the Publish/Source links over the
 * live honeycomb (mounted inside the band only), a left-aligned content
 * column below, and the UniverLab colophon as footer.
 */
import {
  CANOPY_HREF,
  COLOPHON_EXP,
  COLOPHON_LINKS,
  COLOPHON_PRODUCT,
  EDITOR_HREF,
  EDITOR_LABEL,
  MD_FOOTER,
  PUBLISH_HREF,
  PUBLISH_LABEL,
  SEARCH_BUTTON,
  SEARCH_LABEL,
  SEARCH_PLACEHOLDER,
  SITE_NAME,
  SOURCE_HREF,
  SOURCE_LABEL,
  TITLE_SEPARATOR,
  WORDMARK,
} from "./copy.js";
import { AGENT_LINK_HEADER } from "../agent-files.js";
import { renderColophon } from "../../../../packages/look/colophon/footer.js";
import { iconSvg } from "../../../../packages/look/icon-svg.js";
import { escapeHtml } from "./md.js";
import { copyScript, fondoHost, fondoScript, lookCss, lookLinks } from "./look.js";

/** What one route renders: HTML for browsers, markdown for agents. */
export interface Page {
  title: string;
  description: string;
  html: string;
  markdown: string;
  /**
   * True only for pages that must never be crawled: a draft, which is
   * ephemeral and personal, emits the robots meta and is absent from the
   * sitemap and llms.txt. Absent keeps the existing pages byte-identical.
   */
  noindex?: boolean;
  /**
   * Extra stylesheets this one page loads after the kit's, and extra
   * deferred scripts after the inline ones. Only the editor passes them
   * (its bundled `/editor/editor.css` and `editor.js`); every other page
   * leaves them absent, so its shell stays byte-identical.
   */
  styles?: string[];
  scripts?: string[];
}

/** True when the request prefers the markdown twin over HTML. */
export function wantsMarkdown(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/markdown");
}

/** The header band's search form, holding the current query when there is one. */
function searchForm(q: string): string {
  return (
    `<form class="search" action="/search" method="get" role="search">` +
    `<label class="sr-only" for="q">${SEARCH_LABEL}</label>` +
    `<input id="q" name="q" type="search" value="${escapeHtml(q)}" ` +
    `placeholder="${SEARCH_PLACEHOLDER}" autocomplete="off">` +
    `<button type="submit">${iconSvg("search")}<span>${SEARCH_BUTTON}</span></button>` +
    `</form>`
  );
}

function htmlDocument(q: string, page: Page): string {
  const title = escapeHtml(`${page.title}${TITLE_SEPARATOR}${SITE_NAME}`);
  const description = escapeHtml(page.description);
  return [
    `<!doctype html>`,
    `<html lang="en" data-surface="tui">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    ...(page.noindex === true ? [`<meta name="robots" content="noindex">`] : []),
    lookLinks(),
    ...(page.styles ?? []).map((href) => `<link rel="stylesheet" href="${href}">`),
    `<style>`,
    lookCss(),
    `</style>`,
    `</head>`,
    `<body>`,
    `<div class="look-shell">`,
    `<header class="site-header">`,
    fondoHost(),
    `<div class="band">`,
    `<div class="band-top">`,
    `<a class="wordmark" href="${CANOPY_HREF}">${escapeHtml(WORDMARK)}</a>`,
    `<nav class="site-nav" aria-label="Catalogue">`,
    `<a href="${EDITOR_HREF}">${iconSvg("pencilRuler")}<span>${EDITOR_LABEL}</span></a>`,
    `<a href="${PUBLISH_HREF}">${iconSvg("upload")}<span>${PUBLISH_LABEL}</span></a>`,
    `<a href="${SOURCE_HREF}">${iconSvg("github")}<span>${SOURCE_LABEL}</span></a>`,
    `</nav>`,
    `</div>`,
    searchForm(q),
    `</div>`,
    `</header>`,
    `<main class="look-col">`,
    page.html,
    `</main>`,
    renderColophon({ product: COLOPHON_PRODUCT, exp: COLOPHON_EXP, links: COLOPHON_LINKS }),
    `</div>`,
    `<script src="/look/fondo.js" defer></script>`,
    `<script src="/look/icons.js" defer></script>`,
    `<script>`,
    fondoScript(),
    `</script>`,
    `<script>`,
    copyScript(),
    `</script>`,
    ...(page.scripts ?? []).map((src) => `<script src="${src}" defer></script>`),
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}

/**
 * Close a markdown twin with the UniverLab footer section: the privacy and
 * terms links, after exactly one blank line over the twin's last line.
 */
export function withMarkdownFooter(markdown: string): string {
  return `${markdown.replace(/\n+$/, "")}\n\n${MD_FOOTER}`;
}

/**
 * Answer a page request: the markdown twin when asked for, the HTML shell
 * otherwise. Both carry a short public cache, like the JSON API's, unless the
 * route names its own (a draft is `no-store`). The HTML branch also carries
 * the agent Link header (llms.txt and the API catalogue), in univerlab.org's
 * shape; the twin needs none.
 */
export function page(
  req: Request,
  content: Page,
  status = 200,
  cacheControl?: string,
): Response {
  const cache = cacheControl ?? (status === 200 ? "public, max-age=300" : "no-store");
  if (wantsMarkdown(req)) {
    return new Response(withMarkdownFooter(content.markdown), {
      status,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": cache,
      },
    });
  }
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 256);
  return new Response(htmlDocument(q, content), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cache,
      link: AGENT_LINK_HEADER,
    },
  });
}
