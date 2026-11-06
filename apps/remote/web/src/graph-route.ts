// SPDX-License-Identifier: Apache-2.0
// The home screen and the graph route: the Sessions | Graphs tabs, the
// sessions route that carries them (either list painted into its slot),
// the graph route's view args, and the watch lifecycle — ask `graphs`
// when the tab shows and every 10 s while it is visible, watch on open,
// unwatch on back or hide, and rewatch on show. The shell owns render()
// and the route; this module owns everything else the home screen needs,
// through hooks the shell provides. The graph view also pauses and
// continues through here: one request in flight, gated by the host's
// hello, with the refusal landing on the view's note.

import type { GraphStore } from "./graph-store.js";
import { REMOTE_FOOTER } from "./footer.js";
import { icon } from "./icons-dom.js";
import { esc } from "./sheet.js";
import { graphTitle } from "./titles.js";
import { disposeGraphView, renderGraphView, updateGraphView } from "./graph-view.js";
import type { GraphViewArgs } from "./graph-view.js";
import { renderGraphsList } from "./graphs-list.js";
import type { GraphControlAction } from "./protocol.js";
import { newReqId } from "./protocol.js";
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
  /**
   * Pause or continue the open graph: graph_control{req,id,action}.
   * False when nothing went out (no connection), like the kill callback.
   */
  onGraphControl: (req: string, id: string, action: GraphControlAction) => boolean;
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
  // A one-shot confirmation the next sessions render shows once, like
  // the session view's spawn flash: set by the shell, consumed by paint.
  private listFlash: string | null = null;
  /** The host speaks graph_control: hello carried it for this device. */
  private canControl = false;
  /** The pause/continue req in flight; its ok or error re-enables. */
  private pendingReq: string | null = null;
  /** The last control refusal, on the view's note until a success. */
  private controlError: string | null = null;

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

  /** The one-shot confirmation the next sessions render shows once. */
  setListFlash(text: string): void {
    this.listFlash = text;
  }

  renderSessionsRoute(): void {
    const flash = this.listFlash;
    this.listFlash = null;
    this.root.innerHTML = `
    ${this.hooks.header()}
    <main class="sessions">
      ${this.hooks.banner()}
      ${this.tabSwitchHtml()}
      ${flash === null ? "" : `<p class="flash-ok" role="status">${icon("check")}<span>${esc(flash)}</span></p>`}
      <div id="session-list"></div>
    </main>
    ${REMOTE_FOOTER}`;
    this.hooks.wireBanner();
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
      onReload: () => this.callbacks.onGraphsRequest(),
    }, this.graphs?.hasListed() ?? false);
  }

  private shelfListArgs(): SessionListShelf | undefined {
    const shelf = this.shelf;
    if (!shelf) {
      return undefined;
    }
    return {
      enabled: shelf.enabled(),
      unseen: shelf.unseenTotal(),
      onOpenShelf: () => shelf.open(this.root),
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
    disposeGraphView();
    // A refused pause never follows the view home; the flag is per
    // connection, so it stays for the next graph on this host.
    this.pendingReq = null;
    this.controlError = null;
    if (this.graphId === null) {
      return;
    }
    this.graphId = null;
    this.graphName = "";
    this.callbacks.onUnwatchGraph();
  }

  /**
   * Ask the host to pause or continue the open graph: one request in
   * flight, the button disabled until its ok or error lands. Pause takes
   * no confirmation: it is reversible and the running node finishes first.
   */
  requestControl(action: GraphControlAction): void {
    if (this.graphId === null || !this.canControl || this.pendingReq !== null) {
      return;
    }
    // Set before the send: a fast host answers ok and pushes the new
    // state synchronously, and the reply must find its req.
    const req = newReqId();
    this.pendingReq = req;
    if (!this.callbacks.onGraphControl(req, this.graphId, action)) {
      this.pendingReq = null;
      this.controlError = "Not connected";
    }
    this.repaintControl();
  }

  /**
   * True when the ok answered the pending pause/continue: the next
   * successful action clears the note, and the push repaints the button.
   */
  handleControlOk(req: string): boolean {
    if (this.pendingReq === null || req !== this.pendingReq) {
      return false;
    }
    this.pendingReq = null;
    this.controlError = null;
    this.repaintControl();
    return true;
  }

  /**
   * True when the error answered the pending pause/continue — or refused
   * a control the view no longer tracks: either way its message lands on
   * the view's note while a graph is open, never as a dialog.
   */
  handleControlError(req: string | null, message: string): boolean {
    if (this.graphId === null) {
      return false;
    }
    if (this.pendingReq !== null && req === this.pendingReq) {
      this.pendingReq = null;
    }
    this.controlError = message;
    this.repaintControl();
    return true;
  }

  /**
   * The greeting carries what the host speaks: graph_control gates the
   * button, and a fresh connection forgets the old one's request. A
   * reconnect to an older host drops the button with the flag.
   */
  handleHello(features: string[]): void {
    this.canControl = features.includes("graph_control");
    this.pendingReq = null;
    this.controlError = null;
    this.repaintControl();
  }

  /** Repaint the mounted graph view in place, if it is up. */
  private repaintControl(): void {
    if (this.hooks.route() === "graph" && this.graphId !== null) {
      updateGraphView(this.root, this.args());
    }
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
      id: this.graphId ?? "",
      name: this.displayName(),
      summary,
      doc: this.graphs?.currentDoc() ?? null,
      state: this.graphs?.currentState() ?? null,
      receivedAt: this.graphs?.lastReceivedAt() ?? null,
      watchError: this.graphs?.watchError() ?? null,
      connected: this.hooks.connectionState() === "connected",
      canControl: this.canControl,
      controlPending: this.pendingReq !== null,
      controlError: this.controlError,
      onControl: (action) => this.requestControl(action),
      onBack: () => this.back(),
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

  /** The store subscription, the 10 s poll, and the hide hook. */
  start(): void {
    // The graph store feeds both the tab's list and the open graph view;
    // the view repaints in place, so pushes never disturb the view.
    this.stopStore = this.graphs?.subscribe(() => {
      if (this.hooks.route() === "sessions") {
        if (this.homeTab === "graphs") {
          this.paintHome();
        }
      } else if (this.hooks.route() === "graph") {
        updateGraphView(this.root, this.args());
        // The push repaints in place, so the shell's render never runs:
        // the title follows the watched summary's name itself.
        document.title = graphTitle(this.displayName());
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

  dispose(): void {
    if (this.ticker !== null) {
      globalThis.clearInterval(this.ticker);
      this.ticker = null;
    }
    globalThis.document.removeEventListener("visibilitychange", this.onVisibility);
    this.stopStore?.();
    this.stopStore = null;
  }
}
