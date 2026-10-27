// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShell } from "../src/app.js";
import type { Shell, ShellCallbacks } from "../src/app.js";
import { keyBytes } from "../src/keys.js";
import type { KeyDef } from "../src/keys.js";
import { connectFailMessage } from "../src/peer.js";
import { SessionStore } from "../src/sessions.js";
import type { TerminalFactory, TerminalHandle } from "../src/terminal.js";
import type { PairSubmit } from "../src/ui.js";

class FakeHandle implements TerminalHandle {
  written: string[] = [];
  clears = 0;
  disposed = false;
  atBottom = true;
  cols: number;
  rows: number;
  private inputListeners: ((text: string) => void)[] = [];
  private scrollListeners: (() => void)[] = [];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  write = (text: string): void => {
    this.written.push(text);
  };
  clear = (): void => {
    this.clears += 1;
  };
  focus = (): void => {};
  scrollToBottom = (): void => {
    this.atBottom = true;
  };
  isAtBottom = (): boolean => this.atBottom;
  onUserInput = (callback: (text: string) => void): (() => void) => {
    this.inputListeners.push(callback);
    return () => {};
  };
  onScroll = (callback: () => void): (() => void) => {
    this.scrollListeners.push(callback);
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

  emitScroll(atBottom: boolean): void {
    this.atBottom = atBottom;
    for (const listener of this.scrollListeners) {
      listener();
    }
  }
}

describe("createShell", () => {
  let root: HTMLDivElement;
  let store: SessionStore;
  let shell: Shell;
  let calls: ShellCallbacks & {
    pairs: PairSubmit[];
    keys: KeyDef[];
    inputs: string[];
    composerSends: { text: string; req: string }[];
  };
  let handles: FakeHandle[];

  const query = <T extends Element>(selector: string): T => {
    const el = root.querySelector(selector);
    if (!el) {
      throw new Error(`missing ${selector}`);
    }
    return el as T;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T00:00:00.000Z"));
    root = document.createElement("div");
    document.body.appendChild(root);
    store = new SessionStore();
    handles = [];
    const factory: TerminalFactory = (_host, cols, rows) => {
      const handle = new FakeHandle(cols, rows);
      handles.push(handle);
      return handle;
    };
    const pairs: PairSubmit[] = [];
    const keys: KeyDef[] = [];
    const inputs: string[] = [];
    const composerSends: { text: string; req: string }[] = [];
    const signal = {
      connected: [] as string[],
      disconnects: 0,
      retries: 0,
      pairAgains: 0,
      opened: [] as string[],
      left: 0,
      news: 0,
      builders: 0,
    };
    calls = {
      pairs,
      keys,
      inputs,
      composerSends,
      onPair: (submit) => pairs.push(submit),
      onConnect: (hostId) => signal.connected.push(hostId),
      onDisconnect: () => {
        signal.disconnects += 1;
      },
      onRetry: () => {
        signal.retries += 1;
      },
      onPairAgain: () => {
        signal.pairAgains += 1;
      },
      onOpenSession: (id) => signal.opened.push(id),
      onLeaveSession: () => {
        signal.left += 1;
      },
      onKeyPress: (def) => keys.push(def),
      onTerminalInput: (text) => inputs.push(text),
      onComposerSend: (text, req) => composerSends.push({ text, req }),
      onNew: () => {
        signal.news += 1;
      },
      onBuilder: () => {
        signal.builders += 1;
      },
    };
    (
      calls as unknown as {
        signal: typeof signal;
      }
    ).signal = signal;
    shell = createShell(root, store, calls, { terminalFactory: factory });
  });

  afterEach(() => {
    shell.dispose();
    root.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  const signal = () =>
    (
      calls as unknown as {
        signal: {
          connected: string[];
          disconnects: number;
          retries: number;
          pairAgains: number;
          opened: string[];
          left: number;
          news: number;
          builders: number;
        };
      }
    ).signal;

  it("shows the sign-in button", () => {
    shell.showSignIn();
    const button = query<HTMLButtonElement>("#signin-go");
    expect(button.textContent).toBe("Sign in with GitHub");
  });

  it("shows the pair form with the header once logged in", () => {
    shell.setLogin("octo");
    shell.showPair("7K3QH-M9P2X");
    expect(query(".topbar .login").textContent).toBe("octo");
    expect(query<HTMLInputElement>("#pair-code").value).toBe("7K3QH-M9P2X");
    shell.setOnlineHosts([{ host_id: "h1", label: "Host one" }]);
    query<HTMLInputElement>("#pair-code").value = "7K3QH-M9P2X";
    query<HTMLFormElement>("#pair-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(calls.pairs).toHaveLength(1);
    expect(calls.pairs[0]?.hostId).toBe("h1");
  });

  it("shows the host picker with connect buttons", () => {
    shell.setLogin("octo");
    shell.setPairedHosts([
      { host_id: "h1", label: "Host one" },
      { host_id: "h2", label: "Host two" },
    ]);
    shell.showHosts();
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-connect]")];
    expect(buttons).toHaveLength(2);
    buttons[0]?.click();
    expect(signal().connected).toEqual(["h1"]);
  });

  it("renders the sessions route with header, list and actions", () => {
    shell.setLogin("octo");
    shell.setHostLabel("Host one");
    shell.setConnectionState("connected");
    store.replace([
      {
        id: "s1",
        name: "build",
        cli: "muse",
        model: "spark",
        workdir: "/home/u/proj",
        status: "running",
        lastOutputAt: Date.now() - 30_000,
      },
    ]);
    shell.showSessions();
    expect(query(".topbar .login").textContent).toBe("octo");
    expect(query(".topbar .host").textContent).toBe("Host one");
    expect(query(".topbar .conn").textContent).toBe("connected");
    const row = query<HTMLButtonElement>('[data-session="s1"]');
    expect(row.querySelector(".session-name")?.textContent).toBe("build");
    row.click();
    expect(signal().opened).toEqual(["s1"]);
    query<HTMLButtonElement>("#session-new").click();
    expect(signal().news).toBe(1);
    query<HTMLButtonElement>("#conn-disconnect").click();
    expect(signal().disconnects).toBe(1);
  });

  it("updates the list when the store changes", () => {
    shell.showSessions();
    expect(root.querySelector(".session-list")).toBeNull();
    store.add({
      id: "s1",
      name: "build",
      cli: "",
      model: "",
      workdir: "",
      status: "running",
      lastOutputAt: null,
    });
    expect(root.querySelector('[data-session="s1"]')).not.toBeNull();
  });

  it("opens the session view with key bar and composer", () => {
    shell.showSession("s1", "build");
    expect(query(".session-title").textContent).toBe("build");
    const keys = [...root.querySelectorAll<HTMLButtonElement>("#keybar .key")];
    expect(keys).toHaveLength(10);
    keys[0]?.click();
    expect(calls.keys.map((def) => def.id)).toEqual(["esc"]);
    expect([...keyBytes(calls.keys[0] as KeyDef)]).toEqual([0x1b]);

    query<HTMLTextAreaElement>(".composer-input").value = "hello";
    query<HTMLButtonElement>(".composer-send").click();
    expect(calls.composerSends).toHaveLength(1);
    expect(calls.composerSends[0]?.text).toBe("hello");
    shell.composerOk(calls.composerSends[0]?.req ?? "");
    expect(query<HTMLTextAreaElement>(".composer-input").value).toBe("");

    query<HTMLButtonElement>(".composer-builder").click();
    expect(signal().builders).toBe(1);
    query<HTMLButtonElement>("#session-back").click();
    expect(signal().left).toBe(1);
  });

  it("mounts the terminal on ensureTerminal and writes to it", () => {
    shell.showSession("s1", "build");
    expect(root.querySelector(".term-host")).toBeNull();
    shell.ensureTerminal("s1", 80, 24);
    expect(root.querySelector(".term-host")).not.toBeNull();
    expect(handles).toHaveLength(1);
    shell.writeTerminal("hi");
    expect(handles[0]?.written).toEqual(["hi"]);
    // Same size: no remount.
    shell.ensureTerminal("s1", 80, 24);
    expect(handles).toHaveLength(1);
    // Another session's snapshot: ignored.
    shell.ensureTerminal("s2", 80, 24);
    expect(handles).toHaveLength(1);
    // Terminal input flows to the host.
    handles[0]?.emitInput("x");
    expect(calls.inputs).toEqual(["x"]);
  });

  it("keeps the terminal and the composer draft across state changes", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    shell.writeTerminal("hi");
    query<HTMLTextAreaElement>(".composer-input").value = "draft";
    shell.setConnectionState("retrying in 2s");
    expect(query(".topbar .conn").textContent).toBe("retrying in 2s");
    expect(handles).toHaveLength(1);
    expect(handles[0]?.disposed).toBe(false);
    expect(handles[0]?.written).toEqual(["hi"]);
    expect(query<HTMLTextAreaElement>(".composer-input").value).toBe("draft");
  });

  it("disposes the terminal and composer when leaving the session route", () => {
    const leaves: (() => void)[] = [
      () => shell.showPair(),
      () => shell.showHosts(),
      () => shell.showSignIn(),
      () => shell.showSessions(),
    ];
    for (const leave of leaves) {
      shell.showSession("s1", "build");
      shell.ensureTerminal("s1", 80, 24);
      expect(root.querySelector(".composer")).not.toBeNull();
      const handle = handles[handles.length - 1];
      leave();
      expect(handle?.disposed).toBe(true);
      expect(root.querySelector(".term-host")).toBeNull();
      expect(root.querySelector(".composer")).toBeNull();
    }
  });

  it("shows the ↓ latest button while scrolled up", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    const latest = query<HTMLButtonElement>("#term-latest");
    expect(latest.hidden).toBe(true);
    handles[0]?.emitScroll(false);
    expect(latest.hidden).toBe(false);
    latest.click();
    expect(latest.hidden).toBe(true);
  });

  it("shows retry and pair-again on failure", () => {
    shell.showSessions();
    shell.setConnectionState("failed: Too many devices connected");
    query<HTMLButtonElement>("#conn-retry").click();
    expect(signal().retries).toBe(1);
    shell.setConnectionState(`failed: ${connectFailMessage("unknown_device")}`);
    query<HTMLButtonElement>("#conn-pair-again").click();
    expect(signal().pairAgains).toBe(1);
  });

  it("shows the exit badge for the open session", () => {
    shell.showSession("s1", "build");
    shell.showSessionExited(1);
    const badge = query("#session-exit");
    expect(badge.textContent).toBe("exited (1)");
    expect((badge as HTMLElement).hidden).toBe(false);
  });

  it("zooms the terminal with the +/− buttons", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    // No crash without layout; zoom state lives in the view.
    query<HTMLButtonElement>("#term-zoom-in").click();
    query<HTMLButtonElement>("#term-zoom-out").click();
    expect(handles).toHaveLength(1);
  });
});
