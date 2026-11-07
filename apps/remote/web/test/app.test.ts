// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShell } from "../src/app.js";
import type { Shell, ShellCallbacks } from "../src/app.js";
import { CatalogStore } from "../src/catalog.js";
import { connectFailMessage } from "../src/peer.js";
import type { PromptDraft, SpawnRequest } from "../src/protocol.js";
import { openSessionName, SessionStore } from "../src/sessions.js";
import type { TerminalFactory, TerminalHandle } from "../src/terminal.js";
import { KEYBAR_KEY, writeControlSize } from "../src/terminal-prefs.js";
import { sessionTitle } from "../src/titles.js";
import type { PairSubmit } from "../src/ui.js";

class FakeHandle implements TerminalHandle {
  written: Uint8Array[] = [];
  clears = 0;
  disposed = false;
  focuses = 0;
  atBottom = true;
  alternate = false;
  cols: number;
  rows: number;
  resizes: { cols: number; rows: number }[] = [];
  private inputListeners: ((text: string) => void)[] = [];
  private scrollListeners: (() => void)[] = [];
  private bufferListeners: (() => void)[] = [];

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  resize = (cols: number, rows: number): void => {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push({ cols, rows });
  };

  write = (data: Uint8Array): void => {
    this.written.push(data);
  };
  clear = (): void => {
    this.clears += 1;
  };
  focus = (): void => {
    this.focuses += 1;
  };
  blur = (): void => {};
  scrollToBottom = (): void => {
    this.atBottom = true;
  };
  isAtBottom = (): boolean => this.atBottom;
  isAlternateBuffer = (): boolean => this.alternate;
  onBufferChange = (callback: () => void): (() => void) => {
    this.bufferListeners.push(callback);
    return () => {};
  };
  onUserInput = (callback: (text: string) => void): (() => void) => {
    this.inputListeners.push(callback);
    return () => {};
  };
  onScroll = (callback: () => void): (() => void) => {
    this.scrollListeners.push(callback);
    return () => {};
  };
  onReady = (callback: () => void): (() => void) => {
    callback();
    return () => {};
  };
  getSelection = (): string => "";
  onSelectionChange = (): (() => void) => () => {};
  bufferText = (): string => "";
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

  emitBufferChange(alternate: boolean): void {
    this.alternate = alternate;
    for (const listener of this.bufferListeners) {
      listener();
    }
  }
}

describe("createShell", () => {
  let root: HTMLDivElement;
  let store: SessionStore;
  let catalog: CatalogStore;
  let shell: Shell;
  let calls: ShellCallbacks & {
    pairs: PairSubmit[];
    keys: Uint8Array[];
    inputs: Uint8Array[];
    controlSizes: { cols: number; rows: number }[];
    spawns: { spawn: SpawnRequest; req: string }[];
    composes: { draft: PromptDraft; req: string }[];
    draftSends: { draft: PromptDraft; req: string }[];
  };
  let handles: FakeHandle[];
  let sendable: boolean;
  let released: number;

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
    localStorage.clear();
    root = document.createElement("div");
    document.body.appendChild(root);
    store = new SessionStore();
    catalog = new CatalogStore();
    catalog.replace({
      clis: [
        { cli: "muse", label: "Muse", models: ["spark"] },
        { cli: "claude", label: "Claude", models: [] },
      ],
      projects: [
        { name: "demo", path: "/home/u/demo" },
        { name: "other", path: "/home/u/other" },
      ],
      presets: [{ name: "review", preview: "Review the diff." }],
      skills: [{ name: "tdd", label: "TDD" }],
    });
    handles = [];
    sendable = true;
    const factory: TerminalFactory = (_host, cols, rows) => {
      const handle = new FakeHandle(cols, rows);
      handles.push(handle);
      return handle;
    };
    const pairs: PairSubmit[] = [];
    const keys: Uint8Array[] = [];
    const inputs: Uint8Array[] = [];
    const controlSizes: { cols: number; rows: number }[] = [];
    released = 0;
    const spawns: { spawn: SpawnRequest; req: string }[] = [];
    const composes: { draft: PromptDraft; req: string }[] = [];
    const draftSends: { draft: PromptDraft; req: string }[] = [];
    const signal = {
      connected: [] as string[],
      disconnects: 0,
      retries: 0,
      pairAgains: 0,
      opened: [] as string[],
      left: 0,
    };
    calls = {
      pairs,
      keys,
      inputs,
      controlSizes,
      spawns,
      composes,
      draftSends,
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
      onSignOut: () => {},
      onForgetDevice: () => {},
      onKeyPress: (bytes) => keys.push(bytes),
      onTerminalInput: (bytes) => inputs.push(bytes),
      onControlSize: (cols, rows) => controlSizes.push({ cols, rows }),
      onReleaseSize: () => {
        released += 1;
      },
      onKill: () => true,
      onSpawn: (spawn, req) => {
        spawns.push({ spawn, req });
        return sendable;
      },
      onCompose: (draft, req) => {
        composes.push({ draft, req });
        return sendable;
      },
      onSendDraft: (draft, req) => {
        draftSends.push({ draft, req });
        return sendable;
      },
      onSchedule: () => sendable,
      onScheduledList: () => sendable,
      onScheduledCancel: () => sendable,
      onGraphsRequest: () => {},
      onWatchGraph: () => {},
      onUnwatchGraph: () => {},
      onGraphControl: () => true,
    };
    (
      calls as unknown as {
        signal: typeof signal;
      }
    ).signal = signal;
    shell = createShell(root, store, calls, { terminalFactory: factory, catalog });
  });

  afterEach(() => {
    shell.dispose();
    root.remove();
    document.body.innerHTML = "";
    localStorage.clear();
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
        };
      }
    ).signal;

  it("shows the sign-in button", () => {
    shell.showSignIn();
    const button = query<HTMLButtonElement>("#signin-go");
    expect(button.textContent).toBe("Sign in with GitHub");
    expect(button.classList.contains("primary")).toBe(true);
  });

  it("wears the header banner home link on every route, never a body banner", () => {
    const routes: Array<() => void> = [
      () => shell.showSignIn(),
      () => shell.showPair(),
      () => shell.showHosts(),
      () => shell.showSessions(),
      () => shell.showSession("s1", "build"),
    ];
    for (const show of routes) {
      show();
      const home = root.querySelector("#brand-home");
      expect(home?.getAttribute("aria-label")).toBe("Canopy remote, home");
      expect(home?.querySelectorAll(".look-banner-line")).toHaveLength(11);
      expect(home?.querySelector(".look-banner-header")?.getAttribute("role")).toBe("img");
      expect(root.querySelector(".look-banner")).toBeNull();
    }
    // The sign-in screen carries the header too, above its heading.
    shell.showSignIn();
    expect(root.querySelector(".topbar")).not.toBeNull();
    expect(query("main.signin").firstElementChild?.tagName).toBe("H1");
  });

  it("goes home through onLeaveSession, never before pairing", () => {
    shell.showSession("s1", "build");
    query<HTMLButtonElement>("#brand-home").click();
    expect(signal().left).toBe(1);
    shell.showSessions();
    query<HTMLButtonElement>("#brand-home").click();
    expect(signal().left).toBe(2);
    // Before pairing there is no home to show: the banner stays put.
    shell.showSignIn();
    query<HTMLButtonElement>("#brand-home").click();
    shell.showPair();
    query<HTMLButtonElement>("#brand-home").click();
    shell.showHosts();
    query<HTMLButtonElement>("#brand-home").click();
    expect(signal().left).toBe(2);
  });

  it("marks the topbar with the connection state for the host chip", () => {
    shell.showSessions();
    expect(query(".topbar").getAttribute("data-conn")).toBe("connecting");
    shell.setHostLabel("Host one");
    shell.setConnectionState("connected");
    expect(query(".topbar").getAttribute("data-conn")).toBe("connected");
    shell.setConnectionState("retrying in 2s");
    expect(query(".topbar").getAttribute("data-conn")).toBe("retrying in 2s");
  });

  it("draws the host link as wifi while connected and wifi-off otherwise", () => {
    shell.showSessions();
    shell.setHostLabel("Host one");
    shell.setConnectionState("connected");
    const slot = () => query("#conn-icon").getAttribute("data-icon");
    expect(slot()).toBe("wifi");
    expect(query("#conn-icon svg").getAttribute("stroke")).toBe("currentColor");
    shell.setConnectionState("failed: host is gone");
    expect(slot()).toBe("wifiOff");
    // A full re-render mounts the same icon in the current state.
    shell.showSessions();
    expect(slot()).toBe("wifiOff");
  });

  it("draws the session bar's controls as icons, with their names", () => {
    shell.showSession("s1", "build");
    expect(query("#session-back").getAttribute("aria-label")).toBe("Back to sessions");
    expect(query("#session-back svg")).not.toBeNull();
    expect(query("#session-back").textContent).toBe("");
    expect(query("#term-zoom-out svg")).not.toBeNull();
    expect(query("#term-zoom-in svg")).not.toBeNull();
    expect(query("#term-builder svg")).not.toBeNull();
    expect(query("#term-builder").textContent).toContain("Builder");
    // The Keys switch keeps its word beside a keyboard icon (the word
    // steps aside on a phone; the aria-label names it there).
    expect(query("#term-keys").textContent).toBe("Keys");
    expect(query("#term-keys svg")).not.toBeNull();
    expect(query("#term-keys").getAttribute("aria-label")).toBe("Show terminal keys");
    expect(query("#term-latest").getAttribute("aria-label")).toBe("Scroll to the latest output");
    expect(query("#term-latest").getAttribute("title")).toBe("Scroll to the latest output");
  });

  it("ends every view in the same UniverLab footer, after the main", () => {
    const footerHtml = (): string => {
      const footer = root.querySelector("footer.look-colophon");
      expect(footer).not.toBeNull();
      // The footer is a sibling after </main>: at the end of the scroll,
      // never overlaying the view's own widgets.
      expect(footer?.previousElementSibling?.tagName).toBe("MAIN");
      expect(footer?.parentElement).toBe(root);
      return footer?.innerHTML ?? "";
    };
    shell.showSignIn();
    expect(root.querySelector("footer.look-colophon")?.textContent).toContain("Canopy remote");
    expect(footerHtml()).toContain('href="https://univerlab.org/privacy/"');
    expect(footerHtml()).toContain('href="https://univerlab.org/terms/"');
    shell.showPair();
    expect(footerHtml()).toContain('href="https://univerlab.org/privacy/"');
    expect(footerHtml()).toContain('href="https://univerlab.org/terms/"');
    shell.showHosts();
    expect(footerHtml()).toContain("Canopy remote");
    shell.showSessions();
    expect(footerHtml()).toContain("Canopy remote");
    // The graphs home tab shares the sessions route's template, footer kept.
    query<HTMLButtonElement>('[data-tab="graphs"]').click();
    expect(root.querySelector("#session-list")).not.toBeNull();
    expect(footerHtml()).toContain("Canopy remote");
    query<HTMLButtonElement>('[data-tab="sessions"]').click();
    shell.showSession("s1", "build");
    expect(footerHtml()).toContain("Canopy remote");
  });

  it("keeps the session view's terminal and key bar above the footer", () => {
    shell.showSession("s1", "build");
    const main = query("main.session-view");
    expect(main.querySelector("#term-pane")).not.toBeNull();
    expect(main.querySelectorAll("#keybar .key").length).toBe(10);
    expect(main.querySelector("#term-builder")).not.toBeNull();
    // The terminal is the only text input: no textarea below it.
    expect(main.querySelector("textarea")).toBeNull();
    // The terminal and key bar live inside the main; the footer follows
    // it, so nothing scrolls the terminal out or covers it.
    expect(root.querySelector("main.session-view footer.look-colophon")).toBeNull();
    const footer = root.querySelector("footer.look-colophon");
    expect(footer).not.toBeNull();
    expect(footer?.previousElementSibling).toBe(main);
  });

  it("says what signing in shares before the click", () => {
    shell.showSignIn();
    const note = query<HTMLButtonElement>("#signin-go").nextElementSibling;
    expect(note?.tagName).toBe("P");
    expect(note?.textContent).toMatch(
      /^Signing in shares your GitHub username and numeric id with this relay, kept in a 12-hour session cookie\./,
    );
    expect(note?.textContent).toContain("Your sessions travel encrypted between your browser and your machine.");
    expect(
      root.querySelector('.signin a[href="https://univerlab.org/privacy/"]')?.textContent,
    ).toBe("Privacy");
  });

  it("marks the body with the current view", () => {
    shell.showSession("s1", "build");
    expect(document.body.dataset.view).toBe("session");
    shell.showSessions();
    expect(document.body.dataset.view).toBe("sessions");
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
        kind: "agent",
        lastOutputAt: Date.now() - 30_000,
      },
    ]);
    shell.showSessions();
    expect(query(".topbar .login").textContent).toBe("octo");
    expect(query(".topbar .host").textContent).toBe("Host one");
    expect(root.querySelector(".conn-banner")).toBeNull();
    const row = query<HTMLButtonElement>('[data-session="s1"]');
    expect(row.querySelector(".session-name")?.textContent).toBe("build");
    row.click();
    expect(signal().opened).toEqual(["s1"]);
    query<HTMLButtonElement>("#session-new").click();
    expect(root.querySelector("#new-form")).not.toBeNull();
    query<HTMLButtonElement>("#new-close").click();
    expect(root.querySelector(".sheet-overlay")).toBeNull();
    // Disconnect rides the header beside the host chip — nothing below.
    expect(root.querySelector("main #conn-disconnect")).toBeNull();
    query<HTMLButtonElement>(".topbar #conn-disconnect").click();
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
      kind: "terminal",
      lastOutputAt: null,
    });
    expect(root.querySelector('[data-session="s1"]')).not.toBeNull();
  });

  it("opens the session view with key bar and builder", () => {
    shell.showSession("s1", "build");
    expect(query(".session-title").textContent).toBe("build");
    const keys = [...root.querySelectorAll<HTMLButtonElement>("#keybar .key")];
    expect(keys).toHaveLength(10);
    keys[0]?.click();
    expect(calls.keys.map((bytes) => [...bytes])).toEqual([[0x1b]]);

    // The terminal is the only text input: no textarea below it.
    expect(root.querySelector("textarea")).toBeNull();

    // The Builder button lives in the controls row and opens the sheet.
    const builder = query<HTMLButtonElement>("#term-builder");
    expect(builder.closest(".term-controls")).not.toBeNull();
    builder.click();
    expect(root.querySelector("#builder-form")).not.toBeNull();
    query<HTMLButtonElement>("#builder-close").click();
    query<HTMLButtonElement>("#session-back").click();
    expect(signal().left).toBe(1);
  });

  it("latches Ctrl and Shift for exactly one key", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    const ctrl = query<HTMLButtonElement>('#keybar .key[data-key="ctrl"]');
    const tab = query<HTMLButtonElement>('#keybar .key[data-key="tab"]');
    const shift = query<HTMLButtonElement>('#keybar .key[data-key="shift"]');
    ctrl.click();
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    expect(calls.keys).toHaveLength(0);
    // A second tap releases without sending.
    ctrl.click();
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    expect(calls.keys).toHaveLength(0);
    // Latched Ctrl turns the phone keyboard's c into 0x03, then releases.
    ctrl.click();
    handles[0]?.emitInput("c");
    expect(calls.inputs.map((bytes) => [...bytes])).toEqual([[0x03]]);
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    // Latched Shift turns the bar's Tab into back-tab, then releases.
    shift.click();
    tab.click();
    expect(calls.keys.map((bytes) => [...bytes])).toEqual([[0x1b, 0x5b, 0x5a]]);
    expect(shift.getAttribute("aria-pressed")).toBe("false");
  });

  it("forwards a focus report unchanged, leaving the latch armed", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    const ctrl = query<HTMLButtonElement>('#keybar .key[data-key="ctrl"]');
    ctrl.click();
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    // The focus-in report from tapping the terminal is xterm's own, not
    // typing: it goes out as-is and spends nothing.
    handles[0]?.emitInput("\x1b[I");
    expect(calls.inputs.map((bytes) => [...bytes])).toEqual([[0x1b, 0x5b, 0x49]]);
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    // The armed latch still applies to the next typed key.
    handles[0]?.emitInput("c");
    expect(calls.inputs.map((bytes) => [...bytes])).toEqual([
      [0x1b, 0x5b, 0x49],
      [0x03],
    ]);
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  });

  it("sends typed c as 0x03 with Ctrl latched, then releases", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    const ctrl = query<HTMLButtonElement>('#keybar .key[data-key="ctrl"]');
    ctrl.click();
    handles[0]?.emitInput("c");
    expect(calls.inputs.map((bytes) => [...bytes])).toEqual([[0x03]]);
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  });

  it("sends typed a as A with Shift latched, then releases", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    const shift = query<HTMLButtonElement>('#keybar .key[data-key="shift"]');
    shift.click();
    handles[0]?.emitInput("a");
    expect(calls.inputs.map((bytes) => [...bytes])).toEqual([[0x41]]);
    expect(shift.getAttribute("aria-pressed")).toBe("false");
  });

  it("focuses the terminal when arming a latch, never when releasing", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    const ctrl = query<HTMLButtonElement>('#keybar .key[data-key="ctrl"]');
    const shift = query<HTMLButtonElement>('#keybar .key[data-key="shift"]');
    const focuses = () => handles[0]?.focuses ?? -1;
    ctrl.click();
    expect(focuses()).toBe(1);
    // Releasing the latch touches nothing.
    ctrl.click();
    expect(focuses()).toBe(1);
    shift.click();
    expect(focuses()).toBe(2);
    shift.click();
    expect(focuses()).toBe(2);
  });

  it("sends Ctrl+Backspace as BS and releases the latch", () => {
    shell.showSession("s1", "build");
    const ctrl = query<HTMLButtonElement>('#keybar .key[data-key="ctrl"]');
    const backspace = query<HTMLButtonElement>('#keybar .key[data-key="backspace"]');
    ctrl.click();
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    backspace.click();
    expect(calls.keys.map((bytes) => [...bytes])).toEqual([[0x08]]);
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
    // Unlatched Backspace is DEL.
    backspace.click();
    expect(calls.keys.map((bytes) => [...bytes])).toEqual([[0x08], [0x7f]]);
  });

  it("mounts the terminal on ensureTerminal and writes to it", () => {
    shell.showSession("s1", "build");
    expect(root.querySelector(".term-host")).toBeNull();
    shell.ensureTerminal("s1", 80, 24);
    expect(root.querySelector(".term-host")).not.toBeNull();
    expect(handles).toHaveLength(1);
    shell.writeTerminal(new TextEncoder().encode("hi"));
    expect(handles[0]?.written).toEqual([new TextEncoder().encode("hi")]);
    // Same size: no remount.
    shell.ensureTerminal("s1", 80, 24);
    expect(handles).toHaveLength(1);
    // Another session's snapshot: ignored.
    shell.ensureTerminal("s2", 80, 24);
    expect(handles).toHaveLength(1);
    // Terminal input flows to the host.
    handles[0]?.emitInput("x");
    expect(calls.inputs.map((bytes) => [...bytes])).toEqual([[0x78]]);
  });

  it("focuses the terminal once on attach under a fine pointer", async () => {
    const realMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = ((query: string) => ({
      matches: query === "(pointer: fine)",
    })) as unknown as typeof globalThis.matchMedia;
    try {
      shell.showSession("s1", "build");
      shell.ensureTerminal("s1", 80, 24);
      await Promise.resolve();
      expect(handles[0]?.focuses).toBe(1);
      // A remount focuses its own attach, never the stale one.
      shell.ensureTerminal("s1", 100, 40);
      await Promise.resolve();
      expect(handles[0]?.focuses).toBe(1);
      expect(handles[1]?.focuses).toBe(1);
    } finally {
      globalThis.matchMedia = realMatchMedia;
    }
  });

  it("leaves the terminal unfocused on attach without a fine pointer", async () => {
    const realMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = (() => ({ matches: false })) as unknown as typeof globalThis.matchMedia;
    try {
      shell.showSession("s1", "build");
      shell.ensureTerminal("s1", 80, 24);
      await Promise.resolve();
      expect(handles[0]?.focuses).toBe(0);
    } finally {
      globalThis.matchMedia = realMatchMedia;
    }
  });

  it("hides the size row while the resize is disabled", () => {
    shell.showSession("s1", "build");
    expect(root.querySelector("#term-control-size")).toBeNull();
    expect(root.querySelector(".term-size")).toBeNull();
    expect(calls.controlSizes).toEqual([]);
    // Mounting asserts nothing either.
    shell.ensureTerminal("s1", 80, 24);
    expect(calls.controlSizes).toEqual([]);
    expect(query(".term-pane").hasAttribute("data-size-owner")).toBe(false);
  });

  // happy-dom has no layout: a 400 × 320 px panel and a grid whose
  // natural size follows the newest handle at 8 × 16 px cells, so the
  // size that fits the panel is 50 × 20 whatever the host's size is.
  const layOutPanel = (): void => {
    const handle = handles[handles.length - 1];
    const fit = root.querySelector<HTMLElement>(".term-fit");
    const host = root.querySelector<HTMLElement>(".term-host");
    if (!handle || !fit || !host) {
      throw new Error("no terminal to lay out");
    }
    Object.defineProperty(fit, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(fit, "clientHeight", { value: 320, configurable: true });
    Object.defineProperty(host, "scrollWidth", { get: () => handle.cols * 8, configurable: true });
    Object.defineProperty(host, "scrollHeight", { get: () => handle.rows * 16, configurable: true });
  };

  it("asserts nothing from this panel while the resize is disabled", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    layOutPanel();
    vi.advanceTimersByTime(1000);
    expect(calls.controlSizes).toEqual([]);
    expect(handles).toHaveLength(1);
    expect(handles[0]?.resizes).toEqual([]);
    expect(query(".term-pane").hasAttribute("data-size-owner")).toBe(false);
  });

  it("still asserts nothing after a remount while the resize is disabled", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    layOutPanel();
    // A remount (a changed host size): the fresh terminal is laid out and
    // nothing goes out.
    shell.ensureTerminal("s1", 100, 40);
    expect(handles).toHaveLength(2);
    layOutPanel();
    vi.advanceTimersByTime(1000);
    expect(calls.controlSizes).toEqual([]);
  });

  it("zooms without owning or asserting while the resize is disabled", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    layOutPanel();
    const before = query<HTMLElement>(".term-fit").dataset.scale;
    query<HTMLButtonElement>("#term-zoom-in").click();
    expect(query<HTMLElement>(".term-fit").dataset.scale).not.toBe(before);
    vi.advanceTimersByTime(1000);
    expect(calls.controlSizes).toEqual([]);
    expect(query(".term-pane").hasAttribute("data-size-owner")).toBe(false);
  });

  it("follows the host's resized frame in place while not the size owner", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    handles[0]?.write(new TextEncoder().encode("kept"));
    shell.sessionResized("s1", 120, 40);
    // Resized in place: the same terminal, its content kept.
    expect(handles).toHaveLength(1);
    expect(handles[0]?.resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(handles[0]?.written).toHaveLength(1);
    // A snapshot at the new size does not remount.
    shell.ensureTerminal("s1", 120, 40);
    expect(handles).toHaveLength(1);
    // Another session's frame changes nothing.
    shell.sessionResized("s2", 90, 20);
    expect(handles[0]?.resizes).toHaveLength(1);
    expect(calls.controlSizes).toEqual([]);
  });

  it("follows a new host size without owning while the resize is disabled", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    layOutPanel();
    // Another device asserts 120 × 40: follow it, assert nothing back.
    shell.sessionResized("s1", 120, 40);
    expect(handles[0]?.resizes.at(-1)).toEqual({ cols: 120, rows: 40 });
    expect(calls.controlSizes).toEqual([]);
    expect(released).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(calls.controlSizes).toEqual([]);
  });

  it("ignores a remembered control-size toggle while the resize is disabled", () => {
    writeControlSize("s1", true);
    shell.showSession("s1", "build");
    expect(root.querySelector("#term-control-size")).toBeNull();
    shell.ensureTerminal("s1", 80, 24);
    layOutPanel();
    vi.advanceTimersByTime(1000);
    expect(calls.controlSizes).toEqual([]);
    expect(handles[0]?.resizes).toEqual([]);
  });

  it("keeps the terminal across state changes", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    shell.writeTerminal(new TextEncoder().encode("hi"));
    shell.setConnectionState("retrying in 2s");
    expect(query(".conn-banner").textContent).toContain("retrying in 2s");
    expect(handles).toHaveLength(1);
    expect(handles[0]?.disposed).toBe(false);
    expect(handles[0]?.written).toEqual([new TextEncoder().encode("hi")]);
  });

  it("disposes the terminal when leaving the session route", () => {
    const leaves: (() => void)[] = [
      () => shell.showPair(),
      () => shell.showHosts(),
      () => shell.showSignIn(),
      () => shell.showSessions(),
    ];
    for (const leave of leaves) {
      shell.showSession("s1", "build");
      shell.ensureTerminal("s1", 80, 24);
      expect(root.querySelector(".term-host")).not.toBeNull();
      const handle = handles[handles.length - 1];
      leave();
      expect(handle?.disposed).toBe(true);
      expect(root.querySelector(".term-host")).toBeNull();
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

  it("floats the latest button over the terminal card, not in the toolbar", () => {
    shell.showSession("s1", "build");
    const latest = query<HTMLButtonElement>("#term-latest");
    expect(latest.closest(".term-controls")).toBeNull();
    expect(latest.parentElement?.classList.contains("term-stage")).toBe(true);
    expect(latest.parentElement?.querySelector(":scope > #term-pane")).not.toBeNull();
    // Icon-only everywhere: the aria-label names it.
    expect(latest.textContent?.trim()).toBe("");
    expect(latest.querySelector("svg")).not.toBeNull();
  });

  it("in fullscreen shows latest only while the pane is scrolled off the frame top", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    const latest = query<HTMLButtonElement>("#term-latest");
    const pane = query<HTMLElement>("#term-pane");
    expect(latest.hidden).toBe(true);
    // A fullscreen app paints from the frame's top: nothing to jump to,
    // and the floating button would sit over the app's input line.
    handles[0]?.emitBufferChange(true);
    expect(latest.hidden).toBe(true);
    pane.scrollTop = 120;
    pane.dispatchEvent(new Event("scroll"));
    expect(latest.hidden).toBe(false);
    // The tap brings the frame's top back and the button goes.
    latest.click();
    expect(latest.hidden).toBe(true);
    pane.scrollTop = 120;
    pane.dispatchEvent(new Event("scroll"));
    expect(latest.hidden).toBe(false);
    // Back to the shell: follow resumes and the button hides again.
    handles[0]?.emitBufferChange(false);
    expect(latest.hidden).toBe(true);
  });

  it("shows retry and pair-again on failure", () => {
    shell.showSessions();
    shell.setConnectionState("failed: Too many devices connected");
    expect(query(".conn-banner").textContent).toContain("failed: Too many devices connected");
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

  it("hides and shows the key bar with the Keys switch, remembered per device", () => {
    localStorage.clear();
    localStorage.setItem(KEYBAR_KEY, "1");
    shell.showSession("s1", "build");
    const toggle = query<HTMLButtonElement>("#term-keys");
    const bar = query<HTMLElement>("#keybar");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(bar.hidden).toBe(false);
    toggle.click();
    expect(bar.hidden).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem(KEYBAR_KEY)).toBe("0");
    // A fresh paint remembers the hidden choice.
    shell.showSession("s1", "build");
    expect(query<HTMLElement>("#keybar").hidden).toBe(true);
    expect(query<HTMLButtonElement>("#term-keys").getAttribute("aria-pressed")).toBe("false");
    // And the switch shows it again without touching zoom or builder.
    query<HTMLButtonElement>("#term-keys").click();
    expect(query<HTMLElement>("#keybar").hidden).toBe(false);
    expect(query("#term-zoom-in")).not.toBeNull();
    expect(query("#term-builder")).not.toBeNull();
    expect(localStorage.getItem(KEYBAR_KEY)).toBe("1");
  });

  it("spawns from the New sheet and opens the spawned session", () => {
    shell.showSessions();
    query<HTMLButtonElement>("#session-new").click();
    expect(root.querySelector("#new-form")).not.toBeNull();
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    query<HTMLInputElement>("#new-name").value = "build";
    query<HTMLFormElement>("#new-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(calls.spawns).toHaveLength(1);
    expect(calls.spawns[0]?.spawn).toEqual({
      kind: "agent",
      cli: "muse",
      workdir: "/home/u/demo",
      name: "build",
    });
    shell.sheetSpawned(calls.spawns[0]?.req ?? "", "s9");
    expect(signal().opened).toEqual(["s9"]);
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });

  it("confirms a spawn once, at the top of the opened session", () => {
    shell.showSessions();
    query<HTMLButtonElement>("#session-new").click();
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    query<HTMLFormElement>("#new-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    shell.sheetSpawned(calls.spawns[0]?.req ?? "", "s9");
    shell.showSession("s9", "build");
    const flash = query("main.session-view > .flash-ok");
    expect(flash.textContent).toBe("Session started");
    expect(flash.getAttribute("role")).toBe("status");
    // A later render of the same session shows no confirmation.
    shell.showSession("s9", "build");
    expect(root.querySelector("main.session-view > .flash-ok")).toBeNull();
  });

  it("created_session_shows_name_immediately", () => {
    calls.onOpenSession = (id: string, spawnName?: string) => {
      signal().opened.push(id);
      shell.showSession(id, openSessionName(id, store, spawnName));
    };
    shell.showSessions();
    query<HTMLButtonElement>("#session-new").click();
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    query<HTMLInputElement>("#new-name").value = "rubidio";
    query<HTMLFormElement>("#new-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(calls.spawns[0]?.spawn.name).toBe("rubidio");
    const id = "08dbd6bd-7a1c-4d2e-9f3a-5b6c7d8e9f01";
    shell.sheetSpawned(calls.spawns[0]?.req ?? "", id);
    expect(signal().opened).toEqual([id]);
    expect(query(".session-title").textContent).toBe("rubidio");
    expect(document.title).toBe(sessionTitle("rubidio"));
    expect(query(".session-title").textContent).not.toContain("08dbd6bd");
    expect(document.title).not.toContain("08dbd6bd");
    store.add({
      id,
      name: "rubidio",
      cli: "muse",
      model: "",
      workdir: "/home/u/demo",
      status: "running",
      kind: "agent",
      lastOutputAt: null,
    });
    expect(query(".session-title").textContent).toBe("rubidio");
    expect(document.title).toBe(sessionTitle("rubidio"));
    shell.showSessions();
    expect(root.querySelector(`[data-session="${id}"] .session-name`)?.textContent).toBe("rubidio");
  });

  it("keeps the New form when the spawn fails", () => {
    sendable = false;
    shell.showSessions();
    query<HTMLButtonElement>("#session-new").click();
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    query<HTMLFormElement>("#new-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(query("#new-error").textContent).toBe("Not connected");
    expect(root.querySelector("#new-form")).not.toBeNull();
    expect(query<HTMLInputElement>("#new-directory").value).toBe("/home/u/demo");
  });

  it("shows a spawn error beside the directory field", () => {
    shell.showSessions();
    query<HTMLButtonElement>("#session-new").click();
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    query<HTMLFormElement>("#new-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    shell.sheetError("unknown workdir: /home/u/demo", calls.spawns[0]?.req ?? "", "unknown_project");
    const error = query<HTMLElement>("#new-directory-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("unknown workdir: /home/u/demo");
  });

  it("shows no sheet for an old host's req-less unknown-frame error", () => {
    // A host too old to know resize_release answers an error with no req:
    // with nothing pending neither sheet claims it and nothing renders.
    expect(() =>
      shell.sheetError("unknown frame: resize_release", null, "unknown_frame"),
    ).not.toThrow();
    expect(root.querySelector("#builder-error")?.textContent ?? "").toBe("");
    expect(root.querySelector("#new-error")?.textContent ?? "").toBe("");
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });

  it("previews and sends a draft from the Builder", () => {
    shell.showSession("s1", "build");
    query<HTMLButtonElement>("#term-builder").click();
    expect(root.querySelector("#builder-form")).not.toBeNull();
    query<HTMLButtonElement>("#builder-preview").click();
    expect(calls.composes).toHaveLength(1);
    expect(calls.composes[0]?.draft).toEqual({ sections: [], skills: [] });
    shell.sheetComposed(calls.composes[0]?.req ?? "", "composed text");
    expect(query("#builder-composed").textContent).toBe("composed text");
    expect((query("#builder-composed") as HTMLElement).hidden).toBe(false);
    query<HTMLButtonElement>("#builder-send").click();
    expect(calls.draftSends).toHaveLength(1);
    expect(calls.draftSends[0]?.draft).toEqual({ sections: [], skills: [] });
    shell.sheetOk(calls.draftSends[0]?.req ?? "");
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });

  it("closes an open sheet on a route change", () => {
    shell.showSessions();
    query<HTMLButtonElement>("#session-new").click();
    expect(root.querySelector(".sheet-overlay")).not.toBeNull();
    shell.showSession("s1", "build");
    expect(root.querySelector(".sheet-overlay")).toBeNull();

    query<HTMLButtonElement>("#term-builder").click();
    expect(root.querySelector("#builder-form")).not.toBeNull();
    shell.showSessions();
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });
});
