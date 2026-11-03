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
  // Zoom out, zoom in, Keys, Builder, and the nine keys; latest stays
  // hidden until the user scrolls up.
  expect(barBoxes).toHaveLength(13);
  for (const control of barBoxes) {
    expect(control.width, `${control.label} width`).toBeGreaterThanOrEqual(44);
    expect(control.height, `${control.label} height`).toBeGreaterThanOrEqual(44);
  }
});
