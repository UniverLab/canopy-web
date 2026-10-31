// Ported from harness-canopy src/shared/banner.rs (BANNER, BANNER_GRADIENT, gradient_rgb)
// SPDX-License-Identifier: Apache-2.0
/**
 * The house banner: Canopy in the DOS Rebel figlet font, one colour per
 * line over the TUI's five-stop teal gradient, light at the top to dark
 * at the bottom. The ten art lines are byte-identical to the `BANNER`
 * block `banner.rs` prints — trailing spaces included, never retyped.
 * Pair with banner.css; `npm run build:look` copies both into the apps.
 *
 * The header banners below are the same font rendered once with
 * figlet@1.5.0 (`textSync(word, { font: "DOS Rebel" })`), proven against
 * the canopy block (lines 1-9 reproduce byte-identical) and committed as
 * static art — no runtime figlet.
 */

/** The ten DOS Rebel art lines, exactly as `banner.rs` prints them. */
export const BANNER_LINES: readonly string[] = [
  "                                                     ",
  "  ██████   ██████   ████████    ██████  ████████  █████ ████",
  " ███░░███ ░░░░░███ ░░███░░███  ███░░███░░███░░███░░███ ░███ ",
  "░███ ░░░   ███████  ░███ ░███ ░███ ░███ ░███ ░███ ░███ ░███ ",
  "░███  ███ ███░░███  ░███ ░███ ░███ ░███ ░███ ░███ ░███ ░███ ",
  "░░██████ ░░████████ ████ █████░░██████  ░███████  ░░███████ ",
  " ░░░░░░   ░░░░░░░░ ░░░░ ░░░░░  ░░░░░░   ░███░░░    ░░░░░███ ",
  "                                        ░███       ███ ░███ ",
  "                                        █████     ░░██████  ",
  "                                       ░░░░░       ░░░░░░   ",
];

/**
 * The two header banners: "graphs" and "remote" in DOS Rebel, eleven
 * lines each, byte-identical to the generator — trailing spaces
 * included. Every graphs line carries ink; the remote's three trailing
 * blanks keep both headers on the one scale in banner.css.
 */
export const GRAPHS_BANNER_LINES: readonly string[] = [
  "                                        █████             ",
  "                                       ░░███              ",
  "  ███████ ████████   ██████   ████████  ░███████    █████ ",
  " ███░░███░░███░░███ ░░░░░███ ░░███░░███ ░███░░███  ███░░  ",
  "░███ ░███ ░███ ░░░   ███████  ░███ ░███ ░███ ░███ ░░█████ ",
  "░███ ░███ ░███      ███░░███  ░███ ░███ ░███ ░███  ░░░░███",
  "░░███████ █████    ░░████████ ░███████  ████ █████ ██████ ",
  " ░░░░░███░░░░░      ░░░░░░░░  ░███░░░  ░░░░ ░░░░░ ░░░░░░  ",
  " ███ ░███                     ░███                        ",
  "░░██████                      █████                       ",
  " ░░░░░░                      ░░░░░                        ",
];

export const REMOTE_BANNER_LINES: readonly string[] = [
  "                                              █████            ",
  "                                             ░░███             ",
  " ████████   ██████  █████████████    ██████  ███████    ██████ ",
  "░░███░░███ ███░░███░░███░░███░░███  ███░░███░░░███░    ███░░███",
  " ░███ ░░░ ░███████  ░███ ░███ ░███ ░███ ░███  ░███    ░███████ ",
  " ░███     ░███░░░   ░███ ░███ ░███ ░███ ░███  ░███ ███░███░░░  ",
  " █████    ░░██████  █████░███ █████░░██████   ░░█████ ░░██████ ",
  "░░░░░      ░░░░░░  ░░░░░ ░░░ ░░░░░  ░░░░░░     ░░░░░   ░░░░░░  ",
  "                                                               ",
  "                                                               ",
  "                                                               ",
];

/**
 * The five legible Canopy scale stops, light at the top of the banner
 * to dark at the bottom. `#003330` (the darkest stop) is excluded: it
 * is a background tone only, never banner ink.
 */
export const BANNER_GRADIENT: readonly string[] = [
  "#52fff6",
  "#1ffff3",
  "#00e0d4",
  "#00a9a0",
  "#006661",
];

/**
 * The colour of art line `index` in a `count`-line banner: an exact port
 * of `gradient_rgb` — `round(index / count * 4)` over the five stops, so
 * the ten-line canopy banner runs stops [0,0,1,1,2,2,2,3,3,4] and the
 * eleven-line headers [0,0,1,1,1,2,2,3,3,3,4]. The default count is the
 * house banner's ten lines, spelled as a number rather than
 * `BANNER_LINES.length` so an app that never draws the house banner
 * tree-shakes its art out of its bundle.
 */
export function bannerColor(index: number, count = 10): string {
  const stop = Math.min(4, Math.round((index / count) * 4));
  return BANNER_GRADIENT[stop] ?? "#52fff6";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Draw art lines as one inline SVG on a fixed cell grid — one terminal
 * cell per character, 1 wide and 2 tall like the TUI's own cells, `█` a
 * full cell, `░` the same fill at 35% opacity (the TUI's shade), a space
 * nothing — so the banner never depends on a font: no fallback advances,
 * no line box, no gaps between rows. Adjacent cells of one kind merge
 * into one rect, which keeps the graphs banner under 6 KB. Each line is
 * a `<g class="look-banner-line">` filled with its `BANNER_GRADIENT`
 * stop, as a presentation attribute: presentation attributes sit outside
 * the style directives entirely, so the ink survives whatever the relay's
 * CSP allows xterm. The class and the accessible name are the caller's
 * own constants; an unnamed art is decorative and hidden from assistive
 * tech. banner.css sizes the SVG; `viewBox` keeps the 1:2 cells.
 */
export function bannerSvg(lines: readonly string[], className: string, label?: string): string {
  const width = Math.max(1, ...lines.map((line) => line.length));
  const height = (lines.length || 1) * 2;
  const art = lines
    .map((line, y) => {
      // Runs only: a replace would leave the art's own spaces behind as
      // text nodes between the rects, so the matches build the row alone.
      let rects = "";
      for (const run of line.matchAll(/█+|░+/g)) {
        rects +=
          `<rect x="${run.index}" y="${y * 2}" width="${run[0].length}" height="2"` +
          `${run[0][0] === "░" ? ' fill-opacity=".35"' : ""}/>`;
      }
      return `<g class="look-banner-line" fill="${bannerColor(y, lines.length)}">${rects}</g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" class="${className}"${label === undefined ? ` aria-hidden="true"` : ` role="img" aria-label="${label}"`}>${art}</svg>`;
}

/** The apps that wear the banner: the word under the art. */
export type BannerApp = "remote" | "graphs";

/**
 * Render the banner: the ten art lines as an SVG hidden from assistive
 * tech, a visually hidden "Canopy" for readers, and the app name in the
 * mono face, as the TUI prints its title. banner.css paints the app word
 * (`#52fff6`); no style attribute, so the remote's CSP stays happy.
 */
export function renderBanner(app: BannerApp): string {
  return [
    `<div class="look-banner">`,
    bannerSvg(BANNER_LINES, "look-banner-art"),
    `<span class="look-banner-vh">Canopy</span>`,
    `<p class="look-banner-app">${escapeHtml(app)}</p>`,
    `</div>`,
    ``,
  ].join("\n");
}

/**
 * Render the header banner: the app's own DOS Rebel art as an SVG with
 * the app's accessible name, one `<g class="look-banner-line">` per line.
 * banner.css sets each class's width (160 px tall on desktop, 96 px on a
 * phone) and keeps the 1:2 terminal cells; the wrapping link or button
 * carries the home label. An app that needs only its own art (the remote, whose
 * bundle budget is tight) can call `bannerSvg` with its lines directly:
 * anything this function references ships in the importing bundle.
 */
export function renderHeaderBanner(app: BannerApp): string {
  const lines = app === "graphs" ? GRAPHS_BANNER_LINES : REMOTE_BANNER_LINES;
  return bannerSvg(lines, `look-banner-header look-banner-header-${app}`, `Canopy ${app}`);
}
