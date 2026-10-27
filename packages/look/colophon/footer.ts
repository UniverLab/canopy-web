// Ported from univerlab src/components/Footer.astro following quorum c69ed6d and 0dfcc71
// SPDX-License-Identifier: Apache-2.0
/**
 * The UniverLab colophon footer outside Astro: the engraved frieze band
 * across the footer, the product line, the links in columns and the wax
 * seal ahead of the credits. Pair with colophon.css; images resolve under
 * /look/colophon/ once `npm run build:look` has copied the kit.
 */

const SAFE_HREF = /^(?:https?:\/\/|\/|#|\.\.?\/)/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHref(href: string): string {
  return SAFE_HREF.test(href) ? href : "#";
}

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** One link in the colophon columns. */
export interface ColophonLink {
  label: string;
  href: string;
}

/** What the footer needs: the product, its experiment code, backlinks. */
export interface ColophonOptions {
  product: string;
  exp: string;
  links: ColophonLink[];
}

/**
 * Render the footer HTML. Labels, product and experiment are escaped;
 * absolute links open in a new tab, as on univerlab.org; anything that is
 * not an http(s), root-relative, fragment or relative link degrades to #.
 */
export function renderColophon(opts: ColophonOptions): string {
  const product = escapeHtml(opts.product);
  const exp = escapeHtml(opts.exp);
  const items = opts.links
    .map((link) => {
      const href = safeHref(link.href);
      const external = isExternal(href) ? ` target="_blank" rel="noopener noreferrer"` : ``;
      return `      <a href="${escapeHtml(href)}"${external}>${escapeHtml(link.label)}</a>`;
    })
    .join("\n");
  return [
    `<footer class="look-colophon">`,
    `  <picture class="colophon-band" aria-hidden="true">`,
    `    <source type="image/avif" srcset="/look/colophon/frieze-960.avif 960w, /look/colophon/frieze-1920.avif 1920w" sizes="100vw">`,
    `    <img src="/look/colophon/frieze-1920.webp" srcset="/look/colophon/frieze-960.webp 960w, /look/colophon/frieze-1920.webp 1920w" sizes="100vw" width="1920" height="608" alt="" loading="lazy" decoding="async">`,
    `  </picture>`,
    `  <div class="colophon-content">`,
    `    <div class="colophon-brand">`,
    `      <p class="colophon-title">${product}</p>`,
    `      <p class="colophon-sub">Part of UniverLab · ${exp} ${product}</p>`,
    `    </div>`,
    `    <nav class="colophon-col" aria-label="UniverLab">`,
    `      <p class="colophon-label">UniverLab</p>`,
    items,
    `    </nav>`,
    `    <p class="colophon-credits">`,
    `      <img src="/look/colophon/sello-lacre.svg" width="28" height="28" alt="" aria-hidden="true">`,
    `      <span>Artifact conceived and forged at <a href="https://univerlab.org" target="_blank" rel="noopener noreferrer">UniverLab</a></span>`,
    `    </p>`,
    `  </div>`,
    `</footer>`,
    ``,
  ].join("\n");
}
