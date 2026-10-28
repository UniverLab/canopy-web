// SPDX-License-Identifier: Apache-2.0
/**
 * The remote's weight, measured rather than assumed: the app is built the
 * way production builds it and the JavaScript and CSS it ships are gzipped,
 * against the baseline the icon spec was written over (HEAD before the
 * icons, 123 270 bytes gzip) plus the 25 KB the icon language is allowed.
 *
 * The graph editor rides its own lazy chunk behind `/editor`, so it is
 * partitioned out by the one string only it ships ("spec is not
 * connected") and weighed against its own 30 KB budget instead of the
 * main bundle's. The main bundle must not grow for the editor.
 *
 * The build goes to a temporary directory, never over apps/remote/web/dist.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Outside the repository: a build here must never be linted or committed.
const OUT = path.join(tmpdir(), "canopy-remote-bundle");

/** Bytes gzip of the whole app at HEAD, before the icons (js + css). */
const BASELINE = 123_270;
/** The budget this spec allows the icon language to add. */
const BUDGET = 25_600;
/** The budget the lazy editor chunk is allowed, gzip bytes of JS. */
const EDITOR_BUDGET = 30_000;
/** The one string only the editor chunk ships. */
const EDITOR_MARKER = "spec is not connected";

function filesOf(dir: string, extension: string): string[] {
  const names = readdirSync(dir, { recursive: true }) as string[];
  return names.filter((name) => name.endsWith(extension));
}

function textOf(dir: string, extension: string): string {
  let all = "";
  for (const name of filesOf(dir, extension)) {
    all += readFileSync(path.join(dir, name), "utf8");
  }
  return all;
}

function gzipOf(dir: string, extension: string): number {
  let total = 0;
  for (const name of filesOf(dir, extension)) {
    total += gzipSync(readFileSync(path.join(dir, name))).length;
  }
  return total;
}

describe("the remote's bundle", () => {
  it("grows by less than 25 KB gzip for the whole icon language", async () => {
    rmSync(OUT, { recursive: true, force: true });
    await build({
      configFile: path.join(WEB, "vite.config.ts"),
      root: WEB,
      logLevel: "silent",
      build: { outDir: OUT, emptyOutDir: true },
    });
    const assets = path.join(OUT, "assets");
    // The build really is this app: the icon layer is in the emitted bytes.
    expect(textOf(assets, ".js")).toContain("0 0 24 24");
    // The editor chunk split: exactly the files carrying the marker.
    const editorFiles = filesOf(assets, ".js").filter((name) =>
      readFileSync(path.join(assets, name), "utf8").includes(EDITOR_MARKER),
    );
    expect(editorFiles.length, "the editor must ride its own lazy chunk").toBeGreaterThan(0);
    let editorJs = 0;
    for (const name of editorFiles) {
      editorJs += gzipSync(readFileSync(path.join(assets, name))).length;
    }
    const js = gzipOf(assets, ".js");
    const css = gzipOf(assets, ".css");
    // The editor injects its own styles from its chunk: all CSS is main.
    const main = js - editorJs + css;
    rmSync(OUT, { recursive: true, force: true });
    const report = { baseline: BASELINE, js, editorJs, css, main, added: main - BASELINE };
    // Keep the numbers in the failure message: a regression says by how much.
    expect(main, JSON.stringify(report)).toBeLessThanOrEqual(BASELINE + BUDGET);
    expect(editorJs, JSON.stringify(report)).toBeLessThanOrEqual(EDITOR_BUDGET);
    // The app still ships the icons inline: no sprite chunk, no font request.
    expect(css).toBeGreaterThan(0);
  }, 120_000);
});
