// SPDX-License-Identifier: Apache-2.0
// Browser entry point: device key, relay socket, pair form, and the
// reconnecting session connection. Joined snapshots and other protocol
// frames are delivered as `canopy:snapshot` / `canopy:frame` window events
// for the session layer.

import { createChannelHandler } from "./channel.js";
import { generateDeviceKey } from "./crypto.js";
import type { DeviceKey } from "./crypto.js";
import { runPairing } from "./pairing.js";
import { ConnectionManager } from "./reconnect.js";
import { RelaySocket, defaultRelayUrl, parseHostsList } from "./relay.js";
import type { OnlineHost } from "./relay.js";
import { getHost, listHosts, loadDeviceKey, saveDeviceKey, saveHost } from "./store.js";
import type { HostRecord } from "./store.js";
import { consumePairFragment, createApp } from "./ui.js";
import type { PairSubmit } from "./ui.js";

async function ensureDeviceKey(): Promise<DeviceKey> {
  const existing = await loadDeviceKey();
  if (existing) {
    return existing;
  }
  const fresh = await generateDeviceKey();
  await saveDeviceKey(fresh);
  return fresh;
}

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Missing #app element");
  }
  const prefill = consumePairFragment();
  const device = await ensureDeviceKey();

  const relay = new RelaySocket(defaultRelayUrl());
  let onlineHosts: OnlineHost[] = [];
  let manager: ConnectionManager | null = null;

  const ui = createApp(root, {
    onPair: (submit) => void doPair(submit),
    onConnect: (hostId) => void doConnect(hostId),
    onDisconnect: () => {
      manager?.stop();
      manager = null;
      ui.showHosts();
    },
    onRetry: () => manager?.retryNow(),
    onPairAgain: () => {
      manager?.stop();
      manager = null;
      ui.showPair();
    },
  });

  const refreshPaired = async () => {
    ui.setPairedHosts(await listHosts());
  };

  async function doPair(submit: PairSubmit): Promise<void> {
    ui.setPairBusy(true);
    ui.setPairError(null);
    try {
      await relay.connect();
    } catch {
      ui.setPairBusy(false);
      ui.setPairError("Could not reach the relay");
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
      ui.setPairError(err instanceof Error ? err.message : "Pairing failed");
    } finally {
      ui.setPairBusy(false);
    }
  }

  async function doConnect(hostId: string): Promise<void> {
    const host = await getHost(hostId);
    if (!host) {
      await refreshPaired();
      ui.showHosts();
      return;
    }
    startSession(host);
  }

  function startSession(host: HostRecord): void {
    manager?.stop();
    ui.showSession(host.label);
    const frames = createChannelHandler({
      onSnapshot: (snapshot) => {
        globalThis.dispatchEvent(new CustomEvent("canopy:snapshot", { detail: snapshot }));
      },
      onFrame: (frame) => {
        globalThis.dispatchEvent(new CustomEvent("canopy:frame", { detail: frame }));
      },
    });
    const next = new ConnectionManager({ relay, host, device });
    manager = next;
    next.onState((state) => ui.setConnectionState(state));
    next.onMessage((data) => frames.push(data));
    next.start();
  }

  relay.onFrame((frame) => {
    if (frame.from !== "relay") {
      return;
    }
    const hosts = parseHostsList(frame.body);
    if (hosts) {
      onlineHosts = hosts;
      ui.setOnlineHosts(hosts);
    }
  });

  await refreshPaired();
  if (prefill !== null) {
    ui.showPair(prefill);
  } else if ((await listHosts()).length > 0) {
    ui.showHosts();
  } else {
    ui.showPair();
  }

  try {
    await relay.connect();
  } catch {
    ui.setPairError("Could not reach the relay");
  }
}

main().catch((err: unknown) => {
  const root = document.getElementById("app");
  if (root) {
    root.textContent = err instanceof Error ? err.message : "Could not start the app";
  }
});
