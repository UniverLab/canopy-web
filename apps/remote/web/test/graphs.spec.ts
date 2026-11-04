// SPDX-License-Identifier: Apache-2.0
// Watching graphs against the fake host: the Graphs tab lists all five
// fixtures, the running graph opens on a plate with one lit node over
// its spec checklist, pushes move the lit node and tick the specs, and
// leaving the view unwatches. The fake host also ticks on its own every
// 2 s while watched, so every assertion here survives extra pushes:
// statuses and counts only ever move forward.
import { expect, test, type Page } from "@playwright/test";

/** The lit unit's key: nodes by name, members by group#index. */
async function litNodeKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const lit = document.querySelector('#graph-stage [data-state="running"]');
    if (!lit) {
      return null;
    }
    return `${lit.getAttribute("data-name")}#${lit.getAttribute("data-i") ?? "0"}`;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/fake.html");
  await page.locator('[data-tab="graphs"]').click();
  await expect(page.locator(".graph-row")).toHaveCount(5);
});

test("lists the five graphs with chips, fractions, specs and workdirs", async ({ page }) => {
  // Showing the tab asked the host for the list.
  const sent = await page.evaluate(() => window.__fake.sent());
  expect(sent).toContainEqual(expect.objectContaining({ t: "graphs" }));

  const loop = page.locator('[data-graph="g-loop"]');
  await expect(loop.locator(".graph-name")).toHaveText("palette-loop");
  await expect(loop.locator(".status-chip")).toHaveAttribute("data-status", "running");
  await expect(loop.locator(".graph-count")).toHaveText("1/4");
  await expect(loop.locator(".graph-spec")).toHaveText("Draw the plate");
  await expect(loop.locator(".graph-workdir")).toHaveText("/home/u/demo");

  const done = page.locator('[data-graph="g-done"]');
  await expect(done.locator(".graph-name")).toHaveText("quality-bubble");
  await expect(done.locator(".status-chip")).toHaveAttribute("data-status", "completed");
  await expect(done.locator(".graph-count")).toHaveText("3/3");

  const builder = page.locator('[data-graph="g-builder"]');
  await expect(builder.locator(".graph-name")).toHaveText("canopy-builder");
  await expect(builder.locator(".status-chip")).toHaveAttribute("data-status", "running");
  await expect(builder.locator(".graph-count")).toHaveText("0/3");

  const paused = page.locator('[data-graph="g-paused"]');
  await expect(paused.locator(".graph-name")).toHaveText("paused-sketch");
  await expect(paused.locator(".status-chip")).toHaveAttribute("data-status", "paused");
  await expect(paused.locator(".graph-count")).toHaveText("1/2");

  const failed = page.locator('[data-graph="g-failed"]');
  await expect(failed.locator(".graph-name")).toHaveText("failed-sketch");
  await expect(failed.locator(".status-chip")).toHaveAttribute("data-status", "failed");
  await expect(failed.locator(".graph-count")).toHaveText("2/5");
});

test("watches the running graph live on its plate and checklist", async ({ page }) => {
  await page.locator('[data-graph="g-loop"]').click();
  await expect(page.locator("main.graph-view")).toBeVisible();
  const sent = await page.evaluate(() => window.__fake.sent());
  // The watch carries a non-empty req, or the host refuses the frame.
  const watch = sent.find((frame) => (frame as { t: unknown }).t === "graph_watch") as
    | { req: unknown }
    | undefined;
  expect(sent).toContainEqual(expect.objectContaining({ t: "graph_watch", id: "g-loop" }));
  expect(typeof watch?.req).toBe("string");
  expect(watch?.req).not.toBe("");

  // The header: name, chip and count.
  await expect(page.locator(".graph-title")).toHaveText("palette-loop");
  await expect(page.locator("#graph-chip .status-chip")).toHaveAttribute(
    "data-status",
    "running",
  );
  await expect(page.locator("#graph-count")).toHaveText("1/4");

  // The plate with exactly one lit node (vertical below 720 px).
  await expect(page.locator("#graph-stage .plate-svg")).toHaveClass(/plate-v/);
  await expect(page.locator("#graph-stage .state-ring")).toHaveCount(1);
  const lit = page.locator('#graph-stage [data-state="running"]');
  await expect(lit).toHaveCount(1);
  const first = await litNodeKey(page);
  expect(first).not.toBeNull();

  // The checklist in queue order, the running row marked.
  const rows = page.locator("#spec-list .spec-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute("data-status", "completed");
  await expect(rows.nth(1)).toHaveAttribute("data-status", "running");
  await expect(rows.nth(1).locator(".spec-mark")).toHaveAttribute("title", "running");
  await expect(rows.nth(0).locator(".spec-code")).toHaveText("FIX-1");
  await expect(rows.nth(0).locator(".spec-attempts")).toHaveText("×2");

  // A push moves the lit node along the drawing.
  await page.evaluate(() => window.__fake.graphTick());
  await expect.poll(() => litNodeKey(page)).not.toBe(first);
  await expect(page.locator("#graph-stage .state-ring")).toHaveCount(1);

  // A full round completes the running spec and promotes the next one:
  // five ticks always cross a round boundary from any step.
  for (let i = 0; i < 5; i += 1) {
    await page.evaluate(() => window.__fake.graphTick());
  }
  await expect(page.locator('[data-spec="s2"]')).toHaveAttribute("data-status", "completed");
  await expect(page.locator("#spec-list .spec-row[data-status='running']")).toHaveCount(1);
  await expect.poll(() => page.locator("#graph-count").textContent()).not.toBe("1/4");
});

test("unwatches when leaving the graph view", async ({ page }) => {
  await page.locator('[data-graph="g-loop"]').click();
  await expect(page.locator("main.graph-view")).toBeVisible();
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator("#graph-back").click();
  await expect(page.locator("main.sessions")).toBeVisible();
  const sent = await page.evaluate(() => window.__fake.sent());
  expect(sent).toContainEqual({ t: "graph_unwatch", id: "g-loop" });
});

test("draws the plate vertical on a phone, horizontal past 720 px", async ({ page }) => {
  await page.locator('[data-graph="g-loop"]').click();
  const plate = page.locator("#graph-stage .plate-svg");
  await expect(plate).toHaveClass(/plate-v/);
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(plate).toHaveClass(/plate-h/);
});

test("draws the builder plate with its handlers in the side lane at 390 px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-graph="g-builder"]').click();
  await expect(page.locator("main.graph-view")).toBeVisible();
  const plate = page.locator("#graph-stage .plate-svg");
  await expect(plate).toHaveClass(/plate-v/);

  // The failure terminals sit in a lane left of the column, the flow's end
  // under Relock repo, and one amber bus enters Resilience.
  const measured = await page.evaluate(() => {
    const svg = document.querySelector("#graph-stage .plate-svg");
    if (svg === null) {
      return null;
    }
    const nodes = [...svg.querySelectorAll("g.node")].map((node) => ({
      name: node.getAttribute("data-name") ?? "",
      lane: node.getAttribute("data-lane") ?? "",
      cx: Number(node.getAttribute("data-cx")),
      hw: Number(node.getAttribute("data-w")) / 2,
    }));
    const main = nodes.filter((node) => node.lane === "main");
    return {
      mainLeft: Math.min(...main.map((node) => node.cx - node.hw)),
      handlers: nodes
        .filter((node) => node.lane === "handler")
        .map((node) => `${node.name}:${(node.cx + node.hw).toFixed(2)}`),
    };
  });
  expect(measured).not.toBeNull();
  expect(measured?.handlers.map((handler) => handler.split(":")[0]).sort()).toEqual([
    "Human verdict",
    "Resilience",
  ]);
  for (const handler of measured?.handlers ?? []) {
    expect(Number(handler.split(":")[1])).toBeLessThan(measured?.mainLeft ?? 0);
  }

  await expect(plate.locator(".done")).toHaveText("✓ done");
  await expect(plate.locator('[data-done="Relock repo"]')).toHaveCount(1);
  await expect(plate.locator('[data-bus="Resilience"]')).toHaveCount(1);
  await expect(plate.locator('path.edge.error')).toHaveCount(1);

  // Every flow edge — buses included — carries an arrowhead: a plate where
  // a grouped edge lost its marker reads as an unfinished drawing.
  const missing = await plate.locator("path.edge:not(.order)").evaluateAll((paths) =>
    paths.filter((path) => path.getAttribute("marker-end") === null).length,
  );
  expect(missing).toBe(0);

  // The capture: the whole drawing at phone width, lane and done terminal
  // included — the acceptance surface for this geometry.
  await plate.evaluate((svg) => svg.scrollIntoView({ block: "start" }));
  const shot = await plate.screenshot({ path: testInfo.outputPath("canopy-builder-390x844.png") });
  await testInfo.attach("canopy-builder-390x844", { body: shot, contentType: "image/png" });
});
