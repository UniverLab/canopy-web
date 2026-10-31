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
  // Fit off (the default): the readable floor keeps a row at 11 CSS px.
  await expect
    .poll(() =>
      page.evaluate(() => {
        if (innerWidth !== 390) {
          return 0;
        }
        const fit = document.querySelector(".term-fit") as HTMLElement | null;
        const screen = document.querySelector(".xterm-screen") as HTMLElement | null;
        if (!fit || !screen) {
          return 0;
        }
        return (screen.offsetHeight / 24) * Number(fit.dataset.scale);
      }),
    )
    .toBeGreaterThanOrEqual(11);
  const measured = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    const fit = document.querySelector(".term-fit") as HTMLElement;
    const screen = document.querySelector(".xterm-screen") as HTMLElement;
    const doc = document.scrollingElement ?? document.documentElement;
    const style = getComputedStyle(pane);
    return {
      fontOk: document.fonts.check('14px "JetBrains Mono"'),
      fit: fit.dataset.fit,
      rowHeight: (screen.offsetHeight / 24) * Number(fit.dataset.scale),
      pageOverflow: doc.scrollWidth - doc.clientWidth,
      paneScroll: pane.scrollWidth - pane.clientWidth,
      panePadding: parseFloat(style.paddingLeft),
    };
  });
  expect(measured.fontOk).toBe(true);
  expect(measured.fit).toBe("off");
  expect(measured.rowHeight).toBeGreaterThanOrEqual(11);
  // The session pans inside its card; the page itself never scrolls sideways.
  expect(measured.paneScroll).toBeGreaterThan(0);
  expect(measured.pageOverflow).toBeLessThanOrEqual(1);
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
  const look = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    view: document.body.dataset.view ?? null,
    fondo: (() => {
      const host = document.getElementById("fondo");
      return {
        mounted: host?.querySelector("canvas") !== null,
        opacity: host === null ? null : getComputedStyle(host).opacity,
      };
    })(),
  }));
  // #012624, the Liquid Abyss canvas of the Canopy page.
  expect(look.body).toBe("rgb(1, 38, 36)");
  expect(look.view).toBe("session");
  // The honeycomb is behind the session, dimmed so the terminal stays legible.
  expect(look.fondo.mounted).toBe(true);
  expect(look.fondo.opacity).toBe("0.15");
});

for (const viewport of [
  { label: "390x844", width: 390, height: 844 },
  { label: "1280x900", width: 1280, height: 900 },
] as const) {
  test(`stages the terminal on black with one teal Send at ${viewport.label}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // The terminal pane is the black stage: rgb(5, 5, 5).
    const pane = await page.evaluate(
      () => getComputedStyle(document.querySelector(".term-pane") as HTMLElement).backgroundColor,
    );
    expect(pane).toBe("rgb(5, 5, 5)");
    // Send is the only teal-filled button in the session view: rgb(63, 184, 176).
    const teal = await page.evaluate(() =>
      [...document.querySelectorAll("main.session-view button")]
        .filter((button) => getComputedStyle(button).backgroundColor === "rgb(63, 184, 176)")
        .map((button) => button.className),
    );
    expect(teal).toEqual(["composer-send"]);
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

test("puts the banner on its own row and keeps the connection chip at 390x844", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The banner owns the header's first row (275 px on a phone), so a long
  // GitHub login wraps below it with the connection state — the state
  // keeps its right edge inside the bar instead of being pushed out.
  const boxes = await page.evaluate(() => {
    const login = document.querySelector(".topbar .login") as HTMLElement;
    login.textContent = "a-very-long-github-username-1234567890";
    const bar = document.querySelector(".topbar") as HTMLElement;
    const conn = bar.querySelector(".conn") as HTMLElement;
    const banner = bar.querySelector(".look-banner-header") as HTMLElement;
    return {
      overflow: bar.scrollWidth - bar.clientWidth,
      barRight: Math.round(bar.getBoundingClientRect().right),
      connRight: Math.round(conn.getBoundingClientRect().right),
      bannerBottom: Math.round(banner.getBoundingClientRect().bottom),
      loginTop: Math.round(login.getBoundingClientRect().top),
      loginWidth: Math.round(login.getBoundingClientRect().width),
      rowWidth: Math.round(bar.clientWidth),
    };
  });
  expect(boxes.overflow).toBeLessThanOrEqual(0);
  expect(boxes.connRight).toBeLessThanOrEqual(boxes.barRight);
  expect(boxes.loginTop).toBeGreaterThanOrEqual(boxes.bannerBottom);
  expect(boxes.loginWidth).toBeLessThanOrEqual(boxes.rowWidth);
});

test("puts the Content textarea full width in its card", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".composer-builder").click();
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
  await page.locator(".composer-builder").click();
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
  const fit = page.locator("#term-fit");
  await expect(fit).toHaveAttribute("aria-pressed", "false");
  // Fit on: pure fit-to-width, so only the zoom makes it overflow.
  await fit.click();
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  await page.locator("#term-zoom-in").click();
  await page.locator("#term-zoom-in").click();
  const pan = await page.evaluate(() => {
    const pane = document.querySelector(".term-pane") as HTMLElement;
    return {
      overflow: getComputedStyle(pane).overflowX,
      larger: pane.scrollWidth > pane.clientWidth,
      fit: (document.querySelector(".term-fit") as HTMLElement).dataset.fit,
    };
  });
  // Zoomed content exceeds the pane, and the pane lets the user pan it.
  expect(pan.fit).toBe("on");
  expect(pan.larger).toBe(true);
  expect(["auto", "scroll"]).toContain(pan.overflow);
});

for (const viewport of [
  { label: "390x844", width: 390, height: 844 },
  { label: "1280x900", width: 1280, height: 900 },
] as const) {
  test(`morphs the session's icons at ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    // The host chip reads the link: wifi while connected.
    await expect(page.locator("#conn-icon")).toHaveAttribute("data-icon", "wifi");

    const send = page.locator(".composer-send");
    const icon = send.locator(".icon-slot");
    await expect(icon).toHaveAttribute("data-icon", "send");
    // The terminal reports its row height once it has measured itself, and
    // the composer below it settles a moment later. Measuring before that
    // would blame the session's own fit for an icon-sized move. The box is
    // page-relative: the header banner makes a 900 px page scroll when the
    // composer takes focus, and that scroll is not the icon moving.
    const inPage = (): Promise<{ x: number; y: number; width: number; height: number }> =>
      page.evaluate(() => {
        const slot = document.querySelector(".composer-send .icon-slot") as HTMLElement;
        const box = slot.getBoundingClientRect();
        return { x: box.x, y: box.y + window.scrollY, width: box.width, height: box.height };
      });
    const settled = await settledBox(page, ".composer-send .icon-slot");
    expect(settled).not.toBeNull();
    const before = await inPage();

    // Send → (loader while the frame is out) → check on the host's ok.
    await page.locator(".composer-input").fill("do the thing");
    await send.click();
    await expect(icon).toHaveAttribute("data-icon", "check", { timeout: 10_000 });
    await expect(page.locator(".composer-ok")).toContainText("Sent");
    await expect(page.locator(".composer-ok svg.icon")).toBeVisible();
    expect(await inPage()).toEqual(before);
    const sentShot = await page.screenshot({ path: testInfo.outputPath(`morph-sent-${viewport.label}.png`) });
    await testInfo.attach(`morph-sent-${viewport.label}`, { body: sentShot, contentType: "image/png" });

    // Error → x, and the one icon that wears red.
    await page.evaluate(() => window.__fake.failNextPrompt("delivery_failed", "host is gone"));
    await page.locator(".composer-input").fill("do it again");
    await send.click();
    await expect(icon).toHaveAttribute("data-icon", "x", { timeout: 10_000 });
    expect(await icon.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 107, 107)");
    expect(await inPage()).toEqual(before);
    const errorShot = await page.screenshot({ path: testInfo.outputPath(`morph-error-${viewport.label}.png`) });
    await testInfo.attach(`morph-error-${viewport.label}`, { body: errorShot, contentType: "image/png" });

    // The Ctrl latch: a circle that fills to a dot, in place.
    const latch = page.locator('#keybar .key[data-key="ctrl"] .latch-icon');
    await expect(latch).toHaveAttribute("data-icon", "circle");
    const latchBefore = await latch.boundingBox();
    await page.locator('#keybar .key[data-key="ctrl"]').click();
    await expect(page.locator('#keybar .key[data-key="ctrl"]')).toHaveAttribute("aria-pressed", "true");
    await expect(latch).toHaveAttribute("data-icon", "circleDot");
    expect(await latch.boundingBox()).toEqual(latchBefore);
    const latchShot = await page.screenshot({ path: testInfo.outputPath(`morph-latch-${viewport.label}.png`) });
    await testInfo.attach(`morph-latch-${viewport.label}`, { body: latchShot, contentType: "image/png" });
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

test("composer sends a prompt and clears on ok", async ({ page }) => {
  await page.locator(".composer-input").fill("do the thing");
  await page.locator(".composer-send").click();
  const sent = await page.evaluate(() => window.__fake.sent());
  const prompt = (sent as { t: string }[]).find((frame) => frame.t === "prompt");
  expect(prompt).toMatchObject({ t: "prompt", id: "smoke", text: "do the thing" });
  await expect(page.locator(".composer-input")).toHaveValue("");
});

test("composer keeps the text and shows the error", async ({ page }) => {
  await page.evaluate(() => window.__fake.failNextPrompt("delivery_failed", "host is gone"));
  await page.locator(".composer-input").fill("do the thing");
  await page.locator(".composer-send").click();
  await expect(page.locator(".composer-error")).toHaveText("host is gone");
  await expect(page.locator(".composer-input")).toHaveValue("do the thing");
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
