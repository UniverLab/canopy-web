// SPDX-License-Identifier: Apache-2.0
// Browser entry point: auth check, device key, relay socket, pairing,
// and the reconnecting host connection behind the session shell. Joined
// snapshots feed the open session; every other protocol frame is routed
// to the session store, the catalog cache, a sheet, or the composer.

import { createShell } from "./app.js";
import type { Shell } from "./app.js";
import { CatalogStore } from "./catalog.js";
import { createChannelHandler } from "./channel.js";
import { generateDeviceKey } from "./crypto.js";
import type { DeviceKey } from "./crypto.js";
import { GraphStore } from "./graph-store.js";
import { mountCanopyBackground } from "../../../../packages/look/fondo/index.js";
import { buildCatalog, buildCompose, buildList, buildSpawn, newReqId } from "./protocol.js";
import { runPairing } from "./pairing.js";
import { ConnectionManager } from "./reconnect.js";
import { RelaySocket, defaultRelayUrl, parseHostsList } from "./relay.js";
import { createFrameRouter } from "./router.js";
import type { OnlineHost } from "./relay.js";
import { SessionController } from "./session.js";
import { ShelfController } from "./shelf-controller.js";
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
  // The live honeycomb behind the page, from the shared look kit.
  const fondo = document.getElementById("fondo");
  if (fondo) {
    mountCanopyBackground(fondo, "/look/fondo/assets/");
  }
  const prefill = consumePairFragment();
  const login = await fetchLogin();

  const relay = new RelaySocket(defaultRelayUrl());
  const store = new SessionStore();
  const catalog = new CatalogStore();
  let onlineHosts: OnlineHost[] = [];
  let manager: ConnectionManager | null = null;
  // The shelf speaks only while the host's hello carries "shelf".
  const shelf = new ShelfController({
    send: (data) => manager?.send(data) ?? false,
    sessions: store,
  });
  // The watched graphs: the list the Graphs tab polls and the one open
  // graph's state, through the same connection.
  const graphs = new GraphStore({ send: (data) => manager?.send(data) ?? false });

  const shell: Shell = createShell(
    root,
    store,
    {
      onPair: (submit) => void doPair(submit),
      onConnect: (hostId) => void doConnect(hostId),
      onDisconnect: () => void doDisconnect(),
      onRetry: () => manager?.retryNow(),
      onPairAgain: () => {
        catalog.clear();
        manager?.stop();
        manager = null;
        graphs.reset();
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
      onKeyPress: (bytes) => {
        controller.sendInputBytes(bytes);
      },
      onTerminalInput: (bytes) => {
        controller.sendInputBytes(bytes);
      },
      onComposerSend: (text, req) => {
        if (!controller.sendPrompt(text, req)) {
          shell.composerError("Not connected", req);
        }
      },
      onSpawn: (spawn, req) => manager?.send(buildSpawn(req, spawn)) ?? false,
      onCompose: (draft, req) => manager?.send(buildCompose(req, draft)) ?? false,
      onSendDraft: (draft, req) => controller.sendPromptDraft(draft, req),
      onGraphsRequest: () => {
        graphs.requestList();
      },
      onWatchGraph: (id) => {
        graphs.watch(id);
      },
      onUnwatchGraph: () => {
        graphs.unwatch();
      },
    },
    { catalog, shelf, graphs },
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

  const router = createFrameRouter({ store, controller, shell, catalog, shelf, graphs });

  function startSession(host: HostRecord): void {
    // Detach while the old connection is still open so the host sees it.
    controller.close();
    manager?.stop();
    catalog.clear();
    shelf.reset();
    graphs.reset();
    shell.setHostLabel(host.label);
    shell.setHostId(host.host_id);
    shell.showSessions();
    const frames = createChannelHandler({
      onSnapshot: router.handleSnapshot,
      onFrame: router.handleFrame,
    });
    const next = new ConnectionManager({ relay, host, device });
    manager = next;
    next.onState((state) => {
      shell.setConnectionState(state);
      if (state === "connected") {
        // A fresh connect and a reconnect both land here: refresh the
        // catalog and the list, and the open session re-attaches for a
        // fresh snapshot. An open graph watch re-sends too — the host
        // lost the subscription with the old connection.
        next.send(buildCatalog(newReqId()));
        next.send(buildList(newReqId()));
        controller.reattach();
        graphs.rewatch();
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
    // Detach while the connection is still open so the host sees it.
    controller.close();
    manager?.stop();
    manager = null;
    catalog.clear();
    shelf.reset();
    graphs.reset();
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
