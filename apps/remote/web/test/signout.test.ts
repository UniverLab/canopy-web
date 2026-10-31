// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShell } from "../src/app.js";
import type { Shell, ShellCallbacks } from "../src/app.js";
import { FORGET_MESSAGE, renderTopbar } from "../src/chrome.js";
import { renderGraphView, updateGraphView } from "../src/graph-view.js";
import type { GraphViewArgs } from "../src/graph-view.js";
import { renderMetricsView, updateMetricsView } from "../src/metrics-view.js";
import type { MetricsViewArgs } from "../src/metrics-view.js";
import { SessionStore } from "../src/sessions.js";
import type { TerminalHandle } from "../src/terminal.js";

/** Just enough xterm to prove the session view keeps its terminal. */
class StubTerminal implements TerminalHandle {
  written: string[] = [];
  write = (text: string): void => {
    this.written.push(text);
  };
  clear = (): void => {};
  focus = (): void => {};
  scrollToBottom = (): void => {};
  isAtBottom = (): boolean => true;
  onUserInput = (): (() => void) => () => {};
  onScroll = (): (() => void) => () => {};
  onReady = (callback: () => void): (() => void) => {
    callback();
    return () => {};
  };
  dispose = (): void => {};
}

describe("sign out", () => {
  let root: HTMLDivElement;
  let shell: Shell;
  let signedOut: number;
  let forgotten: number;
  let disconnects: number;

  const query = <T extends Element>(selector: string): T => {
    const el = root.querySelector(selector);
    if (!el) {
      throw new Error(`missing ${selector}`);
    }
    return el as T;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement("div");
    document.body.appendChild(root);
    signedOut = 0;
    forgotten = 0;
    disconnects = 0;
    const callbacks: ShellCallbacks = {
      onPair: () => {},
      onConnect: () => {},
      onDisconnect: () => {
        disconnects += 1;
      },
      onRetry: () => {},
      onPairAgain: () => {},
      onOpenSession: () => {},
      onLeaveSession: () => {},
      onSignOut: () => {
        signedOut += 1;
      },
      onForgetDevice: () => {
        forgotten += 1;
      },
      onKeyPress: () => {},
      onTerminalInput: () => {},
      onComposerSend: () => {},
      onSpawn: () => true,
      onCompose: () => true,
      onSendDraft: () => true,
      onGraphsRequest: () => {},
      onWatchGraph: () => {},
      onUnwatchGraph: () => {},
    };
    shell = createShell(root, new SessionStore(), callbacks, {
      terminalFactory: () => new StubTerminal(),
    });
    shell.setLogin("octo");
  });

  afterEach(() => {
    shell.dispose();
    root.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("signs out from the hosts screen through the header menu only", () => {
    shell.setPairedHosts([{ host_id: "h1", label: "demo host" }]);
    shell.showHosts();
    // No bottom control: the menu is the only way out.
    expect(root.querySelector("#signout")).toBeNull();
    expect(root.querySelector("#signout-error")).toBeNull();
    const menu = query("#account");
    expect(menu.querySelector("summary.login")?.textContent).toBe("octo");
    const button = query<HTMLButtonElement>("#signout-menu");
    expect(button.querySelector("svg.icon")).not.toBeNull();
    button.click();
    expect(signedOut).toBe(1);
  });

  it("signs out from the sessions screen through the header menu only", () => {
    shell.showSessions();
    expect(root.querySelector("#signout")).toBeNull();
    expect(root.querySelector("#signout-error")).toBeNull();
    query<HTMLButtonElement>("#signout-menu").click();
    expect(signedOut).toBe(1);
  });

  it("reaches sign out through the header menu on the session view, never a button", () => {
    shell.showSession("s1", "smoke");
    expect(root.querySelector("#signout")).toBeNull();
    expect(root.querySelector("#signout-error")).toBeNull();
    const menu = query("#account");
    expect(menu.querySelector("summary.login")?.textContent).toBe("octo");
    query<HTMLButtonElement>("#signout-menu").click();
    expect(signedOut).toBe(1);
  });

  it("carries the account menu on the pair screen, none while signed out", () => {
    shell.showPair();
    expect(root.querySelector("#account")).not.toBeNull();
    query<HTMLButtonElement>("#signout-menu").click();
    expect(signedOut).toBe(1);
    // Landing on sign-in clears the login first, as the entry point does.
    shell.setLogin(null);
    shell.showSignIn();
    expect(root.querySelector("#account")).toBeNull();
    expect(root.querySelector("#signout")).toBeNull();
  });

  it("keeps every signed-in shell view free of bottom controls", () => {
    shell.setPairedHosts([{ host_id: "h1", label: "demo host" }]);
    const walk: { show: () => void; disconnect: boolean }[] = [
      { show: () => shell.showPair(), disconnect: false },
      { show: () => shell.showHosts(), disconnect: false },
      { show: () => shell.showSessions(), disconnect: true },
      { show: () => shell.showSession("s1", "smoke"), disconnect: false },
    ];
    for (const step of walk) {
      step.show();
      // The old bottom ids render nowhere; the menu signs out everywhere.
      expect(root.querySelector("#signout")).toBeNull();
      expect(root.querySelector("#signout-error")).toBeNull();
      expect(root.querySelector("main #conn-disconnect")).toBeNull();
      expect(root.querySelector(".topbar #signout-menu")).not.toBeNull();
      // Disconnect rides the header on the sessions route alone — no view
      // gains or loses it.
      expect(root.querySelector(".topbar #conn-disconnect") !== null).toBe(step.disconnect);
    }
  });

  it("detaches through the header Disconnect on the sessions route", () => {
    shell.showSessions();
    const disconnect = query<HTMLButtonElement>(".topbar #conn-disconnect");
    expect(disconnect.getAttribute("aria-label")).toBe("Disconnect");
    expect(disconnect.textContent).toContain("Disconnect");
    expect(disconnect.querySelector("svg.icon")).not.toBeNull();
    disconnect.click();
    expect(disconnects).toBe(1);
  });

  it("shows a failure inline and stays signed in", () => {
    shell.setPairedHosts([{ host_id: "h1", label: "demo host" }]);
    shell.showHosts();
    shell.setSignOutError("Could not reach the relay");
    // Still on the hosts screen, the error beside the one control.
    expect(root.querySelector("main.hosts")).not.toBeNull();
    expect(root.querySelector("#signout-error")).toBeNull();
    expect(query("#signout-error-menu").textContent).toBe("Could not reach the relay");
    // The menu opens itself, so the failure is seen.
    expect(query("#account").hasAttribute("open")).toBe(true);
    shell.setSignOutError(null);
    expect(query("#signout-error-menu").textContent).toBe("");
  });

  it("keeps the session terminal mounted when a sign-out fails", () => {
    shell.showSession("s1", "smoke");
    shell.ensureTerminal("s1", 80, 24);
    const pane = query<HTMLElement>("#term-pane");
    const mounted = pane.children.length;
    shell.setSignOutError("Could not reach the relay");
    // Same node, same content: a failure must not repaint the view away.
    expect(root.contains(pane)).toBe(true);
    expect(query("#term-pane")).toBe(pane);
    expect(pane.children).toHaveLength(mounted);
    // The header menu holds the only sign-out control on every view, so
    // the error and the menu both show, with no space lost to a button.
    expect(query("#signout-error-menu").textContent).toBe("Could not reach the relay");
    expect(query("#account").hasAttribute("open")).toBe(true);
    expect(root.querySelector("#signout")).toBeNull();
    shell.setSignOutError(null);
    expect(query("#signout-error-menu").textContent).toBe("");
  });

  it("drops a stale failure when the next screen loads", () => {
    shell.setPairedHosts([{ host_id: "h1", label: "demo host" }]);
    shell.showHosts();
    shell.setSignOutError("Could not sign out (500)");
    expect(query("#signout-error-menu").textContent).toBe("Could not sign out (500)");
    shell.showSessions();
    expect(query("#signout-error-menu").textContent).toBe("");
    expect(query("#account").hasAttribute("open")).toBe(false);
  });

  it("keeps the menu's open state across re-renders", () => {
    shell.setPairedHosts([{ host_id: "h1", label: "demo host" }]);
    shell.showHosts();
    const details = query("#account") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    shell.setConnectionState("retrying in 5s");
    expect(query("#account").hasAttribute("open")).toBe(true);
  });

  it("forgets the device only after the confirmation", () => {
    shell.setPairedHosts([{ host_id: "h1", label: "demo host" }]);
    shell.showHosts();
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    query<HTMLButtonElement>("#forget-menu").click();
    expect(confirm).toHaveBeenCalledWith(FORGET_MESSAGE);
    expect(forgotten).toBe(0);
    confirm.mockReturnValue(true);
    query<HTMLButtonElement>("#forget-menu").click();
    expect(forgotten).toBe(1);
  });

  it("wears no inline styles on the account controls", () => {
    shell.showHosts();
    for (const el of root.querySelectorAll("#account, #signout-menu, #signout-error-menu")) {
      expect(el.getAttribute("style")).toBeNull();
    }
  });
});

function signedInHeader(): string {
  return renderTopbar({
    login: "octo",
    hostLabel: "demo host",
    connectionState: "connected",
    link: "wifi",
    signOutError: null,
    accountOpen: false,
  });
}

describe("sign out on the graph view", () => {
  function args(overrides: Partial<GraphViewArgs> = {}): GraphViewArgs {
    return {
      header: signedInHeader(),
      banner: "",
      id: "g1",
      name: "palette-loop",
      summary: null,
      doc: null,
      state: null,
      receivedAt: null,
      connected: true,
      orientation: "horizontal",
      onBack: () => {},
      ...overrides,
    };
  }

  it("keeps sign-out in the header menu with no bottom controls", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    try {
      renderGraphView(root, args());
      expect(root.querySelector(".topbar #signout-menu")).not.toBeNull();
      expect(root.querySelector("#signout")).toBeNull();
      expect(root.querySelector("#signout-error")).toBeNull();
      expect(root.querySelector("main #conn-disconnect")).toBeNull();
      // A repaint keeps it that way: the view never paints its own.
      updateGraphView(root, args());
      expect(root.querySelector("#signout")).toBeNull();
      expect(root.querySelector("#signout-error")).toBeNull();
      expect(root.querySelector("main #conn-disconnect")).toBeNull();
    } finally {
      root.remove();
    }
  });
});

describe("sign out on the metrics view", () => {
  function args(overrides: Partial<MetricsViewArgs> = {}): MetricsViewArgs {
    return {
      header: signedInHeader(),
      banner: "",
      frame: null,
      history: null,
      receivedAt: null,
      connected: true,
      onBack: () => {},
      ...overrides,
    };
  }

  it("keeps sign-out in the header menu with no bottom controls", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    try {
      renderMetricsView(root, args());
      expect(root.querySelector(".topbar #signout-menu")).not.toBeNull();
      expect(root.querySelector("#signout")).toBeNull();
      expect(root.querySelector("#signout-error")).toBeNull();
      expect(root.querySelector("main #conn-disconnect")).toBeNull();
      // A repaint keeps it that way: the view never paints its own.
      updateMetricsView(root, args());
      expect(root.querySelector("#signout")).toBeNull();
      expect(root.querySelector("#signout-error")).toBeNull();
      expect(root.querySelector("main #conn-disconnect")).toBeNull();
    } finally {
      root.remove();
    }
  });
});
