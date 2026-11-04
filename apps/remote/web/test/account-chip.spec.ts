// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// The hosts header stacks at every width (banner.css): the banner centred
// on its own row, the account chip in the centred row below. The hosts
// screen is the account-only header (no host chip, no Disconnect), the
// same opening the sign-out walk uses.

test("account_chip_aligns_with_header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/fake.html?screen=hosts");
  await expect(page.locator("#host-list")).toBeVisible();
  await expect(page.locator(".topbar #account")).toBeVisible();
  // Box widths depend on the loaded mono face (graphs visual.spec.ts).
  await page.evaluate(() => document.fonts.ready);

  // Premise: the hosts header carries the account alone below the banner.
  await expect(page.locator(".topbar #conn-disconnect")).toHaveCount(0);
  await expect(page.locator(".topbar #metrics-strip")).toHaveCount(0);

  const measured = await page.evaluate(() => {
    const inner = document.querySelector(".topbar-inner") as HTMLElement;
    const account = document.querySelector(".topbar #account") as HTMLElement;
    const banner = document.querySelector(".topbar .look-banner-header") as HTMLElement;
    const innerBox = inner.getBoundingClientRect();
    const chipBox = account.getBoundingClientRect();
    const bannerBox = banner.getBoundingClientRect();
    return {
      view: window.innerWidth,
      inner: { left: innerBox.left, right: innerBox.right, top: innerBox.top, bottom: innerBox.bottom },
      chip: { left: chipBox.left, right: chipBox.right, top: chipBox.top, bottom: chipBox.bottom },
      banner: {
        center: bannerBox.left + bannerBox.width / 2,
        bottom: bannerBox.bottom,
      },
    };
  });
  process.stdout.write(`account-chip boxes at 1280x800: ${JSON.stringify(measured)}\n`);

  // Row 1: the banner sits on the viewport's centre line.
  expect(Math.abs(measured.banner.center - measured.view / 2)).toBeLessThanOrEqual(3);
  // Row 2: the account starts below the banner, centred on the same line.
  const chipCenter = (measured.chip.left + measured.chip.right) / 2;
  expect(measured.chip.top).toBeGreaterThanOrEqual(measured.banner.bottom);
  expect(Math.abs(chipCenter - measured.view / 2)).toBeLessThanOrEqual(4);

  // Fully inside the content max-width container (.topbar-inner).
  expect(measured.chip.left).toBeGreaterThanOrEqual(measured.inner.left - 1);
  expect(measured.chip.right).toBeLessThanOrEqual(measured.inner.right + 1);
  expect(measured.chip.top).toBeGreaterThanOrEqual(measured.inner.top - 1);
  expect(measured.chip.bottom).toBeLessThanOrEqual(measured.inner.bottom + 1);
});
