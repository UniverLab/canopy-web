// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { b64encode } from "../src/crypto.js";
import {
  buildAttach,
  buildDetach,
  buildInput,
  buildInputText,
  buildList,
  buildPrompt,
  decodeSnapshotData,
  decodeUtf8,
  formatLastOutput,
  newReqId,
  parseError,
  parseExited,
  parseOk,
  parseOut,
  parseSessionAdded,
  parseSessionItem,
  parseSessionRemoved,
  parseSessions,
  statusDot,
  workdirBasename,
} from "../src/protocol.js";

describe("builders", () => {
  it("builds the exact session frames", () => {
    expect(JSON.parse(buildList("r1"))).toEqual({ t: "list", req: "r1" });
    expect(JSON.parse(buildAttach("s1"))).toEqual({ t: "attach", id: "s1" });
    expect(JSON.parse(buildDetach("s1"))).toEqual({ t: "detach", id: "s1" });
    expect(JSON.parse(buildPrompt("r2", "s1", "hello"))).toEqual({
      t: "prompt",
      req: "r2",
      id: "s1",
      text: "hello",
    });
  });

  it("base64-encodes input bytes", () => {
    expect(JSON.parse(buildInput("s1", new Uint8Array([0x1b, 0x5b, 0x41])))).toEqual({
      t: "input",
      id: "s1",
      data: "G1tB",
    });
    expect(JSON.parse(buildInputText("s1", "y"))).toEqual({ t: "input", id: "s1", data: "eQ==" });
  });

  it("mints unique req ids", () => {
    expect(newReqId()).not.toBe(newReqId());
  });
});

describe("parseSessionItem", () => {
  it("parses a full item with unix-seconds last output", () => {
    expect(
      parseSessionItem({
        id: "s1",
        name: "build",
        cli: "muse",
        model: "spark",
        workdir: "/home/u/proj",
        status: "running",
        last_output_at: 1793100000,
      }),
    ).toEqual({
      id: "s1",
      name: "build",
      cli: "muse",
      model: "spark",
      workdir: "/home/u/proj",
      status: "running",
      lastOutputAt: 1793100000_000,
    });
  });

  it("accepts millisecond and ISO timestamps", () => {
    expect(parseSessionItem({ id: "a", last_output_at: 1793100000_000 })?.lastOutputAt).toBe(
      1793100000_000,
    );
    expect(
      parseSessionItem({ id: "a", last_output_at: "2026-10-27T00:00:00.000Z" })?.lastOutputAt,
    ).toBe(Date.parse("2026-10-27T00:00:00.000Z"));
  });

  it("tolerates missing fields but never a missing id", () => {
    expect(parseSessionItem({ id: "a" })).toEqual({
      id: "a",
      name: "",
      cli: "",
      model: "",
      workdir: "",
      status: "",
      lastOutputAt: null,
    });
    expect(parseSessionItem({ name: "x" })).toBeNull();
    expect(parseSessionItem(null)).toBeNull();
  });
});

describe("frame parsers", () => {
  it("parses sessions and skips invalid items", () => {
    expect(parseSessions({ t: "sessions", req: "r1", items: [{ id: "a" }, { nope: true }] })).toEqual([
      { id: "a", name: "", cli: "", model: "", workdir: "", status: "", lastOutputAt: null },
    ]);
    expect(parseSessions({ t: "sessions" })).toBeNull();
    expect(parseSessions({ t: "out", id: "a", seq: 1, data: "eQ==" })).toBeNull();
  });

  it("parses session_added, session_removed and exited", () => {
    expect(parseSessionAdded({ t: "session_added", item: { id: "a" } })?.id).toBe("a");
    expect(parseSessionAdded({ t: "session_added" })).toBeNull();
    expect(parseSessionRemoved({ t: "session_removed", id: "a" })).toBe("a");
    expect(parseSessionRemoved({ t: "session_removed" })).toBeNull();
    expect(parseExited({ t: "exited", id: "a", code: 1 })).toEqual({ id: "a", code: 1 });
    expect(parseExited({ t: "exited", id: "a" })).toBeNull();
  });

  it("parses out frames and rejects bad base64", () => {
    expect(parseOut({ t: "out", id: "a", seq: 9, data: "eQ==" })).toEqual({
      id: "a",
      seq: 9,
      data: new Uint8Array([0x79]),
    });
    expect(parseOut({ t: "out", id: "a", seq: 9, data: "!!!" })).toBeNull();
    expect(parseOut({ t: "out", id: "a", seq: 9 })).toBeNull();
  });

  it("parses ok and error replies", () => {
    expect(parseOk({ t: "ok", req: "r1" })).toBe("r1");
    expect(parseOk({ t: "ok" })).toBeNull();
    expect(parseError({ t: "error", req: "r1", code: "internal", message: "boom" })).toEqual({
      req: "r1",
      code: "internal",
      message: "boom",
    });
    expect(parseError({ t: "error", code: "internal", message: "boom" })?.req).toBeNull();
    expect(parseError({ t: "error", code: "internal" })).toBeNull();
  });

  it("decodes snapshot data as UTF-8", () => {
    const bytes = decodeSnapshotData(b64encode(new TextEncoder().encode("héllo")));
    expect(bytes).not.toBeNull();
    expect(decodeUtf8(bytes ?? new Uint8Array())).toBe("héllo");
    expect(decodeSnapshotData("!!!")).toBeNull();
  });
});

describe("display helpers", () => {
  it("takes the workdir basename", () => {
    expect(workdirBasename("/home/u/proj")).toBe("proj");
    expect(workdirBasename("/home/u/proj/")).toBe("proj");
    expect(workdirBasename("proj")).toBe("proj");
    expect(workdirBasename("")).toBe("");
  });

  it("formats relative last-output times", () => {
    const now = 1793100000_000;
    expect(formatLastOutput(now, null)).toBe("no output yet");
    expect(formatLastOutput(now, now - 12_000)).toBe("last output 12s ago");
    expect(formatLastOutput(now, now - 3 * 60_000)).toBe("last output 3min ago");
    expect(formatLastOutput(now, now - 2 * 3600_000)).toBe("last output 2h ago");
  });

  it("maps statuses to dots", () => {
    expect(statusDot("running")).toBe("run");
    expect(statusDot("idle")).toBe("idle");
    expect(statusDot("exited")).toBe("dead");
    expect(statusDot("mystery")).toBe("unknown");
  });
});
