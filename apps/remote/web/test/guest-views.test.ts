// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { createGuestView, guestOutputText } from "../src/guest-views.js";
import type { GuestView } from "../src/guest-views.js";
import type { SessionItem } from "../src/protocol.js";
import { SessionStore } from "../src/sessions.js";

const NOW = 1793100000_000;

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
  counts: { leaves: number; retries: number };
}

function setup(): Setup {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const store = new SessionStore();
  const opened: string[] = [];
  const counts = { leaves: 0, retries: 0 };
  const view = createGuestView(root, store, {
    onOpenSession: (id) => opened.push(id),
    onLeaveSession: () => {
      counts.leaves += 1;
    },
    onRetry: () => {
      counts.retries += 1;
    },
    onSignOut: () => {},
    onForgetDevice: () => {},
  });
  return { root, view, store, opened, counts };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("guestOutputText", () => {
  it("strips escape sequences and normalizes newlines", () => {
    expect(guestOutputText("\x1b[32m●\x1b[0m ok\r\nnext\rlast")).toBe("● ok\nnext\nlast");
    expect(guestOutputText("\x1b]8;;https://x\x07link\x1b\\done")).toBe("linkdone");
    expect(guestOutputText("\x1b(0qqq\x1b(B")).toBe("qqq");
    expect(guestOutputText("plain")).toBe("plain");
  });
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
  it("shows one read-only session with a back button", () => {
    const { root, view, counts } = setup();
    view.showSession("s1", "build");
    expect(root.querySelector(".session-title")?.textContent).toBe("build");
    expect(root.querySelector("#guest-output")).not.toBeNull();
    expect(root.querySelector("#guest-status")?.textContent).toBe("Attaching…");
    root.querySelector<HTMLButtonElement>("#session-back")?.click();
    expect(counts.leaves).toBe(1);
  });

  it("appends stripped output and clears it on redraw", () => {
    const { root, view } = setup();
    view.showSession("s1", "build");
    view.appendOutput("\x1b[32mok\x1b[0m\r\n");
    view.appendOutput("more");
    expect(root.querySelector("#guest-output")?.textContent).toBe("ok\nmore");
    view.clearOutput();
    expect(root.querySelector("#guest-output")?.textContent).toBe("");
  });

  it("shows and hides the session status line", () => {
    const { root, view } = setup();
    view.showSession("s1", "build");
    view.setSessionStatus("Session exited (1)");
    expect(root.querySelector("#guest-status")?.textContent).toBe("Session exited (1)");
    view.setSessionStatus(null);
    expect(root.querySelector("#guest-status")).toBeNull();
    // The output survives the status repaint.
    view.appendOutput("kept");
    view.setSessionStatus("Session exited (1)");
    expect(root.querySelector("#guest-output")?.textContent).toBe("kept");
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
