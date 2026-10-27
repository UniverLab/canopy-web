// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The meaning tints in the remote's stylesheet: the dormant yolo row
 * contract (no view renders `.yolo-row` yet, but when one does the checked
 * row wears the warn tint) and the error label ink beside its block.
 */
describe("web/src/styles.css", () => {
  const resolveFromRoot = (path: string): string =>
    isAbsolute(path) ? path : join(process.cwd(), path);

  const styles = readFileSync(resolveFromRoot("apps/remote/web/src/styles.css"), "utf8");

  it("tints a checked yolo row with the warn tint", () => {
    expect(styles).toContain(".yolo-row:has(input:checked)");
    const rule = styles.slice(styles.indexOf(".yolo-row:has(input:checked)"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("var(--tint-warn)");
  });

  it("labels error blocks in the error ink", () => {
    for (const selector of [
      ".composer-error::before",
      ".sheet-error:not(:empty)::before",
      "#pair-error:not(:empty)::before",
    ]) {
      expect(styles, selector).toContain(selector);
    }
    expect(styles).toContain('content: "Error: "');
    expect(styles).toContain("color: var(--err-label)");
  });

  it("keeps the single teal fill on Send in the session view", () => {
    const rule = styles.slice(styles.indexOf(".composer-send"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("background: var(--accent)");
  });
});
