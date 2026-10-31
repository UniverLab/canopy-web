// SPDX-License-Identifier: Apache-2.0
// The home screen and the graph route: the Sessions | Graphs tabs, the
// sessions route that carries them (either list painted into its slot),
// the graph route's view args, and the watch lifecycle — ask `graphs`
// when the tab shows and every 10 s while it is visible, watch on open,
// unwatch on back or hide, rewatch on show, and repaint the plate when
// the window crosses the 720 px orientation line. The shell owns
// render() and the route; this module owns everything else the home
// screen needs, through hooks the shell provides. Read-only: nothing
// here pauses, continues or resets.

import type { GraphStore } from "./graph-store.js";
import { signOutButtonHtml } from "./chrome.js";
import { renderGraphView, updateGraphView } from "./graph-view.js";
import type { GraphViewArgs } from "./graph-view.js";
import { renderGraphsList } from "./graphs-list.js";
import type { SessionItem } from "./protocol.js";
import { renderSessions } from "./sessions.js";
import type { SessionListShelf } from "./sessions.js";
import type { ShelfHandle } from "./shelf-controller.js";

/** The home screen's two tabs: the session list or the graphs list. */
export type HomeTab = "sessions" | "graphs";

export interface GraphRouteCallbacks {
  /** Ask the host for the graphs list (the Graphs tab shows and polls it). */
  onGraphsRequest: () => void;
  /** Start watching a graph: the host pushes graph_state until unwatched. */
  onWatchGraph: (id: string) => void;
  /** Stop watching: back, leaving the route, or hiding the page. */
  onUnwatchGraph: () => void;
}

export interface GraphRouteHooks {
  /** The sessions the Sessions tab lists, newest interest first. */
  listSessions: () => SessionItem[];
  /** Whether the host has answered `list` on this page yet. */
  sessionsLoaded: () => boolean;
  /** Open a session from the Sessions tab (shell-owned). */
  openSession: (id: string) => void;
  /** Open the New dialog from the Sessions tab (shell-owned). */
  newSession: () => void;
  /** Full re-render of the current route (shell-owned). */
  render: () => void;
  /** Enter the graph route from the home tab (shell-owned teardown). */
  openGraph: (id: string, name: string) => void;
  /** Leave the graph for the sessions route (shell-owned). */
  leaveToSessions: () => void;
  header: () => string;
  banner: () => string;
  wireBanner: () => void;
  onDisconnect: () => void;
  onSignOut: () => void;
  /** The signed-in login the direct button names, or null. */
  login: () => string | null;
  /** The last sign-out failure, shown inline, or null. */
  signOutError: () => string | null;
  connectionState: () => string;
  /** The shell's current route name ("sessions", "graph", …). */
  route: () => string;
}

export class GraphRoute {
  /** The home tab showing now; it persists between visits. */
  homeTab: HomeTab = "sessions";
  /** The open graph: its id drives watch/unwatch, its name the header. */
  private graphId: string | null = null;
  private graphName = "";
  private readonly root: HTMLElement;
  private readonly graphs: GraphStore | null;
  private readonly shelf: ShelfHandle | null;
  private readonly callbacks: GraphRouteCallbacks;
  private readonly hooks: GraphRouteHooks;
  private stopStore: (() => void) | null = null;
  private ticker: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(
    root: HTMLElement,
    graphs: GraphStore | null,
    shelf: ShelfHandle | null,
    callbacks: GraphRouteCallbacks,
    hooks: GraphRouteHooks,
  ) {
    this.root = root;
    this.graphs = graphs;
    this.shelf = shelf;
    this.callbacks = callbacks;
    this.hooks = hooks;
  }

  /** The two-way switch: the selected tab carries the accent border. */
  tabSwitchHtml(): string {
    return (
      `<div class="tab-switch" role="tablist" aria-label="Home">` +
      `<button type="button" role="tab" data-tab="sessions" aria-selected="${this.homeTab === "sessions"}">Sessions</button>` +
      `<button type="button" role="tab" data-tab="graphs" aria-selected="${this.homeTab === "graphs"}">Graphs</button>` +
      `</div>`
    );
  }

  wireTabSwitch(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      button.addEventListener("click", () => {
        const tab = button.getAttribute("data-tab");
        if ((tab !== "sessions" && tab !== "graphs") || tab === this.homeTab) {
          return;
        }
        this.homeTab = tab;
        this.hooks.render();
      });
    }
  }

  renderSessionsRoute(): void {
    this.root.innerHTML = `
    ${this.hooks.header()}
    <main class="sessions">
      ${this.hooks.banner()}
      ${this.tabSwitchHtml()}
      <div id="session-list"></div>
      <p><button type="button" id="conn-disconnect">Disconnect</button></p>
      ${signOutButtonHtml(this.hooks.login(), this.hooks.signOutError())}
    </main>`;
    this.hooks.wireBanner();
    this.root
      .querySelector("#conn-disconnect")
      ?.addEventListener("click", () => this.hooks.onDisconnect());
    this.wireTabSwitch();
    this.paintHome();
    // Showing the Graphs tab asks the host for the list — on a tab click,
    // on the way back from a graph, or on landing here with the tab
    // already up; the 10 s poll keeps it while it stays visible.
    if (this.homeTab === "graphs") {
      this.callbacks.onGraphsRequest();
    }
  }

  /** Whichever home tab is up gets its list painted into the slot. */
  paintHome(): void {
    const slot = this.root.querySelector<HTMLElement>("#session-list");
    if (!slot) {
      return;
    }
    if (this.homeTab === "sessions") {
      this.renderSessionsList(slot);
      return;
    }
    renderGraphsList(slot, this.graphs?.list() ?? [], {
      onOpen: (id, name) => this.hooks.openGraph(id, name),
    });
  }

  private shelfListArgs(): SessionListShelf | undefined {
    const shelf = this.shelf;
    if (!shelf) {
      return undefined;
    }
    return {
      enabled: shelf.enabled(),
      hostCount: shelf.count(null),
      count: (id) => shelf.count(id),
      onOpenShelf: () => shelf.open(this.root, null),
    };
  }

  private renderSessionsList(slot: HTMLElement): void {
    renderSessions(
      slot,
      this.hooks.listSessions(),
      Date.now(),
      {
        onOpen: (id) => this.hooks.openSession(id),
        onNew: () => this.hooks.newSession(),
      },
      this.shelfListArgs(),
      this.hooks.sessionsLoaded(),
    );
  }

  /** Open the graph view: the watch follows the mount, the pushes repaint. */
  open(id: string, name: string): void {
    this.graphId = id;
    this.graphName = name;
    this.hooks.render();
    this.callbacks.onWatchGraph(id);
  }

  /** Back to the home tab, which re-asks for the list it is showing. */
  back(): void {
    this.leave();
    this.hooks.leaveToSessions();
  }

  /** Leaving the graph for anywhere else: drop the watch, forget the ids. */
  leave(): void {
    if (this.graphId === null) {
      return;
    }
    this.graphId = null;
    this.graphName = "";
    this.callbacks.onUnwatchGraph();
  }

  /** The open graph's display name: the watched summary's, else the row's. */
  displayName(): string {
    return this.graphs?.currentSummary()?.name || this.graphName;
  }

  args(): GraphViewArgs {
    const summary = this.graphs?.currentSummary() ?? null;
    return {
      header: this.hooks.header(),
      banner: this.hooks.banner(),
      login: this.hooks.login(),
      signOutError: this.hooks.signOutError(),
      id: this.graphId ?? "",
      name: this.displayName(),
      summary,
      doc: this.graphs?.currentDoc() ?? null,
      state: this.graphs?.currentState() ?? null,
      receivedAt: this.graphs?.lastReceivedAt() ?? null,
      connected: this.hooks.connectionState() === "connected",
      orientation: (globalThis.innerWidth ?? 0) < 720 ? "vertical" : "horizontal",
      onBack: () => this.back(),
      onSignOut: () => this.hooks.onSignOut(),
    };
  }

  mountGraph(): void {
    renderGraphView(this.root, this.args());
  }

  /** After a connection patch, the graph view's disconnect note follows. */
  syncConnection(): void {
    if (this.hooks.route() === "graph") {
      updateGraphView(this.root, this.args());
    }
  }

  /** The store subscription, the 10 s poll, and the hide/resize hooks. */
  start(): void {
    // The graph store feeds both the tab's list and the open graph view;
    // the view repaints in place, so pushes never disturb its scroll.
    this.stopStore = this.graphs?.subscribe(() => {
      if (this.hooks.route() === "sessions") {
        if (this.homeTab === "graphs") {
          this.paintHome();
        }
      } else if (this.hooks.route() === "graph") {
        updateGraphView(this.root, this.args());
      }
    }) ?? null;
    // The Graphs tab asks for the list when it shows and every 10 s while
    // it is the visible view on a visible page.
    this.ticker = globalThis.setInterval(() => {
      if (
        this.hooks.route() === "sessions" &&
        this.homeTab === "graphs" &&
        globalThis.document.hidden !== true
      ) {
        this.callbacks.onGraphsRequest();
      }
    }, 10000);
    globalThis.document.addEventListener("visibilitychange", this.onVisibility);
    globalThis.addEventListener("resize", this.onResize);
  }

  // Hiding the page drops the watch; showing it again (still on the graph)
  // re-sends it. Anything else keeps watching through the hide.
  private readonly onVisibility = (): void => {
    if (this.hooks.route() !== "graph" || this.graphId === null) {
      return;
    }
    if (globalThis.document.hidden) {
      this.callbacks.onUnwatchGraph();
    } else {
      this.callbacks.onWatchGraph(this.graphId);
    }
  };

  // Crossing the 720 px line flips the plate's orientation.
  private readonly onResize = (): void => {
    if (this.hooks.route() === "graph") {
      updateGraphView(this.root, this.args());
    }
  };

  dispose(): void {
    if (this.ticker !== null) {
      globalThis.clearInterval(this.ticker);
      this.ticker = null;
    }
    globalThis.document.removeEventListener("visibilitychange", this.onVisibility);
    globalThis.removeEventListener("resize", this.onResize);
    this.stopStore?.();
    this.stopStore = null;
  }
}
