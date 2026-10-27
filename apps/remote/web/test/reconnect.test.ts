// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDeviceKey } from "../src/crypto.js";
import type { DeviceKey } from "../src/crypto.js";
import { ConnectionManager, documentVisibility } from "../src/reconnect.js";
import {
  createPeerHarness,
  createRelayHarness,
  createTestHost,
  createTurnFetcher,
  createVisibilityHarness,
  signTestAnswer,
} from "./fakes.js";
import type { PeerHarness, RelayHarness, TestHost, VisibilityHarness } from "./fakes.js";

const ANSWER_SDP = "v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\n";

// Real clock and delay, captured before any test fakes the timers. The waits
// below are bounded by real time (WebCrypto runs on the threadpool, so a
// fixed number of fake-clock pumps flakes under parallel load) while the
// fake clock itself only advances via explicit `advanceTimersByTime` calls.
const realSetTimeout = globalThis.setTimeout;
const realDateNow = Date.now;
const WAIT_MS = 4000;

const realDelay = () =>
  new Promise<void>((resolve) => {
    realSetTimeout(resolve, 0);
  });

async function pump(): Promise<void> {
  await realDelay();
  await vi.advanceTimersByTimeAsync(0);
}

interface ManagerSetup {
  relayHarness: RelayHarness;
  peerHarness: PeerHarness;
  visibility: VisibilityHarness;
  device: DeviceKey;
  host: TestHost;
  states: string[];
  manager: ConnectionManager;
}

let active: ManagerSetup | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  active?.manager.stop();
  active = null;
  vi.useRealTimers();
});

async function createManager(): Promise<ManagerSetup> {
  const relayHarness = createRelayHarness();
  const peerHarness = createPeerHarness();
  const turn = createTurnFetcher();
  const visibility = createVisibilityHarness(true);
  const device = await generateDeviceKey();
  const host = await createTestHost("canopy");
  const states: string[] = [];
  const manager = new ConnectionManager({
    relay: relayHarness.relay,
    host: host.record,
    device,
    fetchTurn: turn.fetchTurn,
    createConnection: peerHarness.factory,
    visibility: visibility.visibility,
  });
  manager.onState((state) => states.push(state));
  active = { relayHarness, peerHarness, visibility, device, host, states, manager };
  return active;
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function offerCount(setup: ManagerSetup): number {
  return setup.relayHarness.sockets
    .flatMap((socket) => socket.envelopes())
    .filter((e) => e.body.t === "offer").length;
}

async function waitForOffers(setup: ManagerSetup, n: number): Promise<void> {
  const deadline = realDateNow() + WAIT_MS;
  while (offerCount(setup) < n) {
    if (realDateNow() > deadline) {
      throw new Error(`only ${offerCount(setup)} offers sent, wanted ${n}`);
    }
    await pump();
  }
}

async function startAndOffer(setup: ManagerSetup): Promise<void> {
  setup.manager.start();
  await settle(5);
  setup.relayHarness.latest().open();
  await waitForOffers(setup, 1);
}

async function dropChannel(setup: ManagerSetup): Promise<void> {
  setup.peerHarness.latest().firstChannel().close();
  await settle(10);
}

async function completeHandshake(setup: ManagerSetup): Promise<void> {
  const offers = setup.relayHarness.sockets
    .flatMap((socket) => socket.envelopes())
    .filter((e) => e.body.t === "offer");
  const last = offers[offers.length - 1];
  if (!last) {
    throw new Error("no offer to answer");
  }
  const sig = await signTestAnswer(
    setup.host.privateKey,
    setup.device.deviceId,
    (last.body as unknown as { sig: string }).sig,
    ANSWER_SDP,
  );
  setup.relayHarness.latest().receive(`h:${setup.host.record.host_id}`, {
    t: "answer",
    sdp: ANSWER_SDP,
    sig,
  });
  const deadline = realDateNow() + WAIT_MS;
  while (!setup.peerHarness.latest().remoteDescription) {
    if (realDateNow() > deadline) {
      throw new Error("remote description was never set");
    }
    await pump();
  }
  setup.peerHarness.latest().firstChannel().remoteOpen();
  await settle(10);
}

const lastState = (setup: ManagerSetup): string => {
  const state = setup.states[setup.states.length - 1];
  if (state === undefined) {
    throw new Error("no states emitted");
  }
  return state;
};

describe("ConnectionManager", () => {
  it("retries with backoff 1, 2, 4, 8, 16, 30, 30", async () => {
    const setup = await createManager();
    setup.manager.start();
    await settle(5);
    setup.relayHarness.latest().open();
    const delays = [1, 2, 4, 8, 16, 30, 30];
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      await waitForOffers(setup, attempt + 1);
      await dropChannel(setup);
      expect(lastState(setup)).toBe(`retrying in ${delays[attempt]}s`);
      await vi.advanceTimersByTimeAsync((delays[attempt] ?? 30) * 1000);
      expect(lastState(setup)).toBe("connecting");
    }
    await waitForOffers(setup, delays.length + 1);
  });

  it("counts down retrying in Ns each second", async () => {
    const setup = await createManager();
    await startAndOffer(setup);
    await dropChannel(setup);
    expect(lastState(setup)).toBe("retrying in 1s");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForOffers(setup, 2);
    await dropChannel(setup);
    expect(lastState(setup)).toBe("retrying in 2s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastState(setup)).toBe("retrying in 1s");
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastState(setup)).toBe("connecting");
  });

  it("pauses while hidden and retries at once on visible", async () => {
    const setup = await createManager();
    await startAndOffer(setup);
    await dropChannel(setup);
    expect(lastState(setup)).toBe("retrying in 1s");
    setup.visibility.setVisible(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(offerCount(setup)).toBe(1);
    expect(lastState(setup)).toBe("retrying in 1s");
    setup.visibility.setVisible(true);
    expect(lastState(setup)).toBe("connecting");
    await waitForOffers(setup, 2);
  });

  it("waits 5s on ICE disconnected before retrying", async () => {
    const setup = await createManager();
    await startAndOffer(setup);
    await completeHandshake(setup);
    expect(lastState(setup)).toBe("connected");
    setup.peerHarness.latest().setConnectionState("disconnected");
    await vi.advanceTimersByTimeAsync(4999);
    expect(lastState(setup)).toBe("connected");
    await vi.advanceTimersByTimeAsync(1);
    expect(lastState(setup)).toBe("retrying in 1s");
  });

  it("stays connected when ICE recovers within the grace period", async () => {
    const setup = await createManager();
    await startAndOffer(setup);
    await completeHandshake(setup);
    setup.peerHarness.latest().setConnectionState("disconnected");
    await vi.advanceTimersByTimeAsync(4000);
    setup.peerHarness.latest().setConnectionState("connected");
    await vi.advanceTimersByTimeAsync(10000);
    expect(lastState(setup)).toBe("connected");
    expect(offerCount(setup)).toBe(1);
  });

  it("retries on ICE failed during the handshake", async () => {
    const setup = await createManager();
    await startAndOffer(setup);
    setup.peerHarness.latest().setConnectionState("failed");
    await settle(10);
    expect(lastState(setup)).toBe("retrying in 1s");
    await vi.advanceTimersByTimeAsync(1000);
    await waitForOffers(setup, 2);
  });

  it("retries at once on ICE failed", async () => {
    const setup = await createManager();
    await startAndOffer(setup);
    await completeHandshake(setup);
    setup.peerHarness.latest().setConnectionState("failed");
    await settle(5);
    expect(lastState(setup)).toBe("retrying in 1s");
  });

  it.each([
    ["busy", "Too many devices connected"],
    ["unknown_device", "This browser is no longer paired"],
    ["stale", "Clock skew: check this device's time"],
  ])("stops on connect_fail %s without retrying", async (reason, message) => {
    const setup = await createManager();
    await startAndOffer(setup);
    setup.relayHarness.latest().receive(`h:${setup.host.record.host_id}`, {
      t: "connect_fail",
      reason,
    });
    await settle(10);
    expect(lastState(setup)).toBe(`failed: ${message}`);
    await vi.advanceTimersByTimeAsync(60000);
    expect(offerCount(setup)).toBe(1);
  });

  it("retries on demand after a failure", async () => {
    const setup = await createManager();
    await startAndOffer(setup);
    setup.relayHarness.latest().receive(`h:${setup.host.record.host_id}`, {
      t: "connect_fail",
      reason: "busy",
    });
    await settle(10);
    expect(lastState(setup)).toBe("failed: Too many devices connected");
    setup.manager.retryNow();
    expect(lastState(setup)).toBe("connecting");
    await waitForOffers(setup, 2);
  });

  it("stop cancels a pending retry", async () => {
    const setup = await createManager();
    await startAndOffer(setup);
    await dropChannel(setup);
    expect(lastState(setup)).toBe("retrying in 1s");
    setup.manager.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(offerCount(setup)).toBe(1);
  });
});

describe("documentVisibility", () => {
  it("wires the visibilitychange listener", () => {
    const visibility = documentVisibility();
    let calls = 0;
    const stop = visibility.onChange(() => {
      calls += 1;
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toBe(1);
    expect(visibility.isVisible()).toBe(document.visibilityState === "visible");
    stop();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toBe(1);
  });
});
