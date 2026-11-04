// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's browser entry: what `/editor` loads as
 * `/editor/editor.js` — esbuild's bundle of this file (see
 * `scripts/build-editor.mjs`). No framework and no runtime library: it
 * waits for the shell, hands it to `EditorApp`, and stays quiet. A
 * construction failure (a shell missing a hook) logs instead of leaving
 * a silent page.
 */
import { EditorApp } from "./app.js";

function start(): void {
  const root = document.getElementById("editor");
  if (root === null) {
    return;
  }
  try {
    new EditorApp(root);
  } catch (error) {
    console.error("the editor failed to start", error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
