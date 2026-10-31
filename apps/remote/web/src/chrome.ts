// SPDX-License-Identifier: Apache-2.0
// The app chrome: the sticky topbar (banner home, account menu and host
// chip), the connection banner, the pair form's host options,
// and the sign-out controls — the header account menu on every signed-in
// route, plus a direct button on every signed-in route except the session
// view, which keeps the whole viewport for the terminal. The shell owns
// the state; this module only paints and wires it.

import { icon, type RemoteIconName } from "./icons-dom.js";
import { connectFailMessage } from "./peer.js";
import type { OnlineHost } from "./relay.js";
import { REMOTE_BANNER_LINES, bannerSvg } from "../../../../packages/look/banner/banner.js";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** What the topbar paints: the identity, the link, the sign-out state. */
export interface TopbarState {
  login: string | null;
  hostLabel: string;
  connectionState: string;
  /** The host chip's link icon: wifi while connected, wifiOff otherwise. */
  link: RemoteIconName;
  signOutError: string | null;
  accountOpen: boolean;
  /** The host-metrics strip markup; "" until the first frame lands. */
  metricsStrip?: string;
}

/** The Forget confirmation: keys go, pairing goes, the sign-out follows. */
export const FORGET_MESSAGE =
  "Forget this device? This removes the pairing keys from this browser and signs you out.";

/** A sign-out failure, inline where the control sits; empty hides it. */
export function signOutErrorHtml(error: string | null, id: string): string {
  return `<p class="signout-error" id="${id}" role="alert">${error === null ? "" : esc(error)}</p>`;
}

/** The direct control with the signed-in login, and its inline error. */
export function signOutButtonHtml(login: string | null, error: string | null): string {
  const who = login === null ? "" : ` ${esc(login)}`;
  return (
    `<p><button type="button" id="signout">${icon("logOut")}<span>Sign out${who}</span></button></p>` +
    signOutErrorHtml(error, "signout-error")
  );
}

function accountHtml(login: string, signOutError: string | null, open: boolean): string {
  return (
    `<details class="account" id="account"${open || signOutError !== null ? " open" : ""}>` +
    `<summary class="login chip" aria-label="Account ${esc(login)}">${esc(login)}</summary>` +
    `<div class="account-menu">` +
    `<p class="account-name">${esc(login)}</p>` +
    `<button type="button" id="signout-menu">${icon("logOut")}<span>Sign out</span></button>` +
    `<button type="button" id="forget-menu"><span>Forget this device</span></button>` +
    signOutErrorHtml(signOutError, "signout-error-menu") +
    `</div></details>`
  );
}

// The remote's own art only: `renderHeaderBanner(app)` also carries graphs.
export function renderTopbar(state: TopbarState): string {
  const host =
    state.hostLabel === ""
      ? ""
      : `<span class="host chip">` +
        `<span class="icon-slot" id="conn-icon" data-morph="host" aria-hidden="true">${icon(state.link)}</span>` +
        `${esc(state.hostLabel)}</span>`;
  return (
    `<header class="topbar" data-conn="${esc(state.connectionState)}">` +
    `<div class="topbar-inner">` +
    `<button type="button" id="brand-home" class="brand-home" aria-label="Canopy remote, home">${bannerSvg(REMOTE_BANNER_LINES, "look-banner-header look-banner-header-remote", "Canopy remote")}</button>` +
    (state.login === null ? "" : accountHtml(state.login, state.signOutError, state.accountOpen)) +
    host +
    (state.metricsStrip ?? "") +
    `</div></header>`
  );
}

export function renderConnBanner(connectionState: string): string {
  const failed = connectionState.startsWith("failed:");
  const unpaired = connectionState === `failed: ${connectFailMessage("unknown_device")}`;
  if (!failed && !connectionState.startsWith("retrying")) {
    return "";
  }
  return (
    `<p class="conn-banner" role="status">${esc(connectionState)} ` +
    (failed ? `<button type="button" id="conn-retry">Retry</button> ` : "") +
    (unpaired ? `<button type="button" id="conn-pair-again">Pair again</button>` : "") +
    `</p>`
  );
}

export function wireConnActions(
  root: HTMLElement,
  callbacks: { onRetry: () => void; onPairAgain: () => void },
): void {
  root.querySelector("#conn-retry")?.addEventListener("click", () => callbacks.onRetry());
  root.querySelector("#conn-pair-again")?.addEventListener("click", () => callbacks.onPairAgain());
}

export function renderHostOptions(online: OnlineHost[], draftHostId: string): string {
  if (online.length === 0) {
    return `<option value="" selected>No hosts online</option>`;
  }
  if (online.length === 1 && online[0]) {
    return `<option value="${esc(online[0].host_id)}" selected>${esc(online[0].label)}</option>`;
  }
  const options = online.map(
    (host) =>
      `<option value="${esc(host.host_id)}"${host.host_id === draftHostId ? " selected" : ""}>${esc(host.label)}</option>`,
  );
  const placeholder = draftHostId === "" ? " selected" : "";
  return [`<option value=""${placeholder}>Choose a host…</option>`, ...options].join("");
}

/** Wire the account menu and the direct button, wherever they rendered. */
export function wireAccount(
  root: HTMLElement,
  callbacks: { onSignOut: () => void; onForget: () => void; onToggle: (open: boolean) => void },
): void {
  const details = root.querySelector("#account");
  details?.addEventListener("toggle", () => {
    callbacks.onToggle((details as HTMLDetailsElement).open);
  });
  root.querySelector("#signout-menu")?.addEventListener("click", () => callbacks.onSignOut());
  root.querySelector("#signout")?.addEventListener("click", () => callbacks.onSignOut());
  root.querySelector("#forget-menu")?.addEventListener("click", () => {
    if (globalThis.confirm(FORGET_MESSAGE)) {
      callbacks.onForget();
    }
  });
}
