// SPDX-License-Identifier: Apache-2.0
// Audit E4+E7 (2026-11-01, second pass): at 390x844 every named phone
// target meets 44x44 CSS px of hit area — the header Disconnect, the
// interactive metrics strip, the Agent/Terminal and Yolo labels (the
// whole label is the target: each input is wrapped in its label), and
// the footer UniverLab link — and the dark-only app declares
// `color-scheme: dark`.
import { expect, test } from "@playwright/test";

interface HitBox {
  width: number;
  height: number;
}

test("touch_targets_meet_44px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();

  // The header pair on the sessions home: Disconnect and the metrics
  // strip, which is interactive (a button opening SysInfo).
  const disconnect = page.locator("#conn-disconnect");
  const strip = page.locator("#metrics-strip");
  await expect(disconnect).toBeVisible();
  await expect(strip).toBeVisible();
  const stripTag = await strip.evaluate((el) => el.tagName);
  expect(stripTag).toBe("BUTTON");

  // The New dialog's labels: Agent/Terminal radios and the Yolo
  // checkbox, each wrapped in its label with hit padding.
  await page.locator("#session-new").click();
  await expect(page.locator("#new-form")).toBeVisible();
  const agentLabel = page.locator(".kind-option", { has: page.locator("#new-kind-agent") });
  const terminalLabel = page.locator(".kind-option", {
    has: page.locator("#new-kind-terminal"),
  });
  const yoloLabel = page.locator("label.yolo-row", { has: page.locator("#new-yolo") });
  await expect(agentLabel).toBeVisible();
  await expect(terminalLabel).toBeVisible();
  await expect(yoloLabel).toBeVisible();
  // Measure while the dialog is open: closing removes them from the DOM.
  const agentBox = await agentLabel.boundingBox();
  const terminalBox = await terminalLabel.boundingBox();
  const yoloBox = await yoloLabel.boundingBox();
  await page.locator("#new-cancel").click();
  await expect(page.locator("#new-form")).toBeHidden();

  // The footer UniverLab link (the credits line) plus every colophon
  // link, which all carry the same hit padding.
  const univerlab = page.locator('.colophon-credits a[href="https://univerlab.org"]');
  await univerlab.scrollIntoViewIfNeeded();
  const colophonLinks = page.locator(
    "#app > footer.look-colophon .colophon-col a, #app > footer.look-colophon .colophon-credits a",
  );
  await expect(colophonLinks.first()).toBeVisible();

  const boxes: Record<string, HitBox | null> = {
    disconnect: await disconnect.boundingBox(),
    metricsStrip: await strip.boundingBox(),
    agentLabel: agentBox,
    terminalLabel: terminalBox,
    yoloLabel: yoloBox,
    footerUniverLab: await univerlab.boundingBox(),
  };
  const colophonBoxes = await colophonLinks.evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { label: el.textContent, width: box.width, height: box.height };
    }),
  );
  const colorScheme = await page.evaluate(
    () => getComputedStyle(document.documentElement).colorScheme,
  );
  process.stdout.write(
    `touch-target boxes at 390x844: ${JSON.stringify({ boxes, colophonBoxes, colorScheme }, null, 2)}\n`,
  );

  for (const [name, box] of Object.entries(boxes)) {
    expect(box, name).not.toBeNull();
    expect(box?.width ?? 0, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(44);
  }
  for (const link of colophonBoxes) {
    expect(link.width, `colophon "${link.label}" width`).toBeGreaterThanOrEqual(44);
    expect(link.height, `colophon "${link.label}" height`).toBeGreaterThanOrEqual(44);
  }
  expect(colorScheme).toBe("dark");

  // The session's terminal controls and keys keep the same floor. A fine
  // pointer hides the key bar by default, so show it first.
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-pane")).toBeVisible();
  if (!(await page.locator("#keybar").isVisible())) {
    await page.locator("#term-keys").click();
  }
  const barBoxes = await page
    .locator(".term-controls button, #keybar .key")
    .evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => {
          const box = el.getBoundingClientRect();
          return {
            label: el.getAttribute("aria-label") ?? el.textContent ?? "",
            width: box.width,
            height: box.height,
          };
        }),
    );
  process.stdout.write(`session bar boxes at 390x844: ${JSON.stringify(barBoxes, null, 2)}\n`);
  // Zoom out, zoom in, Keys, Builder, Copy, Attach, Attach from shelf,
  // fullscreen, and the ten keys; latest stays hidden until the user
  // scrolls up.
  expect(barBoxes).toHaveLength(18);
  for (const control of barBoxes) {
    expect(control.width, `${control.label} width`).toBeGreaterThanOrEqual(44);
    expect(control.height, `${control.label} height`).toBeGreaterThanOrEqual(44);
  }
});

// Audit (2026-11-04): the terminal toolbar at phone widths. Keys goes
// icon-only under 640 px (aria-label and title name it), so no label runs
// past its button; the latest button floats over the terminal card's
// bottom-right corner instead of taking a toolbar slot; the toolbar
// itself never wraps onto a second row (which cost the terminal a row)
// but scrolls sideways instead, so it stays one 44 px row. The size
// switch is gone while the resize is disabled (see the toggle assertion
// at the end of the test).
for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
] as const) {
  test(`terminal toolbar fits without clipping at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/fake.html");
    await page.locator('[data-session="smoke"]').click();
    await expect(page.locator("#term-pane")).toBeVisible();
    // Reveal latest the way scrolling up does, so the full row is measured.
    await page.evaluate(() => {
      const latest = document.querySelector<HTMLButtonElement>("#term-latest");
      if (latest) {
        latest.hidden = false;
      }
    });
    const report = await page.evaluate(() => {
      const doc = document.scrollingElement ?? document.documentElement;
      const controls = document.querySelector(".term-controls") as HTMLElement;
      const buttons = [...controls.querySelectorAll<HTMLElement>("button")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => {
          const box = el.getBoundingClientRect();
          return {
            id: el.id,
            width: box.width,
            height: box.height,
            left: box.left,
            top: box.top,
            right: box.right,
            clipped: el.scrollWidth > el.clientWidth + 1,
          };
        });
      const toggle = document.querySelector(".term-size-toggle")?.getBoundingClientRect();
      const latestEl = document.querySelector<HTMLElement>("#term-latest");
      const latest = latestEl?.getBoundingClientRect();
      const pane = document.querySelector("#term-pane")?.getBoundingClientRect();
      const rowBox = controls.getBoundingClientRect();
      const rowStyle = getComputedStyle(controls);
      return {
        pageOverflow: doc.scrollWidth - doc.clientWidth,
        rowLeft: rowBox.left,
        rowScrollWidth: controls.scrollWidth,
        rowWrap: rowStyle.flexWrap,
        rowScroll: rowStyle.overflowX,
        rowHeight: rowBox.height,
        buttons,
        toggle: toggle ? { width: toggle.width, height: toggle.height } : null,
        latestInToolbar: latestEl?.closest(".term-controls") !== null,
        latestLabel: latestEl?.getAttribute("aria-label") ?? null,
        latest: latest
          ? { width: latest.width, height: latest.height, right: latest.right, bottom: latest.bottom, left: latest.left, top: latest.top }
          : null,
        pane: pane ? { right: pane.right, bottom: pane.bottom, left: pane.left, top: pane.top } : null,
      };
    });
    process.stdout.write(`toolbar at ${viewport.width}px: ${JSON.stringify(report)}\n`);
    await page.screenshot({ path: testInfo.outputPath(`toolbar-${viewport.width}.png`) });
    expect(report.pageOverflow).toBeLessThanOrEqual(1);
    // One toolbar row: it never wraps (nowrap), it scrolls sideways
    // instead, so every control stays at the 44 px floor on one row.
    expect(report.rowWrap).toBe("nowrap");
    expect(report.rowScroll).toBe("auto");
    expect(report.rowHeight).toBeLessThan(2 * 44);
    expect(new Set(report.buttons.map((button) => Math.round(button.top))).size).toBe(1);
    // latest floats over the card's bottom-right corner: a 44 px named
    // target inside the pane, never in the toolbar.
    expect(report.latestInToolbar).toBe(false);
    expect(report.latestLabel).toBe("Scroll to the latest output");
    const latest = report.latest;
    const pane = report.pane;
    expect(latest).not.toBeNull();
    expect(pane).not.toBeNull();
    if (latest && pane) {
      expect(latest.width).toBeGreaterThanOrEqual(44);
      expect(latest.height).toBeGreaterThanOrEqual(44);
      expect(latest.right).toBeLessThanOrEqual(pane.right);
      expect(latest.bottom).toBeLessThanOrEqual(pane.bottom);
      expect(pane.right - latest.right).toBeLessThanOrEqual(16);
      expect(pane.bottom - latest.bottom).toBeLessThanOrEqual(16);
      expect(latest.left).toBeGreaterThanOrEqual(pane.left);
      expect(latest.top).toBeGreaterThanOrEqual(pane.top);
    }
    for (const button of report.buttons) {
      expect(button.clipped, `${button.id} clips its label`).toBe(false);
      expect(button.width, `${button.id} width`).toBeGreaterThanOrEqual(44);
      expect(button.height, `${button.id} height`).toBeGreaterThanOrEqual(44);
      expect(button.left, `${button.id} left`).toBeGreaterThanOrEqual(0);
      // Past the viewport edge a button still sits inside the scrollable
      // row: one swipe reaches it.
      expect(
        button.right - report.rowLeft,
        `${button.id} inside the scrollable row`,
      ).toBeLessThanOrEqual(report.rowScrollWidth + 1);
    }
    // No size switch while the resize is disabled: neither toggle nor
    // slider is in the page.
    expect(report.toggle).toBeNull();
    await expect(page.locator("#term-control-size")).toHaveCount(0);
    await expect(page.locator("#term-size-scale")).toHaveCount(0);
  });
}
