// SPDX-License-Identifier: Apache-2.0
/**
 * The remote graph editor in a real browser, at the two reference sizes:
 *
 * - wire spec → agent → check → next by ports and export, asserting the
 *   one-use draft command with its Copy button and countdown;
 * - build an ensemble of 3 agents and export, then re-import the posted
 *   document and check the ensemble is editable again;
 * - delete a node with the key and check its edges are gone;
 * - Clear keeps spec and next.
 *
 * Three guarantees ride beside the scenarios: wiring by touch (tap the output,
 * then the input), the paint coming from a stylesheet rather than an inline
 * `<style>` the remote's CSP refuses, and Export staying the simple CORS
 * request the catalogue's preflight answer accepts.
 *
 * The drafts POST is routed to a canned 201 — no test touches the live
 * catalogue — and the posted document is asserted where it matters.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const DRAFTS_URL = "https://graphs.univerlab.org/api/drafts";
const DRAFT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

const VIEWPORTS = [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 900 },
] as const;

/** Open the editor and wait for the shell's ready marker. */
async function openEditor(page: Page): Promise<void> {
  await page.goto("/editor", { waitUntil: "load" });
  await expect(page.locator("#editor")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
}

/** The n-th node box on the canvas (spec is 0, next is 1). */
function nodeBox(page: Page, index: number): Locator {
  return page.locator("#editor-canvas g.node").nth(index);
}

/** Tap-tap wiring: click the output port, then the input port, then the condition. */
async function wire(
  page: Page,
  from: Locator,
  to: Locator,
  condition: "pass" | "fail" | "always" | "error" = "pass",
): Promise<void> {
  await from.click();
  await to.click();
  const chooser = page.locator("#editor-chooser");
  await expect(chooser).toBeVisible();
  await chooser.locator(`[data-cond="${condition}"]`).click();
  await expect(chooser).toBeHidden();
}

function outputOf(node: Locator): Locator {
  return node.locator("[data-output]");
}

function inputOf(node: Locator): Locator {
  return node.locator("[data-input]");
}

function ensembleBox(page: Page): Locator {
  return page.locator("#editor-canvas g.ensemble");
}

/** Route the drafts POST to a canned draft, capturing the posted document. */
async function mockDrafts(page: Page, captured: { document?: unknown }): Promise<void> {
  await page.route(DRAFTS_URL, async (route) => {
    const request = route.request();
    try {
      captured.document = (request.postDataJSON() as { document: unknown }).document;
    } catch {
      captured.document = null;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: DRAFT_ID,
        kind: "graph",
        name: "untitled",
        expires_at: new Date(Date.now() + 1800_000).toISOString(),
        page_url: `https://graphs.univerlab.org/d/${DRAFT_ID}`,
        install: `canopy graph install draft:${DRAFT_ID}`,
      }),
    });
  });
}

for (const viewport of VIEWPORTS) {
  test(`wires spec to next by ports and exports the draft command at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openEditor(page);

    // Two fixed endpoints, both problems, Export off.
    await expect(nodeBox(page, 0).locator("title")).toHaveText("spec (spec)");
    await expect(nodeBox(page, 1).locator("title")).toHaveText("next (next)");
    await expect(page.locator("#editor-status")).toHaveText("2 problems");
    await expect(page.locator("#editor-problems")).toContainText("spec is not connected");
    await expect(page.locator("#editor-problems")).toContainText("nothing reaches next");
    await expect(page.locator('[data-action="export"]')).toBeDisabled();
    // The old toolbar is gone: Import and Export only, Clear on the canvas.
    await expect(page.locator('[data-action="export-json"]')).toHaveCount(0);
    await expect(page.locator('[data-action="copy-link"]')).toHaveCount(0);
    await expect(page.locator('.editor-toolbar [data-action="import"]')).toBeVisible();
    await expect(page.locator('.editor-zoom [data-action="clear"]')).toBeVisible();

    // spec → agent → check → next, port to port.
    await page.locator('[data-blank="agent"]').click();
    await page.locator('[data-blank="check"]').click();
    await expect(page.locator("#editor-canvas g.node")).toHaveCount(4);
    await wire(page, outputOf(nodeBox(page, 0)), inputOf(nodeBox(page, 2)));
    await wire(page, outputOf(nodeBox(page, 2)), inputOf(nodeBox(page, 3)));
    await wire(page, outputOf(nodeBox(page, 3)), inputOf(nodeBox(page, 1)));
    await expect(page.locator("#editor-canvas g.edge")).toHaveCount(3);
    await expect(page.locator("#editor-status")).toHaveText("No problems.");
    await expect(page.locator('[data-action="export"]')).toBeEnabled();

    // Export stores the draft and shows the one-use command.
    const captured: { document?: unknown } = {};
    await mockDrafts(page, captured);
    await page.locator('[data-action="export"]').click();
    const share = page.locator("#editor-share");
    await expect(share).toBeVisible();
    await expect(share.locator("code")).toContainText(`canopy graph install draft:${DRAFT_ID}`);
    await expect(share.locator('[data-action="copy-draft"]')).toBeVisible();
    await expect(share.locator("#editor-countdown")).toHaveText(/expires in \d+:\d\d/);
    // spec rode as Start; the edge into next rode as nothing.
    const posted = captured.document as Record<string, unknown>;
    const nodes = posted["nodes"] as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node["name"])).toEqual(["Start", "agent", "check"]);
    const edges = posted["edges"] as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(2);

    // No horizontal page scroll at phone width.
    if (viewport.width < 640) {
      const width = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        view: window.innerWidth,
      }));
      expect(width.scroll).toBeLessThanOrEqual(width.view);
    }
  });

  test(`builds an ensemble of 3 agents, exports and re-imports it at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openEditor(page);

    // Three agents, shift-selected, grouped as one ensemble.
    await page.locator('[data-blank="agent"]').click();
    await page.locator('[data-blank="agent"]').click();
    await page.locator('[data-blank="agent"]').click();
    // Deselect first: shift-clicks then build the multi-select from empty.
    await page.locator("#editor-canvas").click({ position: { x: 4, y: 4 } });
    await page.keyboard.down("Shift");
    await nodeBox(page, 2).locator("rect.node-box").click();
    await nodeBox(page, 3).locator("rect.node-box").click();
    await nodeBox(page, 4).locator("rect.node-box").click();
    await page.keyboard.up("Shift");
    await expect(page.locator("#editor-panel")).toContainText("3 nodes");
    await page.locator('[data-action="make-ensemble"]').click();
    await expect(ensembleBox(page)).toHaveCount(1);
    await expect(page.locator("#editor-canvas g.member")).toHaveCount(3);
    await expect(page.locator("#ensemble-name")).toBeVisible();
    await page.locator("#ensemble-name").fill("reviewers");
    await page.locator("#ensemble-name").press("Tab");
    await page.locator("#ensemble-prompt").fill("Review the diff.");

    // spec → ensemble → check → next: the ensemble's exits wire on.
    await page.locator('[data-blank="check"]').click();
    const check = nodeBox(page, 2);
    await wire(page, outputOf(nodeBox(page, 0)), inputOf(ensembleBox(page)));
    await wire(page, outputOf(ensembleBox(page)), inputOf(check));
    // The ensemble offers pass and fail exits only.
    await check.locator("rect.node-box").click();
    await expect(page.locator("#node-name")).toHaveValue("check");
    await wire(page, outputOf(check), inputOf(nodeBox(page, 1)));
    await expect(page.locator("#editor-status")).toHaveText("No problems.");

    // Export writes the ensemble shape; re-import makes it editable again.
    const captured: { document?: unknown } = {};
    await mockDrafts(page, captured);
    await page.locator('[data-action="export"]').click();
    await expect(page.locator("#editor-share code")).toContainText("canopy graph install draft:");
    const posted = captured.document as Record<string, unknown>;
    const ensembles = posted["ensembles"] as Array<Record<string, unknown>>;
    expect(ensembles).toHaveLength(1);
    expect(ensembles[0]?.["name"]).toBe("reviewers");
    expect(ensembles[0]?.["entry_from_node"]).toBe("Start");
    expect(ensembles[0]?.["on_pass_to"]).toBe("check");
    expect(ensembles[0]?.["prompt_template"]).toBe("Review the diff.");
    expect(ensembles[0]?.["members"] as Array<unknown>).toHaveLength(3);

    await page.locator('[data-action="import"]').click();
    await page.locator("#editor-import-text").fill(JSON.stringify(posted));
    await page.locator('[data-action="import-apply"]').click();
    await expect(page.locator("#editor-import")).toBeHidden();
    await expect(ensembleBox(page)).toHaveCount(1);
    await expect(page.locator("#editor-canvas g.member")).toHaveCount(3);
    await expect(page.locator("#editor-status")).toHaveText("No problems.");
    await expect(page.locator("#editor-panel")).not.toContainText("kept as they came");
    await ensembleBox(page).click({ position: { x: 30, y: 14 } });
    await expect(page.locator("#ensemble-name")).toHaveValue("reviewers");
  });

  test(`deletes a node with the key and drops its edges at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openEditor(page);

    await page.locator('[data-blank="agent"]').click();
    await wire(page, outputOf(nodeBox(page, 0)), inputOf(nodeBox(page, 2)));
    await wire(page, outputOf(nodeBox(page, 2)), inputOf(nodeBox(page, 1)));
    await expect(page.locator("#editor-canvas g.edge")).toHaveCount(2);
    await nodeBox(page, 2).locator("rect.node-box").click();
    await expect(page.locator("#node-name")).toHaveValue("agent");
    await page.keyboard.press("Delete");
    await expect(page.locator("#editor-canvas g.node")).toHaveCount(2);
    await expect(page.locator("#editor-canvas g.edge")).toHaveCount(0);
    await expect(page.locator("#editor-problems")).toContainText("spec is not connected");
  });

  test(`Clear keeps spec and next at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openEditor(page);

    await page.locator('[data-blank="agent"]').click();
    await expect(page.locator("#editor-canvas g.node")).toHaveCount(3);
    page.on("dialog", (dialog) => void dialog.accept());
    await page.locator('[data-action="clear"]').click();
    await expect(page.locator("#editor-canvas g.node")).toHaveCount(2);
    await expect(nodeBox(page, 0).locator("title")).toHaveText("spec (spec)");
    await expect(nodeBox(page, 1).locator("title")).toHaveText("next (next)");
    await expect(page.locator("#editor-problems")).toContainText("spec is not connected");
    await expect(page.locator("#editor-problems")).toContainText("nothing reaches next");
  });
}

/**
 * Requirement 1's touch path: on a phone there is no drag and no Shift — a
 * tap on an output port arms it, a tap on an input port lands the edge, and
 * the chooser asks for the condition.
 */
test("wires by tapping an output port and then an input port", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await openEditor(page);
    await page.locator('[data-blank="agent"]').tap();
    await nodeBox(page, 0).locator("[data-output]").tap();
    await nodeBox(page, 2).locator("[data-input]").tap();
    const chooser = page.locator("#editor-chooser");
    await expect(chooser).toBeVisible();
    await chooser.locator('[data-cond="pass"]').tap();
    await nodeBox(page, 2).locator("[data-output]").tap();
    await nodeBox(page, 1).locator("[data-input]").tap();
    await expect(chooser).toBeVisible();
    await chooser.locator('[data-cond="pass"]').tap();
    await expect(page.locator("#editor-canvas g.edge")).toHaveCount(2);
    await expect(page.locator("#editor-status")).toHaveText("No problems.");
  } finally {
    await context.close();
  }
});

/**
 * The remote allows an inline `<style>` solely for xterm.js (see
 * SECURITY_HEADERS in worker/src/protocol.ts), so the editor keeps its
 * paint in editor.css, the stylesheet the editor chunk links, and the
 * exception never spreads past the terminal.
 */
test("paints the graph from a stylesheet, never an inline style", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openEditor(page);
  await page.locator('[data-blank="agent"]').click();
  await wire(page, outputOf(nodeBox(page, 0)), inputOf(nodeBox(page, 2)));
  await expect(page.locator("#editor-canvas g.edge")).toHaveCount(1);

  // No <style> in the svg, and none made by the app either: the dev server's
  // own style tags carry its `data-vite-dev-id`, the app's would not.
  await expect(page.locator("#editor-canvas style")).toHaveCount(0);
  const appStyles = await page.evaluate(() =>
    [...document.querySelectorAll("style")]
      .filter((element) => !element.hasAttribute("data-vite-dev-id"))
      .map((element) => element.id || element.textContent?.slice(0, 40) || "anonymous"),
  );
  expect(appStyles, "the app must not create inline <style> elements").toEqual([]);

  // And the paint lands: the plate's teal edge over the deep stage.
  const paint = await page.evaluate(() => {
    const of = (selector: string, property: string): string => {
      const element = document.querySelector(selector);
      return element === null ? "missing" : getComputedStyle(element)[property as "stroke"];
    };
    return {
      edge: of("#editor-canvas .edge-line", "stroke"),
      box: of("#editor-canvas .node-box", "fill"),
      stage: of("#editor-stage", "backgroundColor"),
    };
  });
  expect(paint.edge).toBe("rgb(0, 169, 160)");
  expect(paint.box).toBe("rgb(12, 20, 22)");
  expect(paint.stage).toBe("rgb(4, 17, 15)");
});

/**
 * Export must survive the catalogue's real CORS answer: it allows the origin
 * and the methods but no request headers, so a `content-type: application/json`
 * POST would be refused after a preflight the editor cannot win. A fulfilled
 * route skips the browser's preflight (so this test cannot reproduce the
 * refusal itself), hence the assertions pin the *request shape*: one plain
 * POST, no preflight-triggering content type.
 */
test("stores the draft as the simple request the catalogue accepts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const seen: string[] = [];
  await page.route(DRAFTS_URL, async (route) => {
    const request = route.request();
    seen.push(`${request.method()} ${request.headers()["content-type"] ?? "no content-type"}`);
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    await route.fulfill({
      status: 201,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({
        id: DRAFT_ID,
        kind: "graph",
        name: "untitled",
        expires_at: new Date(Date.now() + 1800_000).toISOString(),
        install: `canopy graph install draft:${DRAFT_ID}`,
      }),
    });
  });

  await openEditor(page);
  await page.locator('[data-blank="agent"]').click();
  await wire(page, outputOf(nodeBox(page, 0)), inputOf(nodeBox(page, 2)));
  await wire(page, outputOf(nodeBox(page, 2)), inputOf(nodeBox(page, 1)));
  await expect(page.locator('[data-action="export"]')).toBeEnabled();
  await page.locator('[data-action="export"]').click();
  await expect(page.locator("#editor-share code")).toContainText(
    `canopy graph install draft:${DRAFT_ID}`,
  );
  // One POST, no preflight, and the body carries no JSON content type.
  expect(seen.filter((line) => line.startsWith("OPTIONS"))).toEqual([]);
  const post = seen.find((line) => line.startsWith("POST")) ?? "";
  expect(post).toContain("text/plain");
});
