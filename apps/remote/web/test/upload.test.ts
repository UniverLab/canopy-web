// SPDX-License-Identifier: Apache-2.0
// The upload queue outside the browser: frame shapes, the 12 KiB parts,
// the eight-part window, the every-eighth ack, the three-upload cap, the
// abort and the completion the ordinary shelf_added confirms.

import { describe, expect, it } from "vitest";
import {
  buildShelfPutAbort,
  buildShelfPutBegin,
  buildShelfPutEnd,
  buildShelfPutPart,
  parseShelfPutAck,
  parseShelfPutReady,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_WINDOW,
  UploadQueue,
} from "../src/upload.js";

interface Frame {
  t: string;
  req?: string;
  id?: string;
  name?: string;
  size?: number;
  mime?: string;
  sha256?: string;
  file_id?: string;
  part?: number;
  data?: string;
}

function fileOf(bytes: Uint8Array, name: string, type: string): File {
  return {
    name,
    size: bytes.length,
    type,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  } as unknown as File;
}

function bytesOf(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 29 + 3) % 256;
  }
  return bytes;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface Harness {
  queue: UploadQueue;
  frames: Frame[];
}

function harness(maxActive?: number): Harness {
  const frames: Frame[] = [];
  const queue = new UploadQueue({
    send: (data) => {
      frames.push(JSON.parse(data) as Frame);
      return true;
    },
    notify: () => {},
    hash: async (bytes) => `h${bytes.length}`,
    maxActive,
  });
  return { queue, frames };
}

describe("upload frames", () => {
  it("carries the session id, size, mime and sha256 on begin", () => {
    const frame = JSON.parse(buildShelfPutBegin("r1", "s1", "a.txt", 12, "text/plain", "abc")) as Frame;
    expect(frame).toEqual({
      t: "shelf_put_begin",
      req: "r1",
      id: "s1",
      name: "a.txt",
      size: 12,
      mime: "text/plain",
      sha256: "abc",
    });
    const host = JSON.parse(buildShelfPutBegin("r2", null, "a.txt", 12, "", "abc")) as Frame;
    expect(host).not.toHaveProperty("id");
    expect(host).not.toHaveProperty("mime");
  });

  it("builds part, end and abort with the quoted names", () => {
    expect(JSON.parse(buildShelfPutPart("f1", 3, "AAAA"))).toEqual({
      t: "shelf_put_part",
      file_id: "f1",
      part: 3,
      data: "AAAA",
    });
    expect(JSON.parse(buildShelfPutEnd("f1"))).toEqual({ t: "shelf_put_end", file_id: "f1" });
    expect(JSON.parse(buildShelfPutAbort("f1"))).toEqual({ t: "shelf_put_abort", file_id: "f1" });
  });

  it("parses ready and ack strictly", () => {
    expect(parseShelfPutReady({ t: "shelf_put_ready", req: "r1", file_id: "f1" })).toEqual({
      req: "r1",
      file_id: "f1",
    });
    expect(parseShelfPutReady({ t: "shelf_put_ready", req: "r1", file_id: "" })).toBeNull();
    expect(parseShelfPutReady({ t: "shelf_put_ack", file_id: "f1", part: 0 })).toBeNull();
    expect(parseShelfPutAck({ t: "shelf_put_ack", file_id: "f1", part: 7 })).toEqual({
      file_id: "f1",
      part: 7,
    });
    expect(parseShelfPutAck({ t: "shelf_put_ack", file_id: "f1" })).toBeNull();
  });
});

describe("upload queue", () => {
  it("sends 12 KiB parts, eight at a time, and ends after the ack", async () => {
    const { queue, frames } = harness();
    const bytes = bytesOf(10 * UPLOAD_CHUNK_BYTES + 500);
    const parts = Math.ceil(bytes.length / UPLOAD_CHUNK_BYTES);
    queue.add([fileOf(bytes, "data.bin", "application/octet-stream")], "s1");
    await settle();

    const begin = frames[0];
    expect(begin?.t).toBe("shelf_put_begin");
    expect(begin?.id).toBe("s1");
    expect(begin?.sha256).toBe(`h${bytes.length}`);
    expect(begin?.size).toBe(bytes.length);

    queue.handleReady({ req: begin?.req ?? "", file_id: "u1" });
    const first = frames.filter((frame) => frame.t === "shelf_put_part");
    expect(first).toHaveLength(UPLOAD_WINDOW);
    expect(first[0]?.data).toBeDefined();
    // The first part is a 12 KiB chunk; no ninth part goes out unacked.
    expect(atobBinaryLength(first[0]?.data ?? "")).toBe(UPLOAD_CHUNK_BYTES);
    expect(frames.some((frame) => frame.t === "shelf_put_end")).toBe(false);

    expect(queue.handleAck({ file_id: "u1", part: 7 })).toBe(true);
    const all = frames.filter((frame) => frame.t === "shelf_put_part");
    expect(all).toHaveLength(parts);
    expect(frames[frames.length - 1]?.t).toBe("shelf_put_end");

    // The completion is the ordinary shelf_added, and its path feeds the chip.
    expect(queue.confirmAdded({ file_id: "u1", path: "/home/u/data.bin" })).toBe(true);
    const view = queue.views()[0];
    expect(view?.status).toBe("done");
    expect(view?.progress).toBe(1);
    expect(queue.takeAttachment(view?.id ?? "")?.path).toBe("/home/u/data.bin");
    expect(queue.views()[0]?.taken).toBe(true);
  });

  it("keeps three uploads in flight and queues the rest", async () => {
    const { queue, frames } = harness(3);
    queue.add(
      [
        fileOf(bytesOf(100), "a.txt", "text/plain"),
        fileOf(bytesOf(100), "b.txt", "text/plain"),
        fileOf(bytesOf(100), "c.txt", "text/plain"),
        fileOf(bytesOf(100), "d.txt", "text/plain"),
      ],
      null,
    );
    await settle();
    expect(frames.filter((frame) => frame.t === "shelf_put_begin")).toHaveLength(3);
  });

  it("aborts a begun upload and honours refusals", async () => {
    const { queue, frames } = harness();
    queue.add([fileOf(bytesOf(100), "a.txt", "text/plain")], null);
    await settle();
    const begin = frames[0];
    queue.handleReady({ req: begin?.req ?? "", file_id: "u1" });
    const id = queue.views()[0]?.id ?? "";
    queue.cancel(id);
    expect(frames.some((frame) => frame.t === "shelf_put_abort" && frame.file_id === "u1")).toBe(true);
    expect(queue.views()).toHaveLength(0);

    // A begin refusal lands on its task, not on another request.
    queue.add([fileOf(bytesOf(100), "b.txt", "text/plain")], null);
    await settle();
    const second = frames[frames.length - 1];
    expect(queue.handleError({ req: second?.req ?? "", code: "too_large", message: "big" })).toBe(true);
    expect(queue.views()[0]?.error).toBe("too_large");
    expect(queue.handleError({ req: "other", code: "forbidden", message: "no" })).toBe(false);
  });
});

function atobBinaryLength(data: string): number {
  return atob(data).length;
}
