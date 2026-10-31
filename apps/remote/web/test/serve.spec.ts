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
  // The Worker serves /, not the asset alone: the agent Link header rides
  // on the document the scanner reads.
  const link = response?.headers()["link"] ?? "";
  expect(link).toContain('</llms.txt>; rel="describedby"');
  expect(link).toContain('</.well-known/api-catalog>; rel="api-catalog"');
  await expect(page.locator("#app")).toBeAttached();
  await expect(page).toHaveTitle("Sign in · Canopy remote");
});

test("answers / with markdown when asked", async ({ request }) => {
  const response = await request.get("/", { headers: { accept: "text/markdown" } });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/markdown");
  const body = await response.text();
  expect(body).toContain("Canopy remote");
  expect(body).toContain("end to end");
});

test("falls back to the app on /pair", async ({ page }) => {
  const response = await page.goto("/pair");
  expect(response?.status()).toBe(200);
  const html = await page.content();
  expect(html).toContain('<div id="app">');
  await expect(page).toHaveTitle("Sign in · Canopy remote");
});

test("falls back to the app on a guest link", async ({ page }) => {
  const response = await page.goto("/g/7/0123456789abcdef");
  expect(response?.status()).toBe(200);
  const html = await page.content();
  expect(html).toContain('<div id="app">');
  await expect(page).toHaveTitle("Sign in · Canopy remote");
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

test("serves the discovery files with their content types", async ({
  request,
}) => {
  const files: Array<[string, string]> = [
    ["/llms.txt", "text/plain"],
    ["/sitemap.xml", "application/xml"],
    ["/.well-known/api-catalog", "application/linkset+json"],
    ["/.well-known/ai-catalog.json", "application/json"],
    ["/.well-known/agent-skills/index.json", "application/json"],
    ["/.well-known/agent-skills/canopy-remote/SKILL.md", "text/markdown"],
  ];
  for (const [path, contentType] of files) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toContain(contentType);
  }
  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).toContain("<loc>https://remote.univerlab.org/</loc>");
});

test("answers unknown probes with 404 JSON, never the SPA", async ({
  request,
}) => {
  for (const path of ["/llms.txt/", "/sitemap.xml/", "/.well-known/other"]) {
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
  const refused: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      refused.push(message.text());
    }
  });
  await page.goto("/");
  // Unauthenticated, so the sign-in screen — with the header above it.
  await expect(page.locator("main.signin")).toBeVisible();
  const home = page.locator(".topbar #brand-home");
  await expect(home).toHaveAttribute("aria-label", "Canopy remote, home");
  // The SVG banner: one line group per art line, named for assistive tech.
  const banner = home.locator("svg.look-banner-header");
  await expect(banner).toHaveAttribute("role", "img");
  await expect(banner).toHaveAttribute("aria-label", "Canopy remote");
  await expect(banner).toHaveAttribute("shape-rendering", "crispEdges");
  await expect(home.locator(".look-banner-line")).toHaveCount(11);
  await expect(page.locator(".topbar a[href*='univerlab.org/canopy']")).toHaveCount(0);
  await expect(page.locator("main.signin .look-banner")).toHaveCount(0);
  // About 160 px tall at desktop width, from the viewBox's 1:2 cells.
  const box = await banner.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs((box?.height ?? 0) - 160)).toBeLessThanOrEqual(5);
  // The teal gradient survives the relay's CSP: the ink is a `fill`
  // presentation attribute (or banner.css), never an inline style. A
  // refused load would log here.
  const inks = await page
    .locator(".topbar .look-banner-line")
    .evaluateAll((groups) => groups.map((group) => getComputedStyle(group).fill));
  expect(inks).toHaveLength(11);
  expect(inks[0]).toBe("rgb(82, 255, 246)");
  expect(inks[10]).toBe("rgb(0, 102, 97)");
  expect(refused.filter((text) => text.includes("Content Security Policy"))).toEqual([]);
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

test("the graph editor paints under the relay's real CSP on /editor", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const refused: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      refused.push(message.text());
    }
  });
  const response = await page.goto("/editor");
  expect(response?.status()).toBe(200);
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("style-src 'self'");
  await expect(page.locator("#editor")).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });

  // Wire spec → agent by ports, the way the editor.spec.ts scenarios do.
  await page.locator('[data-blank="agent"]').click();
  const nodes = page.locator("#editor-canvas g.node");
  await nodes.nth(0).locator("[data-output]").click();
  await nodes.nth(2).locator("[data-input]").click();
  await page.locator('#editor-chooser [data-cond="pass"]').click();
  await expect(page.locator("#editor-canvas g.edge")).toHaveCount(1);

  // The editor ships its paint in a stylesheet, never an inline <style>;
  // the count below holds the no-inline rule (inline styles on the remote
  // are xterm's exception alone).
  await expect(page.locator("style")).toHaveCount(0);
  const paint = await page.evaluate(() => {
    const of = (selector: string, property: string): string => {
      const element = document.querySelector(selector);
      return element === null ? "missing" : getComputedStyle(element)[property as "stroke"];
    };
    return {
      edge: of("#editor-canvas .edge-line", "stroke"),
      box: of("#editor-canvas .node-box", "fill"),
      stage: of("#editor-stage", "backgroundColor"),
      toolbar: of(".editor-toolbar", "display"),
    };
  });
  expect(paint.edge).toBe("rgb(0, 169, 160)");
  expect(paint.box).toBe("rgb(12, 20, 22)");
  expect(paint.stage).toBe("rgb(4, 17, 15)");
  expect(paint.toolbar).toBe("flex");
  expect(refused.filter((text) => text.includes("Content Security Policy"))).toEqual([]);
});
