// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createChannelHandler } from "../src/channel.js";
import type { JoinedSnapshot } from "../src/channel.js";

function setup() {
  const snapshots: JoinedSnapshot[] = [];
  const frames: unknown[] = [];
  const channel = createChannelHandler({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onFrame: (frame) => frames.push(frame),
  });
  return { channel, snapshots, frames };
}

describe("createChannelHandler", () => {
  it("joins snapshot plus snapshot_more chunks into one snapshot", () => {
    const { channel, snapshots, frames } = setup();
    channel.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 7, data: "aaa" }));
    expect(snapshots).toHaveLength(0);
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: "bbb", last: false }));
    expect(snapshots).toHaveLength(0);
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: "ccc", last: true }));
    expect(snapshots).toEqual([{ id: "s1", cols: 80, rows: 24, seq: 7, data: "aaabbbccc" }]);
    expect(frames).toHaveLength(0);
  });

  it("ignores chunks for an unknown snapshot", () => {
    const { channel, snapshots, frames } = setup();
    channel.push(JSON.stringify({ t: "snapshot_more", id: "nope", data: "x", last: true }));
    expect(snapshots).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it("lets a fresh snapshot supersede a partial one", () => {
    const { channel, snapshots } = setup();
    channel.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 7, data: "aaa" }));
    channel.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 8, data: "zzz" }));
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: "!", last: true }));
    expect(snapshots).toEqual([{ id: "s1", cols: 80, rows: 24, seq: 8, data: "zzz!" }]);
  });

  it("passes other frames through and ignores invalid JSON", () => {
    const { channel, snapshots, frames } = setup();
    channel.push(JSON.stringify({ t: "out", id: "s1", seq: 9, data: "eA==" }));
    channel.push("not json");
    expect(frames).toEqual([{ t: "out", id: "s1", seq: 9, data: "eA==" }]);
    expect(snapshots).toHaveLength(0);
  });
});
