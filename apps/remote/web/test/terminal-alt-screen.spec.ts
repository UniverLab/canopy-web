// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// Fullscreen (alternate-screen) TUIs must frame the whole screen instead
// of following the bottom: with a fullscreen harness the phone showed
// only rows 13–24 of 24 — the conversation painted above, the input box
// below — and the screen overflowed its panel on the right. The WebGL
// renderer has no .xterm-rows text, so visible rows are asserted through
// the fake host's buffer reads, never the DOM — while geometry proves
// nothing is clipped.
async function terminalText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

interface BufferState {
  type: string;
  rows: string[];
  viewportY: number;
  baseY: number;
}

async function bufferState(page: import("@playwright/test").Page): Promise<BufferState> {
  const state = await page.evaluate(() => window.__fake.bufferState?.() ?? null);
  if (!state) {
    throw new Error("no terminal buffer (xterm not open?)");
  }
  return state;
}

async function fitDataset(page: import("@playwright/test").Page): Promise<{ scale: number; buffer: string }> {
  return page.evaluate(() => {
    const fit = document.querySelector(".term-fit") as HTMLElement;
    return { scale: Number(fit.dataset.scale), buffer: fit.dataset.buffer ?? "" };
  });
}

interface AltGeometry {
  scale: number;
  expected: number;
  paneScrollX: number;
  paneScrollY: number;
  pageOverflow: number;
  scalerTop: number;
  scalerBottom: number;
  scalerLeft: number;
  scalerRight: number;
  contentTop: number;
  contentBottom: number;
  contentLeft: number;
  contentRight: number;
}

async function altGeometry(page: import("@playwright/test").Page): Promise<AltGeometry> {
  return page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    const fit = document.querySelector(".term-fit") as HTMLElement;
    const scaler = document.querySelector(".term-scale") as HTMLElement;
    const host = document.querySelector(".term-host") as HTMLElement;
    const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
    const content = (host.firstElementChild as HTMLElement | null) ?? host;
    const naturalW = screen && screen.scrollWidth > 0 ? screen.scrollWidth : content.scrollWidth;
    const naturalH = screen && screen.offsetHeight > 0 ? screen.offsetHeight : content.scrollHeight;
    const doc = document.scrollingElement ?? document.documentElement;
    const style = getComputedStyle(pane);
    const paneBox = pane.getBoundingClientRect();
    const scalerBox = scaler.getBoundingClientRect();
    return {
      scale: Number(fit.dataset.scale),
      expected: Math.min(fit.clientWidth / naturalW, fit.clientHeight / naturalH),
      paneScrollX: pane.scrollWidth - pane.clientWidth,
      paneScrollY: pane.scrollHeight - pane.clientHeight,
      pageOverflow: doc.scrollWidth - doc.clientWidth,
      scalerTop: scalerBox.top,
      scalerBottom: scalerBox.bottom,
      scalerLeft: scalerBox.left,
      scalerRight: scalerBox.right,
      contentTop: paneBox.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop),
      contentBottom:
        paneBox.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom),
      contentLeft: paneBox.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      contentRight:
        paneBox.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
});

for (const viewport of [
  // Landscape phone: the panel is short, so the height binds the fit.
  { label: "844x390", width: 844, height: 390 },
  // Portrait phone: width and height bind together.
  { label: "390x844", width: 390, height: 844 },
] as const) {
  test(`fullscreen_alt_frames_all_rows at ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => window.__fake.pushAltScreen?.());
    // The buffer switch lands through xterm's parse plus onBufferChange:
    // wait for the view to report the alternate buffer…
    await expect.poll(async () => (await fitDataset(page)).buffer).toBe("alternate");
    // …then for all 24 addressed rows to be painted into the viewport.
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.__fake.bufferState?.() ?? null);
        return state?.rows.filter((row) => row.includes("alt-row")).length ?? -1;
      })
      .toBe(24);
    const state = await bufferState(page);
    expect(state.type).toBe("alternate");
    expect(state.rows).toHaveLength(24);
    for (let n = 2; n <= 21; n += 1) {
      expect(state.rows[n - 1]).toContain(`alt-row ${String(n).padStart(2, "0")}`);
    }
    // The full 80-column row arrived intact (start label, end marker).
    expect(state.rows[11]).toContain("|END");
    expect(state.rows[11]?.trimEnd().length).toBe(80);
    // Follow is off while fullscreen: the latest button shows.
    await expect(page.locator("#term-latest")).toBeVisible();
    // The fitted scale is the whole-frame fit…
    await expect
      .poll(async () => {
        const settled = await altGeometry(page);
        return Math.abs(settled.scale - settled.expected);
      })
      .toBeLessThan(0.01);
    const measured = await altGeometry(page);
    expect(measured.scale).toBeCloseTo(measured.expected, 2);
    if (viewport.label === "844x390") {
      // The short panel binds the height here: the whole-frame fit must
      // sit strictly below the width-only fit, or the height term did no
      // work and this test is vacuous.
      const widthOnly = await page.evaluate(() => {
        const fit = document.querySelector(".term-fit") as HTMLElement;
        const host = document.querySelector(".term-host") as HTMLElement;
        const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
        const content = (host.firstElementChild as HTMLElement | null) ?? host;
        const naturalW = screen && screen.scrollWidth > 0 ? screen.scrollWidth : content.scrollWidth;
        return fit.clientWidth / naturalW;
      });
      expect(measured.scale).toBeLessThan(widthOnly - 0.01);
    }
    // …and the frame sits fully inside the pane: no pane scroll either
    // way, no page overflow, no clip on any edge — rows 02–21 are all
    // visible in the capture below.
    expect(measured.paneScrollX).toBeLessThanOrEqual(1);
    expect(measured.paneScrollY).toBeLessThanOrEqual(1);
    expect(measured.pageOverflow).toBeLessThanOrEqual(1);
    expect(measured.scalerLeft).toBeGreaterThanOrEqual(measured.contentLeft - 1);
    expect(measured.scalerRight).toBeLessThanOrEqual(measured.contentRight + 1);
    expect(measured.scalerTop).toBeGreaterThanOrEqual(measured.contentTop - 1);
    expect(measured.scalerBottom).toBeLessThanOrEqual(measured.contentBottom + 1);
    // The capture is the pane element itself, so all of rows 02–21 land in
    // one frame even when the page viewport is shorter than the pane.
    await page.locator(".term-pane").screenshot({ path: testInfo.outputPath(`alt-screen-${viewport.label}.png`) });
    // Leaving fullscreen resumes the width fit plus follow-bottom.
    await page.evaluate(() => window.__fake.exitAltScreen?.());
    await expect.poll(async () => (await fitDataset(page)).buffer).toBe("normal");
    await expect(page.locator("#term-latest")).toBeHidden();
  });
}

test("shell_output_still_follows_bottom", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const lines = Array.from(
    { length: 40 },
    (_, i) => `shell-${String(i + 1).padStart(2, "0")} · tail ${i + 1}`,
  );
  // Forty shell lines, the last without its newline so it sits on the
  // viewport's own last row when the tail is followed.
  await page.evaluate((rows: string[]) => {
    rows.slice(0, -1).forEach((row) => window.__fake.pushOut(`${row}\r\n`));
    window.__fake.pushOut(rows[rows.length - 1] ?? "");
  }, lines);
  await expect.poll(() => terminalText(page)).toContain("shell-40");
  // Null-safe while xterm is still behind the font gate: a throw here
  // would fail the poll instead of retrying it.
  await expect
    .poll(async () => {
      const state = await page.evaluate(() => window.__fake.bufferState?.() ?? null);
      return state?.rows[state.rows.length - 1] ?? "";
    })
    .toContain("shell-40");
  // Normal buffer, still following: no latest button, the viewport pinned
  // to the bottom, the last line on the last row — no shell regression.
  await expect.poll(async () => (await fitDataset(page)).buffer).toBe("normal");
  await expect(page.locator("#term-latest")).toBeHidden();
  const state = await bufferState(page);
  expect(state.type).toBe("normal");
  expect(state.viewportY).toBe(state.baseY);
  expect(state.rows[state.rows.length - 1]).toContain("shell-40");
  // The width fit is unchanged: scale is pane over screen width.
  const widthFit = await page.evaluate(() => {
    const fit = document.querySelector(".term-fit") as HTMLElement;
    const host = document.querySelector(".term-host") as HTMLElement;
    const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
    const content = (host.firstElementChild as HTMLElement | null) ?? host;
    const naturalW = screen && screen.scrollWidth > 0 ? screen.scrollWidth : content.scrollWidth;
    return { scale: Number(fit.dataset.scale), expected: fit.clientWidth / naturalW };
  });
  expect(widthFit.scale).toBeCloseTo(widthFit.expected, 2);
  await page.locator(".term-pane").screenshot({ path: testInfo.outputPath("shell-follow.png") });
});
