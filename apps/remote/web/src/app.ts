// SPDX-License-Identifier: Apache-2.0
// The app shell: Sign in → Pair → Sessions → Session, with a header
// carrying the GitHub login, the host label and the connection state.
// The shell owns the views and the terminal/key-bar/composer widgets;
// main.ts owns the relay, the peer and the frame routing. A host picker
// appears only when several hosts are paired.

import { Composer } from "./composer.js";
import { CatalogStore } from "./catalog.js";
import { Builder } from "./builder.js";
import { icon, mountMorphSlot, type IconName, type MorphSlot } from "./icons-dom.js";
import { renderKeyBar, updateKeyBarLatches } from "./keys.js";
import { keyBytesWithModifiers, ModifierLatches, textBytesWithModifiers } from "./modifiers.js";
import { NewDialog } from "./new-dialog.js";
import { defaultDeviceLabel } from "./pairing.js";
import { connectFailMessage } from "./peer.js";
import type { PromptDraft, SpawnRequest } from "./protocol.js";
import type { OnlineHost } from "./relay.js";
import type { ShelfHandle } from "./shelf-controller.js";
import { renderSessions } from "./sessions.js";
import type { SessionListShelf, SessionStore } from "./sessions.js";
import { createXtermHandle, TerminalView } from "./terminal.js";
import type { TerminalFactory } from "./terminal.js";
import { readFitOnly, writeFitOnly } from "./terminal-prefs.js";
import type { PairSubmit } from "./ui.js";
import { renderBanner } from "../../../../packages/look/banner/banner.js";
import { renderColophon } from "../../../../packages/look/colophon/footer.js";

export interface ShellCallbacks {
  onPair: (submit: PairSubmit) => void;
  onConnect: (hostId: string) => void;
  onDisconnect: () => void;
  onRetry: () => void;
  onPairAgain: () => void;
  onOpenSession: (id: string) => void;
  onLeaveSession: () => void;
  /** Key-bar bytes with the latches applied; the shell owns the latches. */
  onKeyPress: (bytes: Uint8Array) => void;
  /** Phone-keyboard bytes with the latches applied. */
  onTerminalInput: (bytes: Uint8Array) => void;
  onComposerSend: (text: string, req: string) => void;
  /** False when the frame could not be sent; the dialog then says so. */
  onSpawn: (spawn: SpawnRequest, req: string) => boolean;
  onCompose: (draft: PromptDraft, req: string) => boolean;
  onSendDraft: (draft: PromptDraft, req: string) => boolean;
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
}

type Route = "signin" | "pair" | "hosts" | "sessions" | "session";

// The UniverLab colophon, on the sign-in and pair screens only — the
// session view keeps the whole viewport for the terminal.
const COLOPHON = renderColophon({
  product: "Canopy remote",
  exp: "EXP-001",
  links: [
    { label: "Canopy", href: "https://univerlab.org/canopy/" },
    { label: "univerlab.org", href: "https://univerlab.org/" },
    { label: "Source", href: "https://github.com/UniverLab/canopy-web" },
  ],
});

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
  let draft = { code: "", hostId: "", label: "" };
  let pairError: string | null = null;
  let pairBusy = false;
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

  const failed = () => connectionState.startsWith("failed:");
  const unpaired = () => connectionState === `failed: ${connectFailMessage("unknown_device")}`;
  // A live link is the wifi arc; anything else (connecting, retrying,
  // failed) is the crossed-out one, and the conn chip's word says which.
  const linkIcon = (): IconName => (connectionState === "connected" ? "wifi" : "wifiOff");

  const header = (): string => `
    <header class="topbar" data-conn="${esc(connectionState)}">
      <span class="brand">remote</span>
      ${login === null ? "" : `<span class="login chip">${esc(login)}</span>`}
      ${hostLabel === "" ? "" : `<span class="host chip">` +
        `<span class="icon-slot" id="conn-icon" data-morph="host" aria-hidden="true">${icon(linkIcon())}</span>` +
        `${esc(hostLabel)}</span>`}
      <span class="conn chip" role="status">${esc(connectionState)}</span>
    </header>`;

  const connBanner = (): string => {
    if (!failed() && !connectionState.startsWith("retrying")) {
      return "";
    }
    return (
      `<p class="conn-banner" role="status">${esc(connectionState)} ` +
      (failed() ? `<button type="button" id="conn-retry">Retry</button> ` : "") +
      (unpaired() ? `<button type="button" id="conn-pair-again">Pair again</button>` : "") +
      `</p>`
    );
  };

  const wireConnBanner = () => {
    root.querySelector("#conn-retry")?.addEventListener("click", () => callbacks.onRetry());
    root.querySelector("#conn-pair-again")?.addEventListener("click", () => callbacks.onPairAgain());
  };

  const hostOptions = (): string => {
    if (online.length === 0) {
      return `<option value="" selected>No hosts online</option>`;
    }
    if (online.length === 1 && online[0]) {
      return `<option value="${esc(online[0].host_id)}" selected>${esc(online[0].label)}</option>`;
    }
    const options = online.map(
      (host) =>
        `<option value="${esc(host.host_id)}"${host.host_id === draft.hostId ? " selected" : ""}>${esc(host.label)}</option>`,
    );
    const placeholder = draft.hostId === "" ? " selected" : "";
    return [`<option value=""${placeholder}>Choose a host…</option>`, ...options].join("");
  };

  const renderSignIn = () => {
    root.innerHTML = `
    <main class="signin">
      ${renderBanner("remote")}
      <h1>Canopy remote</h1>
      <p>Sign in with GitHub to reach your hosts.</p>
      <button type="button" class="primary" id="signin-go">Sign in with GitHub</button>
      <p>Signing in shares your GitHub username and numeric id with this relay, kept in a 12-hour session cookie. Your sessions travel encrypted between your browser and your machine. <a href="https://univerlab.org/privacy/">Privacy</a></p>
    </main>
    ${COLOPHON}`;
    root.querySelector("#signin-go")?.addEventListener("click", () => {
      globalThis.location.href = "/auth/login";
    });
  };

  const renderPair = () => {
    root.innerHTML = `
    ${header()}
    <main class="pair">
      <h2>Pair this browser</h2>
      <p>Enter the pairing code shown by canopy.</p>
      <form id="pair-form">
        <label>Pairing code
          <input id="pair-code" name="code" autocomplete="off" autocapitalize="characters"
            spellcheck="false" value="${esc(draft.code)}"${pairBusy ? " disabled" : ""}>
        </label>
        <label>Host
          <select id="pair-host" name="host"${pairBusy || online.length === 0 ? " disabled" : ""}>
            ${hostOptions()}
          </select>
        </label>
        <label>Device label
          <input id="pair-label" name="label" autocomplete="off" value="${esc(draft.label)}"${pairBusy ? " disabled" : ""}>
        </label>
        <p id="pair-error" role="alert">${pairError === null ? "" : esc(pairError)}</p>
        <button type="submit"${pairBusy ? " disabled" : ""}>${pairBusy ? "Pairing…" : "Pair"}</button>
      </form>
    </main>
    ${COLOPHON}`;
    root.querySelector<HTMLFormElement>("#pair-form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      snapshotDraft();
      if (online.length === 0 || draft.hostId === "") {
        pairError = online.length === 0 ? "No hosts online" : "Choose a host";
        render();
        return;
      }
      if (draft.code.trim() === "") {
        pairError = "Enter the pairing code";
        render();
        return;
      }
      pairError = null;
      callbacks.onPair({ hostId: draft.hostId, code: draft.code, label: draft.label });
    });
  };

  const renderHosts = () => {
    const rows = paired
      .map(
        (host) => `<li><span>${esc(host.label)}</span>
          <button type="button" data-connect="${esc(host.host_id)}">Connect</button></li>`,
      )
      .join("");
    root.innerHTML = `
    ${header()}
    <main class="hosts">
      <h2>Choose a host</h2>
      <ul id="host-list">${rows}</ul>
      <p><button type="button" id="pair-new">Pair a new host</button></p>
    </main>`;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-connect]")) {
      button.addEventListener("click", () => {
        const hostId = button.getAttribute("data-connect");
        if (hostId) {
          callbacks.onConnect(hostId);
        }
      });
    }
    root.querySelector("#pair-new")?.addEventListener("click", () => callbacks.onPairAgain());
  };

  const renderSessionsRoute = () => {
    root.innerHTML = `
    ${header()}
    <main class="sessions">
      ${renderBanner("remote")}
      ${connBanner()}
      <div id="session-list"></div>
      <p><button type="button" id="conn-disconnect">Disconnect</button></p>
    </main>`;
    wireConnBanner();
    root.querySelector("#conn-disconnect")?.addEventListener("click", () => callbacks.onDisconnect());
    const slot = root.querySelector<HTMLElement>("#session-list");
    if (slot) {
      renderSessionsList(slot);
    }
  };

  const shelfListArgs = (): SessionListShelf | undefined => {
    if (!shelf) {
      return undefined;
    }
    return {
      enabled: shelf.enabled(),
      hostCount: shelf.count(null),
      count: (id) => shelf.count(id),
      onOpenShelf: () => shelf.open(root, null),
    };
  };

  const renderSessionsList = (slot: HTMLElement) => {
    renderSessions(
      slot,
      store.list(),
      Date.now(),
      {
        onOpen: (id) => callbacks.onOpenSession(id),
        onNew: () => openNew(),
      },
      shelfListArgs(),
    );
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
    const next: IconName = (shelf?.isOpen() ?? false) ? "folderOpen" : "folder";
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

  const render = () => {
    // The view name on <body> lets the stylesheet dim the honeycomb
    // behind the terminal (body[data-view="session"]).
    document.body.dataset.view = route;
    if (route === "signin") {
      renderSignIn();
    } else if (route === "pair") {
      renderPair();
    } else if (route === "hosts") {
      renderHosts();
    } else if (route === "sessions") {
      renderSessionsRoute();
    } else {
      renderSession();
    }
    mountHeaderIcon();
  };

  const stopStore = store.subscribe(() => {
    if (route === "sessions") {
      const slot = root.querySelector<HTMLElement>("#session-list");
      if (slot) {
        renderSessionsList(slot);
      }
    }
  });

  const stopShelf = shelf?.subscribe(() => {
    if (route === "sessions") {
      const slot = root.querySelector<HTMLElement>("#session-list");
      if (slot) {
        renderSessionsList(slot);
      }
    } else if (route === "session") {
      syncFilesBadge();
    }
  });

  // The "Ns ago" labels go stale; refresh them while Sessions is visible.
  const ticker = globalThis.setInterval(() => {
    if (route === "sessions") {
      const slot = root.querySelector<HTMLElement>("#session-list");
      if (slot) {
        renderSessionsList(slot);
      }
    }
  }, 15000);

  return {
    showSignIn(): void {
      closeSheets();
      teardownSessionWidgets();
      sessionId = null;
      route = "signin";
      render();
    },
    showPair(prefillCode?: string): void {
      closeSheets();
      teardownSessionWidgets();
      sessionId = null;
      route = "pair";
      pairError = null;
      pairBusy = false;
      draft = {
        code: prefillCode ?? draft.code,
        hostId: online.length === 1 && online[0] ? online[0].host_id : draft.hostId,
        label: draft.label === "" ? defaultDeviceLabel() : draft.label,
      };
      render();
    },
    showHosts(): void {
      closeSheets();
      teardownSessionWidgets();
      sessionId = null;
      route = "hosts";
      render();
    },
    showSessions(): void {
      closeSheets();
      teardownSessionWidgets();
      sessionId = null;
      route = "sessions";
      render();
    },
    showSession(id: string, name: string): void {
      closeSheets();
      sessionId = id;
      sessionName = name;
      route = "session";
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
      if (route === "sessions" || route === "session") {
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
