// SPDX-License-Identifier: Apache-2.0
// The app shell: Sign in → Pair → Sessions → Session, with a header
// carrying the GitHub login, the host label and the connection state.
// The shell owns the views and the terminal/key-bar/composer widgets;
// main.ts owns the relay, the peer and the frame routing. A host picker
// appears only when several hosts are paired.

import { Composer } from "./composer.js";
import { CatalogStore } from "./catalog.js";
import { Builder } from "./builder.js";
import { renderKeyBar } from "./keys.js";
import type { KeyDef } from "./keys.js";
import { NewDialog } from "./new-dialog.js";
import { defaultDeviceLabel } from "./pairing.js";
import { connectFailMessage } from "./peer.js";
import type { PromptDraft, SpawnRequest } from "./protocol.js";
import type { OnlineHost } from "./relay.js";
import { renderSessions } from "./sessions.js";
import type { SessionStore } from "./sessions.js";
import { createXtermHandle, TerminalView } from "./terminal.js";
import type { TerminalFactory } from "./terminal.js";
import type { PairSubmit } from "./ui.js";
import { renderColophon } from "../../../../packages/look/colophon/footer.js";

export interface ShellCallbacks {
  onPair: (submit: PairSubmit) => void;
  onConnect: (hostId: string) => void;
  onDisconnect: () => void;
  onRetry: () => void;
  onPairAgain: () => void;
  onOpenSession: (id: string) => void;
  onLeaveSession: () => void;
  onKeyPress: (def: KeyDef) => void;
  onTerminalInput: (text: string) => void;
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
  let route: Route = "signin";
  let login: string | null = null;
  let hostLabel = "";
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

  // The catalog the host sent and the two sheets that consume it. The
  // dialogs subscribe to the store themselves while they are open.
  const catalog = deps?.catalog ?? new CatalogStore();
  const newDialog = new NewDialog(catalog, {
    onSpawn: (spawn, req) => callbacks.onSpawn(spawn, req),
  });
  const builder = new Builder(catalog, {
    onCompose: (draft, req) => callbacks.onCompose(draft, req),
    onSend: (draft, req) => callbacks.onSendDraft(draft, req),
  });
  const closeSheets = () => {
    newDialog.close();
    builder.close();
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

  const header = (): string => `
    <header class="topbar">
      <span class="brand">remote</span>
      ${login === null ? "" : `<span class="login chip">${esc(login)}</span>`}
      ${hostLabel === "" ? "" : `<span class="host chip">${esc(hostLabel)}</span>`}
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
      <h1>Canopy remote</h1>
      <p>Sign in with GitHub to reach your hosts.</p>
      <button type="button" class="primary" id="signin-go">Sign in with GitHub</button>
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

  const renderSessionsList = (slot: HTMLElement) => {
    renderSessions(slot, store.list(), Date.now(), {
      onOpen: (id) => callbacks.onOpenSession(id),
      onNew: () => openNew(),
    });
  };

  const openNew = () => {
    if (route !== "sessions") {
      return;
    }
    builder.close();
    newDialog.open(root);
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
    sessionCols = 0;
    sessionRows = 0;
  };

  const renderSession = () => {
    teardownSessionWidgets();
    root.innerHTML = `
    ${header()}
    <main class="session-view">
      ${connBanner()}
      <div class="session-bar">
        <button type="button" id="session-back" aria-label="Back to sessions">‹</button>
        <span class="session-title">${esc(sessionName)}</span>
        <span class="session-exit" id="session-exit" hidden></span>
      </div>
      <div class="term-pane" id="term-pane">
        <p class="term-placeholder">Attaching…</p>
      </div>
      <div class="term-controls">
        <button type="button" id="term-zoom-out" aria-label="Zoom out">−</button>
        <button type="button" id="term-zoom-in" aria-label="Zoom in">+</button>
        <button type="button" id="term-latest" hidden>↓ latest</button>
      </div>
      <div class="keybar" id="keybar"></div>
      <div class="composer-slot" id="composer-slot"></div>
    </main>`;
    wireConnBanner();
    root.querySelector("#session-back")?.addEventListener("click", () => callbacks.onLeaveSession());
    root.querySelector("#term-zoom-in")?.addEventListener("click", () => terminalView?.zoomIn());
    root.querySelector("#term-zoom-out")?.addEventListener("click", () => terminalView?.zoomOut());
    latestButton = root.querySelector<HTMLButtonElement>("#term-latest");
    latestButton?.addEventListener("click", () => {
      terminalView?.scrollToLatest();
      if (latestButton) {
        latestButton.hidden = true;
      }
    });
    const bar = root.querySelector<HTMLElement>("#keybar");
    if (bar) {
      renderKeyBar(bar, (def) => callbacks.onKeyPress(def));
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
  };

  const stopStore = store.subscribe(() => {
    if (route === "sessions") {
      const slot = root.querySelector<HTMLElement>("#session-list");
      if (slot) {
        renderSessionsList(slot);
      }
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
    setConnectionState(state: string): void {
      connectionState = state;
      if (route === "sessions" || route === "session") {
        // Never a full re-render here: it would drop the terminal and
        // the composer's draft. Only the header and the banner carry the
        // state, so patch them in place.
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
      terminalView = new TerminalView(terminalFactory, {
        onUserInput: (text) => callbacks.onTerminalInput(text),
        onFollowChange: ({ following }) => {
          if (latestButton) {
            latestButton.hidden = following;
          }
        },
      });
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
      closeSheets();
      teardownSessionWidgets();
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
