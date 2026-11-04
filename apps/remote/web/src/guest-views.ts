// SPDX-License-Identifier: Apache-2.0
// The guest screens behind a /g/ link: the sign-in gate, the shared
// session list, one interactive session, and the connecting and
// unauthorized states. Same markup classes as the owner shell, so the
// guest list is the owner list minus the New button and the guest session
// is the owner session minus the builder, the sheets and the Files: the
// terminal and the key bar are the owner's own widgets, sharing the main
// bundle's chunk. No pairing, no picker, no hub-level control of any kind.

import { armSessionHint } from "./auth.js";
import { renderTopbar, wireAccount } from "./chrome.js";
import { syncHeaderFondo } from "./fondo.js";
import { REMOTE_FOOTER } from "./footer.js";
import { renderKeyBar, updateKeyBarLatches } from "./keys.js";
import { keyBytesWithModifiers, ModifierLatches, textBytesWithModifiers } from "./modifiers.js";
import { SessionStore, renderSessions } from "./sessions.js";
import { TerminalView, createXtermHandle } from "./terminal.js";
import type { TerminalFactory } from "./terminal.js";
import { pointerIsFine } from "./terminal-prefs.js";
import { remoteTitle, sessionTitle } from "./titles.js";

export interface GuestViewCallbacks {
  onOpenSession: (id: string) => void;
  onLeaveSession: () => void;
  onRetry: () => void;
  onSignOut: () => void;
  onForgetDevice: () => void;
  /** Terminal and key-bar bytes with the latches applied. */
  onInput: (bytes: Uint8Array) => void;
}

export interface GuestView {
  showSignIn: () => void;
  showInvalidLink: () => void;
  showConnecting: () => void;
  showForbidden: (message: string) => void;
  showList: (notice?: string | null) => void;
  showSession: (id: string, name: string) => void;
  ensureTerminal: (id: string, cols: number, rows: number) => void;
  writeTerminal: (data: Uint8Array) => void;
  clearTerminal: () => void;
  setSessionStatus: (status: string | null) => void;
  setConnectionState: (state: string) => void;
  setLogin: (login: string | null) => void;
  setSignOutError: (message: string | null) => void;
}

export interface GuestViewDeps {
  terminalFactory?: TerminalFactory;
}

type GuestRoute = "signin" | "invalid" | "connecting" | "forbidden" | "list" | "session";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function createGuestView(
  root: HTMLElement,
  store: SessionStore,
  callbacks: GuestViewCallbacks,
  deps?: GuestViewDeps,
): GuestView {
  const terminalFactory = deps?.terminalFactory ?? createXtermHandle;
  let route: GuestRoute = "connecting";
  let login: string | null = null;
  let connectionState = "connecting";
  let signOutError: string | null = null;
  let accountOpen = false;
  let forbiddenMessage = "";
  let listNotice: string | null = null;
  let sessionId = "";
  let sessionName = "";
  let sessionCols = 0;
  let sessionRows = 0;
  let terminalView: TerminalView | null = null;
  const latches = new ModifierLatches();

  function header(): string {
    return renderTopbar({
      login,
      hostLabel: "",
      connectionState,
      link: connectionState === "connected" ? "wifi" : "wifiOff",
      signOutError,
      accountOpen,
    });
  }

  function wireChrome(): void {
    // Every paint above repainted the header with innerHTML, detaching
    // the honeycomb's old host: remount the kit on the fresh one.
    syncHeaderFondo(root);
    root.querySelector("#brand-home")?.addEventListener("click", () => {
      if (route === "session") {
        callbacks.onLeaveSession();
      }
    });
    wireAccount(root, {
      onSignOut: () => callbacks.onSignOut(),
      onForget: () => callbacks.onForgetDevice(),
      onToggle: (open) => {
        accountOpen = open;
      },
    });
  }

  function teardownSessionWidgets(): void {
    terminalView?.dispose();
    terminalView = null;
    sessionCols = 0;
    sessionRows = 0;
  }

  function paintSignIn(invalid: boolean): void {
    route = invalid ? "invalid" : "signin";
    document.title = remoteTitle(invalid ? "Invalid link" : "Sign in");
    teardownSessionWidgets();
    root.innerHTML = `
    ${header()}
    <main class="signin">
      <h1>Canopy remote</h1>
      ${
        invalid
          ? `<p role="alert">This guest link is malformed. Ask the owner for a fresh one.</p>`
          : `<p>Sign in with GitHub to see the sessions shared with you.</p>
      <button type="button" class="primary" id="signin-go">Sign in with GitHub</button>
      <p>Signing in shares your GitHub username and numeric id with this relay, kept in a 12-hour session cookie. <a href="https://univerlab.org/privacy/">Privacy</a></p>`
      }
    </main>
    ${REMOTE_FOOTER}`;
    wireChrome();
    root.querySelector("#signin-go")?.addEventListener("click", () => {
      // Arm the session hint before leaving for /auth/login: the OAuth
      // landing sets the HttpOnly cookie this page cannot see, so the trip
      // back must fetch /auth/me. A cancelled login self-heals — the next
      // 401 clears the hint again.
      armSessionHint();
      globalThis.location.href = "/auth/login";
    });
  }

  function paintConnecting(): void {
    route = "connecting";
    document.title = remoteTitle("Connecting");
    teardownSessionWidgets();
    const failed = connectionState.startsWith("failed:");
    const retrying = connectionState.startsWith("retrying");
    const banner =
      failed || retrying
        ? `<p class="conn-banner" role="status">${esc(connectionState)} ${
            failed ? `<button type="button" id="guest-retry">Retry</button>` : ""
          }</p>`
        : "";
    root.innerHTML = `
    ${header()}
    <main class="sessions">
      ${banner}
    </main>
    ${REMOTE_FOOTER}`;
    wireChrome();
    root.querySelector("#guest-retry")?.addEventListener("click", () => callbacks.onRetry());
  }

  function paintForbidden(): void {
    route = "forbidden";
    document.title = remoteTitle("Not shared");
    teardownSessionWidgets();
    root.innerHTML = `
    ${header()}
    <main class="signin">
      <h1>Not shared</h1>
      <p role="alert">${esc(forbiddenMessage)}</p>
      <p>Ask the owner to share this host with your GitHub user.</p>
    </main>
    ${REMOTE_FOOTER}`;
    wireChrome();
  }

  function paintList(): void {
    route = "list";
    document.title = remoteTitle("Sessions");
    teardownSessionWidgets();
    const banner =
      listNotice === null
        ? ""
        : `<p class="signout-error" id="guest-notice" role="alert">${esc(listNotice)}</p>`;
    root.innerHTML = `${header()}<main class="sessions">${banner}<div id="guest-list"></div></main>${REMOTE_FOOTER}`;
    wireChrome();
    const list = root.querySelector<HTMLElement>("#guest-list");
    if (list) {
      renderSessions(
        list,
        store.list(),
        Date.now(),
        {
          onOpen: (id) => callbacks.onOpenSession(id),
          onNew: () => {},
        },
        undefined,
        store.loaded(),
        true,
      );
    }
  }

  function paintSession(): void {
    route = "session";
    document.title = sessionTitle(sessionName === "" ? sessionId : sessionName);
    teardownSessionWidgets();
    latches.release();
    root.innerHTML = `
    ${header()}
    <main class="session-view">
      <div class="session-bar">
        <button type="button" id="session-back" aria-label="Back to sessions">←</button>
        <span class="session-title">${esc(sessionName || sessionId)}</span>
        <span class="session-exit" id="guest-exit" hidden></span>
      </div>
      <div class="term-pane" id="term-pane">
        <p class="term-placeholder">Attaching…</p>
      </div>
      <div class="keybar" id="keybar"></div>
    </main>
    ${REMOTE_FOOTER}`;
    wireChrome();
    root.querySelector("#session-back")?.addEventListener("click", () => callbacks.onLeaveSession());
    const bar = root.querySelector<HTMLElement>("#keybar");
    if (bar) {
      renderKeyBar(bar, (def) => {
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
        callbacks.onInput(bytes);
      });
    }
  }

  function repaint(): void {
    if (route === "signin" || route === "invalid") {
      paintSignIn(route === "invalid");
    } else if (route === "connecting") {
      paintConnecting();
    } else if (route === "forbidden") {
      paintForbidden();
    } else if (route === "list") {
      paintList();
    } else {
      paintSession();
    }
  }

  // The session route never repaints for chrome state: it would drop
  // the terminal. Only the header carries the state, so patch it in
  // place, exactly as the owner shell does.
  function patchHeader(): void {
    const topbar = root.querySelector(".topbar");
    if (topbar) {
      topbar.setAttribute("data-conn", connectionState);
    }
    const who = root.querySelector(".topbar .login");
    if (who) {
      who.textContent = login ?? "";
    }
    for (const el of root.querySelectorAll<HTMLElement>(".signout-error")) {
      el.textContent = signOutError ?? "";
    }
  }

  store.subscribe(() => {
    if (route === "list") {
      paintList();
    }
  });

  return {
    showSignIn: () => paintSignIn(false),
    showInvalidLink: () => paintSignIn(true),
    showConnecting: () => paintConnecting(),
    showForbidden: (message: string) => {
      forbiddenMessage = message;
      paintForbidden();
    },
    showList: (notice: string | null = null) => {
      listNotice = notice;
      paintList();
    },
    showSession: (id: string, name: string) => {
      sessionId = id;
      sessionName = name;
      paintSession();
    },
    ensureTerminal: (id: string, cols: number, rows: number) => {
      if (route !== "session" || id !== sessionId) {
        return;
      }
      if (terminalView && cols === sessionCols && rows === sessionRows) {
        return;
      }
      // A remount drops only the terminal; the rest of the session
      // route stays painted around it.
      terminalView?.dispose();
      terminalView = null;
      sessionCols = cols;
      sessionRows = rows;
      const pane = root.querySelector<HTMLElement>("#term-pane");
      if (!pane) {
        return;
      }
      pane.replaceChildren();
      terminalView = new TerminalView(terminalFactory, {
        onUserInput: (text) => {
          const bytes = textBytesWithModifiers(text, latches.snapshot());
          if (latches.hasLatch) {
            latches.release();
            const bar = root.querySelector<HTMLElement>("#keybar");
            if (bar) {
              updateKeyBarLatches(bar, latches.snapshot());
            }
          }
          callbacks.onInput(bytes);
        },
      });
      terminalView.mount(pane, cols, rows);
      // As the owner's: a fine pointer takes focus once on attach, after
      // xterm is open; a touch device waits for the first tap instead.
      if (pointerIsFine()) {
        const attached = terminalView;
        void attached.ready().then(() => {
          if (terminalView === attached) {
            attached.focus();
          }
        });
      }
    },
    writeTerminal: (data: Uint8Array) => {
      terminalView?.write(data);
    },
    clearTerminal: () => {
      terminalView?.clear();
    },
    setSessionStatus: (status: string | null) => {
      const badge = root.querySelector<HTMLElement>("#guest-exit");
      if (badge && route === "session") {
        badge.textContent = status ?? "";
        badge.hidden = status === null;
      }
    },
    setConnectionState: (state: string) => {
      connectionState = state;
      if (route === "session") {
        patchHeader();
      } else {
        repaint();
      }
    },
    setLogin: (name: string | null) => {
      login = name;
      if (route === "session") {
        patchHeader();
      } else {
        repaint();
      }
    },
    setSignOutError: (message: string | null) => {
      signOutError = message;
      if (route === "session") {
        patchHeader();
        if (message !== null) {
          // The menu holds the session view's only sign-out control, so a
          // failure opens it rather than hiding its text — as the owner's.
          const details = root.querySelector<HTMLDetailsElement>("#account");
          if (details !== null && !details.open) {
            details.open = true;
          }
        }
      } else {
        repaint();
      }
    },
  };
}
