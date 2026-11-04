// SPDX-License-Identifier: Apache-2.0
// The Ctrl/Shift latch keys on a phone, against the fake host: tapping
// Ctrl arms the latch and focuses the terminal (the keyboard opens inside
// the tap gesture), the focus reports from that focus never spend the
// latch, and the next typed key goes out with the modifier applied.
import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

async function terminalText(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => window.__fake.terminalText());
}

// Every input frame the host received, decoded to bytes.
async function inputBytes(page: import("@playwright/test").Page): Promise<number[][]> {
  return page.evaluate(() =>
    window.__fake
      .sent()
      .filter((frame) => (frame as { t?: string }).t === "input")
      .map((frame) => {
        const bin = atob((frame as { data: string }).data);
        return Array.from(bin, (ch) => ch.charCodeAt(0));
      }),
  );
}

async function xtermTextareaIsFocused(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.classList.contains("xterm-helper-textarea");
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/fake.html");
  await page.locator('[data-session="smoke"]').click();
  await expect.poll(() => terminalText(page)).toContain("hello from the host");
  // A fine pointer hides the key bar by default; pin it visible the way a
  // touch device shows it.
  if (!(await page.locator("#keybar").isVisible())) {
    await page.locator("#term-keys").click();
  }
});

test("ctrl latch survives the focus report and applies to the next key", async ({ page }) => {
  const ctrl = page.locator('#keybar .key[data-key="ctrl"]');
  await ctrl.tap();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  // The tap focused xterm's hidden textarea: the phone keyboard opens.
  await expect.poll(() => xtermTextareaIsFocused(page)).toBe(true);
  // A TUI with focus tracking turns every blur/focus into a report
  // through the same onData as typed text.
  await page.evaluate(() => window.__fake.pushOut("\x1b[?1004h"));
  await expect.poll(() => terminalText(page)).toContain("\x1b[?1004h");
  // xterm applies the mode off its write queue; the blur below must land
  // after that, or no report is generated at all.
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__fake.clearSent());
  await page.evaluate(() => {
    const area = document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;
    area.blur();
    area.focus();
  });
  // Both reports reached the host unchanged, and the latch stayed armed.
  await expect.poll(() => inputBytes(page)).toEqual([
    [0x1b, 0x5b, 0x4f],
    [0x1b, 0x5b, 0x49],
  ]);
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  // The armed latch still applies to the next typed key.
  await page.keyboard.type("c");
  await expect.poll(() => inputBytes(page)).toEqual([
    [0x1b, 0x5b, 0x4f],
    [0x1b, 0x5b, 0x49],
    [0x03],
  ]);
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
});
