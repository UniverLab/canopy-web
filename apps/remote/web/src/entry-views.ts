// SPDX-License-Identifier: Apache-2.0
// The screens a visitor meets before a terminal exists: Sign in, Pair and
// Choose a host. Each owns its markup and its wiring; the shell owns the
// route and the state, and lends these views one accessor per field they
// paint or change. A pairing complaint and a changed host list repaint
// from the shell, so the views never render themselves.

import { renderHostOptions } from "./chrome.js";
import { REMOTE_FOOTER } from "./footer.js";
import type { OnlineHost } from "./relay.js";
import type { PairSubmit } from "./ui.js";

/** The pair form's three fields, as the shell keeps them between repaints. */
export interface PairDraft {
  code: string;
  hostId: string;
  label: string;
}

/** What these views read from the shell, and the two changes they ask for. */
export interface EntryViewHooks {
  /** The shell's topbar markup; the screens ride below it. */
  header: () => string;
  online: () => OnlineHost[];
  paired: () => { host_id: string; label: string }[];
  /** The draft the fields should carry when the form paints. */
  draft: () => PairDraft;
  /** Save the form's live field values into the shell's draft. */
  snapshotDraft: () => void;
  pairError: () => string | null;
  pairBusy: () => boolean;
  /** A complaint about the form; the shell shows it on the next paint. */
  setPairError: (message: string | null) => void;
  /** The form is valid: the shell clears the error and pairs. */
  onPair: (submit: PairSubmit) => void;
  onConnect: (hostId: string) => void;
  onPairAgain: () => void;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderSignIn(root: HTMLElement, hooks: EntryViewHooks): void {
  root.innerHTML = `
    ${hooks.header()}
    <main class="signin">
      <h1>Canopy remote</h1>
      <p>Sign in with GitHub to reach your hosts.</p>
      <button type="button" class="primary" id="signin-go">Sign in with GitHub</button>
      <p>Signing in shares your GitHub username and numeric id with this relay, kept in a 12-hour session cookie. Your sessions travel encrypted between your browser and your machine. <a href="https://univerlab.org/privacy/">Privacy</a></p>
    </main>
    ${REMOTE_FOOTER}`;
  root.querySelector("#signin-go")?.addEventListener("click", () => {
    globalThis.location.href = "/auth/login";
  });
}

export function renderPair(root: HTMLElement, hooks: EntryViewHooks): void {
  const draft = hooks.draft();
  const online = hooks.online();
  const busy = hooks.pairBusy();
  const error = hooks.pairError();
  root.innerHTML = `
    ${hooks.header()}
    <main class="pair">
      <h2>Pair this browser</h2>
      <p>Enter the pairing code shown by canopy.</p>
      <form id="pair-form">
        <label>Pairing code
          <input id="pair-code" name="code" autocomplete="off" autocapitalize="characters"
            spellcheck="false" value="${esc(draft.code)}"${busy ? " disabled" : ""}>
        </label>
        <label>Host
          <select id="pair-host" name="host"${busy || online.length === 0 ? " disabled" : ""}>
            ${renderHostOptions(online, draft.hostId)}
          </select>
        </label>
        <label>Device label
          <input id="pair-label" name="label" autocomplete="off" value="${esc(draft.label)}"${busy ? " disabled" : ""}>
        </label>
        <p id="pair-error" role="alert">${error === null ? "" : esc(error)}</p>
        <button type="submit"${busy ? " disabled" : ""}>${busy ? "Pairing…" : "Pair"}</button>
      </form>
    </main>
    ${REMOTE_FOOTER}`;
  root.querySelector<HTMLFormElement>("#pair-form")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    hooks.snapshotDraft();
    const live = hooks.draft();
    if (online.length === 0 || live.hostId === "") {
      hooks.setPairError(online.length === 0 ? "No hosts online" : "Choose a host");
      return;
    }
    if (live.code.trim() === "") {
      hooks.setPairError("Enter the pairing code");
      return;
    }
    hooks.onPair({ hostId: live.hostId, code: live.code, label: live.label });
  });
}

export function renderHosts(root: HTMLElement, hooks: EntryViewHooks): void {
  const rows = hooks
    .paired()
    .map(
      (host) => `<li><span>${esc(host.label)}</span>
          <button type="button" data-connect="${esc(host.host_id)}">Connect</button></li>`,
    )
    .join("");
  root.innerHTML = `
    ${hooks.header()}
    <main class="hosts">
      <h2>Choose a host</h2>
      <ul id="host-list">${rows}</ul>
      <p><button type="button" id="pair-new">Pair a new host</button></p>
    </main>
    ${REMOTE_FOOTER}`;
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-connect]")) {
    button.addEventListener("click", () => {
      const hostId = button.getAttribute("data-connect");
      if (hostId) {
        hooks.onConnect(hostId);
      }
    });
  }
  root.querySelector("#pair-new")?.addEventListener("click", () => hooks.onPairAgain());
}
