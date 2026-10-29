// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue's dress: the shared look kit of the Canopy page, worn as a
 * technical index instead of an editorial page.
 *
 * The kit (packages/look, copied to public/look by `npm run build:look`)
 * owns the tokens, the three self-hosted typefaces, the colophon and the
 * honeycomb background. This module only glues them to a server-rendered
 * string page: three stylesheet links, the page stylesheet over the kit's
 * variables, the honeycomb host inside the header band, the bootstrap for
 * `fondo.js` and the two inline scripts (copy buttons, background mount).
 * No framework and no build step of its own: what this module returns is
 * what the page ships.
 *
 * Type roles: Sometype Mono is the UI face (labels, meta, buttons, tabs,
 * rows, the sheet), Old Standard TT only names documents (row titles, page
 * title), EB Garamond only sets README prose and descriptions.
 */
import { COPY_ARIA, COPY_BUTTON, COPY_DONE } from "./copy.js";
import { escapeHtml } from "./md.js";
import { iconSvg } from "../../../../packages/look/icon-svg.js";

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
    `<link rel="stylesheet" href="/look/banner/banner.css">`,
  ].join("\n");
}

/**
 * The honeycomb's host: it lives inside the header band and the background
 * bundle fills it. It is decoration, so it is hidden from assistive tech
 * and from the tab order; the canvas `fondo.js` appends inherits both.
 */
export function fondoHost(): string {
  return `<div class="fondo" id="fondo" aria-hidden="true"></div>`;
}

/**
 * The page stylesheet, inline, over the kit's tokens. The register is a
 * parts catalogue: dense mono rows under a header band, the honeycomb only
 * behind the band, the body flat `--surface-bg`. Nothing is centred except
 * the plate inside its figure. Breakpoints: 640 px (band height, page
 * gutters, plate orientation), 900 px (index rows), 1024 px (datasheet
 * columns).
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
  font-family: var(--font-mono);
  font-size: 0.9375rem;
  line-height: 1.55;
  -webkit-text-size-adjust: 100%;
}
a { color: var(--teal); text-underline-offset: 0.15em; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--teal); outline-offset: 3px; }

/* Every icon is Lucide data drawn inline (packages/look/icon-svg.ts): one
 * box, currentColor, no font and no request. The slot keeps the box fixed
 * while its path morphs (the Copy button). */
.icon { display: inline-block; width: 16px; height: 16px; flex: none; vertical-align: -0.15em; }
.icon-slot { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: none; }
.icon-slot svg, .icon-slot morph-icon { display: block; }
.copy, .search button, .site-nav a, .button { display: inline-flex; align-items: center; gap: 0.4rem; }
.copy-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: none; }
.copy-icon svg, .copy-icon morph-icon { display: block; }
.look-shell { min-height: 100vh; }

.site-header {
  position: relative;
  height: 120px;
  overflow: hidden;
  border-bottom: 1px solid var(--surface-line);
}
.fondo { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.band {
  position: relative;
  z-index: 1;
  max-width: 1120px;
  height: 100%;
  margin: 0 auto;
  padding: 0 1rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.6rem;
}
.band-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem 1rem;
}
.banner-home {
  display: inline-flex;
  flex: none;
}
.banner-home:hover { filter: brightness(1.12); }
.site-nav {
  display: flex;
  gap: 1rem;
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.site-nav a { color: var(--surface-ink-dim); text-decoration: none; }
.site-nav a:hover { color: var(--surface-ink); text-decoration: underline; text-decoration-color: var(--teal); }

.search { display: flex; gap: 0.5rem; margin: 0; }
main .search { margin: 0 0 1.5rem; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.search input {
  flex: 1;
  min-width: 0;
  padding: 0.55rem 0.7rem;
  background: var(--bg-deep);
  color: var(--surface-ink);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-ctl);
  font-family: var(--font-mono);
  font-size: 0.9rem;
}
.search button {
  flex: none;
  padding: 0.55rem 1rem;
  background: var(--tint-info);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-ctl);
  color: var(--surface-ink);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  cursor: pointer;
}
.search button:hover { border-color: var(--teal); }

main.look-col { max-width: 1120px; margin: 0 auto; padding: 1.5rem 1rem 3.5rem; }

h1, h2, h3 { font-weight: 400; line-height: 1.25; color: var(--ink-hi); }
h1 { margin: 0 0 1rem; font-family: var(--font-mono); font-size: 1.05rem; }
.index-title { font-family: var(--font-mono); font-size: 1.05rem; margin: 0 0 1rem; }
.doc-title {
  font-family: var(--font-display);
  font-size: clamp(1.7rem, 5vw, 2.3rem);
  margin: 0 0 0.5rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.doc-title .icon { width: 24px; height: 24px; }
.kicker {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--surface-ink-dim);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
h2.kicker { margin: 2rem 0 0.75rem; }
h3.kicker { margin: 1.25rem 0 0.5rem; }
p { margin: 0 0 1rem; }
.description { margin: 0 0 1rem; font-family: var(--font-body); font-size: 1.1rem; color: var(--surface-ink-dim); }

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

ol.index {
  list-style: none;
  margin: 0 0 1.5rem;
  padding: 0 1rem;
  background: var(--surface-panel);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-card);
}
li.row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem 0.75rem;
  padding: 0.7rem 0;
  border-bottom: 1px solid var(--surface-line);
  font-family: var(--font-mono);
  font-size: 0.85rem;
}
li.row:last-child { border-bottom: 0; }
.row-name {
  font-family: var(--font-display);
  font-size: 1.15rem;
  color: var(--surface-ink);
  text-decoration: none;
}
.row-name:hover { text-decoration: underline; text-decoration-color: var(--teal); }
.kind {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-ctl);
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--surface-ink-dim);
}
.row-meta { color: var(--surface-ink-dim); white-space: nowrap; }
.dots { display: inline-flex; gap: 0.3rem; align-self: center; }
.dot {
  display: inline-block;
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: var(--nc, var(--canopy));
}
/* The command field and its Copy button share one height: each stretches
 * to the other's, so the pair reads as a single control on every host
 * (index rows, datasheet, publish, share panel) — the field painted with
 * the raised command tokens, the command at full ink. */
.row-install { display: inline-flex; gap: 0.5rem; align-items: stretch; margin-left: auto; min-width: 0; }
.row-install code {
  display: flex;
  align-items: center;
  padding: 0.35rem 0.6rem;
  background: var(--command-bg);
  border: 1px solid var(--command-line);
  border-radius: var(--radius-ctl);
  color: var(--surface-ink);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.5;
  white-space: nowrap;
  overflow-x: auto;
}
.row-desc {
  flex-basis: 100%;
  font-family: var(--font-body);
  font-size: 1rem;
  color: var(--surface-ink-dim);
}

ol.cards {
  list-style: none;
  margin: 0 0 1.5rem;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 1rem;
}
li.card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.9rem 1rem 1rem;
  background: var(--surface-panel);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-card);
  font-family: var(--font-mono);
  font-size: 0.85rem;
}
.card-link {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  align-self: stretch;
  color: var(--surface-ink);
  text-decoration: none;
}
.card-link:hover .card-title { text-decoration: underline; text-decoration-color: var(--teal); }
.card-title { font-family: var(--font-display); font-size: 1.25rem; }
.card-summary { font-family: var(--font-body); font-size: 1rem; color: var(--surface-ink-dim); }

/* A plate at thumbnail size: the same black stage, cropped, still, and out
 * of the pointer's way. Index rows carry one after their install box. */
figure.thumb { margin: 0; padding: 0.5rem; max-height: 12rem; overflow: hidden; pointer-events: none; }
figure.thumb svg { width: 100%; height: auto; max-height: 11rem; }
figure.thumb .token { display: none; }
li.row figure.thumb { flex-basis: 100%; order: 3; margin-top: 0.5rem; }

.badge-status {
  display: inline-block;
  padding: 0.05rem 0.4rem;
  background: var(--tint-ok);
  border: 1px solid var(--tint-line);
  border-radius: var(--radius-ctl);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.badge-status.status-in-use { background: var(--tint-info); }
.badge-status.status-experiment { background: var(--tint-warn); }
.doc-title .badge-status { font-size: 0.8rem; }

ul.sources { margin: 0 0 1.5rem; padding-left: 1.25rem; font-family: var(--font-body); font-size: 1.05rem; }
ul.sources li { margin: 0 0 0.35rem; }

.button {
  display: inline-block;
  padding: 0.6rem 1.1rem;
  border: 1px solid var(--tint-line);
  border-radius: var(--radius-ctl);
  background: var(--tint-info);
  color: var(--surface-ink);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  letter-spacing: 0.04em;
  text-decoration: none;
  cursor: pointer;
}
.button:hover { filter: brightness(1.05); }
.copy {
  flex: none;
  padding: 0.35rem 0.7rem;
  background: var(--tint-info);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-ctl);
  color: var(--surface-ink);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  cursor: pointer;
}
.copy:hover { border-color: var(--teal); }
/* The word swaps between Copy and Copied without resizing the button, so
 * neither the icon nor the row moves while the icon morphs. */
.copy-text { display: inline-block; min-width: 3.4rem; }

.doc-cols { display: flex; flex-direction: column; gap: 1.5rem; margin: 1rem 0 1.5rem; }
dl.sheet {
  margin: 0;
  background: var(--surface-panel);
  border: 1px solid var(--surface-line);
  border-radius: var(--radius-card);
  padding: 0 1rem;
  font-family: var(--font-mono);
  font-size: 0.85rem;
}
.sheet .field {
  display: grid;
  grid-template-columns: 7.5rem minmax(0, 1fr);
  gap: 0.75rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--surface-line);
}
.sheet .field:first-child { border-top: 0; }
.sheet .field:last-child { border-bottom: 0; }
.sheet dt {
  margin: 0;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--surface-ink-dim);
}
.sheet dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.sheet .row-install { margin-left: 0; width: 100%; flex-wrap: wrap; }
.sheet .row-install code { flex: 1 1 12rem; min-width: 0; white-space: normal; overflow-wrap: anywhere; overflow-x: visible; }

figure.plate {
  margin: 0 0 1.5rem;
  padding: 0.75rem;
  max-width: 100%;
  overflow-x: auto;
  background: var(--stage-bg);
  border: 1px solid var(--stage-line);
  border-radius: var(--radius-card);
}
.doc-cols figure.plate { margin: 0; }
.plate svg { display: block; height: auto; margin: 0 auto; }
.plate .plate-v { display: none; }

.readme { font-family: var(--font-body); font-size: 1.05rem; line-height: 1.6; }
.readme h1, .readme h2, .readme h3 {
  font-family: var(--font-body);
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--ink-hi);
}
.readme h1 { font-size: 1.6rem; }
.readme h2 { font-size: 1.3rem; }
.readme h3 { font-size: 1.1rem; }
.readme pre {
  padding: 0.75rem;
  background: var(--stage-bg);
  border: 1px solid var(--stage-line);
  border-radius: var(--radius-ctl);
  color: var(--stage-ink);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  overflow-x: auto;
}
.readme code { font-family: var(--font-mono); font-size: 0.9em; }
.readme img { max-width: 100%; height: auto; }
.busy { padding: 0.25rem 0 0.25rem 1rem; border-left: 3px solid var(--teal); }
.busy-error {
  background: var(--tint-error);
  border: 1px solid var(--tint-line);
  border-radius: var(--radius-card);
  padding: 1rem 1.25rem;
}
.busy-error h1 { color: var(--err-label); }
.busy-error p { color: var(--surface-ink); }

.badge-official {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.05rem 0.4rem;
  background: var(--tint-ok);
  border: 1px solid var(--tint-line);
  border-radius: var(--radius-ctl);
  color: var(--surface-ink);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.badge-official .icon { width: 14px; height: 14px; }
.doc-title .badge-official { font-size: 0.8rem; }
.row-source { color: var(--surface-ink-dim); }

.community-warning {
  margin: 1rem 0 1.5rem;
  padding: 0.9rem 1rem;
  background: var(--tint-warn);
  border: 1px solid var(--tint-line);
  border-left: 3px solid var(--attention);
  border-radius: var(--radius-ctl);
  font-family: var(--font-body);
  font-size: 1.05rem;
  line-height: 1.6;
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
}
.community-warning p { margin: 0; }
/* The one icon with an ink of its own: the warning triangle, red on the
 * warn tint. Everything else follows currentColor. */
.community-warning .icon { color: var(--warn-icon); margin-top: 0.35rem; }
.install-review { margin: 0.4rem 0 0; font-family: var(--font-mono); font-size: 0.78rem; color: var(--surface-ink-dim); }

.runs-summary { font-family: var(--font-mono); font-size: 0.85rem; }
.runs-summary.runs-community {
  background: var(--tint-warn);
  border: 1px solid var(--tint-line);
  border-radius: var(--radius-ctl);
  padding: 0.6rem 0.75rem;
}
.run { margin: 0 0 1rem; }
.run-where { font-family: var(--font-mono); font-size: 0.82rem; }
p.run-where { margin: 0 0 0.35rem; }
pre.run-command, pre.run-prompt-text {
  margin: 0;
  padding: 0.75rem;
  max-width: 100%;
  background: var(--stage-bg);
  border: 1px solid var(--stage-line);
  border-radius: var(--radius-ctl);
  color: var(--stage-ink);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow-x: auto;
}
pre.run-command code, pre.run-prompt-text code { font-family: inherit; overflow-wrap: anywhere; }
.attention-chip {
  display: inline-block;
  margin-left: 0.4rem;
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--attention);
  border-radius: var(--radius-ctl);
  color: var(--attention);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  white-space: nowrap;
}
details.run-prompt {
  margin: 0 0 0.75rem;
  padding: 0.6rem 0.75rem;
  background: var(--stage-bg);
  border: 1px solid var(--stage-line);
  border-radius: var(--radius-ctl);
}
details.run-prompt summary { cursor: pointer; }
details.run-prompt summary .run-where { color: var(--surface-ink); }
.run-preview {
  display: block;
  margin-top: 0.25rem;
  color: var(--surface-ink-dim);
  font-family: var(--font-mono);
  font-size: 0.82rem;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.run-builtin { margin: 0.5rem 0 0; font-family: var(--font-mono); font-size: 0.82rem; color: var(--surface-ink-dim); }
details.run-prompt pre.run-prompt-text { margin-top: 0.5rem; }

/* Under 520 px the header's four links show their icon alone, so the row
 * stays one line on a small screen: the label leaves the layout but stays
 * in the accessibility tree through the link's aria-label and title, and
 * each link is a 44 px square target (the 639 block below adds the
 * height). The banner is 253 px wide under 640 px (banner.css); the four
 * labelled links need about 330 px beside it, so above 519 px the band-top
 * wraps them onto a second row inside the band's height. */
@media (max-width: 519px) {
  .site-nav { gap: 0.25rem; }
  .site-nav a { min-width: 44px; justify-content: center; }
  .site-nav a span { display: none; }
}
@media (max-width: 639px) {
  .plate .plate-h { display: none; }
  .plate .plate-v { display: block; }
  /* Phones: every control that holds an icon alone is a 44 × 44 target. */
  .copy { min-width: 44px; min-height: 44px; justify-content: center; }
  .search button, .site-nav a { min-height: 44px; }
}
@media (max-width: 899px) {
  .row-desc { order: 1; }
  .row-install { order: 2; flex-basis: 100%; margin-left: 0; }
  .row-install code { flex: 1; }
}
@media (min-width: 640px) {
  .site-header { height: 160px; }
  .band { padding: 0 1.5rem; }
  main.look-col { padding: 2rem 1.5rem 4rem; }
}
@media (min-width: 1024px) {
  .doc-cols { flex-direction: row; align-items: flex-start; }
  .doc-cols figure.plate { flex: 1; min-width: 0; }
  dl.sheet { flex: 0 0 320px; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`.trim();
}

/**
 * The background bootstrap, inline after `/look/fondo.js`: it mounts the
 * honeycomb on the host inside the header band with the kit's asset base.
 * It waits for DOMContentLoaded when the deferred bundle has not run yet,
 * so the order of the two script tags does not matter.
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
 * The copy script, inline at the end of `<body>`: it hands the buttons to
 * the kit's `/look/icons.js` bundle (the copy morph), which installs one
 * delegated listener for every `.copy` button. The buttons stay plain,
 * focusable `type="button"` elements, so the keyboard reaches them for free.
 */
export function copyScript(): string {
  return (
    `(function(){` +
    `function start(){` +
    `if(window.CanopyIcons&&window.CanopyIcons.mountCopyButtons){window.CanopyIcons.mountCopyButtons(document)}` +
    `}` +
    `if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start)}else{start()}` +
    `})();`
  );
}

/**
 * One copy button for an install command: the copy icon (which morphs into
 * a check, see /look/icons.js) beside the word, and the word's swap. The
 * label stays the same for assistive tech throughout.
 */
export function copyButton(command: string): string {
  return (
    `<button type="button" class="copy" data-copy="${escapeHtml(command)}"` +
    ` data-label="${COPY_BUTTON}" data-done="${COPY_DONE}" aria-label="${COPY_ARIA}">` +
    `<span class="copy-icon" data-icon="copy">${iconSvg("copy")}</span>` +
    `<span class="copy-text">${COPY_BUTTON}</span>` +
    `</button>`
  );
}
