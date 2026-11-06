// SPDX-License-Identifier: Apache-2.0
// Resuming a recorded conversation from the New dialog, against the fake
// host: with "session_resume" in hello the Agent kind gains a New/Resume
// control, Resume filters the host's three fixtures and a tap sends
// session_resume, whose spawned lands the session. The empty history, a
// refused history (message + Retry) and a host without the feature (no
// control at all) are the other three states.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function sentFrames(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => window.__fake.sent() as Record<string, unknown>[]);
}

const newDialog = (page: Page) => page.locator("#new-form");
const resumeRows = (page: Page) => page.locator("#resume-list .resume-row");

test("resumes a fixture and lands in its session", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator("#session-new").click();
  await expect(newDialog(page)).toBeVisible();
  // New is the default, and Resume is offered beside it.
  await expect(page.locator("#new-mode-new")).toBeChecked();
  await expect(page.locator("#new-mode-resume")).toBeVisible();
  await page.locator("#new-mode-resume").check();
  // Entering Resume sends resumable_list and shows the host's three rows,
  // newest first, the third being the folder's latest without a transcript.
  await expect(resumeRows(page)).toHaveCount(3);
  await expect(resumeRows(page).nth(0)).toContainText("refactor the parser");
  await expect(resumeRows(page).nth(0)).toContainText("muse · demo · ");
  await expect(resumeRows(page).nth(0)).toContainText("ago");
  await expect(resumeRows(page).nth(2)).toContainText("latest in this folder");
  // The spawn fields are gone; only the filter and the list remain.
  await expect(page.locator("#new-cli")).toHaveCount(0);
  await expect(page.locator("#new-directory")).toHaveCount(0);
  await expect(page.locator("#new-create")).toHaveCount(0);
  const rowBox = await resumeRows(page).nth(0).boundingBox();
  expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const listed = (await sentFrames(page)).filter((frame) => frame.t === "resumable_list");
  expect(listed).toHaveLength(1);
  expect(typeof listed[0]?.req).toBe("string");

  // The filter matches the harness, case-insensitively.
  await page.locator("#resume-filter").fill("CLAUDE");
  await expect(resumeRows(page)).toHaveCount(1);
  await expect(resumeRows(page).nth(0)).toContainText("docs pass");
  await page.locator("#resume-filter").fill("");
  await expect(resumeRows(page)).toHaveCount(3);

  await page.evaluate(() => window.__fake.clearSent());
  await page.locator('.resume-row[data-resume-id="past-muse"]').click();
  const resumed = (await sentFrames(page)).filter((frame) => frame.t === "session_resume");
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toMatchObject({ t: "session_resume", id: "past-muse" });
  // The spawned opens the session through the spawn path.
  await expect(page.locator("main.session-view")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fake.terminalText())).toContain(
    "hello from the host",
  );
  await page.locator("#session-back").click();
  await expect(page.locator('[data-session="past-muse"]')).toBeVisible();
});

test("a host with no history says so", async ({ page }) => {
  await page.goto("/fake.html?resume=empty");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator("#session-new").click();
  await page.locator("#new-mode-resume").check();
  await expect(resumeRows(page)).toHaveCount(0);
  await expect(page.locator("#resume-status")).toHaveText("No past sessions to resume.");
});

test("a refused history shows the host's message with a Retry", async ({ page }) => {
  await page.goto("/fake.html?resume=error");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator("#session-new").click();
  await page.locator("#new-mode-resume").check();
  await expect(page.locator("#resume-error")).toBeVisible();
  await expect(page.locator("#resume-error-text")).toHaveText("could not read the host's history");
  await expect(page.locator("#resume-retry")).toBeVisible();
  // Retry asks the host again, and the dialog stays on Resume.
  await page.locator("#resume-retry").click();
  await expect
    .poll(async () => (await sentFrames(page)).filter((frame) => frame.t === "resumable_list").length)
    .toBe(2);
  await expect(page.locator("#new-form")).toBeVisible();
});

test("a host without the feature changes nothing", async ({ page }) => {
  await page.goto("/fake.html?resume=off");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator("#session-new").click();
  await expect(newDialog(page)).toBeVisible();
  // The whole segmented control is absent: no New, no Resume.
  await expect(page.locator("#new-mode-new")).toHaveCount(0);
  await expect(page.locator("#new-mode-resume")).toHaveCount(0);
  // The spawn form is exactly the old one.
  await expect(page.locator("#new-cli")).toBeVisible();
  await expect(page.locator("#new-directory")).toBeVisible();
  await expect(page.locator("#new-create")).toBeVisible();
});
