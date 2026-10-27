// SPDX-License-Identifier: Apache-2.0
/**
 * The page shell: one wrapper every route renders through.
 *
 * A route builds a `Page` — a title, a meta description, the HTML body and
 * its markdown twin — and `page()` answers the request with one or the
 * other: a request sending `Accept: text/markdown` gets the twin (content
 * type `text/markdown`), everything else the full HTML document dressed in
 * the shared look kit of the Canopy page: the deep-teal surface with the
 * live honeycomb behind a centred column, the lab's three typefaces, the
 * mono wordmark, and the UniverLab colophon as footer.
 */
import {
  CANOPY_HREF,
  COLOPHON_EXP,
  COLOPHON_LINKS,
  COLOPHON_PRODUCT,
  SITE_NAME,
  TITLE_SEPARATOR,
  WORDMARK,
} from "./copy.js";
import { renderColophon } from "../../../../packages/look/colophon/footer.js";
import { escapeHtml } from "./md.js";
import { copyScript, fondoHost, fondoScript, lookCss, lookLinks } from "./look.js";

/** What one route renders: HTML for browsers, markdown for agents. */
export interface Page {
  title: string;
  description: string;
  html: string;
  markdown: string;
}

/** True when the request prefers the markdown twin over HTML. */
export function wantsMarkdown(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/markdown");
}

function htmlDocument(page: Page): string {
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
    lookLinks(),
    `<style>`,
    lookCss(),
    `</style>`,
    `</head>`,
    `<body>`,
    fondoHost(),
    `<div class="look-shell">`,
    `<header class="site-header">`,
    `<a class="wordmark" href="${CANOPY_HREF}">${escapeHtml(WORDMARK)}</a>`,
    `</header>`,
    `<main class="look-col">`,
    page.html,
    `</main>`,
    renderColophon({ product: COLOPHON_PRODUCT, exp: COLOPHON_EXP, links: COLOPHON_LINKS }),
    `</div>`,
    `<script src="/look/fondo.js" defer></script>`,
    `<script>`,
    fondoScript(),
    `</script>`,
    `<script>`,
    copyScript(),
    `</script>`,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n");
}

/**
 * Answer a page request: the markdown twin when asked for, the HTML shell
 * otherwise. Both carry a short public cache, like the JSON API's.
 */
export function page(req: Request, content: Page, status = 200): Response {
  const cacheControl = status === 200 ? "public, max-age=300" : "no-store";
  if (wantsMarkdown(req)) {
    return new Response(content.markdown, {
      status,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": cacheControl,
      },
    });
  }
  return new Response(htmlDocument(content), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}
