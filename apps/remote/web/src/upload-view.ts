// SPDX-License-Identifier: Apache-2.0
// The upload entry points and the tray above the key bar: the paperclip
// (created only when hello.features carries shelf_upload), the hidden
// file input behind it, drag-and-drop on the session pane, clipboard
// image paste, one cancelable progress row per file, the inline error a
// refused upload leaves (naming the file), and the Attach chip a finished
// upload shows. The state itself lives in the controller's UploadQueue.

import { icon } from "./icons-dom.js";
import type { ShelfHandle } from "./shelf-controller.js";
import type { UploadTaskView } from "./upload.js";

export interface UploadViewOptions {
  root: HTMLElement;
  shelf: ShelfHandle;
  /** The shelf an upload targets: the open session, or the host shelf. */
  sessionId: () => string | null;
  /** Type text into the terminal through the key-byte path. */
  typeText: (text: string) => void;
}

export interface UploadView {
  render: () => void;
}

function progressRow(task: UploadTaskView, shelf: ShelfHandle, render: () => void): HTMLElement {
  if (task.status === "error") {
    const row = document.createElement("p");
    row.className = "upload-error";
    row.dataset.uploadId = task.id;
    row.setAttribute("role", "alert");
    row.textContent = `${task.name}: ${task.error ?? "failed"}`;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "upload-cancel";
    dismiss.setAttribute("aria-label", `Dismiss ${task.name}`);
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => {
      shelf.cancelUpload(task.id);
      render();
    });
    row.append(dismiss);
    return row;
  }
  const row = document.createElement("div");
  row.className = "upload-item";
  row.dataset.uploadId = task.id;
  const name = document.createElement("span");
  name.className = "upload-name";
  name.textContent = task.name;
  const bar = document.createElement("span");
  bar.className = "upload-bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(Math.round(task.progress * 100)));
  const fill = document.createElement("span");
  fill.className = "upload-fill";
  fill.style.width = `${Math.round(task.progress * 100)}%`;
  bar.append(fill);
  const pct = document.createElement("span");
  pct.className = "upload-pct";
  pct.textContent = `${Math.round(task.progress * 100)}%`;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "upload-cancel";
  cancel.setAttribute("aria-label", `Cancel upload of ${task.name}`);
  cancel.textContent = "×";
  cancel.addEventListener("click", () => {
    shelf.cancelUpload(task.id);
    render();
  });
  row.append(name, bar, pct, cancel);
  return row;
}

function attachChip(task: UploadTaskView, opts: UploadViewOptions, render: () => void): HTMLElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "upload-attach";
  chip.dataset.uploadId = task.id;
  chip.textContent = `Attach ${task.path ?? task.name}`;
  chip.title = `Type “Attachment: ${task.path ?? task.name}”`;
  chip.addEventListener("click", () => {
    const attachment = opts.shelf.takeAttachment(task.id);
    if (attachment !== null) {
      opts.typeText(`Attachment: ${attachment.path}`);
    }
    render();
  });
  return chip;
}

/** Wire the session view's upload surfaces and paint the tray once. */
export function mountUploads(opts: UploadViewOptions): UploadView {
  const { root, shelf } = opts;
  const tray = root.querySelector<HTMLElement>("#upload-tray");

  const filesFrom = (list: FileList | null | undefined): File[] =>
    list === undefined || list === null ? [] : Array.from(list);

  const render = (): void => {
    syncControls();
    if (!tray) {
      return;
    }
    const tasks = shelf.uploads().filter((task) => task.status !== "done" || !task.taken);
    tray.replaceChildren();
    for (const task of tasks) {
      tray.append(
        task.status === "done"
          ? attachChip(task, opts, render)
          : progressRow(task, shelf, render),
      );
    }
    tray.hidden = tray.childElementCount === 0;
  };

  const start = (files: File[]): void => {
    if (files.length > 0 && shelf.uploadEnabled()) {
      shelf.startUploads(files, opts.sessionId());
    }
  };

  let input: HTMLInputElement | null = null;

  const syncControls = (): void => {
    const controls = root.querySelector<HTMLElement>(".term-controls");
    if (!controls) {
      return;
    }
    const enabled = shelf.uploadEnabled();
    if (!enabled) {
      controls.querySelector("#term-attach")?.remove();
      input?.remove();
      input = null;
      return;
    }
    if (!controls.querySelector("#term-attach")) {
      const button = document.createElement("button");
      button.type = "button";
      button.id = "term-attach";
      button.setAttribute("aria-label", "Attach files");
      button.title = "Attach files";
      button.innerHTML = icon("paperclip");
      button.addEventListener("click", () => input?.click());
      const builder = controls.querySelector("#term-builder");
      if (builder) {
        builder.insertAdjacentElement("afterend", button);
      } else {
        controls.append(button);
      }
    }
    if (input === null) {
      const element = document.createElement("input");
      element.type = "file";
      element.id = "upload-input";
      element.multiple = true;
      element.hidden = true;
      element.addEventListener("change", () => {
        const files = filesFrom(element.files);
        element.value = "";
        start(files);
      });
      controls.append(element);
      input = element;
    }
  };

  const pane = root.querySelector<HTMLElement>(".session-view") ?? root;
  pane.addEventListener("dragover", (ev) => {
    if (shelf.uploadEnabled()) {
      ev.preventDefault();
    }
  });
  pane.addEventListener("drop", (ev) => {
    if (!shelf.uploadEnabled()) {
      return;
    }
    ev.preventDefault();
    start(filesFrom(ev.dataTransfer?.files));
  });
  pane.addEventListener("paste", (ev) => {
    if (!shelf.uploadEnabled()) {
      return;
    }
    const items = Array.from(ev.clipboardData?.items ?? []);
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) {
        continue;
      }
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
    if (files.length > 0) {
      ev.preventDefault();
      start(files);
    }
  });

  render();
  return { render };
}
