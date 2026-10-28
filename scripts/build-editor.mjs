// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle the graph editor for the browser: esbuild over
 * `apps/graphs/src/editor/editor.ts` and its stylesheet into
 * `apps/graphs/public/editor/` (editor.js + editor.css), the two files
 * the server-rendered `/editor` shell loads through `Page.scripts` and
 * `Page.styles`.
 *
 * Same shape as the look kit's bundling (scripts/build-look.mjs): one
 * bundle per entry, ESM, ES2022, minified — the size gate counts lines
 * of shipped JS — and no sourcemap. Everything the client needs,
 * including the Worker's own validator and the JSON Schemas, rides
 * inside the bundle; no third-party runtime is loaded by the page. The
 * destination is generated and gitignored, like `public/look`.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "apps", "graphs", "src", "editor");
const OUT = path.join(ROOT, "apps", "graphs", "public", "editor");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [path.join(SOURCE, "editor.ts"), path.join(SOURCE, "editor.css")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: OUT,
  minify: true,
  sourcemap: false,
  logLevel: "warning",
});

process.stdout.write(`editor bundle: ${path.relative(ROOT, OUT)}\n`);
