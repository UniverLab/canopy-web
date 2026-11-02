// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// Audit E8 (2026-11-01, second pass): on desktop the account chip sat glued
// to the logo instead of sharing the header content container's alignment.
// The hosts screen is the single-row, account-last header (no host chip,
// no Disconnect), the same opening the sign-out walk uses.

test("account_chip_aligns_with_header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/fake.html?screen=hosts");
  await expect(page.locator("#host-list")).toBeVisible();
  await expect(page.locator(".topbar #account")).toBeVisible();
  // Box widths depend on the loaded mono face (graphs visual.spec.ts).
  await page.evaluate(() => document.fonts.ready);

  // Premise: the hosts header is a single row with the account trailing.
  await expect(page.locator(".topbar #conn-disconnect")).toHaveCount(0);
  await expect(page.locator(".topbar #metrics-strip")).toHaveCount(0);

  const measured = await page.evaluate(() => {
    const inner = document.querySelector(".topbar-inner") as HTMLElement;
    const account = document.querySelector(".topbar #account") as HTMLElement;
    const logo = document.querySelector(".topbar #brand-home") as HTMLElement;
    const innerBox = inner.getBoundingClientRect();
    const chipBox = account.getBoundingClientRect();
    const logoBox = logo.getBoundingClientRect();
    const style = getComputedStyle(inner);
    return {
      inner: { left: innerBox.left, right: innerBox.right, top: innerBox.top, bottom: innerBox.bottom },
      chip: { left: chipBox.left, right: chipBox.right, top: chipBox.top, bottom: chipBox.bottom },
      logo: { left: logoBox.left, right: logoBox.right, top: logoBox.top, bottom: logoBox.bottom },
      padRight: parseFloat(style.paddingRight),
      padLeft: parseFloat(style.paddingLeft),
      columnGap: parseFloat(style.columnGap),
    };
  });
  process.stdout.write(`account-chip boxes at 1280x800: ${JSON.stringify(measured)}\n`);

  // Same vertical center as the header row: no floating at half height.
  const innerCenterY = (measured.inner.top + measured.inner.bottom) / 2;
  const chipCenterY = (measured.chip.top + measured.chip.bottom) / 2;
  expect(Math.abs(chipCenterY - innerCenterY)).toBeLessThanOrEqual(2);

  // Fully inside the content max-width container (.topbar-inner).
  expect(measured.chip.left).toBeGreaterThanOrEqual(measured.inner.left - 1);
  expect(measured.chip.right).toBeLessThanOrEqual(measured.inner.right + 1);
  expect(measured.chip.top).toBeGreaterThanOrEqual(measured.inner.top - 1);
  expect(measured.chip.bottom).toBeLessThanOrEqual(measured.inner.bottom + 1);

  // No intersection with the logo box.
  const intersects =
    measured.chip.left < measured.logo.right &&
    measured.chip.right > measured.logo.left &&
    measured.chip.top < measured.logo.bottom &&
    measured.chip.bottom > measured.logo.top;
  expect(intersects).toBe(false);

  // The E8 guard: flexed against the content end, not glued to the logo.
  const contentRight = measured.inner.right - measured.padRight;
  expect(Math.abs(contentRight - measured.chip.right)).toBeLessThanOrEqual(2);
  expect(measured.chip.left - measured.logo.right).toBeGreaterThanOrEqual(
    measured.columnGap - 1,
  );
});
