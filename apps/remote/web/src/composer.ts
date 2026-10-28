// SPDX-License-Identifier: Apache-2.0
// The composer at the bottom of the session view: a multi-line textarea
// and Send, which ships a prompt frame. On ok the text clears and a
// one-line confirmation shows; on error the text stays and the message
// shows. Builder opens the Prompt Builder sheet, which the shell owns.
// The Send icon says what the frame is doing: send at rest, a spinner
// while the host has it, a check on ok and a red x on error.

import { newReqId } from "./protocol.js";
import { icon, mountMorphSlot, type IconName, type MorphSlot } from "./icons-dom.js";

export interface ComposerCallbacks {
  onSend: (text: string, req: string) => void;
  onBuilder: () => void;
}

/** The confirmation line's words; the check beside them is the icon. */
export const SENT_TEXT = "Sent";

export class Composer {
  private readonly callbacks: ComposerCallbacks;
  private area: HTMLTextAreaElement | null = null;
  private errorEl: HTMLElement | null = null;
  private okEl: HTMLElement | null = null;
  private sendButton: HTMLButtonElement | null = null;
  private sendSlot: MorphSlot | null = null;
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
    const okEl = document.createElement("p");
    okEl.className = "composer-ok flash-ok";
    okEl.setAttribute("role", "status");
    okEl.hidden = true;
    // The confirmation: the check the Send icon became, beside the word.
    const okIcon = document.createElement("span");
    okIcon.className = "icon-slot";
    okIcon.setAttribute("aria-hidden", "true");
    okIcon.innerHTML = icon("check");
    okEl.append(okIcon, document.createTextNode(SENT_TEXT));
    const builder = document.createElement("button");
    builder.type = "button";
    builder.className = "composer-builder";
    builder.innerHTML = icon("blocks");
    builder.append(document.createTextNode("Builder"));
    builder.addEventListener("click", () => this.callbacks.onBuilder());
    const send = document.createElement("button");
    send.type = "button";
    send.className = "composer-send";
    send.setAttribute("aria-label", "Send the prompt");
    const sendIcon = document.createElement("span");
    sendIcon.className = "icon-slot";
    sendIcon.setAttribute("aria-hidden", "true");
    sendIcon.innerHTML = icon("send");
    send.append(sendIcon, document.createTextNode("Send"));
    send.addEventListener("click", () => this.submit());
    area.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        this.submit();
      }
    });
    area.addEventListener("input", () => {
      this.hideOk();
      // Typing while a prompt is in flight keeps the spinner: the frame is
      // still out. Otherwise the button is ready to send again.
      if (this.pendingReq === null) {
        this.setSendIcon("send");
      }
    });
    row.append(errorEl, okEl, builder, send);
    wrap.append(area, row);
    parent.appendChild(wrap);
    this.area = area;
    this.errorEl = errorEl;
    this.okEl = okEl;
    this.sendButton = send;
    this.sendSlot = mountMorphSlot(sendIcon, "send");
  }

  submit(): void {
    const text = this.area?.value ?? "";
    if (text.trim() === "") {
      return;
    }
    const req = newReqId();
    this.pendingReq = req;
    this.hideError();
    this.hideOk();
    // The frame is the host's now: the icon spins until its answer.
    this.setSendIcon("loader");
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
    this.showOk();
    this.setSendIcon("check");
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
    this.hideOk();
    this.showError(message);
    this.setSendIcon("x");
    return true;
  }

  getText(): string {
    return this.area?.value ?? "";
  }

  unmount(): void {
    this.sendSlot?.destroy();
    this.sendSlot = null;
    this.sendButton = null;
    this.area?.closest(".composer")?.remove();
    this.area = null;
    this.errorEl = null;
    this.okEl = null;
    this.pendingReq = null;
  }

  /** The Send icon's current meaning; the error state paints it red. */
  private setSendIcon(name: IconName): void {
    this.sendSlot?.to(name);
    if (this.sendButton !== null) {
      this.sendButton.dataset["state"] = name === "x" ? "error" : name === "loader" ? "sending" : "ready";
    }
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

  private showOk(): void {
    if (this.okEl) {
      this.okEl.hidden = false;
    }
  }

  private hideOk(): void {
    if (this.okEl) {
      // Only the visibility changes: the check icon stays mounted inside.
      this.okEl.hidden = true;
    }
  }
}
