// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShell } from "../src/app.js";
import type { Shell } from "../src/app.js";
import { CatalogStore } from "../src/catalog.js";
import { GraphStore } from "../src/graph-store.js";
import { createGuestView } from "../src/guest-views.js";
import type { GraphSummary } from "../src/protocol.js";
import { SessionStore } from "../src/sessions.js";
import type { TerminalFactory } from "../src/terminal.js";
import { graphTitle, remoteTitle, sessionTitle } from "../src/titles.js";

function summary(overrides: Partial<GraphSummary> = {}): GraphSummary {
  return {
    id: "g1",
    name: "palette-loop",
    status: "running",
    workdir: "/home/u/demo",
    current_spec: "Draw the plate",
    current_node: "implementer",
    done: 1,
    total: 4,
    blocked: false,
    updated_at: 1793100000_000,
    ...overrides,
  };
}

describe("remoteTitle", () => {
  it("joins the view to the site, or holds the bare site when empty", () => {
    expect(remoteTitle("Sessions")).toBe("Sessions · Canopy remote");
    expect(remoteTitle("")).toBe("Canopy remote");
  });

  it("names the session and the graph, with a fallback when nameless", () => {
    expect(sessionTitle("build")).toBe("build · Canopy remote");
    expect(sessionTitle("")).toBe("Session · Canopy remote");
    expect(graphTitle("palette-loop")).toBe("palette-loop · Canopy remote");
    expect(graphTitle("")).toBe("Graph · Canopy remote");
  });
});

describe("shell titles", () => {
  let root: HTMLDivElement;
  let shell: Shell;
  let graphs: GraphStore;

  beforeEach(() => {
    document.title = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    graphs = new GraphStore({ send: () => true });
    const factory: TerminalFactory = () => {
      throw new Error("no terminal in a title test");
    };
    shell = createShell(
      root,
      new SessionStore(),
      {
        onPair: () => {},
        onConnect: () => {},
        onDisconnect: () => {},
        onRetry: () => {},
        onPairAgain: () => {},
        onOpenSession: () => {},
        onLeaveSession: () => {},
        onSignOut: () => {},
        onForgetDevice: () => {},
        onKeyPress: () => {},
        onTerminalInput: () => {},
        onComposerSend: () => {},
        onSpawn: () => true,
        onCompose: () => true,
        onSendDraft: () => true,
        onGraphsRequest: () => {},
        onWatchGraph: () => {},
        onUnwatchGraph: () => {},
      },
      { terminalFactory: factory, catalog: new CatalogStore(), graphs },
    );
  });

  afterEach(() => {
    shell.dispose();
    root.remove();
    document.body.innerHTML = "";
    document.title = "";
  });

  it("titles the entry screens", () => {
    shell.showSignIn();
    expect(document.title).toBe("Sign in · Canopy remote");
    shell.showPair();
    expect(document.title).toBe("Pair · Canopy remote");
    shell.showHosts();
    expect(document.title).toBe("Choose a host · Canopy remote");
  });

  it("titles the sessions list and the open session by name", () => {
    shell.showSessions();
    expect(document.title).toBe("Sessions · Canopy remote");
    shell.showSession("s1", "build");
    expect(document.title).toBe("build · Canopy remote");
  });

  it("titles the graphs tab and the open graph by name", () => {
    graphs.handleGraphs([summary()]);
    shell.showSessions();
    expect(document.title).toBe("Sessions · Canopy remote");
    root.querySelector<HTMLButtonElement>('[data-tab="graphs"]')?.click();
    expect(document.title).toBe("Graphs · Canopy remote");
    root.querySelector<HTMLButtonElement>('[data-graph="g1"]')?.click();
    expect(document.title).toBe("palette-loop · Canopy remote");
  });
});

describe("guest titles", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    document.title = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    document.body.innerHTML = "";
    document.title = "";
  });

  it("titles every guest screen, with the session name on its view", () => {
    const view = createGuestView(root, new SessionStore(), {
      onOpenSession: () => {},
      onLeaveSession: () => {},
      onRetry: () => {},
      onSignOut: () => {},
      onForgetDevice: () => {},
      onInput: () => {},
      onComposerSend: () => {},
    });
    view.showSignIn();
    expect(document.title).toBe("Sign in · Canopy remote");
    view.showInvalidLink();
    expect(document.title).toBe("Invalid link · Canopy remote");
    view.showConnecting();
    expect(document.title).toBe("Connecting · Canopy remote");
    view.showForbidden("not shared");
    expect(document.title).toBe("Not shared · Canopy remote");
    view.showList();
    expect(document.title).toBe("Sessions · Canopy remote");
    view.showSession("s1", "build");
    expect(document.title).toBe("build · Canopy remote");
  });
});
