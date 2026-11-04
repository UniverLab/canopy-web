// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createChannelHandler } from "../src/channel.js";
import type { JoinedSnapshot } from "../src/channel.js";
import { b64encode } from "../src/crypto.js";
import { RAW_PART } from "./fixtures/long-snapshot.js";

const b64 = (text: string): string => b64encode(new TextEncoder().encode(text));
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

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
    channel.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 7, data: b64("aaa") }));
    expect(snapshots).toHaveLength(0);
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: b64("bbb"), last: false }));
    expect(snapshots).toHaveLength(0);
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: b64("ccc"), last: true }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.data).toEqual(bytesOf("aaabbbccc"));
    expect(frames).toHaveLength(0);
  });

  it("joins host-size parts whose base64 padding wraps mid-stream", () => {
    const { channel, snapshots } = setup();
    // The host cuts the RAW bytes at RAW_PART and base64-encodes each
    // part on its own: RAW_PART % 3 = 2, so every full part's encoding
    // ends in `=` — padding that must never reach atob mid-stream.
    const total = RAW_PART * 2 + 5;
    const original = new Uint8Array(total);
    original.fill(0x61);
    // One U+2588 block straddles the first part boundary: its first UTF-8
    // byte closes part one, the other two open part two.
    original.set(bytesOf("█"), RAW_PART - 1);
    const parts = [
      original.slice(0, RAW_PART),
      original.slice(RAW_PART, RAW_PART + 3),
      original.slice(RAW_PART + 3),
    ];
    const encoded = parts.map((part) => b64encode(part));
    // A full RAW_PART part is 12032 raw bytes: 12032 % 3 leaves two
    // carried bits, so its own encoding ends in `=` (interior padding).
    expect(encoded[0]!.endsWith("=")).toBe(true);
    // Head plus two more frames, exactly the host's shape.
    channel.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 7, data: encoded[0] }));
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: encoded[1], last: false }));
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: encoded[2], last: true }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.data).toEqual(original);
  });

  it("drops a part that cannot decode and keeps the rest flowing", () => {
    const { channel, snapshots, frames } = setup();
    channel.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 7, data: b64("x") }));
    // Invalid base64: atob throws on it, and the handler must swallow it.
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: "***", last: false }));
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: b64("y"), last: true }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.data).toEqual(bytesOf("xy"));
    // The handler survived; live output still reaches the router.
    channel.push(JSON.stringify({ t: "out", id: "s2", seq: 1, data: b64("z") }));
    expect(frames).toEqual([{ t: "out", id: "s2", seq: 1, data: b64("z") }]);
  });

  it("ignores chunks for an unknown snapshot", () => {
    const { channel, snapshots, frames } = setup();
    channel.push(JSON.stringify({ t: "snapshot_more", id: "nope", data: b64("x"), last: true }));
    expect(snapshots).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it("lets a fresh snapshot supersede a partial one", () => {
    const { channel, snapshots } = setup();
    channel.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 7, data: b64("aaa") }));
    channel.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 8, data: b64("zzz") }));
    channel.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: b64("!"), last: true }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.data).toEqual(bytesOf("zzz!"));
  });

  it("draws a snapshot whose closing part never came once its session's output arrives", () => {
    const { channel, snapshots, frames } = setup();
    channel.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 7, data: b64("aaa") }));
    channel.push(JSON.stringify({ t: "out", id: "s2", seq: 1, data: b64("x") }));
    expect(snapshots).toHaveLength(0);
    channel.push(JSON.stringify({ t: "out", id: "s1", seq: 8, data: b64("x") }));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.data).toEqual(bytesOf("aaa"));
    expect(frames).toHaveLength(2);
  });

  it("passes other frames through and ignores invalid JSON", () => {
    const { channel, snapshots, frames } = setup();
    channel.push(JSON.stringify({ t: "out", id: "s1", seq: 9, data: b64("x") }));
    channel.push("not json");
    expect(frames).toEqual([{ t: "out", id: "s1", seq: 9, data: b64("x") }]);
    expect(snapshots).toHaveLength(0);
  });
});
