// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseHostsList } from "../src/relay.js";
import type { RelayFrame } from "../src/relay.js";
import { connectRelay, createRelayHarness } from "./fakes.js";

describe("RelaySocket", () => {
  it("connects once and sends JSON envelopes", async () => {
    const harness = createRelayHarness();
    const ws = await connectRelay(harness);
    expect(harness.relay.connected).toBe(true);
    harness.relay.send("h:abc", { t: "offer" });
    expect(ws.envelopes()).toEqual([{ to: "h:abc", body: { t: "offer" } }]);
  });

  it("joins a pending connect and reuses an open socket", async () => {
    const harness = createRelayHarness();
    const first = harness.relay.connect();
    const second = harness.relay.connect();
    harness.latest().open();
    await first;
    await second;
    await harness.relay.connect();
    expect(harness.sockets).toHaveLength(1);
  });

  it("delivers incoming frames and ignores garbage", async () => {
    const harness = createRelayHarness();
    await connectRelay(harness);
    const frames: RelayFrame[] = [];
    harness.relay.onFrame((frame) => frames.push(frame));
    const ws = harness.latest();
    ws.receive("h:abc", { t: "answer" });
    ws.receiveRaw("not json");
    ws.receiveRaw(JSON.stringify({ noFrom: true }));
    ws.receiveRaw(JSON.stringify({ from: 42, body: {} }));
    expect(frames).toEqual([{ from: "h:abc", body: { t: "answer" } }]);
  });

  it("rejects when the socket fails before opening", async () => {
    const harness = createRelayHarness();
    const pending = harness.relay.connect();
    harness.latest().fail();
    await expect(pending).rejects.toThrow("Could not reach the relay");
    expect(harness.relay.connected).toBe(false);
  });

  it("notifies close subscribers", async () => {
    const harness = createRelayHarness();
    await connectRelay(harness);
    let closed = 0;
    harness.relay.onClose(() => {
      closed += 1;
    });
    harness.latest().close();
    expect(closed).toBe(1);
    expect(harness.relay.connected).toBe(false);
  });

  it("refuses to send while disconnected", () => {
    const harness = createRelayHarness();
    expect(() => harness.relay.send("h:abc", {})).toThrow("Relay is not connected");
    expect(harness.relay.trySend("h:abc", {})).toBe(false);
  });
});

describe("parseHostsList", () => {
  it("parses the relay hosts notice", () => {
    expect(parseHostsList({ t: "hosts", items: [{ host_id: "a", label: "A" }] })).toEqual([
      { host_id: "a", label: "A" },
    ]);
  });

  it("drops malformed items and rejects other bodies", () => {
    expect(
      parseHostsList({ t: "hosts", items: [{ host_id: "a", label: "A" }, "junk", { host_id: "b" }] }),
    ).toEqual([{ host_id: "a", label: "A" }]);
    expect(parseHostsList({ t: "error", code: "no_target" })).toBeNull();
    expect(parseHostsList(null)).toBeNull();
    expect(parseHostsList({ t: "hosts" })).toBeNull();
  });
});
