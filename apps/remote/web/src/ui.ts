// SPDX-License-Identifier: Apache-2.0
// Pair form, host picker, and connection state. Vanilla DOM, no framework.

import { defaultDeviceLabel } from "./pairing.js";
import { connectFailMessage } from "./peer.js";
import type { OnlineHost } from "./relay.js";
import type { HostRecord } from "./store.js";

export interface PairSubmit {
  hostId: string;
  code: string;
  label: string;
}

export interface UiCallbacks {
  onPair: (submit: PairSubmit) => void;
  onConnect: (hostId: string) => void;
  onRetry: () => void;
  onPairAgain: () => void;
}

export interface AppUi {
  setOnlineHosts: (hosts: OnlineHost[]) => void;
  setPairedHosts: (hosts: HostRecord[]) => void;
  showPair: (prefillCode?: string) => void;
  showHosts: () => void;
  showSession: (hostLabel: string) => void;
  setPairError: (message: string | null) => void;
  setPairBusy: (busy: boolean) => void;
  setConnectionState: (state: string) => void;
}

// `/pair#<code>`: take the code from the fragment, then remove the fragment
// at once so the code never lingers in the URL.
export function consumePairFragment(): string | null {
  const hash = globalThis.location.hash;
  if (!hash || hash.length < 2) {
    return null;
  }
  const raw = hash.slice(1);
  globalThis.history.replaceState(
    null,
    "",
    globalThis.location.pathname + globalThis.location.search,
  );
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type View = "pair" | "hosts" | "session";

interface PairDraft {
  code: string;
  hostId: string;
  label: string;
}

export function createApp(root: HTMLElement, callbacks: UiCallbacks): AppUi {
  let view: View = "pair";
  let online: OnlineHost[] = [];
  let paired: HostRecord[] = [];
  let draft: PairDraft = { code: "", hostId: "", label: "" };
  let pairError: string | null = null;
  let pairBusy = false;
  let sessionLabel = "";
  let connectionState = "connecting";

  const snapshotDraft = () => {
    const code = root.querySelector<HTMLInputElement>("#pair-code");
    const host = root.querySelector<HTMLSelectElement>("#pair-host");
    const label = root.querySelector<HTMLInputElement>("#pair-label");
    if (code) {
      draft = { code: code.value, hostId: host?.value ?? "", label: label?.value ?? "" };
    }
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

  const renderPair = (): string => `
    <h1>Pair this browser</h1>
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
    <p><a href="/auth/login">Sign in with GitHub</a></p>`;

  const renderHosts = (): string => {
    const rows = paired
      .map(
        (host) => `<li><span>${esc(host.label)}</span>
          <button type="button" data-connect="${esc(host.host_id)}">Connect</button></li>`,
      )
      .join("");
    return `
    <h1>Canopy remote</h1>
    <ul id="host-list">${rows}</ul>
    <p><button type="button" id="pair-new">Pair a new host</button></p>`;
  };

  const renderSession = (): string => {
    const failed = connectionState.startsWith("failed:");
    const unpaired = connectionState === `failed: ${connectFailMessage("unknown_device")}`;
    const actions =
      (failed ? `<button type="button" id="conn-retry">Retry</button> ` : "") +
      (unpaired ? `<button type="button" id="conn-pair-again">Pair again</button> ` : "");
    return `
    <h1>${esc(sessionLabel)}</h1>
    <p id="conn-state" role="status">${esc(connectionState)}</p>
    <p>The session view arrives with the next update.</p>
    ${actions === "" ? "" : `<p>${actions}</p>`}`;
  };

  const render = () => {
    if (view === "pair") {
      root.innerHTML = renderPair();
      const form = root.querySelector<HTMLFormElement>("#pair-form");
      form?.addEventListener("submit", (ev) => {
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
      return;
    }
    if (view === "hosts") {
      root.innerHTML = renderHosts();
      for (const button of root.querySelectorAll<HTMLButtonElement>("[data-connect]")) {
        button.addEventListener("click", () => {
          const hostId = button.getAttribute("data-connect");
          if (hostId) {
            callbacks.onConnect(hostId);
          }
        });
      }
      root.querySelector("#pair-new")?.addEventListener("click", () => callbacks.onPairAgain());
      return;
    }
    root.innerHTML = renderSession();
    root.querySelector("#conn-retry")?.addEventListener("click", () => callbacks.onRetry());
    root.querySelector("#conn-pair-again")?.addEventListener("click", () => callbacks.onPairAgain());
  };

  return {
    setOnlineHosts(hosts: OnlineHost[]): void {
      online = hosts;
      if (view === "pair") {
        snapshotDraft();
        if (online.length === 1 && online[0] && draft.hostId === "") {
          draft.hostId = online[0].host_id;
        }
        render();
      }
    },
    setPairedHosts(hosts: HostRecord[]): void {
      paired = hosts;
      if (view === "hosts") {
        render();
      }
    },
    showPair(prefillCode?: string): void {
      view = "pair";
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
      view = "hosts";
      render();
    },
    showSession(hostLabel: string): void {
      view = "session";
      sessionLabel = hostLabel;
      connectionState = "connecting";
      render();
    },
    setPairError(message: string | null): void {
      pairError = message;
      if (view === "pair") {
        snapshotDraft();
        render();
      }
    },
    setPairBusy(busy: boolean): void {
      pairBusy = busy;
      if (view === "pair") {
        snapshotDraft();
        render();
      }
    },
    setConnectionState(state: string): void {
      connectionState = state;
      if (view === "session") {
        render();
      }
    },
  };
}
