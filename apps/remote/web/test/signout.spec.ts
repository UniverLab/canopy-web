// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// The sign-out walk and the edge-to-edge colophon, through the fake host's
// ?screen= openings (hosts for the walk, sign-in for the band).

test("sign out from the hosts screen lands on sign-in", async ({ page }) => {
  await page.route("**/auth/logout", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
  );
  await page.goto("/fake.html?screen=hosts");
  const button = page.locator("#signout");
  await expect(button).toBeVisible();
  await expect(button).toContainText("Sign out smoke");
  await button.click();
  await expect(page.locator("main.signin")).toBeVisible();
  await expect(page.locator("#signin-go")).toBeVisible();
  // Signed out: no account menu, no direct control left behind.
  await expect(page.locator("#account")).toHaveCount(0);
  await expect(page.locator("#signout")).toHaveCount(0);
});

test("a refused sign-out stays signed in with an inline error", async ({ page }) => {
  await page.route("**/auth/logout", (route) => route.abort("failed"));
  await page.goto("/fake.html?screen=hosts");
  await page.locator("#signout").click();
  await expect(page.locator("#signout-error")).toHaveText("Could not reach the relay");
  await expect(page.locator("main.hosts")).toBeVisible();
  await expect(page.locator("#account")).toBeVisible();
});

for (const viewport of [
  { label: "390x844", width: 390, height: 844 },
  { label: "1280x900", width: 1280, height: 900 },
] as const) {
  test(`the colophon runs edge to edge at ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/fake.html?screen=signin");
    await expect(page.locator("main.signin")).toBeVisible();
    const measured = await page.evaluate(() => {
      const footer = document.querySelector("footer.look-colophon") as HTMLElement;
      const box = footer.getBoundingClientRect();
      const style = getComputedStyle(footer);
      const el = document.scrollingElement ?? document.documentElement;
      return {
        x: box.x,
        width: box.width,
        viewport: window.innerWidth,
        radius: style.borderRadius,
        marginLeft: style.marginLeft,
        marginRight: style.marginRight,
        horizontal: el.scrollWidth - el.clientWidth,
      };
    });
    // The band spans the viewport with no side margins and no rounded box.
    expect(measured.viewport).toBe(viewport.width);
    expect(Math.abs(measured.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(measured.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(measured.marginLeft).toBe("0px");
    expect(measured.marginRight).toBe("0px");
    expect(measured.radius).toBe("0px");
    // Its content stays centred within the measure, and the page never
    // scrolls sideways.
    const content = page.locator("footer.look-colophon .colophon-content");
    await expect(content).toBeVisible();
    const contentBox = await content.boundingBox();
    expect(contentBox).not.toBeNull();
    if (contentBox) {
      const left = contentBox.x;
      const right = viewport.width - (contentBox.x + contentBox.width);
      expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
    }
    expect(measured.horizontal).toBeLessThanOrEqual(1);
  });
}
