// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Composer } from "../src/composer.js";

describe("Composer", () => {
  let slot: HTMLElement;
  let composer: Composer;
  let sent: { text: string; req: string }[];
  let builders: number;

  const query = <T extends Element>(selector: string): T => {
    const el = slot.querySelector(selector);
    if (!el) {
      throw new Error(`missing ${selector}`);
    }
    return el as T;
  };

  beforeEach(() => {
    slot = document.createElement("div");
    document.body.appendChild(slot);
    sent = [];
    builders = 0;
    composer = new Composer({
      onSend: (text, req) => sent.push({ text, req }),
      onBuilder: () => {
        builders += 1;
      },
    });
    composer.mount(slot);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("sends the text with a req id", () => {
    query<HTMLTextAreaElement>(".composer-input").value = "hello\nworld";
    query<HTMLButtonElement>(".composer-send").click();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("hello\nworld");
    expect(typeof sent[0]?.req).toBe("string");
    expect(composer.awaitingReply).toBe(true);
  });

  it("ignores empty submits", () => {
    query<HTMLTextAreaElement>(".composer-input").value = "  \n ";
    query<HTMLButtonElement>(".composer-send").click();
    expect(sent).toHaveLength(0);
  });

  it("clears on the matching ok and ignores other reqs", () => {
    query<HTMLTextAreaElement>(".composer-input").value = "hello";
    query<HTMLButtonElement>(".composer-send").click();
    const req = sent[0]?.req ?? "";
    expect(composer.handleOk("other")).toBe(false);
    expect(query<HTMLTextAreaElement>(".composer-input").value).toBe("hello");
    expect(composer.handleOk(req)).toBe(true);
    expect(query<HTMLTextAreaElement>(".composer-input").value).toBe("");
    expect(composer.awaitingReply).toBe(false);
  });

  it("shows Sent on ok and hides it on the next submit or keystroke", () => {
    query<HTMLTextAreaElement>(".composer-input").value = "hello";
    query<HTMLButtonElement>(".composer-send").click();
    const req = sent[0]?.req ?? "";
    const ok = query(".composer-ok");
    expect((ok as HTMLElement).hidden).toBe(true);
    expect(composer.handleOk(req)).toBe(true);
    expect(ok.textContent).toBe("Sent");
    expect((ok as HTMLElement).hidden).toBe(false);
    // Typing hides it again.
    query<HTMLTextAreaElement>(".composer-input").value = "more";
    query<HTMLTextAreaElement>(".composer-input").dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    expect((query(".composer-ok") as HTMLElement).hidden).toBe(true);
    // So does the next submit.
    query<HTMLButtonElement>(".composer-send").click();
    expect(composer.handleOk(sent[1]?.req ?? "")).toBe(true);
    expect((query(".composer-ok") as HTMLElement).hidden).toBe(false);
    query<HTMLTextAreaElement>(".composer-input").value = "again";
    query<HTMLButtonElement>(".composer-send").click();
    expect((query(".composer-ok") as HTMLElement).hidden).toBe(true);
  });

  it("keeps the text and shows the message on error", () => {
    query<HTMLTextAreaElement>(".composer-input").value = "hello";
    query<HTMLButtonElement>(".composer-send").click();
    const req = sent[0]?.req ?? "";
    expect(composer.handleError("delivery_failed", "other")).toBe(false);
    expect(composer.handleError("delivery_failed: host is gone", req)).toBe(true);
    expect(query<HTMLTextAreaElement>(".composer-input").value).toBe("hello");
    const error = query(".composer-error");
    expect(error.textContent).toBe("delivery_failed: host is gone");
    expect((error as HTMLElement).hidden).toBe(false);
    // A retry clears the error.
    query<HTMLButtonElement>(".composer-send").click();
    expect((query(".composer-error") as HTMLElement).hidden).toBe(true);
  });

  it("accepts an unrouted error for the pending prompt", () => {
    query<HTMLTextAreaElement>(".composer-input").value = "hello";
    query<HTMLButtonElement>(".composer-send").click();
    expect(composer.handleError("internal trouble", null)).toBe(true);
    expect(query(".composer-error").textContent).toBe("internal trouble");
  });

  it("turns Send into a spinner, then a check on ok", () => {
    const send = query<HTMLButtonElement>(".composer-send");
    const icon = () => query(".composer-send .icon-slot").getAttribute("data-icon");
    expect(icon()).toBe("send");
    query<HTMLTextAreaElement>(".composer-input").value = "hello";
    send.click();
    expect(icon()).toBe("loader");
    expect(send.dataset["state"]).toBe("sending");
    expect(composer.handleOk(sent[0]?.req ?? "")).toBe(true);
    expect(icon()).toBe("check");
    expect(send.dataset["state"]).toBe("ready");
    // The confirmation line wears the same check beside its word.
    expect(query(".composer-ok svg")).not.toBeNull();
    expect(query(".composer-ok").textContent).toBe("Sent");
  });

  it("turns Send into an x on error, red, and back when typing", () => {
    const send = query<HTMLButtonElement>(".composer-send");
    const icon = () => query(".composer-send .icon-slot").getAttribute("data-icon");
    query<HTMLTextAreaElement>(".composer-input").value = "hello";
    send.click();
    expect(composer.handleError("host is gone", sent[0]?.req ?? "")).toBe(true);
    expect(icon()).toBe("x");
    expect(send.dataset["state"]).toBe("error");
    query<HTMLTextAreaElement>(".composer-input").value = "hello again";
    query<HTMLTextAreaElement>(".composer-input").dispatchEvent(new Event("input", { bubbles: true }));
    expect(icon()).toBe("send");
    expect(send.dataset["state"]).toBe("ready");
  });

  it("keeps the spinner while a prompt is still out", () => {
    query<HTMLTextAreaElement>(".composer-input").value = "hello";
    query<HTMLButtonElement>(".composer-send").click();
    query<HTMLTextAreaElement>(".composer-input").value = "next";
    query<HTMLTextAreaElement>(".composer-input").dispatchEvent(new Event("input", { bubbles: true }));
    expect(query(".composer-send .icon-slot").getAttribute("data-icon")).toBe("loader");
  });

  it("opens the Builder", () => {
    query<HTMLButtonElement>(".composer-builder").click();
    expect(builders).toBe(1);
  });

  it("sends on Ctrl+Enter", () => {
    query<HTMLTextAreaElement>(".composer-input").value = "hi";
    query<HTMLTextAreaElement>(".composer-input").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
    expect(sent).toHaveLength(1);
  });
});
