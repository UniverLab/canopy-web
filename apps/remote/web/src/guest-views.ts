// SPDX-License-Identifier: Apache-2.0
// The guest screens behind a /g/ link: the sign-in gate, the shared
// session list, one read-only session, and the connecting and
// unauthorized states. Same markup classes as the owner shell, so the
// guest list is the owner list minus the New button; no pairing, no
// picker, no composer, no input of any kind.

import { renderTopbar, wireAccount } from "./chrome.js";
import { renderSessions, SessionStore } from "./sessions.js";
import { renderColophon } from "../../../../packages/look/colophon/footer.js";

export interface GuestViewCallbacks {
  onOpenSession: (id: string) => void;
  onLeaveSession: () => void;
  onRetry: () => void;
  onSignOut: () => void;
  onForgetDevice: () => void;
}

export interface GuestView {
  showSignIn: () => void;
  showInvalidLink: () => void;
  showConnecting: () => void;
  showForbidden: (message: string) => void;
  showList: (notice?: string | null) => void;
  showSession: (id: string, name: string) => void;
  appendOutput: (text: string) => void;
  clearOutput: () => void;
  setSessionStatus: (status: string | null) => void;
  setConnectionState: (state: string) => void;
  setLogin: (login: string | null) => void;
  setSignOutError: (message: string | null) => void;
}

type GuestRoute = "signin" | "invalid" | "connecting" | "forbidden" | "list" | "session";

// The colophon rides the guest entry screens, as on the owner's.
const COLOPHON = renderColophon({
  product: "Canopy remote",
  exp: "EXP-001",
  links: [
    { label: "Canopy", href: "https://univerlab.org/canopy/" },
    { label: "univerlab.org", href: "https://univerlab.org/" },
    { label: "Source", href: "https://github.com/UniverLab/canopy-web" },
  ],
});

// Control sequences a read-only <pre> cannot draw: CSI, OSC and the two
// short forms. Anything left is printable text. The controls below are
// the pattern's whole purpose, not a mistake.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b./g;

/** Most output the read-only session keeps; older lines fall away. */
const MAX_OUTPUT_CHARS = 262144;

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Visible text of terminal output: no escape sequences, no bare returns. */
export function guestOutputText(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function createGuestView(
  root: HTMLElement,
  store: SessionStore,
  callbacks: GuestViewCallbacks,
): GuestView {
  let route: GuestRoute = "connecting";
  let login: string | null = null;
  let connectionState = "connecting";
  let signOutError: string | null = null;
  let accountOpen = false;
  let forbiddenMessage = "";
  let listNotice: string | null = null;
  let sessionId = "";
  let sessionName = "";
  let sessionStatus: string | null = null;
  let output = "";

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

  function paintSignIn(invalid: boolean): void {
    route = invalid ? "invalid" : "signin";
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
    ${COLOPHON}`;
    wireChrome();
    root.querySelector("#signin-go")?.addEventListener("click", () => {
      globalThis.location.href = "/auth/login";
    });
  }

  function paintConnecting(): void {
    route = "connecting";
    const failed = connectionState.startsWith("failed:");
    root.innerHTML = `
    ${header()}
    <main class="sessions">
      <p class="conn-banner" role="status">${esc(connectionState)} ${
        failed ? `<button type="button" id="guest-retry">Retry</button>` : ""
      }</p>
    </main>`;
    wireChrome();
    root.querySelector("#guest-retry")?.addEventListener("click", () => callbacks.onRetry());
  }

  function paintForbidden(): void {
    route = "forbidden";
    root.innerHTML = `
    ${header()}
    <main class="signin">
      <h1>Not shared</h1>
      <p role="alert">${esc(forbiddenMessage)}</p>
      <p>Ask the owner to share this host with your GitHub user.</p>
    </main>
    ${COLOPHON}`;
    wireChrome();
  }

  function paintList(): void {
    route = "list";
    const banner =
      listNotice === null
        ? ""
        : `<p class="signout-error" id="guest-notice" role="alert">${esc(listNotice)}</p>`;
    root.innerHTML = `${header()}<main class="sessions">${banner}<div id="guest-list"></div></main>`;
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
    const status =
      sessionStatus === null ? "" : `<p class="empty" id="guest-status">${esc(sessionStatus)}</p>`;
    root.innerHTML = `
    ${header()}
    <main class="session-view">
      <div class="session-bar">
        <button type="button" id="session-back" aria-label="Back to sessions">←</button>
        <span class="session-title">${esc(sessionName || sessionId)}</span>
      </div>
      <div class="term-pane"><pre id="guest-output" aria-live="off"></pre></div>
      ${status}
    </main>`;
    wireChrome();
    root.querySelector("#session-back")?.addEventListener("click", () => callbacks.onLeaveSession());
    const out = root.querySelector("#guest-output");
    if (out) {
      out.textContent = output;
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
      sessionStatus = "Attaching…";
      output = "";
      paintSession();
    },
    clearOutput: () => {
      output = "";
      const out = root.querySelector("#guest-output");
      if (out) {
        out.textContent = "";
      }
    },
    appendOutput: (text: string) => {
      if (route !== "session") {
        return;
      }
      output = (output + guestOutputText(text)).slice(-MAX_OUTPUT_CHARS);
      const out = root.querySelector("#guest-output");
      if (out) {
        out.textContent = output;
        const pane = out.closest(".term-pane");
        if (pane) {
          pane.scrollTop = pane.scrollHeight;
        }
      }
    },
    setSessionStatus: (status: string | null) => {
      sessionStatus = status;
      if (route === "session") {
        paintSession();
      }
    },
    setConnectionState: (state: string) => {
      connectionState = state;
      repaint();
    },
    setLogin: (name: string | null) => {
      login = name;
      repaint();
    },
    setSignOutError: (message: string | null) => {
      signOutError = message;
      repaint();
    },
  };
}
