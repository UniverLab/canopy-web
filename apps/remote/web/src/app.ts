// SPDX-License-Identifier: Apache-2.0
// The app shell: Sign in → Pair → Sessions → Session, with a header
// carrying the GitHub login, the host label and the connection state.
// The shell owns the views and the terminal/key-bar widgets; main.ts
// owns the relay, the peer and the frame routing. A host picker appears
// only when several hosts are paired.

import { CatalogStore } from "./catalog.js";
import { Builder } from "./builder.js";
import { renderConnBanner, renderTopbar, wireAccount, wireConnActions } from "./chrome.js";
import { syncHeaderFondo } from "./fondo.js";
import { renderHosts, renderPair, renderSignIn } from "./entry-views.js";
import type { EntryViewHooks, PairDraft } from "./entry-views.js";
import { GraphRoute } from "./graph-route.js";
import type { GraphStore } from "./graph-store.js";
import { mountMorphSlot, type RemoteIconName, type MorphSlot } from "./icons-dom.js";
import { MetricsRoute } from "./metrics-route.js";
import type { MetricsStore } from "./metrics-store.js";
import { NewDialog } from "./new-dialog.js";
import { defaultDeviceLabel } from "./pairing.js";
import type {
  GraphControlAction,
  PromptDraft,
  ResumableSession,
  ScheduledItem,
  SpawnRequest,
} from "./protocol.js";
import type { OnlineHost } from "./relay.js";
import type { ShelfHandle } from "./shelf-controller.js";
import type { SessionStore } from "./sessions.js";
import { SessionRoute } from "./session-route.js";
import { createXtermHandle } from "./terminal.js";
import type { TerminalFactory } from "./terminal.js";
import { TermCopySheet } from "./term-copy.js";
import { shellTitle } from "./titles.js";
import type { PairSubmit } from "./ui.js";

export interface ShellCallbacks {
  onPair: (submit: PairSubmit) => void;
  onConnect: (hostId: string) => void;
  onDisconnect: () => void;
  onRetry: () => void;
  onPairAgain: () => void;
  onOpenSession: (id: string, spawnName?: string) => void;
  onLeaveSession: () => void;
  /** Sign out through POST /auth/logout, from the header account menu. */
  onSignOut: () => void;
  /** Forget this device (pairing keys go too) after the shell's confirm. */
  onForgetDevice: () => void;
  /** Key-bar bytes with the latches applied; the session route owns them. */
  onKeyPress: (bytes: Uint8Array) => void;
  /** Phone-keyboard bytes with the latches applied. */
  onTerminalInput: (bytes: Uint8Array) => void;
  /**
   * The device asserts its PTY size for the open session (send
   * resize{id,cols,rows}): the cols × rows that fit this device's panel.
   * Fires when the control-size toggle turns on, on every terminal mount
   * while it is on, and (debounced) whenever the panel changes while on.
   */
  onControlSize: (cols: number, rows: number) => void;
  /** The control-size toggle turned off: give the size back to the host. */
  onReleaseSize: () => void;
  /**
   * The session view's Close sent its second tap: kill{req,id} for the
   * open session. False when nothing went out (no session, no channel).
   */
  onKill: (req: string) => boolean;
  /** False when the frame could not be sent; the dialog then says so. */
  onSpawn: (spawn: SpawnRequest, req: string) => boolean;
  /** The New dialog's Resume pane asks for the host's history. */
  onResumableList?: (req: string) => boolean;
  /** Resume one recorded conversation the pane listed. */
  onResume?: (id: string, req: string) => boolean;
  onCompose: (draft: PromptDraft, req: string) => boolean;
  onSendDraft: (draft: PromptDraft, req: string) => boolean;
  onSchedule: (draft: PromptDraft, fireAt: string, req: string) => boolean;
  onScheduledList: (req: string) => boolean;
  onScheduledCancel: (scheduleId: string, req: string) => boolean;
  /** Ask the host for the graphs list (the Graphs tab shows and polls it). */
  onGraphsRequest: () => void;
  /** Start watching a graph: the host pushes graph_state until unwatched. */
  onWatchGraph: (id: string) => void;
  /** Stop watching: back, switching tab or hiding the page. */
  onUnwatchGraph: () => void;
  /**
   * The graph view's Pause/Continue: graph_control{req,id,action}.
   * False when nothing went out (no connection yet).
   */
  onGraphControl: (req: string, id: string, action: GraphControlAction) => boolean;
  /** Watch the host's metrics while the strip or the SysInfo view shows. */
  onWatchMetrics?: () => void;
  /** Stop watching: hiding the page, entering the terminal, leaving. */
  onUnwatchMetrics?: () => void;
}

export interface Shell {
  showSignIn: () => void;
  showPair: (prefillCode?: string) => void;
  showHosts: () => void;
  showSessions: () => void;
  showSession: (id: string, name: string) => void;
  showNew: () => void;
  showBuilder: () => void;
  setLogin: (login: string | null) => void;
  setHostLabel: (label: string) => void;
  setHostId: (id: string) => void;
  setConnectionState: (state: string) => void;
  setOnlineHosts: (hosts: OnlineHost[]) => void;
  setPairedHosts: (hosts: { host_id: string; label: string }[]) => void;
  setPairError: (message: string | null) => void;
  setPairBusy: (busy: boolean) => void;
  setSignOutError: (message: string | null) => void;
  ensureTerminal: (id: string, cols: number, rows: number) => void;
  /** The host's `resized` frame for the open session. */
  sessionResized: (id: string, cols: number, rows: number) => void;
  writeTerminal: (data: Uint8Array) => void;
  clearTerminal: () => void;
  showSessionExited: (code: number) => void;
  /** The open session was removed on the host, whoever caused it. */
  sessionRemoved: (id: string) => void;
  /** A kill{req} error matched the pending close; true when consumed. */
  killError: (req: string | null, message: string) => boolean;
  /** The host greets: the graph view's pause/continue gate follows hello. */
  graphHello: (features: string[]) => void;
  /** The host greets: the New dialog offers Resume only when it does. */
  resumeHello: (features: string[]) => void;
  /** The host's recorded conversations answer the Resume pane's request. */
  resumeList: (sessions: ResumableSession[]) => void;
  /** A graph_control ok; true when the graph route consumed it. */
  graphControlOk: (req: string) => boolean;
  /** A graph_control error; true when the graph route consumed it. */
  graphControlError: (req: string | null, message: string) => boolean;
  sheetSpawned: (req: string, id: string) => void;
  sheetComposed: (req: string, text: string) => void;
  sheetScheduled: (req: string, item: ScheduledItem) => void;
  sheetScheduledList: (req: string, items: ScheduledItem[]) => void;
  sheetOk: (req: string) => void;
  sheetError: (message: string, req: string | null, code: string) => void;
  dispose: () => void;
}

export interface ShellDeps {
  terminalFactory?: TerminalFactory;
  catalog?: CatalogStore;
  /** The session shelf; without it (or without the feature) no UI. */
  shelf?: ShelfHandle;
  /** The watched graphs; without it the Graphs tab stays empty. */
  graphs?: GraphStore;
  /** The host metrics; without it no strip and no SysInfo view. */
  metrics?: MetricsStore | null;
}

type Route = "signin" | "pair" | "hosts" | "sessions" | "session" | "graph" | "metrics";

export function createShell(
  root: HTMLElement,
  store: SessionStore,
  callbacks: ShellCallbacks,
  deps?: ShellDeps,
): Shell {
  const terminalFactory = deps?.terminalFactory ?? createXtermHandle;
  const shelf = deps?.shelf ?? null;
  let route: Route = "signin";
  let login: string | null = null;
  let hostLabel = "";
  let hostId = "";
  let connectionState = "connecting";
  let online: OnlineHost[] = [];
  let paired: { host_id: string; label: string }[] = [];
  let draft: PairDraft = { code: "", hostId: "", label: "" };
  let pairError: string | null = null;
  let pairBusy = false;
  let signOutError: string | null = null;
  let accountOpen = false;
  // The host chip's link icon slot; the Files button's lives in the session route.
  let hostIcon: MorphSlot | null = null;

  // The catalog the host sent and the two sheets that consume it. The
  // dialogs subscribe to the store themselves while they are open.
  const catalog = deps?.catalog ?? new CatalogStore();
  const newDialog = new NewDialog(
    catalog,
    {
      onSpawn: (spawn, req) => callbacks.onSpawn(spawn, req),
      onResumableList: (req) => callbacks.onResumableList?.(req) ?? false,
      onResume: (id, req) => callbacks.onResume?.(id, req) ?? false,
    },
    { sessions: store, hostId },
  );
  const builder = new Builder(catalog, {
    onCompose: (draft, req) => callbacks.onCompose(draft, req),
    onSend: (draft, req) => callbacks.onSendDraft(draft, req),
    onSchedule: (draft, fireAt, req) => callbacks.onSchedule(draft, fireAt, req),
    onScheduledList: (req) => callbacks.onScheduledList(req),
    onScheduledCancel: (scheduleId, req) => callbacks.onScheduledCancel(scheduleId, req),
  });
  const termCopy = new TermCopySheet();
  const closeSheets = () => {
    newDialog.close();
    builder.close();
    termCopy.close();
    shelf?.close();
  };

  const snapshotDraft = () => {
    const code = root.querySelector<HTMLInputElement>("#pair-code");
    const host = root.querySelector<HTMLSelectElement>("#pair-host");
    const label = root.querySelector<HTMLInputElement>("#pair-label");
    if (code) {
      draft = { code: code.value, hostId: host?.value ?? "", label: label?.value ?? "" };
    }
  };

  // A live link is the wifi arc; anything else (connecting, retrying,
  // failed) is the crossed-out one.
  const linkIcon = (): RemoteIconName => (connectionState === "connected" ? "wifi" : "wifiOff");

  // The chrome paints from the shell's state: the topbar, the banner and
  // the pair form's host options. Disconnect rides the header beside the
  // host chip on exactly one route: the sessions home it always sat on.
  const header = (): string =>
    renderTopbar({
      login,
      hostLabel,
      connectionState,
      link: linkIcon(),
      signOutError,
      accountOpen,
      showDisconnect: route === "sessions",
      metricsStrip: metricsRoute.stripHtml(),
    });
  const connBanner = (): string => renderConnBanner(connectionState);
  const wireConnBanner = (): void => wireConnActions(root, callbacks);

  // The three screens before a terminal exists read and change the shell's
  // state through these hooks; a pairing complaint repaints the form and a
  // pair submit clears the old error before the shell takes over.
  const entryViews: EntryViewHooks = {
    header: () => header(),
    online: () => online,
    paired: () => paired,
    draft: () => draft,
    snapshotDraft: () => snapshotDraft(),
    pairError: () => pairError,
    pairBusy: () => pairBusy,
    setPairError: (message) => {
      pairError = message;
      render();
    },
    onPair: (submit) => {
      pairError = null;
      callbacks.onPair(submit);
    },
    onConnect: (hostId) => callbacks.onConnect(hostId),
    onPairAgain: () => callbacks.onPairAgain(),
  };

  const openNew = () => {
    if (route !== "sessions") {
      return;
    }
    builder.close();
    newDialog.open(root);
  };

  // The host chip's link icon: mounted after every render that carries the
  // header, and patched in place on a connection change.
  const mountHeaderIcon = (): void => {
    hostIcon?.destroy();
    hostIcon = null;
    const slot = root.querySelector<HTMLElement>("#conn-icon");
    if (slot !== null) {
      hostIcon = mountMorphSlot(slot, linkIcon());
    }
  };

  // A fresh screen starts clean: the last sign-out failure and the open
  // account menu belong to the screen that showed them, and a menu that
  // auto-opened over a failure must not follow the user onto the terminal.
  const beginRoute = (): void => {
    signOutError = null;
    accountOpen = false;
  };

  const openGraph = (id: string, name: string) => {
    closeSheets();
    sessionRoute.leave();
    route = "graph";
    beginRoute();
    graphRoute.open(id, name);
  };

  // The header banner goes home through the session-leave path; before
  // pairing there is no home to show, so it stays put.
  const goHome = (): void => {
    if (route === "session" || route === "graph" || route === "sessions" || route === "metrics") {
      callbacks.onLeaveSession();
    }
  };

  // Declared rather than assigned so the entry views' hooks can call it
  // from above: a pairing complaint repaints through setPairError.
  function render(): void {
    // The view name on <body>, and the document title names the view
    // behind it.
    document.body.dataset.view = route;
    document.title = shellTitle(route, {
      homeTab: graphRoute.homeTab,
      graphName: graphRoute.displayName(),
      sessionName: sessionRoute.openName,
    });
    if (route === "signin") {
      renderSignIn(root, entryViews);
    } else if (route === "pair") {
      renderPair(root, entryViews);
    } else if (route === "hosts") {
      renderHosts(root, entryViews);
    } else if (route === "sessions") {
      graphRoute.renderSessionsRoute();
    } else if (route === "graph") {
      graphRoute.mountGraph();
    } else if (route === "metrics") {
      metricsRoute.mount();
    } else {
      sessionRoute.render();
    }
    mountHeaderIcon();
    // Every route above repainted the header with innerHTML, detaching the
    // honeycomb's old host: remount the kit on the fresh one.
    syncHeaderFondo(root);
    metricsRoute.afterRender();
    root.querySelector("#brand-home")?.addEventListener("click", () => goHome());
    // The header Disconnect, present on the sessions route only; the
    // detach it runs is the same one the old bottom button ran.
    root.querySelector("#conn-disconnect")?.addEventListener("click", () => callbacks.onDisconnect());
    wireAccount(root, {
      onSignOut: () => callbacks.onSignOut(),
      onForget: () => callbacks.onForgetDevice(),
      onToggle: (open) => {
        accountOpen = open;
      },
    });
  }

  // The home tabs, the graph route and the watch lifecycle live in the
  // graph route; the shell only lends it render() and the route setters.
  const graphRoute = new GraphRoute(
    root,
    deps?.graphs ?? null,
    shelf,
    {
      onGraphsRequest: () => callbacks.onGraphsRequest(),
      onWatchGraph: (id) => callbacks.onWatchGraph(id),
      onUnwatchGraph: () => callbacks.onUnwatchGraph(),
      onGraphControl: (req, id, action) => callbacks.onGraphControl(req, id, action),
    },
    {
      listSessions: () => store.list(),
      sessionsLoaded: () => store.loaded(),
      openSession: (id) => callbacks.onOpenSession(id),
      newSession: () => openNew(),
      render: () => render(),
      openGraph: (id, name) => openGraph(id, name),
      leaveToSessions: () => {
        route = "sessions";
        beginRoute();
        render();
      },
      header: () => header(),
      banner: () => connBanner(),
      wireBanner: () => wireConnBanner(),
      connectionState: () => connectionState,
      route: () => route,
    },
  );
  const metricsRoute = new MetricsRoute(
    root,
    deps?.metrics ?? null,
    {
      onWatchMetrics: () => callbacks.onWatchMetrics?.(),
      onUnwatchMetrics: () => callbacks.onUnwatchMetrics?.(),
      onOpenMetrics: () => metricsRoute.openCurrent(route, sessionRoute.openId),
    },
    {
      openSession: (id) => callbacks.onOpenSession(id),
      showReturn: (ret) => { route = ret; beginRoute(); render(); },
      teardownSession: () => sessionRoute.teardown(),
      showMetrics: () => { closeSheets(); route = "metrics"; beginRoute(); render(); },
      chrome: () => ({
        header: header(), banner: connBanner(),
        connected: connectionState === "connected",
      }),
      route: () => route,
    },
  );
  const sessionRoute = new SessionRoute(
    root,
    { terminalFactory, shelf },
    {
      onKeyPress: (bytes) => callbacks.onKeyPress(bytes),
      onTerminalInput: (bytes) => callbacks.onTerminalInput(bytes),
      onControlSize: (cols, rows) => callbacks.onControlSize(cols, rows),
      onReleaseSize: () => callbacks.onReleaseSize(),
      onKill: (req) => callbacks.onKill(req),
      onLeaveSession: () => callbacks.onLeaveSession(),
    },
    {
      header: () => header(),
      banner: () => connBanner(),
      wireBanner: () => wireConnBanner(),
      route: () => route,
      openBuilder: () => {
        newDialog.close();
        termCopy.close();
        builder.open(root);
      },
      openCopy: (bufferText) => {
        newDialog.close();
        builder.close();
        termCopy.open(root, { bufferText });
      },
    },
  );
  graphRoute.start();
  metricsRoute.start();

  const stopStore = store.subscribe(() => {
    if (route === "sessions") {
      graphRoute.paintHome();
    } else if (route === "session") {
      sessionRoute.storeUpdated(store);
    }
  });

  const stopShelf = shelf?.subscribe(() => {
    if (route === "sessions") {
      graphRoute.paintHome();
    } else if (route === "session") {
      sessionRoute.shelfUpdated();
    }
  });

  // The "Ns ago" labels go stale; refresh them while Sessions is visible.
  const ticker = globalThis.setInterval(() => {
    if (route === "sessions") {
      graphRoute.paintHome();
    }
  }, 15000);

  // Leaving a route for a fresh one: the sheets close, the session
  // widgets go, and an open graph watch drops with the view.
  const leaveRoute = () => {
    closeSheets();
    sessionRoute.leave();
    graphRoute.leave();
  };

  return {
    showSignIn(): void {
      leaveRoute();
      route = "signin";
      beginRoute();
      render();
    },
    showPair(prefillCode?: string): void {
      leaveRoute();
      route = "pair";
      pairError = null;
      pairBusy = false;
      beginRoute();
      draft = {
        code: prefillCode ?? draft.code,
        hostId: online.length === 1 && online[0] ? online[0].host_id : draft.hostId,
        label: draft.label === "" ? defaultDeviceLabel() : draft.label,
      };
      render();
    },
    showHosts(): void {
      leaveRoute();
      route = "hosts";
      beginRoute();
      render();
    },
    showSessions(): void {
      leaveRoute();
      route = "sessions";
      beginRoute();
      render();
    },
    showSession(id: string, name: string): void {
      closeSheets();
      graphRoute.leave();
      sessionRoute.open(id, name);
      route = "session";
      beginRoute();
      render();
    },
    showNew(): void {
      openNew();
    },
    showBuilder(): void {
      sessionRoute.openBuilder();
    },
    setLogin(next: string | null): void {
      login = next;
      if (route !== "signin") {
        render();
      }
    },
    setHostLabel(label: string): void {
      hostLabel = label;
      if (route !== "signin") {
        render();
      }
    },
    setHostId(id: string): void {
      hostId = id;
      newDialog.setHostId(id);
    },
    setConnectionState(state: string): void {
      connectionState = state;
      if (route === "sessions" || route === "session" || route === "graph" || route === "metrics") {
        // Never a full re-render here: it would drop the terminal. Only
        // the header and the banner carry the state, so patch them in
        // place — the host chip's link icon too. The
        // chip only morphs when its meaning flips: connecting → retrying is
        // still the same crossed-out link, and must not restart the morph.
        const topbar = root.querySelector(".topbar");
        if (topbar) {
          topbar.setAttribute("data-conn", state);
        }
        const link = linkIcon();
        if (hostIcon !== null && hostIcon.name !== link) {
          hostIcon.to(link);
        }
        const main = root.querySelector("main");
        root.querySelector(".conn-banner")?.remove();
        if (main) {
          main.insertAdjacentHTML("afterbegin", connBanner());
          wireConnBanner();
        }
        // The disconnect note hangs on the connection, not the frames.
        graphRoute.syncConnection();
        metricsRoute.syncConnection();
      } else if (route !== "signin") {
        render();
      }
    },
    setOnlineHosts(hosts: OnlineHost[]): void {
      online = hosts;
      if (route === "pair") {
        snapshotDraft();
        if (online.length === 1 && online[0] && draft.hostId === "") {
          draft.hostId = online[0].host_id;
        }
        render();
      }
    },
    setPairedHosts(hosts: { host_id: string; label: string }[]): void {
      paired = hosts;
      if (route === "hosts") {
        render();
      }
    },
    setPairError(message: string | null): void {
      pairError = message;
      if (route === "pair") {
        snapshotDraft();
        render();
      }
    },
    setPairBusy(busy: boolean): void {
      pairBusy = busy;
      if (route === "pair") {
        snapshotDraft();
        render();
      }
    },
    setSignOutError(message: string | null): void {
      signOutError = message;
      if (route === "signin") {
        return;
      }
      // Patch the error slots in place: a full repaint to show one line
      // would tear the session view's terminal down with it (and reset the
      // graph view's scroll), while the user is still signed in.
      for (const el of root.querySelectorAll<HTMLElement>(".signout-error")) {
        el.textContent = message ?? "";
      }
      if (message !== null) {
        // The menu holds the only sign-out control on every view, so a
        // failure opens it rather than hiding its text.
        const details = root.querySelector<HTMLDetailsElement>("#account");
        if (details !== null && !details.open) {
          details.open = true;
        }
      }
    },
    ensureTerminal(id: string, cols: number, rows: number): void {
      sessionRoute.ensureTerminal(id, cols, rows);
    },
    sessionResized(id: string, cols: number, rows: number): void {
      sessionRoute.sessionResized(id, cols, rows);
    },
    writeTerminal(data: Uint8Array): void {
      sessionRoute.writeTerminal(data);
    },
    clearTerminal(): void {
      sessionRoute.clearTerminal();
    },
    showSessionExited(code: number): void {
      sessionRoute.showSessionExited(code);
    },
    sessionRemoved(id: string): void {
      if (route !== "session" || sessionRoute.openId !== id) {
        return;
      }
      // The list's one-shot flash must be set before the leave renders
      // it — render() is synchronous and consumes it.
      if (sessionRoute.wasKillPending()) {
        graphRoute.setListFlash("Session closed");
      }
      callbacks.onLeaveSession();
    },
    killError(req: string | null, message: string): boolean {
      return sessionRoute.killError(req, message);
    },
    graphHello(features: string[]): void {
      graphRoute.handleHello(features);
    },
    resumeHello(features: string[]): void {
      newDialog.setHasResume(features.includes("session_resume"));
    },
    resumeList(sessions: ResumableSession[]): void {
      newDialog.handleResumable(sessions);
    },
    graphControlOk(req: string): boolean {
      return graphRoute.handleControlOk(req);
    },
    graphControlError(req: string | null, message: string): boolean {
      return graphRoute.handleControlError(req, message);
    },
    sheetSpawned(req: string, id: string): void {
      const spawnName = newDialog.handleSpawned(req);
      if (spawnName === null) {
        return;
      }
      closeSheets();
      sessionRoute.setSpawnFlash("Session started");
      callbacks.onOpenSession(id, spawnName);
    },
    sheetComposed(req: string, text: string): void {
      builder.handleComposed(req, text);
    },
    sheetScheduled(req: string, item: ScheduledItem): void {
      builder.handleScheduled(req, item);
    },
    sheetScheduledList(req: string, items: ScheduledItem[]): void {
      builder.handleScheduledList(req, items);
    },
    sheetOk(req: string): void {
      builder.handleOk(req);
    },
    sheetError(message: string, req: string | null, code: string): void {
      if (!builder.handleError(message, req, code)) {
        newDialog.handleError(message, req, code);
      }
    },
    dispose(): void {
      globalThis.clearInterval(ticker);
      graphRoute.dispose();
      metricsRoute.dispose();
      stopStore();
      stopShelf?.();
      closeSheets();
      sessionRoute.dispose();
      hostIcon?.destroy();
      hostIcon = null;
    },
  };

}
