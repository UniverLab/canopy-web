// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShell } from "../src/app.js";
import type { Shell, ShellCallbacks } from "../src/app.js";
import { CatalogStore } from "../src/catalog.js";
import { connectFailMessage } from "../src/peer.js";
import type { PromptDraft, SpawnRequest } from "../src/protocol.js";
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
  let catalog: CatalogStore;
  let shell: Shell;
  let calls: ShellCallbacks & {
    pairs: PairSubmit[];
    keys: Uint8Array[];
    inputs: Uint8Array[];
    composerSends: { text: string; req: string }[];
    spawns: { spawn: SpawnRequest; req: string }[];
    composes: { draft: PromptDraft; req: string }[];
    draftSends: { draft: PromptDraft; req: string }[];
  };
  let handles: FakeHandle[];
  let sendable: boolean;

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
    const composerSends: { text: string; req: string }[] = [];
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
      composerSends,
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
      onComposerSend: (text, req) => composerSends.push({ text, req }),
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
      onGraphsRequest: () => {},
      onWatchGraph: () => {},
      onUnwatchGraph: () => {},
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
    // Fit stays a word: it is a mode, not a direction.
    expect(query("#term-fit").textContent).toBe("Fit");
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

  it("keeps the session view's terminal, key bar and composer above the footer", () => {
    shell.showSession("s1", "build");
    const main = query("main.session-view");
    expect(main.querySelector("#term-pane")).not.toBeNull();
    expect(main.querySelectorAll("#keybar .key").length).toBe(9);
    expect(main.querySelector(".composer-input")).not.toBeNull();
    expect(main.querySelector(".composer-send")).not.toBeNull();
    // The terminal, key bar and composer live inside the main; the footer
    // follows it, so nothing scrolls the terminal out or covers it.
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
    expect(keys).toHaveLength(9);
    keys[0]?.click();
    expect(calls.keys.map((bytes) => [...bytes])).toEqual([[0x1b]]);

    query<HTMLTextAreaElement>(".composer-input").value = "hello";
    query<HTMLButtonElement>(".composer-send").click();
    expect(calls.composerSends).toHaveLength(1);
    expect(calls.composerSends[0]?.text).toBe("hello");
    shell.composerOk(calls.composerSends[0]?.req ?? "");
    expect(query<HTMLTextAreaElement>(".composer-input").value).toBe("");

    query<HTMLButtonElement>(".composer-builder").click();
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
    expect(calls.inputs.map((bytes) => [...bytes])).toEqual([[0x78]]);
  });

  it("keeps the terminal and the composer draft across state changes", () => {
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    shell.writeTerminal("hi");
    query<HTMLTextAreaElement>(".composer-input").value = "draft";
    shell.setConnectionState("retrying in 2s");
    expect(query(".conn-banner").textContent).toContain("retrying in 2s");
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

  it("remembers the Fit toggle per device", () => {
    localStorage.clear();
    shell.showSession("s1", "build");
    shell.ensureTerminal("s1", 80, 24);
    const fit = query<HTMLButtonElement>("#term-fit");
    expect(fit.getAttribute("aria-pressed")).toBe("false");
    fit.click();
    expect(fit.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("canopy.remote.term.fitOnly")).toBe("1");
    fit.click();
    expect(fit.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("canopy.remote.term.fitOnly")).toBe("0");
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

  it("previews and sends a draft from the Builder", () => {
    shell.showSession("s1", "build");
    query<HTMLButtonElement>(".composer-builder").click();
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

    query<HTMLButtonElement>(".composer-builder").click();
    expect(root.querySelector("#builder-form")).not.toBeNull();
    shell.showSessions();
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });
});
