// SPDX-License-Identifier: Apache-2.0
// Copying text out of the remote terminal, on phone and desktop. A phone
// cannot select in the terminal: one finger is the scroll gesture and
// xterm draws through WebGL, so there is no selectable DOM text. The
// phone gets a sheet with the terminal's text in a native textarea, where
// the OS's own long-press selection works; a mouse drags a selection in
// xterm itself and gets a floating Copy button plus Ctrl+Shift+C.

import { icon } from "./icons-dom.js";
import { Sheet } from "./sheet.js";

/** The sheet shows the last this many logical lines of the buffer. */
export const TERM_COPY_LINES = 2000;
/** How long "Copied" stays up, on the sheet's status line and the float. */
export const TERM_COPY_FLASH_MS = 2000;
export const TERM_COPY_FAILURE = "Could not copy. Select the text and use your browser's Copy.";

// Copy through the async clipboard API, falling back to a temporary
// textarea and execCommand for browsers without clipboard permission.
// True when either path copied, false when both failed; never throws.
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = (
      globalThis as unknown as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }
    ).navigator?.clipboard;
    if (clipboard?.writeText) {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to execCommand below.
      }
    }
  } catch {
    // A hostile navigator getter still gets the fallback.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    try {
      area.select();
      return document.execCommand("copy") === true;
    } finally {
      area.remove();
    }
  } catch {
    return false;
  }
}

// The copy shortcut: Ctrl+Shift+C on the keydown. Plain Ctrl+C is an
// interrupt for the session, never a copy, even with a selection.
export function isCopyKeydown(ev: { type: string; key: string; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return ev.type === "keydown" && (ev.key === "c" || ev.key === "C") && ev.ctrlKey && ev.shiftKey;
}

/**
 * xterm's custom key handler for the copy shortcut: with a selection it
 * copies and returns false (the key never reaches the session), otherwise
 * true (xterm processes the key exactly as without the handler).
 */
export function handleCopyKeydown(
  ev: { type: string; key: string; ctrlKey: boolean; shiftKey: boolean; preventDefault?: () => void },
  getSelection: () => string,
  copy: (text: string) => Promise<boolean> = copyText,
): boolean {
  if (isCopyKeydown(ev)) {
    const selection = getSelection();
    if (selection !== "") {
      // Chrome and Firefox bind this chord to their DevTools.
      ev.preventDefault?.();
      void copy(selection);
      return false;
    }
  }
  return true;
}

/** The slice of the terminal the sheet reads, once, when it opens. */
export interface TermCopySource {
  bufferText: (maxLines: number) => string;
}

export class TermCopySheet {
  private readonly sheet: Sheet;
  private readonly copy: (text: string) => Promise<boolean>;
  private body: HTMLElement | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private onSelectionChange: (() => void) | null = null;

  constructor(copy: (text: string) => Promise<boolean> = copyText) {
    this.copy = copy;
    this.sheet = new Sheet({ kind: "term-copy", title: "Copy from terminal" }, () => this.close());
  }

  get isOpen(): boolean {
    return this.sheet.isOpen;
  }

  open(parent: HTMLElement, source: TermCopySource): void {
    if (this.sheet.isOpen) {
      return;
    }
    // Read once: the sheet is a snapshot, it never live-updates.
    const text = source.bufferText(TERM_COPY_LINES);
    const body = this.sheet.mount(parent);
    this.body = body;
    body.innerHTML = `
      <textarea
        id="term-copy-text"
        readonly
        wrap="off"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        aria-label="Terminal text"
      ></textarea>
      <p class="term-copy-status" id="term-copy-status" role="status"></p>
      <div class="sheet-actions">
        <button type="button" class="secondary" id="term-copy-all">Copy all</button>
        <button type="button" class="primary" id="term-copy-selection" disabled>Copy selection</button>
      </div>`;
    const area = body.querySelector<HTMLTextAreaElement>("#term-copy-text");
    const status = body.querySelector<HTMLElement>("#term-copy-status");
    const copyAll = body.querySelector<HTMLButtonElement>("#term-copy-all");
    const copySelection = body.querySelector<HTMLButtonElement>("#term-copy-selection");
    if (!area || !status || !copyAll || !copySelection) {
      return;
    }
    area.value = text;
    // An empty buffer copies nothing.
    copyAll.disabled = text === "";
    // The tail is what is wanted: open scrolled to the bottom.
    area.scrollTop = area.scrollHeight;
    const syncSelection = (): void => {
      copySelection.disabled = area.selectionStart === area.selectionEnd;
    };
    this.onSelectionChange = syncSelection;
    document.addEventListener("selectionchange", syncSelection);
    area.addEventListener("select", syncSelection);
    const say = (message: string, flash: boolean): void => {
      if (this.statusTimer !== null) {
        clearTimeout(this.statusTimer);
        this.statusTimer = null;
      }
      status.textContent = message;
      if (flash) {
        this.statusTimer = setTimeout(() => {
          this.statusTimer = null;
          if (status.isConnected) {
            status.textContent = "";
          }
        }, TERM_COPY_FLASH_MS);
      }
    };
    copyAll.addEventListener("click", () => {
      void this.copy(area.value).then((ok) => {
        if (status.isConnected) {
          say(ok ? "Copied" : TERM_COPY_FAILURE, ok);
        }
      });
    });
    copySelection.addEventListener("click", () => {
      const start = area.selectionStart ?? 0;
      const end = area.selectionEnd ?? 0;
      void this.copy(area.value.slice(start, end)).then((ok) => {
        if (status.isConnected) {
          say(ok ? "Copied" : TERM_COPY_FAILURE, ok);
        }
      });
    });
  }

  close(): void {
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.onSelectionChange) {
      document.removeEventListener("selectionchange", this.onSelectionChange);
      this.onSelectionChange = null;
    }
    this.body = null;
    this.sheet.close();
  }
}

/**
 * The floating selection button, in the .term-stage top-right corner the
 * way #term-latest floats over the bottom-right: icon plus the word Copy,
 * shown only while xterm holds a drag selection.
 */
export function termCopyFloatHtml(): string {
  return `
        <button
          type="button"
          id="term-copy-float"
          hidden
          aria-label="Copy selection"
          title="Copy the selected text"
        >${icon("copy")}<span>Copy</span></button>`;
}

/** The slice of the terminal the float reads: selection only. */
export interface CopyFloatView {
  getSelection: () => string;
  onSelectionChange: (callback: () => void) => () => void;
}

export function wireCopyFloat(
  button: HTMLButtonElement,
  view: CopyFloatView,
  copy: (text: string) => Promise<boolean> = copyText,
): () => void {
  const label = button.querySelector("span");
  const previous = label?.textContent ?? "Copy";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sync = (): void => {
    button.hidden = view.getSelection() === "";
  };
  const unsubscribe = view.onSelectionChange(sync);
  sync();
  const onClick = (): void => {
    const selection = view.getSelection();
    if (selection === "") {
      return;
    }
    void copy(selection).then((ok) => {
      // The selection stays: copying clears nothing.
      if (ok && label && label.isConnected) {
        label.textContent = "Copied";
        if (timer !== null) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          timer = null;
          if (label.isConnected) {
            label.textContent = previous;
          }
        }, TERM_COPY_FLASH_MS);
      }
    });
  };
  button.addEventListener("click", onClick);
  return () => {
    unsubscribe();
    button.removeEventListener("click", onClick);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
