// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The meaning tints in the remote's stylesheet: the New dialog's yolo row
 * (the checked row wears the warn tint) and the error label ink beside
 * its block.
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
      ".sheet-error:not(:empty)::before",
      "#pair-error:not(:empty)::before",
      ".signout-error:not(:empty)::before",
    ]) {
      expect(styles, selector).toContain(selector);
    }
    expect(styles).toContain('content: "Error: "');
    expect(styles).toContain("color: var(--err-label)");
  });

  it("keeps the single teal fill on primary buttons", () => {
    const rule = styles.slice(styles.indexOf("button.primary"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("background: var(--accent)");
  });

  it("confines the honeycomb to the header band over a flat body", () => {
    // The body is the flat deep surface, never the honeycomb's stage.
    expect(styles).toContain("body {\n  background: var(--bg-deep);");
    // The host rides the sticky band, clipping its own canvas — the bar
    // itself must not clip, or the account menu is cut off.
    const fondo = styles.slice(styles.indexOf(".fondo {"));
    const fondoRule = fondo.slice(0, fondo.indexOf("}"));
    expect(fondoRule).toContain("position: absolute");
    expect(fondoRule).not.toContain("position: fixed");
    expect(fondoRule).toContain("overflow: hidden");
    expect(fondoRule).not.toContain("opacity");
    const topbar = styles.slice(styles.indexOf(".topbar {"));
    const topbarRule = topbar.slice(0, topbar.indexOf("}"));
    expect(topbarRule).toContain("background: var(--bg-deep)");
    expect(topbarRule).not.toContain("overflow");
    // The header's row paints above the host, the band's first child.
    const inner = styles.slice(styles.indexOf(".topbar-inner {"));
    const innerRule = inner.slice(0, inner.indexOf("}"));
    expect(innerRule).toContain("position: relative");
    expect(innerRule).toContain("z-index: 1");
    // No view dims a page-wide layer anymore: there is none.
    expect(styles).not.toContain("body[data-view=");
  });
});
