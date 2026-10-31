// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { createGuestView } from "../src/guest-views.js";
import type { GuestView } from "../src/guest-views.js";
import type { SessionItem } from "../src/protocol.js";
import { SessionStore } from "../src/sessions.js";
import type { TerminalFactory, TerminalHandle } from "../src/terminal.js";

const NOW = 1793100000_000;

class FakeHandle implements TerminalHandle {
  written: string[] = [];
  clears = 0;
  disposed = false;
  private inputListeners: ((text: string) => void)[] = [];

  write = (text: string): void => {
    this.written.push(text);
  };
  clear = (): void => {
    this.clears += 1;
  };
  focus = (): void => {};
  scrollToBottom = (): void => {};
  isAtBottom = (): boolean => true;
  onUserInput = (callback: (text: string) => void): (() => void) => {
    this.inputListeners.push(callback);
    return () => {};
  };
  onScroll = (): (() => void) => () => {};
  onReady = (callback: () => void): (() => void) => {
    callback();
    return () => {};
  };
  dispose = (): void => {
    this.disposed = true;
  };

  emitInput(text: string): void {
    for (const listener of this.inputListeners) {
      listener(text);
    }
  }
}

function item(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: "s1",
    name: "build",
    cli: "muse",
    model: "spark",
    workdir: "/home/u/proj",
    status: "running",
    lastOutputAt: NOW - 12_000,
    ...overrides,
  };
}

interface Setup {
  root: HTMLElement;
  view: GuestView;
  store: SessionStore;
  opened: string[];
  inputs: Uint8Array[];
  sends: { text: string; req: string }[];
  handles: FakeHandle[];
  counts: { leaves: number; retries: number };
}

function setup(): Setup {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const store = new SessionStore();
  const opened: string[] = [];
  const inputs: Uint8Array[] = [];
  const sends: { text: string; req: string }[] = [];
  const handles: FakeHandle[] = [];
  const counts = { leaves: 0, retries: 0 };
  const factory: TerminalFactory = () => {
    const handle = new FakeHandle();
    handles.push(handle);
    return handle;
  };
  const view = createGuestView(
    root,
    store,
    {
      onOpenSession: (id) => opened.push(id),
      onLeaveSession: () => {
        counts.leaves += 1;
      },
      onRetry: () => {
        counts.retries += 1;
      },
      onSignOut: () => {},
      onForgetDevice: () => {},
      onInput: (bytes) => inputs.push(bytes),
      onComposerSend: (text, req) => sends.push({ text, req }),
    },
    { terminalFactory: factory },
  );
  return { root, view, store, opened, inputs, sends, handles, counts };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("guest entry screens", () => {
  it("gates unsigned guests behind GitHub sign-in", () => {
    const { root, view } = setup();
    view.showSignIn();
    expect(root.querySelector("main.signin h1")?.textContent).toBe("Canopy remote");
    expect(root.querySelector("#signin-go")?.textContent).toBe("Sign in with GitHub");
    expect(root.querySelector('main.signin a[href*="privacy"]')).not.toBeNull();
    expect(root.querySelector("footer.look-colophon")).not.toBeNull();
  });

  it("rejects a malformed link without a sign-in button", () => {
    const { root, view } = setup();
    view.showInvalidLink();
    expect(root.querySelector("#signin-go")).toBeNull();
    expect(root.querySelector("main.signin [role='alert']")?.textContent).toContain("malformed");
  });

  it("ends every guest screen in the footer, after the main", () => {
    const { root, view } = setup();
    const footerAfterMain = (): void => {
      const footer = root.querySelector("footer.look-colophon");
      expect(footer).not.toBeNull();
      expect(footer?.previousElementSibling?.tagName).toBe("MAIN");
      expect(footer?.textContent).toContain("Canopy remote");
    };
    view.showSignIn();
    footerAfterMain();
    view.showInvalidLink();
    footerAfterMain();
    view.setConnectionState("connecting");
    view.showConnecting();
    footerAfterMain();
    view.showForbidden("This host is not shared with you");
    footerAfterMain();
    view.showList();
    footerAfterMain();
    view.showSession("s1", "build");
    footerAfterMain();
    // The terminal, key bar and composer stay inside the main; the footer
    // follows it, so nothing scrolls the terminal out or covers it.
    const main = root.querySelector("main.session-view");
    expect(main?.querySelector("#term-pane")).not.toBeNull();
    expect(main?.querySelectorAll("#keybar .key").length).toBe(9);
    expect(main?.querySelector(".composer-input")).not.toBeNull();
    expect(root.querySelector("main.session-view footer.look-colophon")).toBeNull();
  });

  it("shows the relay state while connecting, with a retry on failure", () => {
    const { root, view, counts } = setup();
    view.setConnectionState("connecting");
    view.showConnecting();
    expect(root.querySelector(".conn-banner")?.textContent).toContain("connecting");
    expect(root.querySelector("#guest-retry")).toBeNull();
    view.setConnectionState("failed: Connection closed");
    const retry = root.querySelector<HTMLButtonElement>("#guest-retry");
    expect(retry).not.toBeNull();
    retry?.click();
    expect(counts.retries).toBe(1);
  });

  it("paints the unauthorized state with the hub's message", () => {
    const { root, view } = setup();
    view.setLogin("guest-user");
    view.showForbidden("This host is not shared with you");
    expect(root.querySelector("main.signin h1")?.textContent).toBe("Not shared");
    expect(root.querySelector("main.signin [role='alert']")?.textContent).toBe(
      "This host is not shared with you",
    );
  });
});

describe("guest session list", () => {
  it("lists shared sessions with no New button", () => {
    const { root, view, store, opened } = setup();
    view.setLogin("guest-user");
    view.showList();
    store.replace([item(), item({ id: "s2", name: "docs" })]);
    expect(root.querySelector(".sessions-head h2")?.textContent).toBe("Shared sessions");
    expect(root.querySelector("#session-new")).toBeNull();
    expect(root.querySelectorAll("[data-session]").length).toBe(2);
    root.querySelector<HTMLButtonElement>('[data-session="s2"]')?.click();
    expect(opened).toEqual(["s2"]);
  });

  it("says what an empty grant means, and what connecting means", () => {
    const { root, view, store } = setup();
    view.showList();
    expect(root.querySelector("p.empty")?.textContent).toBe("Connecting to the host…");
    store.replace([]);
    expect(root.querySelector("p.empty")?.textContent).toBe("No sessions shared with you.");
  });

  it("carries the unauthorized notice above the list", () => {
    const { root, view, store } = setup();
    view.showList("That session is not shared with you.");
    store.replace([item()]);
    expect(root.querySelector("#guest-notice")?.textContent).toContain("not shared with you");
    expect(root.querySelectorAll("[data-session]").length).toBe(1);
    view.showList();
    expect(root.querySelector("#guest-notice")).toBeNull();
  });
});

describe("guest session view", () => {
  it("shows the owner's terminal, key bar and composer, minus the builder", () => {
    const { root, view, counts } = setup();
    view.showSession("s1", "build");
    expect(root.querySelector(".session-title")?.textContent).toBe("build");
    expect(root.querySelector("#term-pane .term-placeholder")?.textContent).toBe("Attaching…");
    expect(root.querySelectorAll("#keybar button.key").length).toBe(9);
    expect(root.querySelector(".composer-input")).not.toBeNull();
    expect(root.querySelector(".composer-send")).not.toBeNull();
    // No builder, no sheets, no Files: a guest sends text prompts only.
    expect(root.querySelector<HTMLButtonElement>(".composer-builder")?.hidden).toBe(true);
    expect(root.querySelector("#session-files")).toBeNull();
    root.querySelector<HTMLButtonElement>("#session-back")?.click();
    expect(counts.leaves).toBe(1);
  });

  it("mounts the terminal on snapshot and feeds it output", () => {
    const { root, view, handles } = setup();
    view.showSession("s1", "build");
    view.ensureTerminal("s1", 80, 24);
    expect(handles.length).toBe(1);
    expect(root.querySelector("#term-pane .term-placeholder")).toBeNull();
    view.writeTerminal("hello");
    view.writeTerminal("!");
    expect(handles[0]?.written.join("")).toBe("hello!");
    view.clearTerminal();
    expect(handles[0]?.clears).toBe(1);
  });

  it("ignores snapshots for another session and same-size remounts", () => {
    const { view, handles } = setup();
    view.showSession("s1", "build");
    view.ensureTerminal("s2", 80, 24);
    expect(handles.length).toBe(0);
    view.ensureTerminal("s1", 80, 24);
    view.ensureTerminal("s1", 80, 24);
    expect(handles.length).toBe(1);
    // A changed host size remounts the terminal but keeps the draft.
    const area = document.querySelector<HTMLTextAreaElement>(".composer-input");
    area!.value = "draft kept";
    view.ensureTerminal("s1", 100, 30);
    expect(handles.length).toBe(2);
    expect(handles[0]?.disposed).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>(".composer-input")?.value).toBe("draft kept");
  });

  it("sends typed text and key-bar keys as input", () => {
    const { root, view, handles, inputs } = setup();
    view.showSession("s1", "build");
    view.ensureTerminal("s1", 80, 24);
    handles[0]?.emitInput("ls");
    root.querySelector<HTMLButtonElement>('#keybar button[data-key="enter"]')?.click();
    expect(Array.from(inputs, (bytes) => Array.from(bytes))).toEqual([
      Array.from(new TextEncoder().encode("ls")),
      [0x0d],
    ]);
  });

  it("applies the one-shot Ctrl latch to typed text, then releases it", () => {
    const { root, view, handles, inputs } = setup();
    view.showSession("s1", "build");
    view.ensureTerminal("s1", 80, 24);
    root.querySelector<HTMLButtonElement>('#keybar button[data-key="ctrl"]')?.click();
    expect(root.querySelector('#keybar button[data-key="ctrl"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    handles[0]?.emitInput("c");
    expect(Array.from(inputs[0] ?? [])).toEqual([0x03]);
    expect(root.querySelector('#keybar button[data-key="ctrl"]')?.getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("sends prompts through the composer and answers ok and error", () => {
    const { root, view, sends } = setup();
    view.showSession("s1", "build");
    const area = root.querySelector<HTMLTextAreaElement>(".composer-input");
    area!.value = "fix the build";
    root.querySelector<HTMLButtonElement>(".composer-send")?.click();
    expect(sends.length).toBe(1);
    expect(sends[0]?.text).toBe("fix the build");
    view.composerOk(sends[0]?.req ?? "");
    expect(root.querySelector<HTMLElement>(".composer-ok")?.hidden).toBe(false);
    expect(area?.value).toBe("");
    area!.value = "again";
    root.querySelector<HTMLButtonElement>(".composer-send")?.click();
    view.composerError("host is busy", sends[1]?.req ?? null);
    const error = root.querySelector<HTMLElement>(".composer-error");
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe("host is busy");
    expect(area?.value).toBe("again");
  });

  it("patches the exit badge and the header in place, keeping the terminal", () => {
    const { root, view, handles } = setup();
    view.showSession("s1", "build");
    view.ensureTerminal("s1", 80, 24);
    view.writeTerminal("kept");
    view.setSessionStatus("Session exited (1)");
    const badge = root.querySelector<HTMLElement>("#guest-exit");
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toBe("Session exited (1)");
    view.setSessionStatus(null);
    expect(root.querySelector<HTMLElement>("#guest-exit")?.hidden).toBe(true);
    view.setConnectionState("retrying");
    view.setLogin("guest-user");
    view.setSignOutError(null);
    // Still the same terminal: nothing repainted under it.
    expect(handles.length).toBe(1);
    expect(handles[0]?.disposed).toBe(false);
    expect(handles[0]?.written.join("")).toBe("kept");
    expect(root.querySelector(".topbar .conn")?.textContent).toBe("retrying");
  });

  it("tears the terminal down when leaving the session", () => {
    const { view, handles } = setup();
    view.showSession("s1", "build");
    view.ensureTerminal("s1", 80, 24);
    view.showList();
    expect(handles[0]?.disposed).toBe(true);
    expect(document.querySelector("#term-pane")).toBeNull();
  });

  it("opens the account menu for a sign-out failure inside the session", () => {
    const { root, view, handles } = setup();
    view.setLogin("guest-user");
    view.showSession("s1", "build");
    view.ensureTerminal("s1", 80, 24);
    view.setSignOutError("Could not sign out");
    // The menu opens so the failure is visible; the terminal survives.
    expect(root.querySelector<HTMLDetailsElement>("#account")?.open).toBe(true);
    expect(root.querySelector("#signout-error-menu")?.textContent).toBe("Could not sign out");
    expect(handles.length).toBe(1);
    expect(handles[0]?.disposed).toBe(false);
  });
});

describe("guest chrome", () => {
  it("paints the login and the connection state in the topbar", () => {
    const { root, view } = setup();
    view.setLogin("guest-user");
    view.setConnectionState("connected");
    view.showList();
    expect(root.querySelector(".topbar .login")?.textContent).toBe("guest-user");
    expect(root.querySelector(".topbar .conn")?.textContent).toBe("connected");
    expect(root.querySelector(".topbar")?.getAttribute("data-conn")).toBe("connected");
  });
});
