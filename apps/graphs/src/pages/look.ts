// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue's dress: the shared look kit of the Canopy page.
 *
 * The kit (packages/look, copied to public/look by `npm run build:look`)
 * owns the tokens, the three self-hosted typefaces, the colophon and the
 * honeycomb background. This module only glues them to a server-rendered
 * string page: three stylesheet links, the page stylesheet over the kit's
 * variables, the hidden canvas host, the bootstrap for `fondo.js` and the
 * two inline scripts (copy buttons, background mount). No framework and no
 * build step of its own: what this module returns is what the page ships.
 */
import { COPY_ARIA, COPY_BUTTON, COPY_DONE } from "./copy.js";
import { escapeHtml } from "./md.js";

/**
 * The kit's stylesheets, in load order: tokens first (the variables the
 * other two read), then the faces, then the colophon. Each file lives in its
 * own folder because fonts.css resolves ./woff2 beside itself and the
 * colophon's frieze/seal resolve from /look/colophon/.
 */
export function lookLinks(): string {
  return [
    `<link rel="stylesheet" href="/look/tokens.css">`,
    `<link rel="stylesheet" href="/look/fonts/fonts.css">`,
    `<link rel="stylesheet" href="/look/colophon/colophon.css">`,
  ].join("\n");
}

/**
 * The honeycomb's host: a fixed canvas layer behind the whole page. It is
 * decoration, so it is hidden from assistive tech and from the tab order;
 * the canvas `fondo.js` appends inherits both.
 */
export function fondoHost(): string {
  return `<div class="fondo" id="fondo" aria-hidden="true"></div>`;
}

/**
 * The page stylesheet, inline, over the kit's tokens. Mobile first: the
 * base rules are the 390px column and the one `min-width` query widens the
 * gutters on desktop. The plate figure scrolls inside itself so the page
 * never does.
 */
export function lookCss(): string {
  return `
*, *::before, *::after { box-sizing: border-box; }
html {
  background: var(--surface-bg);
  color-scheme: dark;
}
body {
  margin: 0;
  min-height: 100vh;
  background: var(--surface-bg);
  color: var(--surface-ink);
  font-family: var(--font-body);
  font-size: 1.0625rem;
  line-height: 1.6;
  -webkit-text-size-adjust: 100%;
}
a { color: var(--teal); text-underline-offset: 0.15em; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }
.fondo { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
.look-shell { position: relative; z-index: 1; }

.site-header { max-width: 46rem; margin: 0 auto; padding: 1.25rem 1.25rem 0; }
.wordmark {
  display: inline-block;
  padding-bottom: 0.15rem;
  border-bottom: 1px solid var(--surface-line);
  font-family: var(--font-mono);
  font-size: 1rem;
  letter-spacing: 0.08em;
  color: var(--surface-ink);
  text-decoration: none;
}
.wordmark:hover { border-bottom-color: var(--teal); }

main.look-col { max-width: 46rem; margin: 0 auto; padding: 1.25rem 1.25rem 3.5rem; }

h1, h2, h3 {
  font-family: var(--font-display);
  font-weight: 400;
  line-height: 1.2;
  color: var(--ink-hi);
}
h1 { margin: 0 0 0.75rem; font-size: clamp(1.9rem, 6vw, 2.6rem); }
h2 { margin: 2rem 0 0.65rem; font-size: 1.45rem; }
h3 {
  margin: 1.5rem 0 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--surface-ink-dim);
}
p { margin: 0 0 1rem; }
.description { margin: 0 0 1.25rem; font-size: 1.15rem; color: var(--surface-ink-dim); }
.hero-title { max-width: 22ch; }

.search { display: grid; gap: 0.6rem; margin: 0 0 1.5rem; }
.search label {
  display: block;
  margin-bottom: 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--surface-ink-dim);
}
.search input {
  width: 100%;
  padding: 0.6rem 0.7rem;
  background: var(--bg-deep);
  color: var(--surface-ink);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-ctl);
  font-family: var(--font-body);
  font-size: 1rem;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.9rem;
  margin: 0 0 1.5rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.tabs a {
  padding-bottom: 0.15rem;
  border-bottom: 1px solid transparent;
  color: var(--surface-ink-dim);
  text-decoration: none;
}
.tabs a[aria-current="page"] { border-bottom-color: var(--teal); color: var(--surface-ink); }

.doc-list { display: grid; gap: 0.75rem; list-style: none; padding: 0; margin: 0; }
.doc-list li {
  padding: 1rem 1.1rem;
  background: var(--surface-bg-raise);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-card);
}
.doc-list .doc-name {
  font-family: var(--font-display);
  font-size: 1.2rem;
  color: var(--surface-ink);
  text-decoration: none;
}
.doc-list .doc-name:hover { text-decoration: underline; text-decoration-color: var(--teal); }
.doc-list .doc-description { display: block; margin-top: 0.25rem; color: var(--surface-ink-dim); }
.doc-stats {
  margin-left: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--surface-ink-faint);
  white-space: nowrap;
}
.meta { font-family: var(--font-mono); font-size: 0.85rem; color: var(--surface-ink-dim); }

.button {
  display: inline-block;
  padding: 0.6rem 1.1rem;
  border: 0;
  border-radius: var(--radius-ctl);
  background: var(--cta-gradient);
  color: #012624;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  letter-spacing: 0.04em;
  text-decoration: none;
  cursor: pointer;
}
.button:hover { filter: brightness(1.05); }

.install { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: stretch; margin: 0 0 1.25rem; }
.install code {
  flex: 1 1 12rem;
  min-width: 0;
  padding: 0.55rem 0.7rem;
  background: var(--surface-bg-raise);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-ctl);
  color: var(--surface-ink);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  line-height: 1.5;
  white-space: nowrap;
  overflow-x: auto;
}
.copy {
  padding: 0.5rem 0.85rem;
  background: transparent;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-ctl);
  color: var(--surface-ink);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  cursor: pointer;
}
.copy:hover { border-color: var(--teal); }

figure.plate {
  margin: 1rem 0 1.5rem;
  padding: 0.75rem;
  max-width: 100%;
  overflow-x: auto;
  background: var(--bg-deep);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-card);
}
.plate svg { display: block; height: auto; max-width: none; }

.readme h1 { font-size: 1.6rem; }
.readme h2 { font-size: 1.25rem; }
.readme pre {
  padding: 0.75rem;
  background: var(--bg-deep);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-ctl);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  overflow-x: auto;
}
.readme code { font-family: var(--font-mono); font-size: 0.9em; }
.readme img { max-width: 100%; height: auto; }
.agent-nodes { font-family: var(--font-mono); font-size: 0.9rem; color: var(--surface-ink-dim); }
.busy { padding: 0.25rem 0 0.25rem 1rem; border-left: 3px solid var(--teal); }

@media (min-width: 48rem) {
  .site-header { padding: 2rem 2rem 0; }
  main.look-col { padding: 2rem 2rem 4rem; }
  .search { grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`.trim();
}

/**
 * The background bootstrap, inline after `/look/fondo.js`: it mounts the
 * honeycomb on the hidden host with the kit's asset base. It waits for
 * DOMContentLoaded when the deferred bundle has not run yet, so the order
 * of the two script tags does not matter.
 */
export function fondoScript(): string {
  return (
    `(function(){` +
    `function start(){` +
    `var host=document.getElementById("fondo");` +
    `if(!host||!window.CanopyLook||!window.CanopyLook.mountCanopyBackground){return}` +
    `window.CanopyLook.mountCanopyBackground(host,"/look/fondo/assets/")` +
    `}` +
    `if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start)}else{start()}` +
    `})();`
  );
}

/**
 * The copy script, inline at the end of `<body>`: one delegated listener
 * for every `.copy` button, so the buttons stay plain, focusable
 * `type="button"` elements and the keyboard reaches them for free.
 */
export function copyScript(): string {
  return (
    `(function(){` +
    `document.addEventListener("click",function(event){` +
    `var target=event.target;` +
    `if(!target||!target.classList||!target.classList.contains("copy")){return}` +
    `var command=target.getAttribute("data-copy")||"";` +
    `if(navigator.clipboard){navigator.clipboard.writeText(command)}` +
    `var original=target.textContent;` +
    `target.textContent="${COPY_DONE}";` +
    `window.setTimeout(function(){target.textContent=original},1500);` +
    `});` +
    `})();`
  );
}

/** One copy button for an install command. */
export function copyButton(command: string): string {
  return `<button type="button" class="copy" data-copy="${escapeHtml(command)}" aria-label="${COPY_ARIA}">${COPY_BUTTON}</button>`;
}
