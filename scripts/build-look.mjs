// SPDX-License-Identifier: Apache-2.0
/**
 * Copy the shared look kit (packages/look) into both apps' public folders
 * and bundle the honeycomb background for the catalogue Worker's pages.
 *
 *   apps/graphs/public/look/      tokens.css, fonts/, colophon/, banner/, fondo/assets/, fondo.js
 *   apps/remote/web/public/look/  tokens.css, fonts/, colophon/, banner/, fondo/assets/
 *
 * The remote web app imports the kit's TypeScript sources directly through
 * Vite, so only the catalogue — whose pages are server-rendered strings —
 * needs the fondo.js bundle. Both destinations are generated and gitignored.
 */
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT = path.join(ROOT, "packages", "look");
const GRAPHS_LOOK = path.join(ROOT, "apps", "graphs", "public", "look");
const REMOTE_LOOK = path.join(ROOT, "apps", "remote", "web", "public", "look");

/** The two generated destinations, in build order. */
export const LOOK_TARGETS = [GRAPHS_LOOK, REMOTE_LOOK];

/**
 * Copy the servable kit (everything but the TypeScript sources).
 *
 * @param {string} target - the destination look/ folder
 */
export function copyLook(target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  copyFileSync(path.join(KIT, "tokens.css"), path.join(target, "tokens.css"));
  cpSync(path.join(KIT, "fonts"), path.join(target, "fonts"), { recursive: true });
  cpSync(path.join(KIT, "colophon"), path.join(target, "colophon"), {
    recursive: true,
    // footer.ts ships as source for the apps to import, not as a download.
    filter: (source) => !source.endsWith(".ts"),
  });
  cpSync(path.join(KIT, "banner"), path.join(target, "banner"), {
    recursive: true,
    // banner.ts ships as source for the apps to import, not as a download.
    filter: (source) => !source.endsWith(".ts"),
  });
  cpSync(path.join(KIT, "fondo", "assets"), path.join(target, "fondo", "assets"), {
    recursive: true,
  });
}

/**
 * Bundle the honeycomb background as one script the catalogue pages can
 * load with a plain <script src>: `CanopyLook.mountCanopyBackground(host,
 * assetBase)`. Minified — there is no sourcemap to keep self-hosted.
 *
 * @param {string} outfile - the destination fondo.js file
 */
export async function bundleFondo(outfile) {
  await build({
    entryPoints: [path.join(KIT, "fondo", "index.ts")],
    bundle: true,
    format: "iife",
    globalName: "CanopyLook",
    platform: "browser",
    target: "es2022",
    minify: true,
    logLevel: "silent",
    outfile,
  });
}

export async function buildLook() {
  for (const target of LOOK_TARGETS) {
    copyLook(target);
  }
  await bundleFondo(path.join(GRAPHS_LOOK, "fondo.js"));
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  await buildLook();
}
