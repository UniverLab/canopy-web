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
