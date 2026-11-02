// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// Audit finding U5 (2026-11-01, second pass): at devicePixelRatio 1
// (common desktop monitors) the WebGL backing store is the CSS size, so
// the default 14 px face rasterises a hyphen as a single ~1 device-px row
// and the composited terminal shows a whisper of it: VIA-TECLADO read as
// "VIA TECLADO". The fix renders DPR 1 sessions at the double source size
// (see terminal-font.ts) and lets the fit-to-width scale bring the visual
// size back down, so the compositor downsamples a ~2.6 px-thick stroke
// instead of displaying a thin one.
//
// The pixels are read from the composited screenshot, not from the canvas
// backing store: a canvas readback would show the stroke both before and
// after the fix (the glyph is drawn into the atlas either way), while
// what U5 broke is what reaches the screen after the GPU composite — and
// a screenshot IS the composited web page.
//
// Known headless limitation, out of scope like the DPR-3 case: WebGL
// canvas screenshots composite black at DPR 2+ inside this suite, so the
// pixel truth lives at DPR 1, the affected density. DPR 2+ renders keep
// the open size they had before (the unit tests pin the gate's constants).

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

// VIA-TECLADO sits at a known 80×24 cell: the line is cursor-addressed to
// 1-based row 12, col 25 — 0-based row 11, col 24 — on a cleared screen.
const LINE_ROW = 11;
// The V of the line: a letter cell for the ink-height reference. Three
// cells right (col 27) is the hyphen.
const V_COL = 24;
const HYPHEN_COL = 27;
// A full-block band below the line: customGlyphs draws U+2588
// full-bleed, so those cells hold nothing but true foreground ink
// grounded in the same palette the terminal paints with.
const BLOCK_ROW = 14;
const BLOCK_COL = 40;

interface Ink {
  /** Pixels at or past the foreground reference floor. */
  wrtForeground: number;
  /** The brightest pixel of the cell. */
  max: number;
}

interface Replay {
  imgW: number;
  imgH: number;
  cellW: number;
  cellH: number;
  background: number;
  block: number;
  vLetter: Ink;
  hyphen: Ink;
}

test("terminal_hyphens_visible_at_dpr1", async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await page.waitForFunction(() => (window.__fake.terminalText() || "").includes("hello from the host"));

  // This suite renders at DPR 1; the browser must agree.
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
  // The double-size gate engaged: 80 advances of the 28 px face measure
  // well past a 14 px raster (measured 1360 device px in the audit walk).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const canvas = document.querySelector(
          ".term-host canvas:not(.xterm-link-layer)",
        ) as HTMLCanvasElement | null;
        return canvas?.width ?? 0;
      }),
    )
    .toBeGreaterThanOrEqual(1300);
  // Cells measured on a fallback face would be meaningless: demand the
  // real face at the size the terminal opens with.
  expect(await page.evaluate(() => document.fonts.check('28px "JetBrains Mono"'))).toBe(true);

  // Clear, place VIA-TECLADO at the known cell, then a full-block band at
  // row 15 (1-based) for the foreground reference.
  await page.evaluate(() => window.__fake.pushOut("\x1b[2J\x1b[12;25HVIA-TECLADO\x1b[15;41H██████"));
  // The refit must have settled for the pushed frame before any pixels.
  await expect
    .poll(() =>
      page.evaluate(() => Number((document.querySelector(".term-fit") as HTMLElement).dataset.scale)),
    )
    .toBeGreaterThan(0);

  const box = await page.evaluate(() => {
    const screen = document.querySelector(".xterm-screen") as HTMLElement;
    const r = screen.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const shot = await page.screenshot({
    clip: { x: box.x, y: box.y, width: box.w, height: box.h },
  });

  const view = await page.evaluate(
    ({ dataUrl, lineRow, vCol, hyphenCol, blockRow, blockCol }) => {
      const img = new Image();
      const load = new Promise((ok, bad) => {
        img.onload = () => ok(null);
        img.onerror = () => bad(new Error("screenshot did not decode"));
      });
      img.src = dataUrl;
      return load.then(() => {
        const cv = document.createElement("canvas");
        cv.width = img.width;
        cv.height = img.height;
        const ctx = cv.getContext("2d") as CanvasRenderingContext2D;
        ctx.drawImage(img, 0, 0);
        const cellW = img.width / 80;
        const cellH = img.height / 24;
        // Luminance scan of one cell; `floor` turns it into a counter of
        // pixels at or past that brightness.
        const scan = (col: number, row: number, floor?: number): Ink => {
          const w = Math.round(cellW);
          const h = Math.round(cellH);
          const data = ctx.getImageData(Math.round(col * cellW), Math.round(row * cellH), w, h).data;
          let max = 0;
          let wrtForeground = 0;
          for (let p = 0; p < data.length; p += 4) {
            const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
            if (lum > max) {
              max = lum;
            }
            if (floor !== undefined && lum >= floor) {
              wrtForeground += 1;
            }
          }
          return { wrtForeground, max };
        };
        // The background ceiling: the max over several empty cells of the
        // cleared screen, so stray antialiasing never fakes a floor.
        const bgMax = Math.max(
          scan(10, lineRow).max,
          scan(45, lineRow - 2).max,
          scan(45, lineRow + 5).max,
        );
        // The foreground reference: true ink straight from the renderer's
        // own block elements, in the palette the terminal paints with.
        const blockMax = Math.max(
          scan(blockCol, blockRow).max,
          scan(blockCol + 1, blockRow).max,
          scan(blockCol + 2, blockRow).max,
        );
        // Foreground beyond background within a +-10% window: a pixel
        // counts when it comes within 10% of true ink, measured from the
        // real background the cell sits on.
        const floor = Math.round(bgMax + (blockMax - bgMax) * 0.9);
        return {
          imgW: img.width,
          imgH: img.height,
          cellW: Math.round(cellW * 100) / 100,
          cellH: Math.round(cellH * 100) / 100,
          background: bgMax,
          block: blockMax,
          vLetter: scan(vCol, lineRow),
          hyphen: scan(hyphenCol, lineRow, floor),
        };
      });
    },
    {
      dataUrl: "data:image/png;base64," + shot.toString("base64"),
      lineRow: LINE_ROW,
      vCol: V_COL,
      hyphenCol: HYPHEN_COL,
      blockRow: BLOCK_ROW,
      blockCol: BLOCK_COL,
    },
  ) as Replay;

  // Grid sanity: the composited screenshot is genuinely the 80×24 screen
  // box (clamp the 1 px rounding of a fractional clip).
  expect(Math.abs(view.imgW - box.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(view.imgH - box.h)).toBeLessThanOrEqual(1);

  // A clean background and true ink for the reference window.
  expect(view.background).toBeLessThanOrEqual(60);
  expect(view.block).toBeGreaterThanOrEqual(200);

  // The letter ink is real — a letter that failed the pipeline would make
  // a passing hyphen meaningless.
  expect(view.vLetter.max).toBeGreaterThan(view.background + (view.block - view.background) / 2);

  // THE U5 assertion: the hyphen's own cell contains foreground pixels
  // beyond the background, with the +-10% tolerance window: a stroke that
  // reads on screen instead of blending into the background. The audit's
  // vanished case left nothing past the floor.
  expect(view.hyphen.max).toBeGreaterThanOrEqual(
    view.background + (view.block - view.background) * 0.9,
  );
  expect(view.hyphen.wrtForeground).toBeGreaterThanOrEqual(3);
  // …and it is a stroke, not a cell-sized wall: a full block lights the
  // whole cell, while the hyphen's ink is its middle band only.
  expect(view.hyphen.wrtForeground).toBeLessThan(Math.round(view.cellW * view.cellH) * 0.35);
});
