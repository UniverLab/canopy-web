// SPDX-License-Identifier: Apache-2.0
// The relay's CSP against the real terminal and graphs list: opening a
// session, typing, resizing, zooming and rendering the graphs list must fire
// zero `securitypolicyviolation` events.
//
// The policy is read from web/public/_headers — the exact header the relay
// serves for its documents (pinned to worker/src/protocol.ts by
// web/test/headers-file.test.ts) — and applied to the smoke page through a
// route, because vite dev serves no CSP of its own. The flow pins both
// relaxed directives (see SECURITY_HEADERS in worker/src/protocol.ts):
// xterm.js 5.5.0 injects two `<style>` elements on open (allowed only by
// `style-src-elem 'unsafe-inline'`), and the graphs list's progress-bar
// widths are `style` attributes (allowed only by `style-src-attr
// 'unsafe-inline'`); every `element.style` write is CSSOM the style
// directives do not govern.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

interface CspViolation {
  directive: string;
  uri: string;
  sample: string;
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
  }
}

/** The relay's document CSP, straight from the `_headers` file it ships. */
function relayCsp(): string {
  const file = readFileSync(join(import.meta.dirname, "../public/_headers"), "utf8");
  const line = file
    .split("\n")
    .find((candidate) => candidate.trim().toLowerCase().startsWith("content-security-policy:"));
  if (line === undefined) {
    throw new Error("public/_headers carries no content-security-policy");
  }
  return line.slice(line.indexOf(":") + 1).trim();
}

async function terminalText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

test("opening a session, typing, resizing and listing graphs fires zero CSP violations", async ({
  page,
}) => {
  const csp = relayCsp();
  await page.route("**/fake.html", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": csp },
    });
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations?.push({
        directive: event.violatedDirective,
        uri: event.blockedURI,
        sample: event.sample.slice(0, 80),
      });
    });
  });
  // Vite's dev-only HMR socket speaks ws://localhost regardless of the
  // page's host, so the page opens on localhost too: the socket stays
  // same-origin ('self') and the zero-violation assertion covers the app,
  // never vite's machinery (production has no HMR socket at all).
  const base = test.info().project.use?.baseURL ?? "http://127.0.0.1:5199";
  const response = await page.goto(`${base.replace("127.0.0.1", "localhost")}/fake.html`);
  // The header on the document response is the check that the route really
  // applied the relay's policy; without it this test would pass vacuously.
  expect(response?.headers()["content-security-policy"]).toBe(csp);
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
  // Typing moves xterm's cursor (its hidden textarea follows) and the refit
  // writes the scale; pushed output grows the viewport's scroll area.
  const area = page.locator(".xterm-helper-textarea");
  for (const key of ["h", "e", "l", "l", "o", "Enter"]) {
    await area.press(key);
  }
  await page.evaluate(() => window.__fake.pushOut("live line\n"));
  await expect.poll(() => terminalText(page)).toContain("live line");
  // Resizing refits the terminal scale twice over; the zoom buttons drive
  // the same refit path from the toolbar.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#term-zoom-in").click();
  await page.locator("#term-zoom-out").click();
  // The graphs list renders one `style="width:…"` attribute per row: the
  // leg that pins `style-src-attr` (refused without it, and the bars lose
  // their widths). Fixtures: palette-loop 1/4, quality-bubble 3/3.
  await page.locator("#session-back").click();
  await page.locator('[data-tab="graphs"]').click();
  await expect(page.locator(".graph-row")).toHaveCount(2);
  const widths = await page.locator(".progress-fill").evaluateAll((bars) =>
    bars.map((bar) => (bar as HTMLElement).style.width),
  );
  expect(widths).toHaveLength(2);
  expect(widths).toContain("25%");
  expect(widths).toContain("100%");
  // "missing listener" fails loudly if the init script never ran: an empty
  // array must mean zero violations, never a lost collector.
  const violations = await page.evaluate(() => window.__cspViolations ?? "missing listener");
  expect(violations).toEqual([]);
});
