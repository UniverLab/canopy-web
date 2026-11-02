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
  await expect(page.locator(".graph-row")).toHaveCount(2);
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
  await expect(page.locator(".graph-row")).toHaveCount(2);
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

test("footer_separators_stay_with_links: no wrapped line starts with · at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await expect(page.locator("#app > footer.look-colophon")).toBeVisible();
  // No separator hides inside an anchor, where it would underline.
  expect(await page.locator(".colophon-col a .colophon-sep").count()).toBe(0);
  await expect(page.locator(".colophon-col .colophon-link-unit")).toHaveCount(5);
  const report = await page.evaluate(() => {
    const units = [...document.querySelectorAll(".colophon-col .colophon-link-unit")];
    const rows = new Set(
      units.map((unit) => Math.round(unit.getBoundingClientRect().top)),
    );
    const seps = [...document.querySelectorAll(".colophon-col .colophon-sep")];
    // Every unit — including the last, separator-less one — starts with
    // its link and never breaks, so no wrapped line starts with ·.
    const unitChecks = units.map((unit) => {
      const link = unit.querySelector("a")?.getBoundingClientRect();
      return {
        startsWithLink: (link?.left ?? 1) <= unit.getBoundingClientRect().left + 1,
        nowrap: getComputedStyle(unit).whiteSpace === "nowrap",
      };
    });
    const checks = seps.map((sep) => {
      const box = sep.getBoundingClientRect();
      const unit = sep.parentElement;
      const anchor = unit?.querySelector("a") as Element;
      const link = anchor?.getBoundingClientRect();
      const mid = box.top + box.height / 2;
      const linkMid = (link?.top ?? 0) + (link?.height ?? 0) / 2;
      const sepStyle = getComputedStyle(sep);
      const linkStyle = getComputedStyle(anchor);
      return {
        // Outside the anchor, on its link's line, after its link's text.
        outsideAnchor: sep.closest("a") === null,
        sameLineAsLink: Math.abs(mid - linkMid) < 4,
        afterLink: box.left >= (link?.right ?? 0) - 1,
        notUnderlined: sepStyle.textDecorationLine === "none",
        // The kit's separator was the anchor's ::before: same face, same
        // size, so desktop widths render exactly as before.
        sameFontAsLink:
          sepStyle.fontFamily === linkStyle.fontFamily &&
          sepStyle.fontSize === linkStyle.fontSize,
      };
    });
    return {
      unitCount: units.length,
      rowCount: rows.size,
      sepCount: seps.length,
      unitChecks,
      checks,
    };
  });
  expect(report.unitCount).toBe(5);
  expect(report.sepCount).toBe(4);
  // The narrow viewport forces the wrap this test guards.
  expect(report.rowCount).toBeGreaterThan(1);
  for (const check of report.unitChecks) {
    expect(check).toEqual({ startsWithLink: true, nowrap: true });
  }
  for (const check of report.checks) {
    expect(check).toEqual({
      outsideAnchor: true,
      sameLineAsLink: true,
      afterLink: true,
      notUnderlined: true,
      sameFontAsLink: true,
    });
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
