// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "../src/crypto.js";
import { ConnectionManager } from "../src/reconnect.js";
import { HostPeer } from "../src/peer.js";
import type { PeerEvent } from "../src/peer.js";
import {
  connectRelay,
  createPeerHarness,
  createRelayHarness,
  createTestHost,
  createTurnFetcher,
  createVisibilityHarness,
  flush,
  signTestAnswer,
  waitForSend,
} from "./fakes.js";

const ANSWER_SDP = "v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\n";

async function openPeer(): Promise<{ peer: HostPeer; sent: () => string[]; stop: () => void }> {
  const relayHarness = createRelayHarness();
  const ws = await connectRelay(relayHarness);
  const peerHarness = createPeerHarness();
  const turn = createTurnFetcher();
  const device = await generateDeviceKey();
  const host = await createTestHost();
  const peer = new HostPeer({
    relay: relayHarness.relay,
    host: host.record,
    device,
    fetchTurn: turn.fetchTurn,
    createConnection: peerHarness.factory,
    nowMs: () => 1793100000_000,
  });
  const pending = peer.connect();
  await waitForSend(ws);
  const offer = ws.envelopes().find((e) => e.body.t === "offer");
  if (!offer) {
    throw new Error("no offer sent");
  }
  const body = offer.body as { sig: string };
  const sig = await signTestAnswer(host.privateKey, device.deviceId, body.sig, ANSWER_SDP);
  ws.receive(`h:${host.record.host_id}`, { t: "answer", sdp: ANSWER_SDP, sig });
  for (let i = 0; i < 100 && !peerHarness.latest().remoteDescription; i += 1) {
    await flush();
  }
  peerHarness.latest().firstChannel().remoteOpen();
  await pending;
  return {
    peer,
    sent: () => peerHarness.latest().firstChannel().sent,
    stop: () => peer.close(),
  };
}

describe("HostPeer.send", () => {
  it("sends on the open data channel", async () => {
    const { peer, sent, stop } = await openPeer();
    try {
      expect(peer.send(`{"t":"list"}`)).toBe(true);
      expect(sent()).toEqual([`{"t":"list"}`]);
    } finally {
      stop();
    }
  });

  it("refuses before open and after close", async () => {
    const relayHarness = createRelayHarness();
    await connectRelay(relayHarness);
    const device = await generateDeviceKey();
    const host = await createTestHost();
    const peer = new HostPeer({
      relay: relayHarness.relay,
      host: host.record,
      device,
      fetchTurn: createTurnFetcher().fetchTurn,
      createConnection: createPeerHarness().factory,
    });
    expect(peer.send("x")).toBe(false);
    peer.close();
    expect(peer.send("x")).toBe(false);
  });
});

class StubPeer {
  readonly sent: string[] = [];
  private readonly handlers = new Set<(ev: PeerEvent) => void>();

  onEvent(handler: (ev: PeerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async connect(): Promise<void> {
    queueMicrotask(() => {
      for (const handler of this.handlers) {
        handler({ type: "open" });
      }
    });
  }

  send(data: string): boolean {
    this.sent.push(data);
    return true;
  }

  close(): void {}
}

describe("ConnectionManager.send", () => {
  it("forwards while open and refuses otherwise", async () => {
    const relayHarness = createRelayHarness();
    const visibility = createVisibilityHarness(true);
    const device = await generateDeviceKey();
    const host = await createTestHost();
    const stub = new StubPeer();
    const manager = new ConnectionManager({
      relay: relayHarness.relay,
      host: host.record,
      device,
      fetchTurn: createTurnFetcher().fetchTurn,
      createConnection: createPeerHarness().factory,
      createPeer: () => stub as unknown as HostPeer,
      visibility: visibility.visibility,
    });
    try {
      expect(manager.connected).toBe(false);
      expect(manager.send("early")).toBe(false);
      manager.start();
      relayHarness.latest().open();
      for (let i = 0; i < 100 && !manager.connected; i += 1) {
        await flush();
      }
      expect(manager.connected).toBe(true);
      expect(manager.send(`{"t":"list"}`)).toBe(true);
      expect(stub.sent).toEqual([`{"t":"list"}`]);
    } finally {
      manager.stop();
    }
  });
});
