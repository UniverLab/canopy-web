// SPDX-License-Identifier: Apache-2.0
/**
 * The editor page: the server-rendered shell `GET /editor` answers with.
 *
 * The shell is structure and prose only — the toolbar, the import box, the
 * palette with a blank node of every kind, the canvas host, the zoom and
 * condition-chooser controls, the inspector host and the share block — all
 * of it static markup in the catalogue's look (the h1, the description, the
 * same band and colophon every page wears). Behaviour lives in the browser
 * bundle `public/editor/editor.js` (src/editor/), which this page loads
 * through `Page.scripts` next to its stylesheet. Nothing here reads the
 * index or an API: the route renders whatever the request asked for, and
 * the client fetches the three endpoints it needs.
 *
 * Every string comes from `pages/copy.ts`, the kind glyphs draw the plate's
 * own geometry (`packages/plate/vocabulary.ts`), and the buttons carry the
 * `data-` hooks the bundle binds to — so the shell and the client agree on
 * names through this one file.
 */
import { GEOM, PALETTE } from "../../../../packages/plate/vocabulary.js";
import { NODE_KINDS, shapeOfKind, type NodeKind } from "../editor/kinds.js";
import {
  EDITOR_APPLY,
  EDITOR_BLANK_HEADING,
  EDITOR_CANCEL,
  EDITOR_CANVAS_EMPTY,
  EDITOR_CANVAS_LABEL,
  EDITOR_CATALOGUE_HEADING,
  EDITOR_CONDITION_HEADING,
  EDITOR_COPY_LINK,
  EDITOR_EXPORT,
  EDITOR_IMPORT,
  EDITOR_IMPORT_FILE,
  EDITOR_IMPORT_HEADING,
  EDITOR_IMPORT_LABEL,
  EDITOR_LABEL,
  EDITOR_NEW,
  EDITOR_NODES_HEADING,
  EDITOR_PALETTE_LABEL,
  EDITOR_PANEL_GRAPH_HEADING,
  EDITOR_PANEL_LABEL,
  EDITOR_ROUTE_LABEL,
  EDITOR_ROUTE_PLACEHOLDER,
  EDITOR_SEARCH_LABEL,
  EDITOR_SEARCH_PLACEHOLDER,
  EDITOR_SELECT_HINT,
  EDITOR_SHARE_HEADING,
  EDITOR_TAGLINE,
  EDITOR_TITLE,
  EDITOR_TWIN_LINE,
  EDITOR_ZOOM_FIT,
  EDITOR_ZOOM_IN,
  EDITOR_ZOOM_OUT,
  NO_RESULTS,
} from "./copy.js";
import { escapeHtml } from "./md.js";
import { iconSvg } from "../../../../packages/look/icon-svg.js";
import type { Page } from "./layout.js";

/** One button of the toolbar: its action hook, its icon and its word. */
function tool(action: string, icon: Parameters<typeof iconSvg>[0], label: string): string {
  return `<button type="button" class="button" data-action="${action}">${iconSvg(icon)}<span>${escapeHtml(label)}</span></button>`;
}

function toolbar(): string {
  return [
    `<div class="editor-toolbar" role="toolbar" aria-label="${escapeHtml(EDITOR_LABEL)}">`,
    tool("new", "plus", EDITOR_NEW),
    tool("import", "folderOpen", EDITOR_IMPORT),
    tool("export", "arrowDown", EDITOR_EXPORT),
    tool("copy-link", "send", EDITOR_COPY_LINK),
    `<span class="editor-status" id="editor-status" role="status"></span>`,
    `</div>`,
    `<p class="editor-notice" id="editor-notice" role="status" hidden></p>`,
    `<ul class="editor-problems" id="editor-problems" hidden></ul>`,
  ].join("\n");
}

function importBox(): string {
  return [
    `<div class="editor-import" id="editor-import" hidden>`,
    `<h2 class="kicker">${escapeHtml(EDITOR_IMPORT_HEADING)}</h2>`,
    `<label class="sr-only" for="editor-import-text">${escapeHtml(EDITOR_IMPORT_LABEL)}</label>`,
    `<textarea id="editor-import-text" rows="6" spellcheck="false" autocomplete="off"></textarea>`,
    `<div class="editor-import-actions">`,
    `<label class="editor-file" for="editor-import-file">${iconSvg("folderOpen")}<span>${escapeHtml(EDITOR_IMPORT_FILE)}</span></label>`,
    `<input id="editor-import-file" type="file" accept=".json,application/json">`,
    `<button type="button" class="button" data-action="import-apply">${escapeHtml(EDITOR_APPLY)}</button>`,
    `<button type="button" class="button" data-action="import-cancel">${escapeHtml(EDITOR_CANCEL)}</button>`,
    `</div>`,
    `<p class="editor-import-error" id="editor-import-error" role="alert" hidden></p>`,
    `</div>`,
  ].join("\n");
}

/**
 * The kind glyph: the plate's own geometry, drawn small — the rounded
 * agent square, the check's square, the gate's rotated diamond (routers
 * draw as gates, exactly like the canvas draws them).
 */
function kindGlyph(kind: NodeKind): string {
  const geom = GEOM[shapeOfKind(kind)];
  const rotate = geom.rot === 0 ? "" : ` transform="rotate(${geom.rot})"`;
  const stroke = kind === "agent" ? ` style="stroke:var(--canopy,#00a9a0)"` : ` stroke="${PALETTE.gateStroke}"`;
  return (
    `<svg class="editor-glyph" viewBox="-4.4 -4.4 8.8 8.8" width="22" height="22" aria-hidden="true">` +
    `<rect x="${-geom.w / 2}" y="${-geom.h / 2}" width="${geom.w}" height="${geom.h}" rx="${geom.rx}"` +
    ` fill="${PALETTE.gateFill}"${stroke}${rotate}/>` +
    `</svg>`
  );
}

function blankButton(kind: NodeKind): string {
  return (
    `<button type="button" class="editor-kind" data-blank="${kind}">` +
    `${kindGlyph(kind)}<span>${kind}</span></button>`
  );
}

function palette(): string {
  return [
    `<aside class="editor-palette" aria-label="${escapeHtml(EDITOR_PALETTE_LABEL)}">`,
    `<h2 class="kicker">${escapeHtml(EDITOR_NODES_HEADING)}</h2>`,
    `<h3 class="kicker">${escapeHtml(EDITOR_BLANK_HEADING)}</h3>`,
    `<div class="editor-blank" role="group" aria-label="${escapeHtml(EDITOR_BLANK_HEADING)}">`,
    NODE_KINDS.map(blankButton).join(""),
    `</div>`,
    `<h3 class="kicker">${escapeHtml(EDITOR_CATALOGUE_HEADING)}</h3>`,
    `<form class="editor-search" role="search">`,
    `<label class="sr-only" for="editor-search">${escapeHtml(EDITOR_SEARCH_LABEL)}</label>`,
    `<input id="editor-search" type="search" placeholder="${escapeHtml(EDITOR_SEARCH_PLACEHOLDER)}" autocomplete="off">`,
    `<button type="submit" aria-label="${escapeHtml(EDITOR_SEARCH_LABEL)}">${iconSvg("search")}</button>`,
    `</form>`,
    `<p class="editor-results-empty" id="editor-results-empty" hidden>${escapeHtml(NO_RESULTS)}</p>`,
    `<ul class="editor-results" id="editor-results"></ul>`,
    `<p class="editor-palette-error" id="editor-palette-error" role="status" hidden></p>`,
    `</aside>`,
  ].join("\n");
}

function zoomControls(): string {
  return [
    `<div class="editor-zoom" role="group" aria-label="${escapeHtml(EDITOR_ZOOM_IN)}">`,
    `<button type="button" data-zoom="out" aria-label="${escapeHtml(EDITOR_ZOOM_OUT)}">${iconSvg("minus")}</button>`,
    `<button type="button" data-zoom="fit" aria-label="${escapeHtml(EDITOR_ZOOM_FIT)}">${iconSvg("circleDot")}</button>`,
    `<button type="button" data-zoom="in" aria-label="${escapeHtml(EDITOR_ZOOM_IN)}">${iconSvg("plus")}</button>`,
    `</div>`,
  ].join("\n");
}

function chooser(): string {
  return [
    `<div class="editor-chooser" id="editor-chooser" role="group" aria-label="${escapeHtml(EDITOR_CONDITION_HEADING)}" hidden>`,
    `<p class="editor-chooser-title">${escapeHtml(EDITOR_CONDITION_HEADING)}</p>`,
    `<div class="editor-chooser-row">`,
    `<button type="button" data-cond="pass">pass</button>`,
    `<button type="button" data-cond="fail">fail</button>`,
    `<button type="button" data-cond="always">always</button>`,
    `<span class="editor-chooser-route" id="editor-chooser-route" hidden>`,
    `<label class="sr-only" for="editor-route">${escapeHtml(EDITOR_ROUTE_LABEL)}</label>`,
    `<input id="editor-route" type="text" placeholder="${escapeHtml(EDITOR_ROUTE_PLACEHOLDER)}" autocomplete="off">`,
    `<button type="button" data-cond="route">route</button>`,
    `</span>`,
    `</div>`,
    `<button type="button" class="editor-chooser-cancel" data-cond="cancel">${escapeHtml(EDITOR_CANCEL)}</button>`,
    `</div>`,
  ].join("\n");
}

function stage(): string {
  return [
    `<div class="editor-stage" id="editor-stage">`,
    `<svg class="editor-svg" id="editor-canvas" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(EDITOR_CANVAS_LABEL)}"></svg>`,
    `<p class="editor-empty" id="editor-empty">${escapeHtml(EDITOR_CANVAS_EMPTY)}</p>`,
    zoomControls(),
    chooser(),
    `</div>`,
  ].join("\n");
}

function shareBlock(): string {
  return [
    `<section class="editor-share" id="editor-share" hidden>`,
    `<h2 class="kicker">${escapeHtml(EDITOR_SHARE_HEADING)}</h2>`,
    `<div id="editor-share-body"></div>`,
    `</section>`,
  ].join("\n");
}

/** The editor page: one h1, the toolbar over the three-pane body. */
export function editorPage(): Page {
  const html = [
    `<h1 class="index-title">${escapeHtml(EDITOR_TITLE)}</h1>`,
    `<p class="description">${escapeHtml(EDITOR_TAGLINE)}</p>`,
    `<div class="editor" id="editor">`,
    toolbar(),
    importBox(),
    `<div class="editor-body">`,
    palette(),
    stage(),
    `<aside class="editor-panel" id="editor-panel" aria-label="${escapeHtml(EDITOR_PANEL_LABEL)}">`,
    `<h2 class="kicker">${escapeHtml(EDITOR_PANEL_GRAPH_HEADING)}</h2>`,
    `<p class="editor-hint">${escapeHtml(EDITOR_SELECT_HINT)}</p>`,
    `</aside>`,
    `</div>`,
    shareBlock(),
    `</div>`,
  ].join("\n");
  return {
    title: EDITOR_TITLE,
    description: EDITOR_TAGLINE,
    html,
    markdown: [`# ${EDITOR_TITLE}`, ``, EDITOR_TAGLINE, ``, EDITOR_TWIN_LINE, ``].join("\n"),
    styles: ["/editor/editor.css"],
    scripts: ["/editor/editor.js"],
  };
}
