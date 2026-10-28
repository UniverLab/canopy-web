// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// The web build is served from the relay Worker via its [assets] binding, on
// the same origin as the WebSocket. The CSP values mirror
// apps/remote/worker/src/protocol.ts; the exact text is covered by the
// unit tests (worker/test/headers.test.ts, web/test/headers-file.test.ts).
const CSP_PREFIX = "default-src 'self'; connect-src 'self' wss://";
const HEADERS: Array<[string, string]> = [
  ["content-security-policy", CSP_PREFIX],
  ["referrer-policy", "no-referrer"],
  ["x-content-type-options", "nosniff"],
];

test("serves the app on / with the shared security headers", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  for (const [name, value] of HEADERS) {
    const header = response?.headers()[name];
    expect(header, `missing header ${name}`).toBeTruthy();
    expect(header).toContain(value);
  }
  await expect(page.locator("#app")).toBeAttached();
  await expect(page).toHaveTitle("Canopy remote");
});

test("falls back to the app on /pair", async ({ page }) => {
  const response = await page.goto("/pair");
  expect(response?.status()).toBe(200);
  const html = await page.content();
  expect(html).toContain('<div id="app">');
  await expect(page).toHaveTitle("Canopy remote");
});

test("answers /auth/me with 401 JSON without a session", async ({ request }) => {
  const response = await request.get("/auth/me");
  expect(response.status()).toBe(401);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("serves robots.txt as static text that keeps crawlers out", async ({
  request,
}) => {
  const response = await request.get("/robots.txt");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/plain");
  const body = await response.text();
  expect(body).toContain("User-agent: *");
  expect(body).toContain("Disallow: /");
  expect(body).toContain("Content-Signal: search=no, ai-input=no, ai-train=no");
});

test("answers agent probes with 404 JSON, never the SPA", async ({
  request,
}) => {
  for (const path of ["/llms.txt", "/llms.txt/", "/sitemap.xml", "/sitemap.xml/", "/.well-known/api-catalog"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(response.headers()["content-type"], path).toContain("application/json");
  }
});

test("answers a missing built asset with 404, not index.html", async ({
  request,
}) => {
  for (const path of ["/app.css", "/app.css/"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
});

test("sign-in wears the header banner and a one-row colophon at 1280x900", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  // Unauthenticated, so the sign-in screen — with the header above it.
  await expect(page.locator("main.signin")).toBeVisible();
  const home = page.locator(".topbar #brand-home");
  await expect(home).toHaveAttribute("aria-label", "Canopy remote, home");
  await expect(home.locator(".look-banner-header span")).toHaveCount(11);
  await expect(page.locator(".topbar a[href*='univerlab.org/canopy']")).toHaveCount(0);
  await expect(page.locator("main.signin .look-banner")).toHaveCount(0);
  // The teal gradient survives the app's `style-src 'self'` CSP: the ink
  // comes from banner.css, not from a style attribute the header refuses.
  const inks = await page
    .locator(".topbar .look-banner-header span")
    .evaluateAll((spans) => spans.map((span) => getComputedStyle(span).color));
  expect(inks).toHaveLength(11);
  expect(inks[0]).toBe("rgb(82, 255, 246)");
  expect(inks[10]).toBe("rgb(0, 102, 97)");
  const tops = await page
    .locator("footer.look-colophon nav a")
    .evaluateAll((links) => links.map((link) => (link as HTMLElement).offsetTop));
  expect(tops).toHaveLength(5);
  expect(new Set(tops).size).toBe(1);
});

test("sign-in never scrolls sideways at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("main.signin")).toBeVisible();
  const boxes = await page
    .locator("footer.look-colophon nav a")
    .evaluateAll((links) =>
      links.map((link) => {
        const box = link.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    );
  expect(boxes).toHaveLength(5);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(391);
  }
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.view);
});
