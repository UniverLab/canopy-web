// SPDX-License-Identifier: Apache-2.0
/**
 * The visual system of univerlab.org for the catalogue pages.
 *
 * Google Fonts (Old Standard TT for display, EB Garamond for body, Sometype
 * Mono for labels and commands), one inline stylesheet over CSS variables,
 * and two tiny inline scripts: the theme (localStorage, else the visitor's
 * local hour — 06-18 is day) and the copy buttons. No framework, no build
 * step: what this module returns is exactly what the page ships.
 */
import { COPY_ARIA, COPY_BUTTON, THEME_TOGGLE } from "./copy.js";
import { escapeHtml } from "./md.js";

/** The Google Fonts link: the three families, one request, swap on load. */
export function fontLinks(): string {
  return [
    `<link rel="preconnect" href="https://fonts.googleapis.com">`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`,
    `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?` +
      `family=EB+Garamond:ital,wght@0,400..800;1,400..800&` +
      `family=Old+Standard+TT:ital,wght@0,400;0,700;1,400&` +
      `family=Sometype+Mono:ital,wght@0,400..700;1,400..700&display=swap">`,
  ].join("\n");
}

/** Day and night as the two value sets behind the CSS variables. */
export const THEME = {
  day: { background: "#f4f0ea", ink: "#1d1510" },
  night: { background: "#222928", ink: "#ecebe4" },
  accent: "#3fb8b0",
} as const;

const DISPLAY = `"Old Standard TT", Georgia, serif`;
const BODY = `"EB Garamond", Georgia, serif`;
const MONO = `"Sometype Mono", "Courier New", monospace`;

/**
 * The whole stylesheet, inline. `:root` is day; `html[data-theme="night"]`
 * overrides the two variables that change. Reduced motion is respected by
 * turning every transition off.
 */
export function themeCss(): string {
  const { day, night, accent } = THEME;
  return `
:root {
  --bg: ${day.background};
  --ink: ${day.ink};
  --accent: ${accent};
  --display: ${DISPLAY};
  --body: ${BODY};
  --mono: ${MONO};
}
html[data-theme="night"] {
  --bg: ${night.background};
  --ink: ${night.ink};
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 1.5rem 1.25rem 3rem;
  max-width: 46rem;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--body);
  font-size: 1.0625rem;
  line-height: 1.55;
}
a { color: var(--accent); }
a:hover, a:focus-visible { text-decoration-thickness: 2px; }
.site-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.brand {
  font-family: var(--display);
  font-size: 1.5rem;
  color: var(--ink);
  text-decoration: none;
}
.tagline { margin: 0.25rem 0 1.5rem; font-style: italic; }
h1, h2, h3 { font-family: var(--display); line-height: 1.2; }
h1 { font-size: 2rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.35rem; margin: 2rem 0 0.5rem; }
.description { margin: 0 0 1.25rem; font-size: 1.15rem; }
.readme h1 { font-size: 1.6rem; }
.readme h2 { font-size: 1.25rem; }
.readme pre {
  overflow-x: auto;
  padding: 0.75rem;
  border: 1px solid var(--ink);
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 0.85rem;
}
.readme code { font-family: var(--mono); font-size: 0.9em; }
.readme img { max-width: 100%; }
.meta { font-family: var(--mono); font-size: 0.85rem; margin: 0.25rem 0 1rem; }
.tabs { display: flex; gap: 1rem; margin: 1rem 0; font-family: var(--mono); }
.tabs a[aria-current="page"] { color: var(--ink); text-decoration-thickness: 2px; }
.search { display: flex; gap: 0.5rem; align-items: end; margin: 1rem 0 2rem; }
.search label { display: block; font-family: var(--mono); font-size: 0.85rem; }
.search input {
  min-width: 14rem;
  padding: 0.4rem 0.5rem;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--ink);
  border-radius: 4px;
  font-family: var(--body);
  font-size: 1rem;
}
.doc-list { list-style: none; padding: 0; margin: 0; }
.doc-list li { margin: 0.75rem 0; }
.doc-list .doc-name { font-family: var(--display); font-size: 1.15rem; }
.doc-list .doc-description { display: block; }
.button {
  display: inline-block;
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--accent);
  border-radius: 4px;
  color: var(--bg);
  background: var(--accent);
  font-family: var(--mono);
  font-size: 0.9rem;
  text-decoration: none;
  cursor: pointer;
}
.install {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin: 0.5rem 0 1rem;
}
.install code {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--ink);
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 0.9rem;
  overflow-x: auto;
}
.copy {
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--ink);
  border-radius: 4px;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 0.9rem;
  cursor: pointer;
}
.copy:hover, .copy:focus-visible { border-color: var(--accent); }
.theme-toggle {
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--ink);
  border-radius: 4px;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 0.85rem;
  cursor: pointer;
}
.plate { margin: 1rem 0; overflow-x: auto; max-width: 100%; }
.plate svg { display: block; height: auto; max-width: none; }
.agent-nodes { font-family: var(--mono); font-size: 0.95rem; }
.site-footer { margin-top: 3rem; font-family: var(--mono); font-size: 0.85rem; }
.busy { border-left: 3px solid var(--accent); padding-left: 1rem; }
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`.trim();
}

/**
 * The theme script, inline in `<head>` so the ground never flashes: the
 * stored choice wins, else the local hour decides (06-18 is day). The
 * toggle flips the theme and stores it.
 */
export function themeScript(): string {
  return (
    `(function(){` +
    `var stored=null;try{stored=localStorage.getItem("theme")}catch(e){}` +
    `var hour=new Date().getHours();` +
    `var theme=stored||(hour>=6&&hour<18?"day":"night");` +
    `document.documentElement.dataset.theme=theme;` +
    `document.addEventListener("DOMContentLoaded",function(){` +
    `var button=document.getElementById("theme-toggle");` +
    `if(!button){return}` +
    `button.addEventListener("click",function(){` +
    `var next=document.documentElement.dataset.theme==="day"?"night":"day";` +
    `document.documentElement.dataset.theme=next;` +
    `try{localStorage.setItem("theme",next)}catch(e){}` +
    `});` +
    `});` +
    `})();`
  );
}

/** The theme toggle button, in the header. */
export function themeToggle(): string {
  return `<button type="button" class="theme-toggle" id="theme-toggle" aria-label="${THEME_TOGGLE}">${THEME_TOGGLE}</button>`;
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
    `target.textContent=command;` +
    `window.setTimeout(function(){target.textContent=original},1500);` +
    `});` +
    `})();`
  );
}

/** One copy button for an install command. */
export function copyButton(command: string): string {
  return `<button type="button" class="copy" data-copy="${escapeHtml(command)}" aria-label="${COPY_ARIA}">${COPY_BUTTON}</button>`;
}
