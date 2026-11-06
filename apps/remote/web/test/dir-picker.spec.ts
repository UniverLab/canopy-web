// SPDX-License-Identifier: Apache-2.0
// The New dialog's folder picker against the fake host: dir_list walks a
// small fixture tree at phone size, Use this folder fills the directory
// field, and the host's error and truncated notes stay inside the sheet.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function sentFrames(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => window.__fake.sent() as Record<string, unknown>[]);
}

async function dirLists(page: Page): Promise<Record<string, unknown>[]> {
  return (await sentFrames(page)).filter((frame) => frame.t === "dir_list");
}

async function openPicker(page: Page): Promise<void> {
  await page.locator("#session-new").click();
  await expect(page.locator("#new-form")).toBeVisible();
  await page.locator("#new-directory-browse").click();
  await expect(page.locator("#new-picker")).toBeVisible();
  await expect(page.locator(".dir-row-item").first()).toBeVisible();
}

test("browses down and up, picks a folder and creates the session there", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.evaluate(() => window.__fake.clearSent());
  await openPicker(page);

  // Home is /home/u: the first request carries no path, Recent offers the
  // catalog/session suggestions, and the hidden fixture stays hidden.
  const first = await dirLists(page);
  expect(first).toHaveLength(1);
  expect(first[0]?.path).toBeUndefined();
  expect(typeof first[0]?.req).toBe("string");
  await expect(page.locator("#dir-recent")).toBeVisible();
  await expect(page.locator(".dir-recent-item").first()).toContainText("/home/u/demo");
  await expect(page.locator('.dir-row-item[data-dir-path="/home/u/demo"]')).toBeVisible();
  await expect(page.locator('.dir-row-item[data-dir-path="/home/u/.config"]')).toHaveCount(0);
  await expect(page.locator("#dir-crumbs .dir-crumb").last()).toHaveText("u");

  // Down into demo, back up through .., then down again to pick it.
  await page.locator('.dir-row-item[data-dir-path="/home/u/demo"]').click();
  await expect(page.locator("#dir-crumbs .dir-crumb").last()).toHaveText("demo");
  await expect(page.locator('.dir-row-item[data-dir-path="/home/u/demo/src"]')).toBeVisible();
  await page.locator(".dir-up").click();
  await expect(page.locator("#dir-crumbs .dir-crumb").last()).toHaveText("u");
  await page.locator('.dir-row-item[data-dir-path="/home/u/demo"]').click();
  await expect(page.locator("#dir-use")).toHaveText("Use this folder · demo");
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  await page.locator("#dir-use").click();
  await expect(page.locator("#new-form")).toBeVisible();
  await expect(page.locator("#new-directory")).toHaveValue("/home/u/demo");
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator("#new-create").click();
  await expect(page.locator("main.session-view")).toBeVisible();
  const spawns = (await sentFrames(page)).filter((frame) => frame.t === "spawn");
  expect(spawns).toHaveLength(1);
  expect(spawns[0]).toMatchObject({ kind: "agent", cli: "muse", workdir: "/home/u/demo" });
});

test("keeps the host's error on the current folder and notes a truncated listing", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await openPicker(page);

  await page.locator('.dir-row-item[data-dir-path="/home/u/locked"]').click();
  await expect(page.locator("#dir-error")).toHaveText("permission denied");
  // The failed folder never became current: the breadcrumb and rows stay home.
  await expect(page.locator("#dir-crumbs .dir-crumb").last()).toHaveText("u");
  await expect(page.locator('.dir-row-item[data-dir-path="/home/u/demo"]')).toBeVisible();

  await page.locator('.dir-row-item[data-dir-path="/home/u/many"]').click();
  await expect(page.locator("#dir-error")).toBeHidden();
  await expect(page.locator("#dir-status")).toHaveText(
    "Showing the first 500 folders; filter or type the path.",
  );
  await expect(page.locator(".dir-row-item")).toHaveCount(500);
  await expect(page.locator('.dir-row-item[data-dir-path="/home/u/many/folder-000"]')).toBeVisible();
});

test("a host without dir_list keeps the plain directory field", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/fake.html?dirs=off");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator("#session-new").click();
  await expect(page.locator("#new-form")).toBeVisible();
  await expect(page.locator("#new-directory")).toBeVisible();
  await expect(page.locator("#new-directory-browse")).toHaveCount(0);
  await expect(page.locator("#new-picker")).toHaveCount(0);
  expect(await dirLists(page)).toHaveLength(0);
});
