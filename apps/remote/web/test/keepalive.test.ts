// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayKeepalive, jitteredBackoffMs } from "../src/keepalive.js";
import { createRelayHarness } from "./fakes.js";
import type { RelayHarness } from "./fakes.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface KeepaliveSetup {
  harness: RelayHarness;
  keepalive: RelayKeepalive;
  advance: (ms: number) => Promise<void>;
  now: () => number;
}

function createSetup(randomValue = 0.5): KeepaliveSetup {
  let now = 0;
  const harness = createRelayHarness();
  const keepalive = new RelayKeepalive({
    relay: harness.relay,
    nowMs: () => now,
    random: () => randomValue,
  });
  keepalive.start();
  return {
    harness,
    keepalive,
    now: () => now,
    advance: async (ms: number) => {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

async function openRelay(setup: KeepaliveSetup): Promise<void> {
  const opened = setup.harness.relay.connect();
  setup.harness.latest().open();
  await opened;
  await vi.advanceTimersByTimeAsync(0);
}

function pingsOf(setup: KeepaliveSetup): Array<{ to: string; body: unknown }> {
  return setup.harness.sockets
    .flatMap((socket) => socket.envelopes())
    .filter((e) => (e.body as { t?: unknown }).t === "ping");
}

describe("RelayKeepalive", () => {
  it("sends an app ping every 20s while connected", async () => {
    const setup = createSetup();
    await openRelay(setup);
    setup.harness.latest().receive("relay", { t: "hosts", items: [] });
    await setup.advance(15000);
    expect(pingsOf(setup)).toEqual([]);
    await setup.advance(5000);
    expect(pingsOf(setup)).toEqual([{ to: "relay", body: { t: "ping" } }]);
    await setup.advance(20000);
    expect(pingsOf(setup)).toHaveLength(2);
    setup.keepalive.stop();
  });

  it("reconnects after 45s without any frame", async () => {
    const setup = createSetup();
    await openRelay(setup);
    setup.harness.latest().receive("relay", { t: "hosts", items: [] });
    await setup.advance(40000);
    expect(setup.harness.sockets).toHaveLength(1);
    await setup.advance(5000);
    expect(setup.harness.sockets).toHaveLength(2);
    expect(setup.harness.sockets[0]?.readyState).toBe(3);
    expect(setup.harness.relay.connected).toBe(false);
    setup.harness.latest().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.harness.relay.connected).toBe(true);
    // The fresh socket gets a full silence budget before the next verdict.
    await setup.advance(40000);
    expect(setup.harness.sockets).toHaveLength(2);
    setup.keepalive.stop();
  });

  it("treats a pong like any other frame for the silence timer", async () => {
    const setup = createSetup();
    await openRelay(setup);
    setup.harness.latest().receive("relay", { t: "hosts", items: [] });
    await setup.advance(40000);
    setup.harness.latest().receive("relay", { t: "pong" });
    await setup.advance(40000);
    expect(setup.harness.sockets).toHaveLength(1);
    await setup.advance(5000);
    expect(setup.harness.sockets).toHaveLength(2);
    setup.keepalive.stop();
  });

  it("paces disconnected reconnects by the backoff ladder", async () => {
    const setup = createSetup(0.5);
    // A fail-fast server: each attempt fails at once so no connect stays
    // pending across ticks (a pending join would not open a new socket).
    async function tickAndFail(): Promise<void> {
      await setup.advance(5000);
      const latest = setup.harness.latest();
      if (latest.readyState === 0) {
        latest.fail();
        await vi.advanceTimersByTimeAsync(0);
      }
    }
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(1);
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(2);
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(3);
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(4);
    // The 8s backoff skips the next tick.
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(4);
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(5);
    // The 16s backoff skips three ticks (35s, 40s, 45s).
    await tickAndFail();
    await tickAndFail();
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(5);
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(6);
    // The 30s cap holds: five quiet ticks, then one retry.
    await tickAndFail();
    await tickAndFail();
    await tickAndFail();
    await tickAndFail();
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(6);
    await tickAndFail();
    expect(setup.harness.sockets).toHaveLength(7);
    setup.keepalive.stop();
  });

  it("stops pinging and reconnecting after stop", async () => {
    const setup = createSetup();
    await openRelay(setup);
    await setup.advance(20000);
    expect(pingsOf(setup)).toHaveLength(1);
    setup.keepalive.stop();
    await setup.advance(60000);
    expect(pingsOf(setup)).toHaveLength(1);
    expect(setup.harness.sockets).toHaveLength(1);
  });
});

describe("jitteredBackoffMs", () => {
  it("walks the ladder 1, 2, 4, 8, 16, 30, 30 at mid jitter", () => {
    expect([
      jitteredBackoffMs(0, 0.5),
      jitteredBackoffMs(1, 0.5),
      jitteredBackoffMs(2, 0.5),
      jitteredBackoffMs(3, 0.5),
      jitteredBackoffMs(4, 0.5),
      jitteredBackoffMs(5, 0.5),
      jitteredBackoffMs(6, 0.5),
      jitteredBackoffMs(99, 0.5),
    ]).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("clamps jitter to [1s, 30s]", () => {
    expect(jitteredBackoffMs(0, 0)).toBe(1000);
    expect(jitteredBackoffMs(0, 0.999)).toBeLessThanOrEqual(30000);
    expect(jitteredBackoffMs(5, 0.999)).toBe(30000);
    expect(jitteredBackoffMs(5, 0)).toBe(15000);
  });
});
