// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

// The WebGL renderer has no .xterm-rows text, so output is asserted through
// the fake host's recorded writes, never the DOM.
async function terminalText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

/**
 * The box of `selector` once the session's own layout has stopped moving.
 * The terminal measures itself after its face loads — a row appears a moment
 * after attach — and everything below it follows. Waiting for the fit's row
 * height and two equal reads keeps an icon's before/after comparison about
 * the icon, never about that first fit.
 */
async function settledBox(
  page: import("@playwright/test").Page,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  await expect(page.locator(".term-fit")).toHaveAttribute("data-row-height", /^\d+$/);
  let previous = "";
  let stable = 0;
  await expect
    .poll(async () => {
      const next = JSON.stringify(await page.locator(selector).boundingBox());
      stable = next === previous ? stable + 1 : 0;
      previous = next;
      return stable;
    })
    .toBeGreaterThanOrEqual(2);
  // The value three reads agreed on — not a fourth that a late shift races.
  return previous === ""
    ? null
    : (JSON.parse(previous) as { x: number; y: number; width: number; height: number } | null);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/fake.html");
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
  // A fine pointer hides the key bar by default; these specs tap the keys,
  // so pin it visible the way a touch device shows it.
  if (!(await page.locator("#keybar").isVisible())) {
    await page.locator("#term-keys").click();
  }
});

test("renders the terminal and the key bar at 360x640", async ({ page }) => {
  expect(await terminalText(page)).toContain("$ muse run");
  const keys = page.locator("#keybar .key");
  await expect(keys).toHaveCount(9);
  await expect(page.locator(".topbar .login")).toHaveText("smoke");
  await expect(page.locator(".topbar .host")).toHaveText("smoke host");
  // Live output flows into the terminal.
  await page.evaluate(() => window.__fake.pushOut("live line\n"));
  await expect.poll(() => terminalText(page)).toContain("live line");
  // No horizontal page scroll outside the terminal pane.
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test("renders a character split across output frames whole", async ({ page }) => {
  // A braille spinner glyph (3 bytes) and an accented letter (2 bytes),
  // each cut inside its UTF-8 sequence: xterm keeps the state across the
  // writes, so the row shows the characters, never two replacement marks.
  await page.evaluate(() => {
    window.__fake.pushOutSplit("⠋", 1);
    window.__fake.pushOutSplit("é", 1);
  });
  await expect.poll(() => terminalText(page)).toContain("⠋é");
  const stream = await terminalText(page);
  expect(stream).not.toContain("\uFFFD");
  expect(stream.endsWith("⠋é")).toBe(true);
});

test("renders a legible 80-column session at 390x844", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The terminal opens only after the real face is loaded (or the 1.5 s
  // fallback fired), so this is the face the cell size was measured with.
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('14px "JetBrains Mono"')))
    .toBe(true);
  // ...and it is the self-hosted face, not a family the browser made up.
  const faces = await page.evaluate(() =>
    Array.from(document.fonts).map((face) => ({
      family: face.family.replace(/"/g, ""),
      status: face.status,
    })),
  );
  expect(faces).toContainEqual({ family: "JetBrains Mono", status: "loaded" });
  // Always fitted: the terminal fits the pane by itself, so the rightmost
  // column reads with no manual step. Glyph legibility itself is the
  // sibling spec's font-size concern, not a scale floor.
  await expect
    .poll(() =>
      page.evaluate(() => {
        if (innerWidth !== 390) {
          return 99;
        }
        const pane = document.querySelector(".term-pane") as HTMLElement | null;
        const fit = document.querySelector(".term-fit") as HTMLElement | null;
        if (!pane || !fit) {
          return 99;
        }
        if (!(Number(fit.dataset.scale) > 0)) {
          return 99;
        }
        return pane.scrollWidth - pane.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(1);
  const measured = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    const fit = document.querySelector(".term-fit") as HTMLElement;
    const scaler = document.querySelector(".term-scale") as HTMLElement;
    const doc = document.scrollingElement ?? document.documentElement;
    const style = getComputedStyle(pane);
    const paneBox = pane.getBoundingClientRect();
    const scalerBox = scaler.getBoundingClientRect();
    return {
      fontOk: document.fonts.check('14px "JetBrains Mono"'),
      scale: Number(fit.dataset.scale),
      pageOverflow: doc.scrollWidth - doc.clientWidth,
      paneScroll: pane.scrollWidth - pane.clientWidth,
      scrollLeft: pane.scrollLeft,
      scalerLeft: scalerBox.left,
      scalerRight: scalerBox.right,
      contentLeft:
        paneBox.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      contentRight:
        paneBox.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
      panePadding: parseFloat(style.paddingLeft),
    };
  });
  expect(measured.fontOk).toBe(true);
  expect(measured.scale).toBeGreaterThan(0);
  // The session fits inside its card with the line start at the left edge;
  // the page itself never scrolls sideways.
  expect(measured.paneScroll).toBeLessThanOrEqual(1);
  expect(measured.pageOverflow).toBeLessThanOrEqual(1);
  expect(measured.scrollLeft).toBeLessThanOrEqual(1);
  expect(measured.scalerLeft).toBeGreaterThanOrEqual(measured.contentLeft - 1);
  expect(measured.scalerRight).toBeLessThanOrEqual(measured.contentRight + 1);
  const shot = await page.screenshot({ path: testInfo.outputPath("session-390x844.png") });
  await testInfo.attach("session-390x844", { body: shot, contentType: "image/png" });
});

test("keeps the terminal text off its border at 1280x900", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const padding = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    const style = getComputedStyle(pane);
    return {
      top: parseFloat(style.paddingTop),
      left: parseFloat(style.paddingLeft),
      right: parseFloat(style.paddingRight),
      bottom: parseFloat(style.paddingBottom),
    };
  });
  expect(Math.min(padding.top, padding.left, padding.right, padding.bottom)).toBeGreaterThanOrEqual(
    8,
  );
});

test("shows all nine keys inside the viewport at 360x640", async ({ page }) => {
  const keys = page.locator("#keybar .key");
  await expect(keys).toHaveCount(9);
  // The keybar follows the terminal's first fit, which lands after its
  // face loads — measuring before that blames the placeholder height
  // (the 46dvh fallback) for keys the settled layout holds in view.
  await settledBox(page, "#keybar");
  const boxes = await keys.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    }),
  );
  // Two rows of equal-width keys (five, then four), every one a touch
  // target in view.
  const rows = [...new Set(boxes.map((box) => Math.round(box.y)))].sort((a, b) => a - b);
  expect(rows).toHaveLength(2);
  const first = boxes.filter((box) => Math.round(box.y) === rows[0]);
  const second = boxes.filter((box) => Math.round(box.y) === rows[1]);
  expect(first).toHaveLength(5);
  expect(second).toHaveLength(4);
  for (const row of [first, second]) {
    for (const box of row) {
      expect(Math.abs(box.width - row[0]!.width)).toBeLessThanOrEqual(1);
    }
  }
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.right).toBeLessThanOrEqual(360);
    expect(box.bottom).toBeLessThanOrEqual(640);
  }
});

test("dresses the page in the Canopy surface", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-surface", "tui");
  // The honeycomb mounts lazily after the header paints.
  await expect.poll(() => page.locator(".topbar > #fondo canvas").count()).toBeGreaterThan(0);
  const look = await page.evaluate(() => {
    const host = document.getElementById("fondo");
    const bar = document.querySelector(".topbar");
    const hostBox = host?.getBoundingClientRect();
    const barBox = bar?.getBoundingClientRect();
    return {
      body: getComputedStyle(document.body).backgroundColor,
      view: document.body.dataset.view ?? null,
      fondo: {
        mounted: host?.querySelector("canvas") !== null,
        inHeader: host?.parentElement?.classList.contains("topbar") ?? false,
        position: host ? getComputedStyle(host).position : null,
        inside:
          hostBox !== undefined &&
          barBox !== undefined &&
          hostBox.top >= barBox.top - 1 &&
          hostBox.bottom <= barBox.bottom + 1,
      },
      fixedCanvases: [...document.querySelectorAll("canvas")].filter(
        (canvas) => getComputedStyle(canvas).position === "fixed",
      ).length,
    };
  });
  // #011d1c, the flat deep surface: the body carries no honeycomb.
  expect(look.body).toBe("rgb(1, 29, 28)");
  expect(look.view).toBe("session");
  // The honeycomb lives inside the sticky header band only.
  expect(look.fondo.mounted).toBe(true);
  expect(look.fondo.inHeader).toBe(true);
  expect(look.fondo.position).toBe("absolute");
  expect(look.fondo.inside).toBe(true);
  expect(look.fixedCanvases).toBe(0);
});

for (const viewport of [
  { label: "390x844", width: 390, height: 844 },
  { label: "1280x900", width: 1280, height: 900 },
] as const) {
  test(`stages the terminal on black with no teal call-to-action at ${viewport.label}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // The terminal pane is the black stage: rgb(5, 5, 5).
    const pane = await page.evaluate(
      () => getComputedStyle(document.querySelector(".term-pane") as HTMLElement).backgroundColor,
    );
    expect(pane).toBe("rgb(5, 5, 5)");
    // No teal-filled button in the session view at rest: the terminal is
    // the input now, and only a pressed latch fills teal — rgb(63, 184, 176).
    const teal = await page.evaluate(() =>
      [...document.querySelectorAll("main.session-view button")]
        .filter((button) => getComputedStyle(button).backgroundColor === "rgb(63, 184, 176)")
        .map((button) => button.className),
    );
    expect(teal).toEqual([]);
    const shot = await page.screenshot({ path: testInfo.outputPath(`stage-${viewport.label}.png`) });
    await testInfo.attach(`stage-${viewport.label}`, { body: shot, contentType: "image/png" });
  });

  test(`links home from the header banner at ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // The header banner: an SVG on a fixed grid, one line group per art
    // line, named for assistive tech; no header link points at the
    // Canopy landing.
    const home = page.locator(".topbar #brand-home");
    await expect(home).toHaveAttribute("aria-label", "Canopy remote, home");
    const banner = home.locator("svg.look-banner-header");
    await expect(banner).toHaveAttribute("role", "img");
    await expect(banner).toHaveAttribute("aria-label", "Canopy remote");
    await expect(home.locator(".look-banner-line")).toHaveCount(11);
    await expect(page.locator(".topbar a[href*='univerlab.org/canopy']")).toHaveCount(0);
    // About 160 px tall on desktop, 96 px on the phone.
    const art = await banner.boundingBox();
    expect(art).not.toBeNull();
    expect(Math.abs((art?.height ?? 0) - (viewport.width < 640 ? 96 : 160))).toBeLessThanOrEqual(5);
    // No body banner anywhere; the sessions start under the header.
    await expect(page.locator("main .look-banner")).toHaveCount(0);
    // From the session, the banner goes home to the sessions list.
    await home.click();
    await expect(page.locator("main.sessions")).toBeVisible();
    await expect(page.locator("main .look-banner")).toHaveCount(0);
    const fit = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(fit).toBeLessThanOrEqual(1);
    const shot = await page.screenshot({ path: testInfo.outputPath(`banner-${viewport.label}.png`) });
    await testInfo.attach(`banner-${viewport.label}`, { body: shot, contentType: "image/png" });
  });
}

test("puts the banner on its own row and keeps the login inside at 390x844", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The banner owns the header's first row (275 px on a phone), so a long
  // GitHub login wraps below it, keeping its right edge inside the bar
  // instead of being pushed out.
  const boxes = await page.evaluate(() => {
    const login = document.querySelector(".topbar .login") as HTMLElement;
    login.textContent = "a-very-long-github-username-1234567890";
    const bar = document.querySelector(".topbar") as HTMLElement;
    const banner = bar.querySelector(".look-banner-header") as HTMLElement;
    return {
      overflow: bar.scrollWidth - bar.clientWidth,
      barRight: Math.round(bar.getBoundingClientRect().right),
      loginRight: Math.round(login.getBoundingClientRect().right),
      bannerBottom: Math.round(banner.getBoundingClientRect().bottom),
      loginTop: Math.round(login.getBoundingClientRect().top),
      loginWidth: Math.round(login.getBoundingClientRect().width),
      rowWidth: Math.round(bar.clientWidth),
    };
  });
  expect(boxes.overflow).toBeLessThanOrEqual(0);
  expect(boxes.loginRight).toBeLessThanOrEqual(boxes.barRight);
  expect(boxes.loginTop).toBeGreaterThanOrEqual(boxes.bannerBottom);
  expect(boxes.loginWidth).toBeLessThanOrEqual(boxes.rowWidth);
});

test("stacks the banner over a centred chips row at 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => {
    const banner = document.querySelector(".topbar .look-banner-header") as HTMLElement;
    const bannerBox = banner.getBoundingClientRect();
    const chips = [...document.querySelectorAll(".topbar-inner > :not(#brand-home)")].map(
      (chip) => {
        const box = chip.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
      },
    );
    const el = document.scrollingElement ?? document.documentElement;
    return {
      view: window.innerWidth,
      bannerCenter: bannerBox.left + bannerBox.width / 2,
      bannerBottom: bannerBox.bottom,
      chips,
      overflow: el.scrollWidth - el.clientWidth,
    };
  });
  // Row 1: the banner sits on the viewport's centre line.
  expect(Math.abs(layout.bannerCenter - layout.view / 2)).toBeLessThanOrEqual(3);
  // Row 2: every chip starts below the banner, and each wrapped row is
  // centred; the page never scrolls sideways.
  expect(layout.chips.length).toBeGreaterThan(0);
  const rows = new Map<number, { left: number; right: number }>();
  for (const chip of layout.chips) {
    expect(chip.top).toBeGreaterThanOrEqual(layout.bannerBottom);
    expect(chip.left).toBeGreaterThanOrEqual(-1);
    expect(chip.right).toBeLessThanOrEqual(layout.view + 1);
    const key = Math.round(chip.top);
    const row = rows.get(key) ?? { left: chip.left, right: chip.right };
    row.left = Math.min(row.left, chip.left);
    row.right = Math.max(row.right, chip.right);
    rows.set(key, row);
  }
  for (const row of rows.values()) {
    expect(Math.abs((row.left + row.right) / 2 - layout.view / 2)).toBeLessThanOrEqual(4);
  }
  expect(layout.overflow).toBeLessThanOrEqual(1);
});

test("keeps the banner left-aligned on the first row at 1280x900", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  // Desktop keeps the current single-row header: the banner stays
  // left-aligned beside the chips instead of stacking centred above them.
  const layout = await page.evaluate(() => {
    const inner = document.querySelector(".topbar-inner") as HTMLElement;
    const home = document.querySelector(".topbar #brand-home") as HTMLElement;
    const first = document.querySelector(".topbar-inner > :not(#brand-home)") as HTMLElement;
    const innerBox = inner.getBoundingClientRect();
    const homeBox = home.getBoundingClientRect();
    const firstBox = first.getBoundingClientRect();
    return {
      innerLeft: innerBox.left + parseFloat(getComputedStyle(inner).paddingLeft),
      home: { left: homeBox.left, top: homeBox.top, bottom: homeBox.bottom },
      first: { top: firstBox.top, bottom: firstBox.bottom },
    };
  });
  expect(Math.abs(layout.home.left - layout.innerLeft)).toBeLessThanOrEqual(1);
  expect(layout.first.top).toBeGreaterThanOrEqual(layout.home.top - 1);
  expect(layout.first.bottom).toBeLessThanOrEqual(layout.home.bottom + 1);
});

test("puts the Content textarea full width in its card", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#term-builder").click();
  await expect(page.locator("#builder-form")).toBeVisible();
  const measured = await page.evaluate(() => {
    const card = document.querySelector(".builder-section") as HTMLElement;
    const area = document.querySelector(".section-content") as HTMLTextAreaElement;
    const style = getComputedStyle(card);
    const contentWidth =
      card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { contentWidth, areaWidth: area.getBoundingClientRect().width };
  });
  expect(Math.abs(measured.areaWidth - measured.contentWidth)).toBeLessThanOrEqual(1);
  const shot = await page.screenshot({ path: testInfo.outputPath("builder-390x844.png") });
  await testInfo.attach("builder-390x844", { body: shot, contentType: "image/png" });
});

test("builder picks sections by kind at 390x844", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#term-builder").click();
  await expect(page.locator("#builder-form")).toBeVisible();
  // One Instruction section, no free title field.
  await expect(page.locator(".section-kind")).toHaveValue("instruction");
  await expect(page.locator(".section-title")).toHaveCount(0);
  // Add section offers the six kinds; choosing appends that kind.
  await expect(page.locator("#builder-add-section option")).toHaveCount(7);
  await page.locator("#builder-add-section").selectOption("goal");
  await expect(page.locator(".builder-section")).toHaveCount(2);
  await expect(page.locator('.section-kind[data-index="1"]')).toHaveValue("goal");
  // The kind selector and the textarea stack full width in the card, like
  // the preset control spans the form; move/remove stay inside the page.
  const measured = await page.evaluate(() => {
    const card = document.querySelector(".builder-section") as HTMLElement;
    const select = document.querySelector(".section-kind") as HTMLSelectElement;
    const area = document.querySelector(".section-content") as HTMLTextAreaElement;
    const preset = document.querySelector("#builder-preset") as HTMLSelectElement;
    const add = document.querySelector("#builder-add-section") as HTMLSelectElement;
    const cardStyle = getComputedStyle(card);
    const cardContent =
      card.clientWidth - parseFloat(cardStyle.paddingLeft) - parseFloat(cardStyle.paddingRight);
    const selectBox = select.getBoundingClientRect();
    const areaBox = area.getBoundingClientRect();
    const presetBox = preset.getBoundingClientRect();
    const addBox = add.getBoundingClientRect();
    const form = document.querySelector("#builder-form") as HTMLElement;
    const actions = [...document.querySelectorAll(".section-actions button")].map((button) => {
      const box = button.getBoundingClientRect();
      return { left: box.left, right: box.right };
    });
    return {
      cardContent,
      selectWidth: selectBox.width,
      areaWidth: areaBox.width,
      stacked: selectBox.bottom <= areaBox.top,
      sameLeft: Math.abs(selectBox.left - areaBox.left),
      presetWidth: presetBox.width,
      addWidth: addBox.width,
      formWidth: form.clientWidth,
      actions,
    };
  });
  expect(Math.abs(measured.selectWidth - measured.cardContent)).toBeLessThanOrEqual(1);
  expect(Math.abs(measured.areaWidth - measured.cardContent)).toBeLessThanOrEqual(1);
  expect(measured.stacked).toBe(true);
  expect(measured.sameLeft).toBeLessThanOrEqual(1);
  expect(Math.abs(measured.presetWidth - measured.formWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(measured.addWidth - measured.formWidth)).toBeLessThanOrEqual(1);
  for (const box of measured.actions) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390);
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  const shot = await page.screenshot({ path: testInfo.outputPath("builder-kinds-390x844.png") });
  await testInfo.attach("builder-kinds-390x844", { body: shot, contentType: "image/png" });
});

test("terminal pans when zoomed", async ({ page }) => {
  // Always fitted, so only the zoom makes it overflow.
  await page.locator("#term-zoom-in").click();
  await page.locator("#term-zoom-in").click();
  const pan = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    return {
      overflow: getComputedStyle(pane).overflowX,
      larger: pane.scrollWidth > pane.clientWidth,
    };
  });
  // Zoomed content exceeds the pane, and the pane lets the user pan it.
  expect(pan.larger).toBe(true);
  expect(["auto", "scroll"]).toContain(pan.overflow);
});

test("the Keys switch hides the bar and remembers the choice across reload", async ({ page }) => {
  const bar = page.locator("#keybar");
  const toggle = page.locator("#term-keys");
  // The beforeEach pinned the bar visible.
  await expect(bar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(bar).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  // Only the key bar goes: zoom and builder stay.
  await expect(page.locator("#term-zoom-in")).toBeVisible();
  await expect(page.locator("#term-builder")).toBeVisible();
  // The choice survives a reload.
  await page.reload();
  await expect(page.locator('[data-session="smoke"]')).toBeVisible();
  await page.locator('[data-session="smoke"]').click();
  await expect(page.locator("#term-keys")).toBeVisible();
  await expect(page.locator("#keybar")).toBeHidden();
  await expect(page.locator("#term-keys")).toHaveAttribute("aria-pressed", "false");
});

for (const viewport of [
  { label: "390x844", width: 390, height: 844 },
  { label: "1280x900", width: 1280, height: 900 },
] as const) {
  test(`morphs the session's icons at ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    // The host chip reads the link: wifi while connected.
    await expect(page.locator("#conn-icon")).toHaveAttribute("data-icon", "wifi");
    // The Builder button wears the blocks icon beside its label.
    await expect(page.locator("#term-builder svg.icon")).toBeVisible();
    await expect(page.locator("#term-builder")).toContainText("Builder");

    // The Ctrl latch: a filled teal button, with no circle or dot icon.
    const ctrl = page.locator('#keybar .key[data-key="ctrl"]');
    await expect(page.locator("#keybar .latch-icon")).toHaveCount(0);
    await expect(page.locator('#keybar [data-icon="circle"], #keybar [data-icon="circleDot"]')).toHaveCount(0);
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");
    await ctrl.click();
    await expect(ctrl).toHaveAttribute("aria-pressed", "true");
    const pressedFill = await ctrl.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(pressedFill).not.toBe("rgba(0, 0, 0, 0)");
    const latchShot = await page.screenshot({ path: testInfo.outputPath(`latch-fill-${viewport.label}.png`) });
    await testInfo.attach(`latch-fill-${viewport.label}`, { body: latchShot, contentType: "image/png" });
  });

  test(`connects, kills and lists sessions with their icons at ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // The header says the link is up.
    await expect(page.locator("#conn-icon")).toHaveAttribute("data-icon", "wifi");
    await page.locator("#session-back").click();
    // The session row says what it is, and New wears its plus.
    await expect(page.locator('[data-session="smoke"] .session-kind')).toHaveAttribute("data-kind", "bot");
    await expect(page.locator("#session-new svg.icon")).toBeVisible();
    // A terminal spawned from the dialog is a square terminal.
    await page.locator("#session-new").click();
    await page.locator("#new-kind-terminal").check();
    await page.locator("#new-directory").fill("/tmp");
    await page.locator("#new-create").click();
    await expect(page.locator("main.session-view")).toBeVisible();
    await page.locator("#session-back").click();
    const spawned = page.locator('[data-session="spawned-1"] .session-kind');
    await expect(spawned).toHaveAttribute("data-kind", "squareTerminal");
  });
}

test("sends key bar bytes as input", async ({ page }) => {
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator('#keybar .key[data-key="tab"]').click();
  await page.locator('#keybar .key[data-key="up"]').click();
  const sent = await page.evaluate(() => window.__fake.sent());
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "CQ==" });
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "G1tB" });
});

test("latches Ctrl so the keyboard's c sends 0x03", async ({ page }) => {
  await page.evaluate(() => window.__fake.clearSent());
  const ctrl = page.locator('#keybar .key[data-key="ctrl"]');
  await ctrl.click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  // Focus xterm's hidden textarea and type: the latch turns c into 0x03.
  await page.locator(".xterm-helper-textarea").press("c");
  const sent = await page.evaluate(() => window.__fake.sent());
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "Aw==" });
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
});

test("spawns a terminal from the New dialog", async ({ page }) => {
  await page.locator("#session-back").click();
  await page.locator("#session-new").click();
  await expect(page.locator("#new-form")).toBeVisible();
  await page.locator("#new-kind-terminal").check();
  await expect(page.locator("#new-cli")).toBeHidden();
  await page.locator("#new-directory").fill("/tmp");
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator("#new-create").click();
  const sent = await page.evaluate(() => window.__fake.sent());
  const spawn = (sent as Record<string, unknown>[]).find((frame) => frame.t === "spawn");
  expect(spawn).toMatchObject({ t: "spawn", kind: "terminal", workdir: "/tmp" });
  expect(spawn).not.toHaveProperty("cli");
  expect(spawn).not.toHaveProperty("prompt");
  expect(spawn).not.toHaveProperty("yolo");
  // The fake host answers spawned and the shell opens the session.
  await expect(page.locator("main.session-view > .flash-ok")).toHaveText("Session started");
  // The confirmation's check is an icon beside the words.
  await expect(page.locator("main.session-view > .flash-ok svg.icon")).toBeVisible();
});

test("typing in the terminal reaches the host as input bytes", async ({ page }) => {
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator(".xterm-helper-textarea").press("l");
  await page.locator(".xterm-helper-textarea").press("s");
  const sent = await page.evaluate(() => window.__fake.sent());
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "bA==" });
  expect(sent).toContainEqual({ t: "input", id: "smoke", data: "cw==" });
});

test("tapping the terminal pane focuses xterm", async ({ page }) => {
  // The attach focuses xterm on this fine-pointer browser; blur first so
  // the tap below proves the pane focuses it, not the attach.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
  // The pane's own padding, not the terminal: (4, 4) sits inside the 8 px
  // inset, off the fitted terminal.
  await page.locator("#term-pane").click({ position: { x: 4, y: 4 } });
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
});

test("gives the terminal pane the freed height at 360x640", async ({ page }) => {
  // The default viewport is already 360x640; the beforeEach pinned the
  // key bar visible the way a touch device shows it.
  await settledBox(page, "#keybar");
  const layout = await page.evaluate(() => {
    const pane = document.querySelector("#term-pane") as HTMLElement;
    const paneBox = pane.getBoundingClientRect();
    const style = getComputedStyle(pane);
    const size = document.querySelector(".term-size") as HTMLElement;
    return {
      paneHeight: paneBox.height,
      visualHeight: Number(pane.style.getPropertyValue("--term-visual-h").replace("px", "")),
      chrome:
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.borderBottomWidth),
      keyBottoms: [...document.querySelectorAll("#keybar .key")].map(
        (key) => key.getBoundingClientRect().bottom,
      ),
      sizeBottom: size.getBoundingClientRect().bottom,
      textareas: document.querySelectorAll("main.session-view textarea").length,
      helperTextareas: document.querySelectorAll(".xterm-helper-textarea").length,
    };
  });
  // The pane stands taller than the fitted terminal it holds: the floor
  // engaged, so the terminal took height instead of a second input.
  expect(layout.visualHeight).toBeGreaterThan(0);
  expect(layout.paneHeight - layout.chrome).toBeGreaterThan(layout.visualHeight);
  // ...while every key and the whole size row stay inside the viewport.
  expect(layout.keyBottoms).toHaveLength(9);
  for (const bottom of layout.keyBottoms) {
    expect(bottom).toBeLessThanOrEqual(640);
  }
  expect(layout.sizeBottom).toBeLessThanOrEqual(640);
  // xterm's hidden textarea is the only text input left in the view.
  expect(layout.textareas).toBe(1);
  expect(layout.helperTextareas).toBe(1);
});

test("builder sends the draft and closes on ok", async ({ page }) => {
  await page.locator("#term-builder").click();
  await expect(page.locator("#builder-form")).toBeVisible();
  await page.locator(".section-content").fill("ship it");
  await page.evaluate(() => window.__fake.clearSent());
  await page.locator("#builder-send").click();
  const sent = await page.evaluate(() => window.__fake.sent());
  const prompt = (sent as Record<string, unknown>[]).find((frame) => frame.t === "prompt");
  expect(prompt).toMatchObject({ t: "prompt", id: "smoke" });
  // The draft form, never the removed text form.
  expect(prompt).not.toHaveProperty("text");
  const draft = prompt?.draft as { sections: { title: string; content: string }[] };
  expect(draft.sections).toHaveLength(1);
  expect(draft.sections[0]?.content).toBe("ship it");
  await expect(page.locator("#builder-form")).toHaveCount(0);
});

test("builder keeps the draft and shows the error", async ({ page }) => {
  await page.evaluate(() => window.__fake.failNextPrompt("delivery_failed", "host is gone"));
  await page.locator("#term-builder").click();
  await expect(page.locator("#builder-form")).toBeVisible();
  await page.locator(".section-content").fill("ship it");
  await page.locator("#builder-send").click();
  await expect(page.locator("#builder-error")).toHaveText("host is gone");
  await expect(page.locator(".section-content")).toHaveValue("ship it");
});

// --- The session shelf (hello.features "shelf") -------------------------

async function horizontalOverflow(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

async function gridColumns(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.querySelector(".shelf-grid") as Element | null;
    if (!grid) {
      return 0;
    }
    return getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
  });
}

test("shelf badge, sheet and viewer at 390x844", async ({ page }, testInfo) => {
  const badge = page.locator("#session-files-badge");
  // Nothing is unseen until the host pushes a file two seconds after attach.
  await expect(badge).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("1");
  const pushedShot = await page.screenshot({
    path: testInfo.outputPath("shelf-badge-390x844.png"),
  });
  await testInfo.attach("shelf-badge-390x844", { body: pushedShot, contentType: "image/png" });

  await expect(page.locator("#session-files-icon")).toHaveAttribute("data-icon", "folder");
  await page.locator("#session-files").click();
  await expect(page.locator(".shelf-cell")).toHaveCount(4);
  // The folder opens with the sheet.
  await expect(page.locator("#session-files-icon")).toHaveAttribute("data-icon", "folderOpen");
  // The shelf was looked at, so the badge clears as the sheet opens.
  await expect(badge).toBeHidden();
  // Two columns on a phone.
  expect(await gridColumns(page)).toBe(2);
  const sheetShot = await page.screenshot({
    path: testInfo.outputPath("shelf-sheet-390x844.png"),
  });
  await testInfo.attach("shelf-sheet-390x844", { body: sheetShot, contentType: "image/png" });
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  // The SVG is a file like any other: fetched once, shown through an img.
  const svg = page.locator('.shelf-cell[title="layout.svg"] img');
  await expect(svg).toBeVisible();
  await expect
    .poll(() => svg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  expect(await svg.getAttribute("src")).toMatch(/^blob:/);
  // Never inlined, never in a frame.
  expect(await page.locator(".sheet object, .sheet iframe, .sheet embed").count()).toBe(0);

  // The viewer opens on a tap and closes on Esc, leaving the sheet up.
  await page.locator('.shelf-cell[title="layout.svg"]').click();
  await expect(page.locator("#shelf-viewer")).toBeVisible();
  await expect(page.locator("#shelf-viewer-img")).toBeVisible();
  await expect(page.locator("#shelf-count")).toHaveText("3 / 4");
  const viewerShot = await page.screenshot({
    path: testInfo.outputPath("shelf-viewer-390x844.png"),
  });
  await testInfo.attach("shelf-viewer-390x844", { body: viewerShot, contentType: "image/png" });
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#shelf-viewer")).toBeHidden();
  await expect(page.locator(".shelf-cell")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-sheet="shelf"]')).toBeHidden();
});

test("shelf grid, arrow steps and list counts at 1280x900", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const badge = page.locator("#session-files-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("1");

  await page.locator("#session-files").click();
  await expect(page.locator(".shelf-cell")).toHaveCount(4);
  // Four columns from 900 px up.
  expect(await gridColumns(page)).toBe(4);
  await expect(page.locator('.shelf-cell[title="gradient.png"] img')).toBeVisible();
  await expect(page.locator('.shelf-cell[title="layout.svg"] img')).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  // The viewer steps with the arrow keys and downloads the blob URL.
  await page.locator(".shelf-cell").first().click();
  await expect(page.locator("#shelf-viewer")).toBeVisible();
  await expect(page.locator("#shelf-count")).toHaveText("1 / 4");
  await expect(page.locator("#shelf-download")).toHaveAttribute("href", /^blob:/);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#shelf-count")).toHaveText("2 / 4");
  const viewerShot = await page.screenshot({
    path: testInfo.outputPath("shelf-viewer-1280x900.png"),
  });
  await testInfo.attach("shelf-viewer-1280x900", { body: viewerShot, contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(page.locator("#shelf-viewer")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-sheet="shelf"]')).toBeHidden();

  // The session list carries the counts: one 📎 per row plus the host's own.
  await page.locator("#session-back").click();
  await expect(page.locator("#host-shelf-row")).toBeVisible();
  await expect(page.locator("#host-shelf-row .session-files-count")).toHaveText("1");
  await expect(page.locator('[data-session="smoke"] .session-files-count')).toHaveText("4");
  // The count's folder is an icon, not a glyph in the text.
  await expect(page.locator("#host-shelf-row .session-files svg.icon")).toBeVisible();
  const listShot = await page.screenshot({
    path: testInfo.outputPath("shelf-list-1280x900.png"),
  });
  await testInfo.attach("shelf-list-1280x900", { body: listShot, contentType: "image/png" });
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

  // The Shelf row opens the same sheet over the host's own files.
  await page.locator("#host-shelf-row").click();
  await expect(page.locator(".shelf-cell")).toHaveCount(1);
  await expect(page.locator('.shelf-cell[title="host-mark.png"] img')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-sheet="shelf"]')).toBeHidden();
});
