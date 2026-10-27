// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createChannelHandler } from "../src/channel.js";
import { b64encode } from "../src/crypto.js";
import { buildList, parseError, parseExited, parseOk, parseOut, parseSessions } from "../src/protocol.js";
import { SessionController } from "../src/session.js";
import { SessionStore } from "../src/sessions.js";
import { FakeDataChannel } from "./fakes.js";

const b64 = (text: string): string => b64encode(new TextEncoder().encode(text));

interface Harness {
  channel: FakeDataChannel;
  store: SessionStore;
  controller: SessionController;
  written: string[];
  cleared: number;
  exited: { id: string; code: number }[];
  sent: () => unknown[];
  hostSend: (frame: unknown) => void;
}

function setup(): Harness {
  const channel = new FakeDataChannel("canopy-session-v1", { ordered: true });
  const store = new SessionStore();
  const written: string[] = [];
  const exited: { id: string; code: number }[] = [];
  let clears = 0;
  const controller = new SessionController({
    send: (data) => {
      channel.send(data);
      return true;
    },
    terminal: () => ({
      write: (text) => written.push(text),
      clear: () => {
        clears += 1;
      },
    }),
    onExited: (id, code) => exited.push({ id, code }),
  });
  const frames = createChannelHandler({
    onSnapshot: (snapshot) => controller.handleSnapshot(snapshot),
    onFrame: (frame) => {
      const sessions = parseSessions(frame);
      if (sessions) {
        store.replace(sessions);
        return;
      }
      const out = parseOut(frame);
      if (out) {
        controller.handleOut(out);
        return;
      }
      const done = parseExited(frame);
      if (done) {
        store.markExited(done.id);
        controller.handleExited(done.id, done.code);
        return;
      }
      const ok = parseOk(frame);
      if (ok !== null) {
        return;
      }
      parseError(frame);
    },
  });
  channel.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") {
      frames.push(ev.data);
    }
  };
  return {
    channel,
    store,
    controller,
    written,
    exited,
    get cleared() {
      return clears;
    },
    sent: () => channel.sent.map((raw) => JSON.parse(raw) as unknown),
    hostSend: (frame: unknown) => channel.deliver(JSON.stringify(frame)),
  };
}

function snapshotFrames(id: string, seq: number, text: string): unknown[] {
  // The host splits the base64 stream, so split the encoding, not the text.
  const full = b64(text);
  const cut = Math.min(3, full.length);
  return [
    { t: "snapshot", id, cols: 80, rows: 24, seq, data: full.slice(0, cut) },
    { t: "snapshot_more", id, data: full.slice(cut), last: true },
  ];
}

describe("session flow over a fake data channel", () => {
  it("lists, attaches, and feeds the terminal from snapshot plus out", () => {
    const h = setup();
    h.channel.send(buildList("r1"));
    h.hostSend({
      t: "sessions",
      req: "r1",
      items: [{ id: "s1", name: "build", cli: "muse", status: "running" }],
    });
    expect(h.store.list().map((row) => row.id)).toEqual(["s1"]);

    h.controller.open("s1");
    expect(h.sent()).toContainEqual({ t: "attach", id: "s1" });
    for (const frame of snapshotFrames("s1", 7, "hello")) {
      h.hostSend(frame);
    }
    expect(h.cleared).toBe(1);
    expect(h.written.join("")).toBe("hello");

    h.hostSend({ t: "out", id: "s1", seq: 8, data: b64("!") });
    expect(h.written.join("")).toBe("hello!");

    h.controller.close();
    expect(h.sent()).toContainEqual({ t: "detach", id: "s1" });
  });

  it("drops out frames at or below the last applied seq", () => {
    const h = setup();
    h.controller.open("s1");
    for (const frame of snapshotFrames("s1", 7, "ab")) {
      h.hostSend(frame);
    }
    h.hostSend({ t: "out", id: "s1", seq: 7, data: b64("STALE") });
    h.hostSend({ t: "out", id: "s1", seq: 6, data: b64("OLDER") });
    h.hostSend({ t: "out", id: "s1", seq: 8, data: b64("!") });
    h.hostSend({ t: "out", id: "s1", seq: 8, data: b64("DUP") });
    h.hostSend({ t: "out", id: "s2", seq: 99, data: b64("WRONG") });
    expect(h.written.join("")).toBe("ab!");
  });

  it("holds early out frames until the snapshot, then applies them in order", () => {
    const h = setup();
    h.controller.open("s1");
    h.hostSend({ t: "out", id: "s1", seq: 9, data: b64("c") });
    h.hostSend({ t: "out", id: "s1", seq: 8, data: b64("b") });
    expect(h.written).toEqual([]);
    for (const frame of snapshotFrames("s1", 7, "a")) {
      h.hostSend(frame);
    }
    expect(h.written.join("")).toBe("abc");
  });

  it("re-attaches after a reconnect without duplicating output", () => {
    const h = setup();
    h.controller.open("s1");
    for (const frame of snapshotFrames("s1", 7, "ab")) {
      h.hostSend(frame);
    }
    h.hostSend({ t: "out", id: "s1", seq: 8, data: b64("c") });
    expect(h.written.join("")).toBe("abc");

    // The reconnect: attach again, a fresh snapshot redraws, and the
    // in-flight out frame from before the drop is dropped by seq.
    expect(h.controller.reattach()).toBe(true);
    expect(h.sent().filter((f) => (f as { t: string }).t === "attach")).toHaveLength(2);
    h.hostSend({ t: "out", id: "s1", seq: 8, data: b64("c") });
    for (const frame of snapshotFrames("s1", 8, "abc")) {
      h.hostSend(frame);
    }
    h.hostSend({ t: "out", id: "s1", seq: 9, data: b64("d") });
    expect(h.cleared).toBe(2);
    expect(h.written.join("")).toBe("abcabcd");
  });

  it("marks sessions exited and notifies the open one", () => {
    const h = setup();
    h.hostSend({ t: "sessions", req: "r1", items: [{ id: "s1", status: "running" }] });
    h.controller.open("s1");
    h.hostSend({ t: "exited", id: "s1", code: 1 });
    expect(h.store.get("s1")?.status).toBe("exited");
    expect(h.exited).toEqual([{ id: "s1", code: 1 }]);
  });

  it("sends input and prompt frames for the open session", () => {
    const h = setup();
    expect(h.controller.sendInputText("x")).toBe(false);
    h.controller.open("s1");
    expect(h.controller.sendInputBytes(new Uint8Array([0x1b]))).toBe(true);
    expect(h.controller.sendInputText("y")).toBe(true);
    expect(h.controller.sendPrompt("do it", "r9")).toBe(true);
    expect(h.sent()).toContainEqual({ t: "input", id: "s1", data: "Gw==" });
    expect(h.sent()).toContainEqual({ t: "input", id: "s1", data: "eQ==" });
    expect(h.sent()).toContainEqual({ t: "prompt", req: "r9", id: "s1", text: "do it" });
  });

  it("detaches the previous session when opening another", () => {
    const h = setup();
    h.controller.open("s1");
    h.controller.open("s2");
    expect(h.sent()).toContainEqual({ t: "detach", id: "s1" });
    expect(h.sent()).toContainEqual({ t: "attach", id: "s2" });
  });
});
