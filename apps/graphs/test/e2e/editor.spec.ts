// SPDX-License-Identifier: Apache-2.0
/**
 * The editor in a real browser, at the two reference sizes:
 *
 * - a graph built from blank (agent → check → agent, a pass edge down
 *   the chain and a fail edge back), renamed, then Exported — the
 *   download is checked with the Worker's own validator and its
 *   topological positions;
 * - `?from=hello-graph` opened as a copy, a catalogue node added
 *   through the palette's official list and its search, connected, and
 *   shared with Copy link, which stores a real draft (the fixture
 *   Worker's in-memory DRAFTS) and shows `canopy graph install draft:`
 *   — then a reload proves the autosaved session comes back;
 * - no horizontal page scroll at 390 px;
 * - the plate vocabulary on the canvas (checks stroked #e8f6f1, fail
 *   edges dashed #ff6b6b) and the condition chooser's router-only route;
 * - pasting a graph that keeps an ensemble: its wired nodes lock
 *   against rename and delete, so the kept section never strands;
 * - choosing a `.json` file in the import box: it fills the import
 *   textarea and Apply loads the graph.
 *
 * One screenshot per viewport is attached to the report (never
 * compared), and the exported JSON is validated with the same
 * `documentProblems`/`harnessProblems` the Worker runs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { documentProblems, harnessProblems } from "../../src/validate.js";

/** The fixture graph the import-file test below chooses in the file picker. */
const IMPORT_FIXTURE = fileURLToPath(new URL("../fixtures/graphs/quality-bubble/graph.json", import.meta.url));

const VIEWPORTS = [
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 900 },
] as const;

/** Open the editor and wait for the shell's ready marker. */
async function openEditor(page: Page, query = ""): Promise<void> {
  await page.goto(`/editor${query}`, { waitUntil: "load" });
  await expect(page.locator("#editor")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
}

/** The centre of a canvas element, for the pointer gestures below. */
async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  expect(box, "the canvas element must be on screen").not.toBeNull();
  if (box === null) {
    return { x: 0, y: 0 };
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drag from one canvas point to another, the way a person connects nodes. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/** The output handle of the n-th node on the canvas. */
function handleOf(page: Page, index: number): Locator {
  return page.locator("#editor-canvas g.node").nth(index).locator("circle.handle-hit");
}

/** The shape of the n-th node: the drop target a person aims at. */
function nodeOf(page: Page, index: number): Locator {
  return page.locator("#editor-canvas g.node").nth(index).locator("rect.shape");
}

/** Connect two nodes through the chooser that follows a handle drag. */
async function connect(page: Page, from: number, to: number, condition: "pass" | "fail" | "always"): Promise<void> {
  await drag(page, await centreOf(handleOf(page, from)), await centreOf(nodeOf(page, to)));
  const chooser = page.locator("#editor-chooser");
  await expect(chooser).toBeVisible();
  await chooser.locator(`[data-cond="${condition}"]`).click();
  await expect(chooser).toBeHidden();
}

for (const viewport of VIEWPORTS) {
  test(`builds a graph from blank and exports a valid document at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openEditor(page);

    // The clean start, and the read-only promise under every face.
    await expect(page.locator("#editor-status")).toHaveText("No problems.");
    await expect(page.locator('[data-action="export"]')).toBeEnabled();
    await expect(page.locator("#editor-panel")).toContainText("this editor does not edit them yet");

    // Three blank nodes: unique names by suffix.
    await page.locator('[data-blank="agent"]').click();
    await page.locator('[data-blank="check"]').click();
    await page.locator('[data-blank="agent"]').click();
    await expect(page.locator("#editor-canvas g.node")).toHaveCount(3);
    await expect(page.locator("#editor-canvas g.node title")).toHaveText([
      "agent (agent)",
      "check (check)",
      "agent-2 (agent)",
    ]);
    // The panel edits the selected node: the quick prompt field writes config.
    await expect(page.locator("#node-name")).toHaveValue("agent-2");
    await page.locator("#quick-prompt").fill("Do the work.");
    await expect(page.locator("#editor-status")).toHaveText("No problems.");

    // A harness key typed into the config is a live problem: it is
    // listed with its path, and Export and Copy link switch off.
    await page.locator("#node-config").fill('{"prompt_template": "Do the work.", "model": "x"}');
    await expect(page.locator("#editor-status")).toHaveText(/\d+ problems?/);
    await expect(page.locator("#editor-problems")).toBeVisible();
    await expect(page.locator("#editor-problems")).toContainText("#/nodes/");
    await expect(page.locator('[data-action="export"]')).toBeDisabled();
    await expect(page.locator('[data-action="copy-link"]')).toBeDisabled();
    await page.locator("#node-config").fill('{"prompt_template": "Do the work."}');
    await expect(page.locator("#editor-status")).toHaveText("No problems.");
    await expect(page.locator('[data-action="export"]')).toBeEnabled();

    // The plate vocabulary on the canvas: a check strokes #e8f6f1.
    const checkStroke = await nodeOf(page, 1).evaluate((el) => getComputedStyle(el).stroke);
    expect(checkStroke).toBe("rgb(232, 246, 241)");

    // agent -> check -> agent, with a fail edge back.
    await connect(page, 0, 1, "pass");
    await connect(page, 1, 2, "pass");
    await connect(page, 1, 0, "fail");
    await expect(page.locator("#editor-canvas g.edge")).toHaveCount(3);
    await expect(page.locator("#editor-canvas g.edge.fail")).toHaveCount(1);
    const failStroke = await page
      .locator("#editor-canvas g.edge.fail .edge-line")
      .evaluate((el) => getComputedStyle(el).stroke);
    expect(failStroke).toBe("rgb(255, 107, 107)");

    // Deselect into the graph view and give the graph its slug name.
    await page.locator("#editor-canvas").click({ position: { x: 4, y: 4 } });
    await expect(page.locator("#graph-name")).toHaveValue("untitled");
    await page.locator("#graph-name").fill("sample-build");
    await page.locator("#graph-name").press("Tab");
    await expect(page.locator("#editor-status")).toHaveText("No problems.");

    // Export: a download named after the graph, valid against the
    // Worker's own validator, positions from the topological order.
    const downloadPromise = page.waitForEvent("download");
    await page.locator('[data-action="export"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("sample-build.graph.json");
    const file = await download.path();
    expect(file).not.toBeNull();
    const raw = readFileSync(file as string, "utf8");
    const document = JSON.parse(raw) as Record<string, unknown>;
    expect(document["format_version"]).toBe(6);
    expect(document["name"]).toBe("sample-build");
    const nodes = document["nodes"] as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node["name"])).toEqual(["agent", "check", "agent-2"]);
    expect(nodes.map((node) => node["position"])).toEqual([1, 2, 3]);
    expect((nodes[2]?.["config"] as Record<string, unknown>)["prompt_template"]).toBe("Do the work.");
    const edges = document["edges"] as Array<Record<string, unknown>>;
    expect(edges.map((edge) => edge["condition"])).toEqual(["pass", "pass", "fail"]);
    expect(documentProblems("graph", document)).toEqual([]);
    expect(harnessProblems("graph", document)).toEqual([]);
    expect(raw).not.toContain('"platform"');
    expect(raw).not.toContain('"model"');
    expect(raw).not.toContain('"cli"');

    const shot = await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`editor-blank-${viewport.label}.png`),
    });
    await testInfo.attach(`editor-blank-${viewport.label}`, { body: shot, contentType: "image/png" });
  });

  test(`opens ?from=hello-graph, adds a catalogue node and shares a draft at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openEditor(page, "?from=hello-graph");
    await expect(page.locator("#editor-canvas g.node")).toHaveCount(5);
    await expect(page.locator("#graph-name")).toHaveValue("hello-graph");
    await expect(page.locator("#editor-status")).toHaveText("No problems.");

    // The palette lists the official nodes from /api/official, and a
    // query through /api/search finds the same one.
    const officialRow = page.locator('[data-ref="UniverLab/canopy-graphs/hello-node"]');
    await expect(officialRow).toBeVisible();
    await page.locator("#editor-search").fill("hello-node");
    await page.locator("#editor-search").press("Enter");
    await expect(officialRow).toBeVisible();

    // Adding copies name, kind, config and preset: six nodes, unique.
    await officialRow.click();
    await expect(page.locator("#editor-canvas g.node")).toHaveCount(6);
    await expect(page.locator("#editor-status")).toHaveText("No problems.");
    // The preset landed, referenced from the agent's config.
    await expect(page.locator("#quick-preset")).toHaveValue("quick");

    // Connect the new node into the chain.
    await connect(page, 5, 0, "pass");
    await expect(page.locator("#editor-canvas g.edge")).toHaveCount(6);

    // Copy link: the draft is stored and the install command shows.
    await page.locator('[data-action="copy-link"]').click();
    const share = page.locator("#editor-share");
    await expect(share).toBeVisible({ timeout: 20_000 });
    await expect(share.locator("code")).toContainText("canopy graph install draft:");
    await expect(share.locator(".copy")).toBeVisible();
    await expect(share.locator(".editor-share-links a")).toHaveAttribute("href", /\/d\/[0-9a-hjkmnp-tv-z]{26}$/);
    await expect(share.locator("#editor-countdown")).toHaveText(/expires in \d+:\d\d/);

    // The work in progress autosaves: a reload of the same URL comes
    // back with all six nodes instead of refetching the five.
    await page.reload({ waitUntil: "load" });
    await expect(page.locator("#editor")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
    await expect(page.locator("#editor-canvas g.node")).toHaveCount(6);
    await expect(page.locator("#editor-status")).toHaveText("No problems.");

    const shot = await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`editor-share-${viewport.label}.png`),
    });
    await testInfo.attach(`editor-share-${viewport.label}`, { body: shot, contentType: "image/png" });
  });
}

test("the editor page never scrolls sideways at 390", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const query of ["", "?from=hello-graph"]) {
    await openEditor(page, query);
    const width = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: window.innerWidth,
    }));
    expect(width.view).toBeLessThanOrEqual(390);
    expect(width.scroll).toBeLessThanOrEqual(width.view);
  }
  const shot = await page.screenshot({ fullPage: true, path: testInfo.outputPath("editor-edges-mobile.png") });
  await testInfo.attach("editor-edges-mobile", { body: shot, contentType: "image/png" });
});

test("a router offers a route condition and other kinds do not", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openEditor(page);

  await page.locator('[data-blank="router"]').click();
  await page.locator('[data-blank="check"]').click();
  await expect(page.locator("#editor-canvas g.node")).toHaveCount(2);

  // From a plain check, the route row stays hidden.
  await drag(page, await centreOf(handleOf(page, 1)), await centreOf(nodeOf(page, 0)));
  const chooser = page.locator("#editor-chooser");
  await expect(chooser).toBeVisible();
  await expect(page.locator("#editor-chooser-route")).toBeHidden();
  await chooser.locator('[data-cond="cancel"]').click();
  await expect(chooser).toBeHidden();
  await expect(page.locator("#editor-canvas g.edge")).toHaveCount(0);

  // From the router, it shows — and an empty route name is refused.
  await drag(page, await centreOf(handleOf(page, 0)), await centreOf(nodeOf(page, 1)));
  await expect(chooser).toBeVisible();
  await expect(page.locator("#editor-chooser-route")).toBeVisible();
  await chooser.locator('[data-cond="route"]').click();
  await expect(chooser).toBeVisible();
  await expect(page.locator("#editor-notice")).toContainText("route needs a name");
  await page.locator("#editor-route").fill("ship");
  await chooser.locator('[data-cond="route"]').click();
  await expect(chooser).toBeHidden();

  // The inspector now edits that edge, and the route rides as {route}.
  await expect(page.locator("#edge-condition")).toHaveValue("route");
  await expect(page.locator("#edge-route")).toHaveValue("ship");
  await expect(page.locator("#editor-status")).toHaveText("No problems.");
  await expect(page.locator("#editor-canvas g.edge.pass")).toHaveCount(1);
});

test("a pasted graph with an ensemble locks its wired nodes against rename and delete", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openEditor(page);

  // Paste carries the same document the file picker does; this one keeps
  // an ensemble wiring both its nodes, so both lock.
  await page.locator('[data-action="import"]').click();
  await page.locator("#editor-import-text").fill(
    JSON.stringify({
      format_version: 6,
      name: "locked-graph",
      description: "",
      nodes: [
        { name: "build", kind: "agent", position: 1, config: { prompt_template: "Go." } },
        { name: "gate", kind: "gate", position: 2, config: {} },
      ],
      edges: [{ from_node: "build", to_node: "gate", condition: "pass" }],
      ensembles: [
        {
          name: "reviewers",
          kind: "parallel",
          commit_rights: false,
          prompt_template: "Review.",
          entry_from_node: "gate",
          entry_condition: "pass",
          on_pass_to: "build",
          min_pass: 1,
          timeout_minutes: 30,
        },
      ],
      hooks: { on_completed: [], on_failed: [], on_blocked: [], on_spec_completed: [] },
      infra_node: "build",
      presets: {},
    }),
  );
  await page.locator('[data-action="import-apply"]').click();
  await expect(page.locator("#editor-import")).toBeHidden();
  await expect(page.locator("#editor-canvas g.node")).toHaveCount(2);
  await expect(page.locator("#editor-status")).toHaveText("No problems.");

  // Renaming a wired node would strand the kept ensemble, so the name
  // field locks exactly like the delete button does.
  await nodeOf(page, 1).click();
  await expect(page.locator("#node-name")).toHaveValue("gate");
  await expect(page.locator("#node-name")).toBeDisabled();
  await expect(page.locator('[data-action="delete-node"]')).toBeDisabled();
  await expect(page.locator("#editor-panel")).toContainText("does not edit ensembles");
});

test("choosing a .json file in the import box loads it into the editor", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openEditor(page);

  // The file input feeds the import textarea; Apply then takes the graph.
  await page.locator('[data-action="import"]').click();
  await page.locator("#editor-import-file").setInputFiles({
    name: "quality-bubble.graph.json",
    mimeType: "application/json",
    buffer: readFileSync(IMPORT_FIXTURE),
  });
  await expect(page.locator("#editor-import-text")).toHaveValue(/"name": "quality-bubble"/);
  await page.locator('[data-action="import-apply"]').click();
  await expect(page.locator("#editor-import")).toBeHidden();
  await expect(page.locator("#graph-name")).toHaveValue("quality-bubble");
  await expect(page.locator("#editor-canvas g.node")).toHaveCount(4);
  await expect(page.locator("#editor-canvas g.edge")).toHaveCount(6);
  await expect(page.locator("#editor-status")).toHaveText("No problems.");
});
