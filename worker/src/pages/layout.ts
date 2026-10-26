// SPDX-License-Identifier: Apache-2.0
/**
 * The page shell: one wrapper every route renders through.
 *
 * A route builds a `Page` — a title, a meta description, the HTML body and
 * its markdown twin — and `page()` answers the request with one or the
 * other: a request sending `Accept: text/markdown` gets the twin (content
 * type `text/markdown`), everything else the full HTML document with the
 * theme, fonts and footer of univerlab.org's visual system.
 */
import { SITE_NAME, TAGLINE, TITLE_SEPARATOR, FOOTER_HREF, FOOTER_TEXT } from "./copy.js";
import { escapeHtml } from "./md.js";
import {
  copyScript,
  fontLinks,
  themeCss,
  themeScript,
  themeToggle,
} from "./theme.js";

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
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    fontLinks(),
    `<style>`,
    themeCss(),
    `</style>`,
    `<script>`,
    themeScript(),
    `</script>`,
    `</head>`,
    `<body>`,
    `<header class="site-header">`,
    `<a class="brand" href="/">${escapeHtml(SITE_NAME)}</a>`,
    themeToggle(),
    `</header>`,
    `<p class="tagline">${escapeHtml(TAGLINE)}</p>`,
    `<main>`,
    page.html,
    `</main>`,
    `<footer class="site-footer"><a href="${FOOTER_HREF}">${FOOTER_TEXT}</a></footer>`,
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
