// SPDX-License-Identifier: Apache-2.0
// The modal sheet shared by the New dialog and the Prompt Builder: a fixed
// overlay with a titled panel, a close button and an empty body the caller
// fills. Esc and the close button call the owner's close; the shell closes
// both sheets on any route change.

export interface SheetOptions {
  /** Stable name used for ids and the data-sheet attribute. */
  kind: string;
  title: string;
}

export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class Sheet {
  private readonly kind: string;
  private readonly title: string;
  private readonly onClose: () => void;
  private overlay: HTMLElement | null = null;

  constructor(options: SheetOptions, onClose: () => void) {
    this.kind = options.kind;
    this.title = options.title;
    this.onClose = onClose;
  }

  get isOpen(): boolean {
    return this.overlay !== null && this.overlay.isConnected;
  }

  mount(parent: HTMLElement): HTMLElement {
    this.close();
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.dataset.sheet = this.kind;
    overlay.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.onClose();
      }
    });

    const panel = document.createElement("section");
    panel.className = "sheet";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", this.title);

    const head = document.createElement("header");
    head.className = "sheet-head";
    const heading = document.createElement("h2");
    heading.textContent = this.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "sheet-close";
    close.id = `${this.kind}-close`;
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", () => this.onClose());
    head.append(heading, close);

    const body = document.createElement("div");
    body.className = "sheet-body";
    body.id = `${this.kind}-body`;
    panel.append(head, body);
    overlay.append(panel);
    parent.append(overlay);

    this.overlay = overlay;
    return body;
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }
}
