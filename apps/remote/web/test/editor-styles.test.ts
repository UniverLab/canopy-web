// SPDX-License-Identifier: Apache-2.0
/**
 * The remote editor's stylesheet against the remote's CSP.
 *
 * The relay serves every response with `style-src 'self'`, which refuses
 * inline `<style>` elements and style attributes: the editor therefore
 * loads `editor.css` as a real stylesheet from its lazy chunk. An injected
 * `<style>` still looks right in `vite dev` (no CSP there) and leaves the
 * graph unpainted in production, so the rule is held here as well as by the
 * browser tests.
 *
 * The canvas paints in the plate's palette; the colours are literals in the
 * CSS, so PALETTE is the source they are held to (as look.test.ts does for
 * the banner gradient).
 */
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PALETTE } from "../../../../packages/plate/vocabulary.js";

function resolveFromRoot(path: string): string {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

const EDITOR_DIR = "apps/remote/web/src/editor";
const editorCss = readFileSync(resolveFromRoot(`${EDITOR_DIR}/editor.css`), "utf8");

describe("web/src/editor/editor.css", () => {
  it("loads as a stylesheet from the editor chunk, never as an inline style", () => {
    const entry = readFileSync(resolveFromRoot(`${EDITOR_DIR}/editor.ts`), "utf8");
    expect(entry).toContain('import "./editor.css";');
    // No source file may build an inline <style>: `style-src 'self'` refuses
    // it. Comments are stripped first — they explain the rule, they are not
    // the thing it forbids.
    const code = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const name of readdirSync(resolveFromRoot(EDITOR_DIR)).filter((entry) => entry.endsWith(".ts"))) {
      const source = code(readFileSync(resolveFromRoot(`${EDITOR_DIR}/${name}`), "utf8"));
      expect(source, name).not.toContain('createElement("style")');
      expect(source, name).not.toContain("<style>");
    }
  });

  it("paints the canvas boxes, ports and edges", () => {
    for (const selector of [
      ".editor-svg .node-box",
      ".editor-svg .port-in",
      ".editor-svg .port-out",
      ".editor-svg .edge-line",
      ".editor-svg .group-box",
      ".editor-svg .member-shape",
      ".remote-editor [hidden]",
    ]) {
      expect(editorCss, selector).toContain(selector);
    }
    // The hidden attribute wins over the layout rules; a toggled block the
    // cascade overrode would show the notice and the chooser shut all along.
    expect(editorCss).toContain("display: none !important");
  });

  it("takes its canvas colours from the plate palette", () => {
    for (const colour of [PALETTE.chipFill, PALETTE.gateFill, PALETTE.gateStroke, PALETTE.label, PALETTE.deep, PALETTE.red]) {
      expect(editorCss, colour).toContain(colour);
    }
  });

  it("fetches nothing: a stylesheet the CSP can serve from 'self'", () => {
    expect(editorCss).not.toContain("@import");
    expect(editorCss).not.toMatch(/url\(\s*['"]?(https?:)?\/\//);
  });

  it("stacks the panes on a phone so the page never scrolls sideways", () => {
    const media = editorCss.slice(editorCss.indexOf("@media (max-width: 900px)"));
    expect(media).toContain("grid-template-columns: 1fr");
  });
});
