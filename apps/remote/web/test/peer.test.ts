// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { b64decode, generateDeviceKey, importSpkiVerifyKey } from "../src/crypto.js";
import type { DeviceKey } from "../src/crypto.js";
import { HostPeer } from "../src/peer.js";
import type { PeerEvent } from "../src/peer.js";
import {
  connectRelay,
  createPeerHarness,
  createRelayHarness,
  createTestHost,
  createTurnFetcher,
  flush,
  signTestAnswer,
  waitForSend,
} from "./fakes.js";
import type { FakeWebSocket, PeerHarness, RelayHarness, TestHost } from "./fakes.js";

const ANSWER_SDP = "v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\n";

interface PeerSetup {
  relayHarness: RelayHarness;
  ws: FakeWebSocket;
  peerHarness: PeerHarness;
  device: DeviceKey;
  host: TestHost;
  events: PeerEvent[];
  peer: HostPeer;
}

async function setupPeer(turnOk = true): Promise<PeerSetup> {
  const relayHarness = createRelayHarness();
  const ws = await connectRelay(relayHarness);
  const peerHarness = createPeerHarness();
  const turn = createTurnFetcher(turnOk);
  const device = await generateDeviceKey();
  const host = await createTestHost();
  const events: PeerEvent[] = [];
  const peer = new HostPeer({
    relay: relayHarness.relay,
    host: host.record,
    device,
    fetchTurn: turn.fetchTurn,
    createConnection: peerHarness.factory,
    nowMs: () => 1793100000_000,
  });
  peer.onEvent((ev) => events.push(ev));
  return { relayHarness, ws, peerHarness, device, host, events, peer };
}

function offerBody(setup: PeerSetup): { device_id: string; ts: string; sdp: string; sig: string } {
  const offer = setup.ws.envelopes().find((e) => e.body.t === "offer");
  if (!offer || offer.to !== `h:${setup.host.record.host_id}`) {
    throw new Error("no offer sent to the host");
  }
  return offer.body as unknown as { device_id: string; ts: string; sdp: string; sig: string };
}

async function waitForRemoteDescription(setup: PeerSetup): Promise<void> {
  for (let i = 0; i < 100 && !setup.peerHarness.latest().remoteDescription; i += 1) {
    await flush();
  }
  if (!setup.peerHarness.latest().remoteDescription) {
    throw new Error("remote description was never set");
  }
}

async function answerHandshake(setup: PeerSetup, sdp: string = ANSWER_SDP): Promise<void> {
  const offer = offerBody(setup);
  const sig = await signTestAnswer(
    setup.host.privateKey,
    setup.device.deviceId,
    offer.sig,
    sdp,
  );
  setup.ws.receive(`h:${setup.host.record.host_id}`, { t: "answer", sdp, sig });
  await waitForRemoteDescription(setup);
}

async function setupAndOpen(): Promise<PeerSetup> {
  const setup = await setupPeer();
  const pending = setup.peer.connect();
  await waitForSend(setup.ws);
  await answerHandshake(setup);
  setup.peerHarness.latest().firstChannel().remoteOpen();
  await pending;
  return setup;
}

async function offerSignatureValid(
  device: DeviceKey,
  hostId: string,
  ts: string,
  sdp: string,
  sig: string,
): Promise<boolean> {
  const key = await importSpkiVerifyKey(device.spki);
  return globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new Uint8Array(b64decode(sig)),
    new TextEncoder().encode(`canopy-remote/v1/offer\n${hostId}\n${ts}\n${sdp}`),
  );
}

describe("HostPeer", () => {
  it("sends a signed offer and opens the channel on a valid answer", async () => {
    const setup = await setupPeer();
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);

    const offer = offerBody(setup);
    expect(offer.device_id).toBe(setup.device.deviceId);
    expect(offer.ts).toBe("1793100000");
    expect(offer.sdp).toBe(setup.peerHarness.latest().offerSdp);
    await expect(
      offerSignatureValid(setup.device, setup.host.record.host_id, offer.ts, offer.sdp, offer.sig),
    ).resolves.toBe(true);

    const pc = setup.peerHarness.latest();
    expect(pc.config.iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
    expect(pc.firstChannel().label).toBe("canopy-session-v1");
    expect(pc.firstChannel().ordered).toBe(true);

    // ICE before the answer is queued, not dropped.
    setup.ws.receive(`h:${setup.host.record.host_id}`, {
      t: "ice",
      candidate: { candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 },
    });
    await flush();
    expect(pc.addedCandidates).toHaveLength(0);

    // An answer from another sender is ignored.
    setup.ws.receive("h:other", { t: "answer", sdp: ANSWER_SDP, sig: "bogus" });
    await flush();
    expect(pc.remoteDescription).toBeNull();

    await answerHandshake(setup);
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: ANSWER_SDP });
    expect(pc.addedCandidates).toEqual([
      { candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 },
    ]);

    pc.firstChannel().remoteOpen();
    await pending;
    expect(setup.events).toContainEqual({ type: "open" });

    pc.firstChannel().deliver(`{"t":"out"}`);
    expect(setup.events).toContainEqual({ type: "message", data: `{"t":"out"}` });
  });

  it("refuses a forged answer and closes", async () => {
    const setup = await setupPeer();
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    const offer = offerBody(setup);
    const forged = `${offer.sig.slice(0, -4)}MA==`;
    setup.ws.receive(`h:${setup.host.record.host_id}`, { t: "answer", sdp: ANSWER_SDP, sig: forged });
    await expect(pending).rejects.toThrow("Host identity check failed");
    expect(setup.events).toContainEqual({ type: "failed", reason: "Host identity check failed" });
    expect(setup.peerHarness.latest().closed).toBe(true);
  });

  it.each([
    ["unknown_device", "This browser is no longer paired"],
    ["stale", "Clock skew: check this device's time"],
    ["busy", "Too many devices connected"],
  ])("fails with connect_fail %s", async (reason, message) => {
    const setup = await setupPeer();
    const pending = setup.peer.connect();
    const assertion = expect(pending).rejects.toThrow(message);
    await waitForSend(setup.ws);
    setup.ws.receive(`h:${setup.host.record.host_id}`, { t: "connect_fail", reason });
    await assertion;
    expect(setup.events).toContainEqual({ type: "failed", reason: message });
  });

  it("trickles local candidates", async () => {
    const setup = await setupPeer();
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    setup.peerHarness.latest().emitIceCandidate({ candidate: "c2", sdpMid: "0", sdpMLineIndex: 0 });
    const ice = setup.ws.envelopes().find((e) => e.body.t === "ice");
    expect(ice?.to).toBe(`h:${setup.host.record.host_id}`);
    expect(ice?.body).toEqual({
      t: "ice",
      candidate: { candidate: "c2", sdpMid: "0", sdpMLineIndex: 0 },
    });
    setup.peer.close();
    await expect(pending).rejects.toThrow("Connection closed");
  });

  it("sends bye and closes on close", async () => {
    const setup = await setupAndOpen();
    setup.peer.close();
    const byes = setup.ws.envelopes().filter((e) => e.body.t === "bye");
    expect(byes).toHaveLength(1);
    expect(byes[0]?.to).toBe(`h:${setup.host.record.host_id}`);
    expect(setup.peerHarness.latest().closed).toBe(true);
  });

  it("emits closed when the channel drops", async () => {
    const setup = await setupAndOpen();
    setup.peerHarness.latest().firstChannel().close();
    expect(setup.events).toContainEqual({ type: "closed" });
  });

  it("fails when TURN credentials cannot load", async () => {
    const setup = await setupPeer(false);
    await expect(setup.peer.connect()).rejects.toThrow("Could not load TURN credentials");
  });
});
