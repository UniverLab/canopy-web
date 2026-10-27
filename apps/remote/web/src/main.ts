// SPDX-License-Identifier: Apache-2.0
// Browser entry point: auth check, device key, relay socket, pairing,
// and the reconnecting host connection behind the session shell. Joined
// snapshots feed the open session; every other protocol frame is routed
// to the session store, the composer, or the window events the Prompt
// Builder (next spec) listens for.

import { createShell } from "./app.js";
import type { Shell } from "./app.js";
import { createChannelHandler } from "./channel.js";
import type { JoinedSnapshot } from "./channel.js";
import { generateDeviceKey } from "./crypto.js";
import type { DeviceKey } from "./crypto.js";
import { keyBytes } from "./keys.js";
import {
  buildList,
  newReqId,
  parseError,
  parseExited,
  parseOk,
  parseOut,
  parseSessionAdded,
  parseSessionRemoved,
  parseSessions,
} from "./protocol.js";
import { runPairing } from "./pairing.js";
import { ConnectionManager } from "./reconnect.js";
import { RelaySocket, defaultRelayUrl, parseHostsList } from "./relay.js";
import type { OnlineHost } from "./relay.js";
import { SessionController } from "./session.js";
import { SessionStore } from "./sessions.js";
import { getHost, listHosts, loadDeviceKey, saveDeviceKey, saveHost } from "./store.js";
import type { HostRecord } from "./store.js";
import { consumePairFragment } from "./ui.js";
import type { PairSubmit } from "./ui.js";
import "./styles.css";

async function ensureDeviceKey(): Promise<DeviceKey> {
  const existing = await loadDeviceKey();
  if (existing) {
    return existing;
  }
  const fresh = await generateDeviceKey();
  await saveDeviceKey(fresh);
  return fresh;
}

// The worker answers 401 without a session cookie, 200 {login} with one.
async function fetchLogin(): Promise<string | null> {
  let res: Response;
  try {
    res = await globalThis.fetch("/auth/me");
  } catch {
    return null;
  }
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body === "object" && body !== null && typeof (body as { login: unknown }).login === "string") {
    return (body as { login: string }).login;
  }
  return null;
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Missing #app element");
  }
  const prefill = consumePairFragment();
  const login = await fetchLogin();

  const relay = new RelaySocket(defaultRelayUrl());
  const store = new SessionStore();
  let onlineHosts: OnlineHost[] = [];
  let manager: ConnectionManager | null = null;

  const shell: Shell = createShell(
    root,
    store,
    {
      onPair: (submit) => void doPair(submit),
      onConnect: (hostId) => void doConnect(hostId),
      onDisconnect: () => void doDisconnect(),
      onRetry: () => manager?.retryNow(),
      onPairAgain: () => {
        manager?.stop();
        manager = null;
        shell.showPair();
      },
      onOpenSession: (id) => {
        shell.showSession(id, store.get(id)?.name ?? id);
        controller.open(id);
      },
      onLeaveSession: () => {
        controller.close();
        shell.showSessions();
      },
      onKeyPress: (def) => {
        controller.sendInputBytes(keyBytes(def));
      },
      onTerminalInput: (text) => {
        controller.sendInputText(text);
      },
      onComposerSend: (text, req) => {
        if (!controller.sendPrompt(text, req)) {
          shell.composerError("Not connected", req);
        }
      },
      // The New dialog and the Prompt Builder arrive with the next spec;
      // until then the buttons announce themselves on the window.
      onNew: () => {
        globalThis.dispatchEvent(new CustomEvent("canopy:new"));
      },
      onBuilder: () => {
        globalThis.dispatchEvent(new CustomEvent("canopy:builder"));
      },
    },
  );

  const controller = new SessionController({
    send: (data) => manager?.send(data) ?? false,
    terminal: () => ({
      write: (text) => shell.writeTerminal(text),
      clear: () => shell.clearTerminal(),
    }),
    onExited: (_id, code) => shell.showSessionExited(code),
  });

  const refreshPaired = async () => {
    shell.setPairedHosts(await listHosts());
  };

  function handleSnapshot(snapshot: JoinedSnapshot): void {
    globalThis.dispatchEvent(new CustomEvent("canopy:snapshot", { detail: snapshot }));
    shell.ensureTerminal(snapshot.id, snapshot.cols, snapshot.rows);
    controller.handleSnapshot(snapshot);
  }

  function handleFrame(frame: unknown): void {
    globalThis.dispatchEvent(new CustomEvent("canopy:frame", { detail: frame }));
    const sessions = parseSessions(frame);
    if (sessions) {
      store.replace(sessions);
      return;
    }
    const added = parseSessionAdded(frame);
    if (added) {
      store.add(added);
      return;
    }
    const removed = parseSessionRemoved(frame);
    if (removed !== null) {
      store.remove(removed);
      return;
    }
    const exited = parseExited(frame);
    if (exited) {
      store.markExited(exited.id);
      controller.handleExited(exited.id, exited.code);
      return;
    }
    const out = parseOut(frame);
    if (out) {
      controller.handleOut(out);
      return;
    }
    const ok = parseOk(frame);
    if (ok !== null) {
      shell.composerOk(ok);
      return;
    }
    const error = parseError(frame);
    if (error) {
      shell.composerError(error.message, error.req);
    }
  }

  function startSession(host: HostRecord): void {
    manager?.stop();
    controller.close();
    shell.setHostLabel(host.label);
    shell.showSessions();
    const frames = createChannelHandler({
      onSnapshot: handleSnapshot,
      onFrame: handleFrame,
    });
    const next = new ConnectionManager({ relay, host, device });
    manager = next;
    next.onState((state) => {
      shell.setConnectionState(state);
      if (state === "connected") {
        // A fresh connect and a reconnect both land here: refresh the
        // list, and the open session re-attaches for a fresh snapshot.
        next.send(buildList(newReqId()));
        controller.reattach();
      }
    });
    next.onMessage((data) => frames.push(data));
    next.start();
  }

  const device = await ensureDeviceKey();

  async function doPair(submit: PairSubmit): Promise<void> {
    shell.setPairBusy(true);
    shell.setPairError(null);
    try {
      await relay.connect();
    } catch {
      shell.setPairBusy(false);
      shell.setPairError("Could not reach the relay");
      return;
    }
    const picked = onlineHosts.find((host) => host.host_id === submit.hostId);
    const stored = await getHost(submit.hostId);
    const hostLabel = picked?.label ?? stored?.label ?? submit.hostId;
    try {
      const host = await runPairing({
        relay,
        hostId: submit.hostId,
        hostLabel,
        code: submit.code,
        deviceLabel: submit.label,
        device,
        saveHost,
      });
      await refreshPaired();
      startSession(host);
    } catch (err) {
      shell.setPairError(err instanceof Error ? err.message : "Pairing failed");
    } finally {
      shell.setPairBusy(false);
    }
  }

  async function doConnect(hostId: string): Promise<void> {
    const host = await getHost(hostId);
    if (!host) {
      await refreshPaired();
      shell.showHosts();
      return;
    }
    startSession(host);
  }

  async function doDisconnect(): Promise<void> {
    manager?.stop();
    manager = null;
    controller.close();
    const stored = await listHosts();
    await refreshPaired();
    if (stored.length === 0) {
      shell.showPair();
    } else {
      shell.showHosts();
    }
  }

  relay.onFrame((frame) => {
    if (frame.from !== "relay") {
      return;
    }
    const hosts = parseHostsList(frame.body);
    if (hosts) {
      onlineHosts = hosts;
      shell.setOnlineHosts(hosts);
    }
  });

  if (login === null) {
    shell.showSignIn();
    return;
  }
  shell.setLogin(login);
  await refreshPaired();
  const stored = await listHosts();
  if (prefill !== null || stored.length === 0) {
    shell.showPair(prefill ?? undefined);
  } else if (stored.length === 1 && stored[0]) {
    startSession(stored[0]);
  } else {
    shell.showHosts();
  }

  try {
    await relay.connect();
  } catch {
    shell.setPairError("Could not reach the relay");
  }
}

main().catch((err: unknown) => {
  const root = document.getElementById("app");
  if (root) {
    root.textContent = err instanceof Error ? err.message : "Could not start the app";
  }
});
