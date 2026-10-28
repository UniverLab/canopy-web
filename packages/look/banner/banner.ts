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
 * eleven-line headers [0,0,1,1,1,2,2,3,3,3,4].
 */
export function bannerColor(index: number, count: number = BANNER_LINES.length): string {
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

/** The apps that wear the banner: the word under the art. */
export type BannerApp = "remote" | "graphs";

/**
 * Render the banner: the ten art lines in a `pre` hidden from assistive
 * tech (one colour per line, in the lightest stop's company only for
 * the app word), a visually hidden "Canopy" for readers, and the app
 * name in the mono face, as the TUI prints its title.
 */
export function renderBanner(app: BannerApp): string {
  const art = BANNER_LINES.map(
    (line, index) => `<span style="color:${bannerColor(index)}">${escapeHtml(line)}</span>`,
  ).join("\n");
  return [
    `<div class="look-banner">`,
    `<pre class="look-banner-art" aria-hidden="true">${art}</pre>`,
    `<span class="look-banner-vh">Canopy</span>`,
    `<p class="look-banner-app" style="color:#52fff6">${escapeHtml(app)}</p>`,
    `</div>`,
    ``,
  ].join("\n");
}

/**
 * Render the header banner: the app's own DOS Rebel art in a `pre`
 * hidden from assistive tech, one span per line. banner.css paints the
 * lines with the teal gradient, never a style attribute: the remote's
 * CSP refuses inline styles. The header link around it carries the
 * app's accessible name.
 */
export function renderHeaderBanner(app: BannerApp): string {
  const lines = app === "graphs" ? GRAPHS_BANNER_LINES : REMOTE_BANNER_LINES;
  const art = lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("\n");
  return `<pre class="look-banner-header" aria-hidden="true">${art}</pre>`;
}
