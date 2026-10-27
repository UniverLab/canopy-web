// SPDX-License-Identifier: Apache-2.0
// The composer at the bottom of the session view: a multi-line textarea
// and Send, which ships a prompt frame. On ok the text clears; on error
// the text stays and the message shows. Builder opens the Prompt Builder
// sheet, which the shell owns.

import { newReqId } from "./protocol.js";

export interface ComposerCallbacks {
  onSend: (text: string, req: string) => void;
  onBuilder: () => void;
}

export class Composer {
  private readonly callbacks: ComposerCallbacks;
  private area: HTMLTextAreaElement | null = null;
  private errorEl: HTMLElement | null = null;
  private pendingReq: string | null = null;

  constructor(callbacks: ComposerCallbacks) {
    this.callbacks = callbacks;
  }

  get awaitingReply(): boolean {
    return this.pendingReq !== null;
  }

  get currentReq(): string | null {
    return this.pendingReq;
  }

  mount(parent: HTMLElement): void {
    this.unmount();
    const wrap = document.createElement("div");
    wrap.className = "composer";
    const area = document.createElement("textarea");
    area.className = "composer-input";
    area.rows = 2;
    area.placeholder = "Message this session…";
    area.setAttribute("aria-label", "Message this session");
    const row = document.createElement("div");
    row.className = "composer-row";
    const errorEl = document.createElement("p");
    errorEl.className = "composer-error";
    errorEl.setAttribute("role", "alert");
    errorEl.hidden = true;
    const builder = document.createElement("button");
    builder.type = "button";
    builder.className = "composer-builder";
    builder.textContent = "Builder";
    builder.addEventListener("click", () => this.callbacks.onBuilder());
    const send = document.createElement("button");
    send.type = "button";
    send.className = "composer-send";
    send.textContent = "Send";
    send.addEventListener("click", () => this.submit());
    area.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        this.submit();
      }
    });
    row.append(errorEl, builder, send);
    wrap.append(area, row);
    parent.appendChild(wrap);
    this.area = area;
    this.errorEl = errorEl;
  }

  submit(): void {
    const text = this.area?.value ?? "";
    if (text.trim() === "") {
      return;
    }
    const req = newReqId();
    this.pendingReq = req;
    this.hideError();
    this.callbacks.onSend(text, req);
  }

  handleOk(req: string): boolean {
    if (this.pendingReq === null || this.pendingReq !== req) {
      return false;
    }
    this.pendingReq = null;
    if (this.area) {
      this.area.value = "";
    }
    this.hideError();
    return true;
  }

  handleError(message: string, req: string | null): boolean {
    if (this.pendingReq === null) {
      return false;
    }
    if (req !== null && req !== this.pendingReq) {
      return false;
    }
    this.pendingReq = null;
    this.showError(message);
    return true;
  }

  getText(): string {
    return this.area?.value ?? "";
  }

  unmount(): void {
    this.area?.closest(".composer")?.remove();
    this.area = null;
    this.errorEl = null;
    this.pendingReq = null;
  }

  private showError(message: string): void {
    if (this.errorEl) {
      this.errorEl.textContent = message;
      this.errorEl.hidden = false;
    }
  }

  private hideError(): void {
    if (this.errorEl) {
      this.errorEl.textContent = "";
      this.errorEl.hidden = true;
    }
  }
}
