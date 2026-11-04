// SPDX-License-Identifier: Apache-2.0
// Copying terminal text out: the buffer as plain text (wrapped rows join,
// trailing blanks go, only the last maxLines stay), copyText's clipboard
// then execCommand fallback, the sheet's Copy all / Copy selection, the
// floating selection button, and the Ctrl+Shift+C key handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERM_COPY_FAILURE,
  copyText,
  handleCopyKeydown,
  isCopyKeydown,
  termCopyFloatHtml,
  wireCopyFloat,
  TermCopySheet,
} from "../src/term-copy.js";
import type { CopyFloatView } from "../src/term-copy.js";
import { bufferLinesToText, TerminalView } from "../src/terminal.js";
import type { BufferLike } from "../src/terminal.js";

function fakeBuffer(rows: ({ text: string; wrapped: boolean } | null)[]): BufferLike {
  return {
    length: rows.length,
    getLine: (y: number) => {
      const row = rows[y];
      if (!row) {
        return undefined;
      }
      return {
        isWrapped: row.wrapped,
        translateToString: () => row.text,
      };
    },
  };
}

describe("bufferLinesToText", () => {
  it("joins a wrapped line into one line", () => {
    const buffer = fakeBuffer([
      { text: "hel", wrapped: false },
      { text: "lo", wrapped: true },
      { text: "next", wrapped: false },
    ]);
    expect(bufferLinesToText(buffer, 2000)).toBe("hello\nnext");
  });

  it("right-trims every row", () => {
    const seen: (boolean | undefined)[] = [];
    const buffer: BufferLike = {
      length: 1,
      getLine: () => ({ isWrapped: false, translateToString: (trim) => (seen.push(trim), "ab") }),
    };
    expect(bufferLinesToText(buffer, 2000)).toBe("ab");
    expect(seen).toEqual([true]);
  });

  it("drops trailing blank lines but keeps interior ones", () => {
    const buffer = fakeBuffer([
      { text: "a", wrapped: false },
      { text: "", wrapped: false },
      { text: "b", wrapped: false },
      { text: "", wrapped: false },
      { text: "", wrapped: false },
    ]);
    expect(bufferLinesToText(buffer, 2000)).toBe("a\n\nb");
  });

  it("keeps the last maxLines lines", () => {
    const buffer = fakeBuffer([
      { text: "one", wrapped: false },
      { text: "two", wrapped: false },
      { text: "three", wrapped: false },
    ]);
    expect(bufferLinesToText(buffer, 2)).toBe("two\nthree");
    expect(bufferLinesToText(buffer, 99)).toBe("one\ntwo\nthree");
  });

  it("skips missing rows and refuses a non-positive maxLines", () => {
    const buffer = fakeBuffer([{ text: "a", wrapped: false }, null, { text: "b", wrapped: false }]);
    expect(bufferLinesToText(buffer, 2000)).toBe("a\nb");
    expect(bufferLinesToText(buffer, 0)).toBe("");
    expect(bufferLinesToText(buffer, -3)).toBe("");
  });
});

describe("copyText", () => {
  let hadClipboard: boolean;
  let prevClipboard: unknown;
  let prevExecCommand: typeof document.execCommand | undefined;

  beforeEach(() => {
    hadClipboard = "clipboard" in navigator;
    prevClipboard = (navigator as unknown as Record<string, unknown>)["clipboard"];
    prevExecCommand = document.execCommand;
  });

  afterEach(() => {
    if (hadClipboard) {
      Object.defineProperty(navigator, "clipboard", {
        value: prevClipboard,
        configurable: true,
        writable: true,
      });
    } else {
      delete (navigator as unknown as Record<string, unknown>)["clipboard"];
    }
    if (prevExecCommand === undefined) {
      delete (document as unknown as Record<string, unknown>)["execCommand"];
    } else {
      document.execCommand = prevExecCommand;
    }
    document.body.innerHTML = "";
  });

  const stubClipboard = (clipboard: unknown): void => {
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true, writable: true });
  };

  it("copies through the async clipboard when it is there", async () => {
    const writeText = vi.fn(async (): Promise<void> => {});
    stubClipboard({ writeText });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to a temporary textarea and execCommand", async () => {
    stubClipboard(undefined);
    const execCommand = vi.fn((): boolean => true);
    document.execCommand = execCommand as typeof document.execCommand;
    await expect(copyText("hello")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    // The temporary textarea is gone again.
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("falls back when the clipboard write rejects", async () => {
    stubClipboard({
      writeText: vi.fn(async (): Promise<void> => {
        throw new Error("denied");
      }),
    });
    document.execCommand = (() => true) as typeof document.execCommand;
    await expect(copyText("hello")).resolves.toBe(true);
  });

  it("is false without throwing when both paths fail", async () => {
    stubClipboard({
      writeText: vi.fn(async (): Promise<void> => {
        throw new Error("denied");
      }),
    });
    document.execCommand = (() => false) as typeof document.execCommand;
    await expect(copyText("hello")).resolves.toBe(false);
    document.execCommand = (() => {
      throw new Error("no copy");
    }) as typeof document.execCommand;
    await expect(copyText("hello")).resolves.toBe(false);
  });
});

describe("TermCopySheet", () => {
  let parent: HTMLDivElement;
  let sheet: TermCopySheet;

  beforeEach(() => {
    vi.useFakeTimers();
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });

  afterEach(() => {
    sheet?.close();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const area = (): HTMLTextAreaElement => {
    const el = parent.querySelector<HTMLTextAreaElement>("#term-copy-text");
    if (!el) {
      throw new Error("missing #term-copy-text");
    }
    return el;
  };
  const status = (): HTMLElement => {
    const el = parent.querySelector<HTMLElement>("#term-copy-status");
    if (!el) {
      throw new Error("missing #term-copy-status");
    }
    return el;
  };

  it("shows the buffer once, scrolled to the bottom", () => {
    const reads: number[] = [];
    sheet = new TermCopySheet(async () => true);
    sheet.open(parent, {
      bufferText: (maxLines) => {
        reads.push(maxLines);
        return "one\ntwo";
      },
    });
    expect(sheet.isOpen).toBe(true);
    expect(parent.querySelector(".sheet")?.getAttribute("aria-label")).toBe("Copy from terminal");
    expect(area().value).toBe("one\ntwo");
    expect(area().readOnly).toBe(true);
    expect(area().getAttribute("wrap")).toBe("off");
    expect(area().getAttribute("spellcheck")).toBe("false");
    expect(area().scrollTop).toBe(area().scrollHeight);
    // Read once on open: no live update.
    expect(reads).toEqual([2000]);
  });

  it("copies everything on Copy all and flashes Copied", async () => {
    const copied: string[] = [];
    sheet = new TermCopySheet(async (text) => {
      copied.push(text);
      return true;
    });
    sheet.open(parent, { bufferText: () => "one\ntwo" });
    parent.querySelector<HTMLButtonElement>("#term-copy-all")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toEqual(["one\ntwo"]);
    expect(status().textContent).toBe("Copied");
    expect(status().getAttribute("role")).toBe("status");
    vi.advanceTimersByTime(2000);
    expect(status().textContent).toBe("");
  });

  it("enables Copy selection through selectionchange and copies only it", async () => {
    const copied: string[] = [];
    sheet = new TermCopySheet(async (text) => {
      copied.push(text);
      return true;
    });
    sheet.open(parent, { bufferText: () => "one\ntwo" });
    const button = parent.querySelector<HTMLButtonElement>("#term-copy-selection");
    expect(button?.disabled).toBe(true);
    area().selectionStart = 0;
    area().selectionEnd = 3;
    document.dispatchEvent(new Event("selectionchange"));
    expect(button?.disabled).toBe(false);
    button?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toEqual(["one"]);
    expect(status().textContent).toBe("Copied");
  });

  it("says how to copy by hand when the copy fails", async () => {
    sheet = new TermCopySheet(async () => false);
    sheet.open(parent, { bufferText: () => "one" });
    parent.querySelector<HTMLButtonElement>("#term-copy-all")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(status().textContent).toBe(TERM_COPY_FAILURE);
    expect(TERM_COPY_FAILURE).toBe("Could not copy. Select the text and use your browser's Copy.");
  });

  it("disables Copy all on an empty buffer", () => {
    sheet = new TermCopySheet(async () => true);
    sheet.open(parent, { bufferText: () => "" });
    expect(area().value).toBe("");
    expect(parent.querySelector<HTMLButtonElement>("#term-copy-all")?.disabled).toBe(true);
    expect(parent.querySelector<HTMLButtonElement>("#term-copy-selection")?.disabled).toBe(true);
  });
});

describe("the floating selection button", () => {
  let button: HTMLButtonElement;
  let selection = "";
  let listeners: (() => void)[] = [];
  let copied: string[] = [];
  let dispose: (() => void) | null = null;

  const view: CopyFloatView = {
    getSelection: () => selection,
    onSelectionChange: (callback: () => void) => {
      listeners.push(callback);
      return () => {};
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    selection = "";
    listeners = [];
    copied = [];
    const host = document.createElement("div");
    host.innerHTML = termCopyFloatHtml();
    document.body.appendChild(host);
    button = document.querySelector<HTMLButtonElement>("#term-copy-float") as HTMLButtonElement;
    dispose = wireCopyFloat(button, view, async (text) => {
      copied.push(text);
      return true;
    });
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const emit = (next: string): void => {
    selection = next;
    for (const listener of listeners) {
      listener();
    }
  };

  it("shows only while a selection exists", () => {
    expect(button.hidden).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copy selection");
    emit("picked");
    expect(button.hidden).toBe(false);
    emit("");
    expect(button.hidden).toBe(true);
  });

  it("copies the selection, flashes Copied and clears nothing", async () => {
    emit("picked");
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toEqual(["picked"]);
    expect(button.querySelector("span")?.textContent).toBe("Copied");
    expect(view.getSelection()).toBe("picked");
    vi.advanceTimersByTime(2000);
    expect(button.querySelector("span")?.textContent).toBe("Copy");
  });
});

describe("the copy shortcut", () => {
  const key = (overrides: Partial<{ type: string; key: string; ctrlKey: boolean; shiftKey: boolean }>) => ({
    type: "keydown",
    key: "c",
    ctrlKey: true,
    shiftKey: true,
    ...overrides,
  });

  it("names Ctrl+Shift+C on the keydown", () => {
    expect(isCopyKeydown(key({}))).toBe(true);
    expect(isCopyKeydown(key({ key: "C" }))).toBe(true);
    expect(isCopyKeydown(key({ shiftKey: false }))).toBe(false);
    expect(isCopyKeydown(key({ type: "keyup" }))).toBe(false);
    expect(isCopyKeydown(key({ key: "x" }))).toBe(false);
  });

  it("copies and is not forwarded with a selection", async () => {
    const copied: string[] = [];
    const copy = async (text: string): Promise<boolean> => {
      copied.push(text);
      return true;
    };
    expect(handleCopyKeydown(key({}), () => "picked", copy)).toBe(false);
    await Promise.resolve();
    expect(copied).toEqual(["picked"]);
  });

  it("leaves plain Ctrl+C an interrupt even with a selection", () => {
    const copy = vi.fn(async (): Promise<boolean> => true);
    expect(handleCopyKeydown(key({ shiftKey: false }), () => "picked", copy)).toBe(true);
    expect(handleCopyKeydown(key({}), () => "", copy)).toBe(true);
    expect(handleCopyKeydown(key({ key: "x" }), () => "picked", copy)).toBe(true);
    expect(copy).not.toHaveBeenCalled();
  });
});

describe("TerminalView selection and buffer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("forwards getSelection, onSelectionChange and bufferText", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    let selection = "";
    const listeners: (() => void)[] = [];
    const view = new TerminalView(
      () => ({
        write: () => {},
        clear: () => {},
        focus: () => {},
        scrollToBottom: () => {},
        isAtBottom: () => true,
        onUserInput: () => () => {},
        onScroll: () => () => {},
        onReady: (callback: () => void) => {
          callback();
          return () => {};
        },
        getSelection: () => selection,
        onSelectionChange: (callback: () => void) => {
          listeners.push(callback);
          return () => {};
        },
        bufferText: (maxLines: number) => `last ${maxLines}`,
        dispose: () => {},
      }),
      { onUserInput: () => {} },
    );
    // Subscribing before the mount still hears the handle.
    const heard: string[] = [];
    view.mount(parent, 80, 24);
    const stop = view.onSelectionChange(() => heard.push(view.getSelection()));
    selection = "picked";
    for (const listener of listeners) {
      listener();
    }
    expect(heard).toEqual(["picked"]);
    expect(view.getSelection()).toBe("picked");
    expect(view.bufferText(2000)).toBe("last 2000");
    stop();
    selection = "again";
    for (const listener of listeners) {
      listener();
    }
    expect(heard).toEqual(["picked"]);
    view.dispose();
    expect(view.getSelection()).toBe("");
    expect(view.bufferText(2000)).toBe("");
  });
});
