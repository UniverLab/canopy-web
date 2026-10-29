// SPDX-License-Identifier: Apache-2.0
// The app shell: Sign in → Pair → Sessions → Session, with a header
// carrying the GitHub login, the host label and the connection state.
// The shell owns the views and the terminal/key-bar/composer widgets;
// main.ts owns the relay, the peer and the frame routing. A host picker
// appears only when several hosts are paired.

import { Composer } from "./composer.js";
import { CatalogStore } from "./catalog.js";
import { Builder } from "./builder.js";
import { renderConnBanner, renderTopbar, wireAccount, wireConnActions } from "./chrome.js";
import { renderHosts, renderPair, renderSignIn } from "./entry-views.js";
import type { EntryViewHooks, PairDraft } from "./entry-views.js";
import { GraphRoute } from "./graph-route.js";
import type { GraphStore } from "./graph-store.js";
import { icon, mountMorphSlot, type RemoteIconName, type MorphSlot } from "./icons-dom.js";
import { renderKeyBar, updateKeyBarLatches } from "./keys.js";
import { MetricsRoute } from "./metrics-route.js";
import type { MetricsStore } from "./metrics-store.js";
import { keyBytesWithModifiers, ModifierLatches, textBytesWithModifiers } from "./modifiers.js";
import { NewDialog } from "./new-dialog.js";
import { defaultDeviceLabel } from "./pairing.js";
import type { PromptDraft, SpawnRequest } from "./protocol.js";
import type { OnlineHost } from "./relay.js";
import type { ShelfHandle } from "./shelf-controller.js";
import type { SessionStore } from "./sessions.js";
import { createXtermHandle, TerminalView } from "./terminal.js";
import type { TerminalFactory } from "./terminal.js";
import { readFitOnly, writeFitOnly } from "./terminal-prefs.js";
import type { PairSubmit } from "./ui.js";

export interface ShellCallbacks {
  onPair: (submit: PairSubmit) => void;
  onConnect: (hostId: string) => void;
  onDisconnect: () => void;
  onRetry: () => void;
  onPairAgain: () => void;
  onOpenSession: (id: string) => void;
  onLeaveSession: () => void;
  /** Sign out through POST /auth/logout, from the menu or a direct button. */
  onSignOut: () => void;
  /** Forget this device (pairing keys go too) after the shell's confirm. */
  onForgetDevice: () => void;
  /** Key-bar bytes with the latches applied; the shell owns the latches. */
  onKeyPress: (bytes: Uint8Array) => void;
  /** Phone-keyboard bytes with the latches applied. */
  onTerminalInput: (bytes: Uint8Array) => void;
  onComposerSend: (text: string, req: string) => void;
  /** False when the frame could not be sent; the dialog then says so. */
  onSpawn: (spawn: SpawnRequest, req: string) => boolean;
  onCompose: (draft: PromptDraft, req: string) => boolean;
  onSendDraft: (draft: PromptDraft, req: string) => boolean;
  /** Ask the host for the graphs list (the Graphs tab shows and polls it). */
  onGraphsRequest: () => void;
  /** Start watching a graph: the host pushes graph_state until unwatched. */
  onWatchGraph: (id: string) => void;
  /** Stop watching: back, switching tab or hiding the page. */
  onUnwatchGraph: () => void;
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
  writeTerminal: (text: string) => void;
  clearTerminal: () => void;
  showSessionExited: (code: number) => void;
  composerOk: (req: string) => void;
  composerError: (message: string, req: string | null) => void;
  sheetSpawned: (req: string, id: string) => void;
  sheetComposed: (req: string, text: string) => void;
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

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
  // The one-shot Ctrl/Shift latches for the open session, released on
  // every consumed key and every session render.
  const latches = new ModifierLatches();
  let connectionState = "connecting";
  let online: OnlineHost[] = [];
  let paired: { host_id: string; label: string }[] = [];
  let draft: PairDraft = { code: "", hostId: "", label: "" };
  let pairError: string | null = null;
  let pairBusy = false;
  let signOutError: string | null = null;
  let accountOpen = false;
  let sessionId: string | null = null;
  let sessionName = "";
  let sessionCols = 0;
  let sessionRows = 0;
  let terminalView: TerminalView | null = null;
  let composer: Composer | null = null;
  let latestButton: HTMLButtonElement | null = null;
  // The three state-telling slots: the host chip's link icon, the Files
  // button's folder, and nothing else — the composer owns its Send.
  let hostIcon: MorphSlot | null = null;
  let shelfIcon: MorphSlot | null = null;
  // The one-shot spawn confirmation: set by sheetSpawned, consumed by the
  // session view's first render, so it shows exactly once.
  let spawnFlash: string | null = null;

  // The catalog the host sent and the two sheets that consume it. The
  // dialogs subscribe to the store themselves while they are open.
  const catalog = deps?.catalog ?? new CatalogStore();
  const newDialog = new NewDialog(
    catalog,
    {
      onSpawn: (spawn, req) => callbacks.onSpawn(spawn, req),
    },
    { sessions: store, hostId },
  );
  const builder = new Builder(catalog, {
    onCompose: (draft, req) => callbacks.onCompose(draft, req),
    onSend: (draft, req) => callbacks.onSendDraft(draft, req),
  });
  const closeSheets = () => {
    newDialog.close();
    builder.close();
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
  // failed) is the crossed-out one, and the conn chip's word says which.
  const linkIcon = (): RemoteIconName => (connectionState === "connected" ? "wifi" : "wifiOff");

  // The chrome paints from the shell's state: the topbar, the banner and
  // the pair form's host options.
  const header = (): string =>
    renderTopbar({
      login,
      hostLabel,
      connectionState,
      link: linkIcon(),
      signOutError,
      accountOpen,
      metricsStrip: metricsRoute.stripHtml(),
    });
  const connBanner = (): string => renderConnBanner(connectionState);
  const wireConnBanner = (): void => wireConnActions(root, callbacks);

  // The three screens before a terminal exists read and change the shell's
  // state through these hooks; a pairing complaint repaints the form and a
  // pair submit clears the old error before the shell takes over.
  const entryViews: EntryViewHooks = {
    header: () => header(),
    login: () => login,
    signOutError: () => signOutError,
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

  // The Files badge lives in the session bar; every shelf change either
  // patches it (session route) or repaints the list (sessions route). The
  // folder icon opens while the sheet is up and closes when it goes.
  const syncFilesBadge = () => {
    const button = root.querySelector<HTMLElement>("#session-files");
    if (!button) {
      return;
    }
    const enabled = shelf?.enabled() ?? false;
    button.hidden = !enabled;
    // A morph says the meaning changed; a repaint that leaves the sheet as
    // it was must not restart it.
    const next: RemoteIconName = (shelf?.isOpen() ?? false) ? "folderOpen" : "folder";
    if (shelfIcon !== null && shelfIcon.name !== next) {
      shelfIcon.to(next);
    }
    const badge = button.querySelector<HTMLElement>("#session-files-badge");
    if (!badge) {
      return;
    }
    const unseen = !enabled || sessionId === null ? 0 : shelf?.unseen(sessionId) ?? 0;
    badge.hidden = unseen === 0;
    badge.textContent = unseen === 0 ? "" : String(unseen);
  };

  const openNew = () => {
    if (route !== "sessions") {
      return;
    }
    builder.close();
    newDialog.open(root);
  };

  // The host chip's link icon: mounted after every render that carries the
  // header, and patched in place while a connection change patches the chip.
  const mountHeaderIcon = (): void => {
    hostIcon?.destroy();
    hostIcon = null;
    const slot = root.querySelector<HTMLElement>("#conn-icon");
    if (slot !== null) {
      hostIcon = mountMorphSlot(slot, linkIcon());
    }
  };

  const openBuilder = () => {
    if (route !== "session") {
      return;
    }
    newDialog.close();
    builder.open(root);
  };

  const teardownSessionWidgets = () => {
    terminalView?.dispose();
    terminalView = null;
    composer?.unmount();
    composer = null;
    latestButton = null;
    shelfIcon?.destroy();
    shelfIcon = null;
    sessionCols = 0;
    sessionRows = 0;
  };

  const renderSession = () => {
    teardownSessionWidgets();
    latches.release();
    const flash = spawnFlash;
    spawnFlash = null;
    root.innerHTML = `
    ${header()}
    <main class="session-view">
      ${flash === null ? "" : `<p class="flash-ok" role="status">${icon("check")}<span>${esc(flash)}</span></p>`}
      ${connBanner()}
      <div class="session-bar">
        <button type="button" id="session-back" aria-label="Back to sessions">${icon("chevronLeft")}</button>
        <span class="session-title">${esc(sessionName)}</span>
        <span class="session-exit" id="session-exit" hidden></span>
        <button type="button" id="session-files" hidden>
          <span class="icon-slot" id="session-files-icon" data-morph="shelf" aria-hidden="true">${icon("folder")}</span>
          <span>Files</span><span
          class="files-badge" id="session-files-badge" hidden
        ></span></button>
      </div>
      <div class="term-pane" id="term-pane">
        <p class="term-placeholder">Attaching…</p>
      </div>
      <div class="term-controls">
        <button type="button" id="term-zoom-out" aria-label="Zoom out">${icon("minus")}</button>
        <button type="button" id="term-zoom-in" aria-label="Zoom in">${icon("plus")}</button>
        <button
          type="button"
          id="term-fit"
          aria-pressed="${readFitOnly() ? "true" : "false"}"
          aria-label="Fit terminal to pane width"
          title="Fit the terminal to the pane width"
        >Fit</button>
        <button type="button" id="term-latest" hidden aria-label="Scroll to the latest output">${icon("arrowDown")}<span>latest</span></button>
      </div>
      <div class="keybar" id="keybar"></div>
      <div class="composer-slot" id="composer-slot"></div>
    </main>`;
    wireConnBanner();
    const filesIcon = root.querySelector<HTMLElement>("#session-files-icon");
    if (filesIcon) {
      shelfIcon = mountMorphSlot(filesIcon, "folder");
    }
    root.querySelector("#session-back")?.addEventListener("click", () => callbacks.onLeaveSession());
    // The Files sheet only exists behind hello.features "shelf"; the
    // button itself is rendered hidden and syncFilesBadge reveals it.
    root.querySelector("#session-files")?.addEventListener("click", () => {
      if (sessionId !== null) {
        shelf?.open(root, sessionId);
      }
    });
    syncFilesBadge();
    root.querySelector("#term-zoom-in")?.addEventListener("click", () => terminalView?.zoomIn());
    root.querySelector("#term-zoom-out")?.addEventListener("click", () => terminalView?.zoomOut());
    // Fit off (default) keeps the readable floor; Fit on is pure
    // fit-to-width. The choice is remembered per device.
    const fitButton = root.querySelector<HTMLButtonElement>("#term-fit");
    fitButton?.addEventListener("click", () => {
      const next = fitButton.getAttribute("aria-pressed") !== "true";
      writeFitOnly(next);
      fitButton.setAttribute("aria-pressed", `${next}`);
      terminalView?.setFitOnly(next);
    });
    latestButton = root.querySelector<HTMLButtonElement>("#term-latest");
    latestButton?.addEventListener("click", () => {
      terminalView?.scrollToLatest();
      if (latestButton) {
        latestButton.hidden = true;
      }
    });
    const bar = root.querySelector<HTMLElement>("#keybar");
    if (bar) {
      renderKeyBar(bar, (def) => {
        // A latch toggles and shows pressed; a second tap releases it
        // without sending. Any other key goes out with the latch applied,
        // then the latch releases.
        if (def.id === "ctrl") {
          latches.toggleCtrl();
          updateKeyBarLatches(bar, latches.snapshot());
          return;
        }
        if (def.id === "shift") {
          latches.toggleShift();
          updateKeyBarLatches(bar, latches.snapshot());
          return;
        }
        const bytes = keyBytesWithModifiers(def.id, latches.snapshot());
        latches.release();
        updateKeyBarLatches(bar, latches.snapshot());
        callbacks.onKeyPress(bytes);
      });
    }
    const slot = root.querySelector<HTMLElement>("#composer-slot");
    if (slot) {
      composer = new Composer({
        onSend: (text, req) => callbacks.onComposerSend(text, req),
        onBuilder: () => openBuilder(),
      });
      composer.mount(slot);
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
    teardownSessionWidgets();
    sessionId = null;
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
    // The view name on <body> lets the stylesheet dim the honeycomb
    // behind the terminal (body[data-view="session"]).
    document.body.dataset.view = route;
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
      renderSession();
    }
    mountHeaderIcon();
    metricsRoute.afterRender();
    root.querySelector("#brand-home")?.addEventListener("click", () => goHome());
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
      onDisconnect: () => callbacks.onDisconnect(),
      onSignOut: () => callbacks.onSignOut(),
      login: () => login,
      signOutError: () => signOutError,
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
      onOpenMetrics: () => metricsRoute.openCurrent(route, sessionId),
    },
    {
      openSession: (id) => callbacks.onOpenSession(id),
      showReturn: (ret) => { route = ret; beginRoute(); render(); },
      teardownSession: () => teardownSessionWidgets(),
      showMetrics: () => { closeSheets(); route = "metrics"; beginRoute(); render(); },
      chrome: () => ({
        header: header(), banner: connBanner(), login, signOutError,
        connected: connectionState === "connected",
        onSignOut: () => callbacks.onSignOut(),
      }),
      route: () => route,
    },
  );
  graphRoute.start();
  metricsRoute.start();

  const stopStore = store.subscribe(() => {
    if (route === "sessions") {
      graphRoute.paintHome();
    }
  });

  const stopShelf = shelf?.subscribe(() => {
    if (route === "sessions") {
      graphRoute.paintHome();
    } else if (route === "session") {
      syncFilesBadge();
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
    teardownSessionWidgets();
    sessionId = null;
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
      sessionId = id;
      sessionName = name;
      route = "session";
      beginRoute();
      render();
    },
    showNew(): void {
      openNew();
    },
    showBuilder(): void {
      openBuilder();
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
        // Never a full re-render here: it would drop the terminal and
        // the composer's draft. Only the header and the banner carry the
        // state, so patch them in place — the host chip's link icon too. The
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
        const conn = root.querySelector(".topbar .conn");
        if (conn) {
          conn.textContent = state;
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
        // The menu is where the session view keeps its only sign-out
        // control, so a failure opens it rather than hiding its text.
        const details = root.querySelector<HTMLDetailsElement>("#account");
        if (details !== null && !details.open) {
          details.open = true;
        }
      }
    },
    ensureTerminal(id: string, cols: number, rows: number): void {
      if (route !== "session" || id !== sessionId) {
        return;
      }
      if (terminalView && cols === sessionCols && rows === sessionRows) {
        return;
      }
      teardownSessionWidgetsKeepComposer();
      const pane = root.querySelector<HTMLElement>("#term-pane");
      if (!pane) {
        return;
      }
      pane.replaceChildren();
      sessionCols = cols;
      sessionRows = rows;
      terminalView = new TerminalView(
        terminalFactory,
        {
          // Phone-keyboard keys honour the latches too: Ctrl+c sends 0x03,
          // then the latch releases and the bar shows it.
          onUserInput: (text) => {
            const bytes = textBytesWithModifiers(text, latches.snapshot());
            if (latches.hasLatch) {
              latches.release();
              const bar = root.querySelector<HTMLElement>("#keybar");
              if (bar) {
                updateKeyBarLatches(bar, latches.snapshot());
              }
            }
            callbacks.onTerminalInput(bytes);
          },
          onFollowChange: ({ following }) => {
            if (latestButton) {
              latestButton.hidden = following;
            }
          },
        },
        { fitOnly: readFitOnly() },
      );
      terminalView.mount(pane, cols, rows);
    },
    writeTerminal(text: string): void {
      terminalView?.write(text);
    },
    clearTerminal(): void {
      terminalView?.clear();
    },
    showSessionExited(code: number): void {
      const badge = root.querySelector<HTMLElement>("#session-exit");
      if (badge) {
        badge.textContent = `exited (${code})`;
        badge.hidden = false;
      }
    },
    composerOk(req: string): void {
      composer?.handleOk(req);
    },
    composerError(message: string, req: string | null): void {
      composer?.handleError(message, req);
    },
    sheetSpawned(req: string, id: string): void {
      if (!newDialog.handleSpawned(req)) {
        return;
      }
      closeSheets();
      spawnFlash = "Session started";
      callbacks.onOpenSession(id);
    },
    sheetComposed(req: string, text: string): void {
      builder.handleComposed(req, text);
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
      teardownSessionWidgets();
      hostIcon?.destroy();
      hostIcon = null;
      composer?.unmount();
      composer = null;
    },
  };

  // Remounting the terminal (a changed host size) must not drop the
  // composer's draft, so the composer survives a terminal teardown.
  function teardownSessionWidgetsKeepComposer(): void {
    terminalView?.dispose();
    terminalView = null;
    sessionCols = 0;
    sessionRows = 0;
    if (latestButton) {
      latestButton.hidden = true;
    }
  }
}
