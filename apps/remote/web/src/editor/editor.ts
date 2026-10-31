// SPDX-License-Identifier: Apache-2.0
/**
 * The remote editor's entry, loaded as a lazy chunk behind `/editor`:
 * its stylesheet rides this chunk as a real file (inline styles on the
 * remote are xterm's exception alone), it mounts the shell into `#app`,
 * and hands it to the app. A construction failure writes its reason into
 * the page instead of leaving it silent.
 */
import { EditorApp, editorShell } from "./app.js";
import { remoteTitle } from "../titles.js";
import "./editor.css";

/** Mount the graph editor into the app root. */
export function mountEditor(root: HTMLElement): void {
  document.title = remoteTitle("Graph editor");
  root.innerHTML = editorShell();
  const shell = root.querySelector<HTMLElement>("#editor");
  if (shell === null) {
    throw new Error("the editor shell did not mount");
  }
  try {
    new EditorApp(shell);
  } catch (error) {
    shell.textContent = error instanceof Error ? error.message : "Could not start the editor";
  }
}
