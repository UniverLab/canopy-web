// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { pdfFixture, textFixture, zipFixture } from "./fixtures/upload-files.js";
import type { UploadFixture } from "./fixtures/upload-files.js";

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

async function openSession(page: Page, search = ""): Promise<void> {
  await page.goto(`/fake.html${search}`);
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
}

function upload(page: Page, fixtures: UploadFixture[]): Promise<void> {
  return page
    .locator("#upload-input")
    .setInputFiles(fixtures.map((file) => ({ name: file.name, mimeType: file.mimeType, buffer: file.buffer })))
    .then(() => undefined);
}

test("uploads txt, pdf and zip and downloads the same bytes", async ({ page }) => {
  await openSession(page);
  await expect(page.locator("#term-attach")).toBeVisible();

  const fixtures = [textFixture(), pdfFixture(), zipFixture()];
  await upload(page, fixtures);

  await expect
    .poll(() =>
      page.evaluate(
        () => (window.__fake.sent() as { t?: string }[]).filter((frame) => frame.t === "shelf_put_end").length,
      ),
    )
    .toBe(fixtures.length);
  await expect(page.locator(".upload-attach")).toHaveCount(fixtures.length);

  // The Attach chip types the host's path as input bytes, then goes.
  const chip = page.locator(".upload-attach", { hasText: "notes.txt" });
  await chip.click();
  const typed = await page.evaluate(() => {
    const frames = window.__fake.sent() as { t?: string; data?: string }[];
    const input = [...frames].reverse().find((frame) => frame.t === "input");
    return input?.data === undefined ? "" : atob(input.data);
  });
  expect(typed).toBe("Attachment: /home/u/demo/notes.txt");
  await expect(chip).toHaveCount(0);

  await page.locator("#session-files").click();
  await expect(page.locator(".shelf-section-title").first()).toHaveText("From agent");
  await expect(page.locator(".shelf-section-title").nth(1)).toHaveText("Yours");
  const yours = page.locator(".shelf-section", { hasText: "Yours" });

  for (const fixture of fixtures) {
    const cell = yours.locator(`.shelf-cell[title="${fixture.name}"]`);
    await expect(cell).toBeVisible();
    const item = cell.locator("xpath=..");
    const download = item.locator(".shelf-download");
    // The bytes may still be in transit: the link fetches on the tap.
    const event = page.waitForEvent("download");
    await download.click();
    const saved = await event;
    const path = await saved.path();
    expect(path).not.toBeNull();
    expect(readFileSync(path as string).equals(fixture.buffer)).toBe(true);
    await expect(download).toHaveAttribute("href", /^blob:/);
  }
});

test("refuses a 25 MiB upload before any data flows", async ({ page }) => {
  await openSession(page);
  await upload(page, [
    { name: "huge.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(25 * 1024 * 1024) },
  ]);
  const error = page.locator(".upload-error");
  await expect(error).toContainText("huge.bin");
  await expect(error).toContainText("too_large");
  const parts = await page.evaluate(
    () => (window.__fake.sent() as { t?: string }[]).filter((frame) => frame.t === "shelf_put_part").length,
  );
  expect(parts).toBe(0);
});

test("a guest without upload sees the forbidden message", async ({ page }) => {
  await openSession(page, "?upload=denied");
  await expect(page.locator("#term-attach")).toBeVisible();
  await upload(page, [textFixture()]);
  const error = page.locator(".upload-error");
  await expect(error).toContainText("notes.txt");
  await expect(error).toContainText("forbidden");
});

test("a hello without shelf_upload renders no paperclip", async ({ page }) => {
  await openSession(page, "?upload=off");
  await expect(page.locator("#term-attach")).toHaveCount(0);
  await expect(page.locator("#upload-input")).toHaveCount(0);
});
