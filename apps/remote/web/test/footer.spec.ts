// SPDX-License-Identifier: Apache-2.0
// Every remote view ends in the UniverLab footer: the sessions home (both
// tabs), the session shell, the graph and SysInfo views, and the guest
// list and session. The footer sits at the end of the scroll — after the
// main in the DOM and below it on the page — so it never overlays the
// terminal, the key bar, the composer or the session list, and the
// terminal keeps its size. Phone assertions run at 390 px, the reference
// width, with no sideways scroll.
import { expect, test, type Page } from "@playwright/test";

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

/** The one footer: #app's child directly after the main, naming the product. */
async function expectFooterAfterMain(page: Page): Promise<void> {
  const footer = page.locator("#app > footer.look-colophon");
  await expect(footer).toHaveCount(1);
  await expect(footer).toContainText("Canopy remote");
  const order = await page.evaluate(() => {
    const foot = document.querySelector("#app > footer.look-colophon");
    return foot?.previousElementSibling?.tagName ?? null;
  });
  expect(order).toBe("MAIN");
}

interface VBox {
  top: number;
  bottom: number;
}

/** Page-coordinate vertical boxes; null when the selector is missing. */
async function vboxes(page: Page, selectors: string[]): Promise<(VBox | null)[]> {
  return page.evaluate((sels: string[]) =>
    sels.map((sel) => {
      const el = document.querySelector(sel);
      if (!el) {
        return null;
      }
      const box = el.getBoundingClientRect();
      return { top: box.top + window.scrollY, bottom: box.bottom + window.scrollY };
    }),
  selectors);
}

test("ends the sessions home, both tabs, in the footer at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.locator('[data-tab="graphs"]').click();
  await expect(page.locator(".graph-row")).toHaveCount(3);
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("keeps the session's terminal, key bar and composer above the footer at 390x844", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  // The key bar is hidden under a fine pointer by default: show it so its
  // box sits in the terminal → key bar → composer order below.
  if (!(await page.locator("#keybar").isVisible())) {
    await page.locator("#term-keys").click();
  }
  await expectFooterAfterMain(page);
  // Top to bottom: terminal, key bar, composer, then the footer — the
  // footer never overlays any of them, and the terminal keeps its height.
  const [term, keys, composer, footer] = await vboxes(page, [
    "#term-pane",
    "#keybar",
    ".composer",
    "footer.look-colophon",
  ]);
  expect(term).not.toBeNull();
  expect(keys).not.toBeNull();
  expect(composer).not.toBeNull();
  expect(footer).not.toBeNull();
  expect(term!.bottom).toBeLessThanOrEqual(keys!.top + 1);
  expect(keys!.bottom).toBeLessThanOrEqual(composer!.top + 1);
  expect(composer!.bottom).toBeLessThanOrEqual(footer!.top + 1);
  expect(term!.bottom - term!.top).toBeGreaterThan(200);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("ends the graph and SysInfo views in the footer at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await page.locator('[data-tab="graphs"]').click();
  await expect(page.locator(".graph-row")).toHaveCount(3);
  await page.locator('[data-graph="g-loop"]').click();
  await expect(page.locator("main.graph-view")).toBeVisible();
  await expect(page.locator("#graph-stage .plate-svg")).toBeVisible();
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.locator("#graph-back").click();
  await page.locator('[data-tab="sessions"]').click();
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator("#metrics-strip").click();
  await expect(page.locator("main.metrics-view")).toBeVisible();
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

test("footer_separators_are_gone: no dangling middot at a wrapped line edge at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await expect(page.locator("#app > footer.look-colophon")).toBeVisible();
  const report = await page.evaluate(() => {
    const nav = document.querySelector("#app > footer.look-colophon .colophon-col");
    if (nav === null) {
      throw new Error("footer link row missing");
    }
    const links = [...nav.querySelectorAll("a")];
    const tops: number[] = [];
    const rows: string[][] = [];
    for (const link of links) {
      const top = Math.round(link.getBoundingClientRect().top);
      let row = tops.findIndex((value) => Math.abs(value - top) <= 1);
      if (row === -1) {
        row = tops.push(top) - 1;
      }
      (rows[row] ??= []).push(link.textContent ?? "");
    }
    // The kit paints the separator as a + a::before; the remote overrides
    // it, so no generated middot can lead a wrapped line either.
    const generated = links.flatMap((link) =>
      ["::before", "::after"].map((pseudo) => getComputedStyle(link, pseudo).content),
    );
    return {
      linkCount: links.length,
      spanCount: nav.querySelectorAll("span").length,
      middotInText: (nav.textContent ?? "").includes("·"),
      generated,
      rowCount: rows.length,
      rows,
      columnGap: parseFloat(getComputedStyle(nav).columnGap),
      rootSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });
  expect(report.linkCount).toBe(5);
  expect(report.spanCount).toBe(0);
  expect(report.middotInText).toBe(false);
  for (const content of report.generated) {
    expect(content).not.toContain("·");
  }
  // 2 × 0.75em × the 1.15rem link face: the old whitespace rhythm, now
  // carried by the flex gap.
  expect(report.columnGap).toBeCloseTo(1.725 * report.rootSize, 1);
  // The narrow viewport forces the wrap this test guards.
  expect(report.rowCount).toBeGreaterThan(1);
  for (const row of report.rows) {
    expect(row[0]?.startsWith("·")).toBe(false);
    expect(row[row.length - 1]?.endsWith("·")).toBe(false);
  }
});

test("footer_links_use_palette: links wear --teal at >= 4.5:1", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html?screen=signin");
  await expect(
    page.locator('.signin a[href="https://univerlab.org/privacy/"]'),
  ).toBeVisible();
  const report = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--teal)";
    document.body.append(probe);
    const tokenColor = getComputedStyle(probe).color;
    probe.remove();
    const parse = (color: string): [number, number, number] => {
      const match = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
      return [match[0] ?? 0, match[1] ?? 0, match[2] ?? 0];
    };
    const luminance = (rgb: [number, number, number]): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
    };
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const pageBg = getComputedStyle(document.body).backgroundColor;
    const footer = document.querySelector("#app > footer.look-colophon");
    const footerBg = getComputedStyle(footer as Element).backgroundColor;
    const links = [
      ...document.querySelectorAll(
        "main.signin a, #app > footer.look-colophon .colophon-col a, #app > footer.look-colophon .colophon-credits a",
      ),
    ].map((link) => {
      const color = getComputedStyle(link).color;
      const bg = link.closest("footer") ? footerBg : pageBg;
      return { label: link.textContent, color, bg, ratio: ratio(color, bg) };
    });
    return {
      token: getComputedStyle(document.documentElement).getPropertyValue("--teal").trim(),
      tokenColor,
      pageBg,
      links,
    };
  });
  expect(report.token).toBe("#3fb8b0");
  // The floor is measured against the page background, #011d1c.
  expect(report.pageBg).toBe("rgb(1, 29, 28)");
  expect(report.links.length).toBeGreaterThanOrEqual(6);
  for (const link of report.links) {
    expect(link.color, link.label ?? "?").toBe(report.tokenColor);
    expect(link.ratio, link.label ?? "?").toBeGreaterThanOrEqual(4.5);
  }
});

test("ends the guest list and session in the footer at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html?screen=guest");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await expectFooterAfterMain(page);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-pane .xterm-screen")).toBeVisible();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
  await expectFooterAfterMain(page);
  const [term, keys, composer, footer] = await vboxes(page, [
    "#term-pane",
    "#keybar",
    ".composer",
    "footer.look-colophon",
  ]);
  expect(term).not.toBeNull();
  expect(footer).not.toBeNull();
  expect(term!.bottom).toBeLessThanOrEqual(keys!.top + 1);
  expect(composer!.bottom).toBeLessThanOrEqual(footer!.top + 1);
  expect(term!.bottom - term!.top).toBeGreaterThan(200);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});
