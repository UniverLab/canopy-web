// SPDX-License-Identifier: Apache-2.0
// The production frame wiring, driven through a fake data channel exactly
// as main.ts chains it: channel text → snapshot assembler → router.

import { describe, expect, it } from "vitest";
import type { Shell } from "../src/app.js";
import { createChannelHandler } from "../src/channel.js";
import { b64encode } from "../src/crypto.js";
import { createFrameRouter } from "../src/router.js";
import type { FrameRouter } from "../src/router.js";
import { SessionController } from "../src/session.js";
import { SessionStore } from "../src/sessions.js";
import { FakeDataChannel } from "./fakes.js";

const b64 = (text: string): string => b64encode(new TextEncoder().encode(text));

interface Harness {
  router: FrameRouter;
  store: SessionStore;
  controller: SessionController;
  written: string[];
  terminals: { id: string; cols: number; rows: number }[];
  oks: string[];
  errors: { message: string; req: string | null }[];
  exits: number[];
  hostSend: (frame: unknown) => void;
}

function setup(): Harness {
  const channel = new FakeDataChannel("canopy-session-v1", { ordered: true });
  const store = new SessionStore();
  const written: string[] = [];
  const terminals: Harness["terminals"] = [];
  const oks: string[] = [];
  const errors: Harness["errors"] = [];
  const exits: number[] = [];
  // Only the methods the router calls; main.ts wires the real shell.
  const shell = {
    ensureTerminal: (id: string, cols: number, rows: number) => {
      terminals.push({ id, cols, rows });
    },
    composerOk: (req: string) => {
      oks.push(req);
    },
    composerError: (message: string, req: string | null) => {
      errors.push({ message, req });
    },
    showSessionExited: (code: number) => {
      exits.push(code);
    },
  } as unknown as Shell;
  const controller = new SessionController({
    send: (data) => {
      channel.send(data);
      return true;
    },
    terminal: () => ({
      write: (text: string) => written.push(text),
      clear: () => {},
    }),
    onExited: (_id, code) => shell.showSessionExited(code),
  });
  const router = createFrameRouter({ store, controller, shell });
  const frames = createChannelHandler({
    onSnapshot: router.handleSnapshot,
    onFrame: router.handleFrame,
  });
  channel.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === "string") {
      frames.push(ev.data);
    }
  };
  return {
    router,
    store,
    controller,
    written,
    terminals,
    oks,
    errors,
    exits,
    hostSend: (frame: unknown) => channel.deliver(JSON.stringify(frame)),
  };
}

describe("createFrameRouter", () => {
  it("routes the session list and its updates to the store", () => {
    const h = setup();
    h.hostSend({ t: "sessions", req: "r1", items: [{ id: "s1", name: "build", status: "running" }] });
    expect(h.store.list().map((row) => row.id)).toEqual(["s1"]);
    h.hostSend({ t: "session_added", item: { id: "s2", name: "docs", status: "idle" } });
    expect(h.store.list().map((row) => row.id)).toEqual(["s1", "s2"].sort());
    h.hostSend({ t: "session_removed", id: "s1" });
    expect(h.store.get("s1")).toBeNull();
    expect(h.store.get("s2")?.name).toBe("docs");
  });

  it("marks the session exited in the store and on the open view", () => {
    const h = setup();
    h.hostSend({ t: "sessions", req: "r1", items: [{ id: "s1", status: "running" }] });
    h.controller.open("s1");
    h.hostSend({ t: "exited", id: "s1", code: 1 });
    expect(h.store.get("s1")?.status).toBe("exited");
    expect(h.exits).toEqual([1]);
  });

  it("mounts the terminal from the snapshot before feeding it", () => {
    const h = setup();
    h.controller.open("s1");
    const full = b64("hello");
    h.hostSend({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 7, data: full.slice(0, 3) });
    expect(h.terminals).toEqual([]);
    expect(h.written).toEqual([]);
    h.hostSend({ t: "snapshot_more", id: "s1", data: full.slice(3), last: true });
    expect(h.terminals).toEqual([{ id: "s1", cols: 80, rows: 24 }]);
    expect(h.written.join("")).toBe("hello");
    h.hostSend({ t: "out", id: "s1", seq: 8, data: b64("!") });
    expect(h.written.join("")).toBe("hello!");
  });

  it("routes ok and error replies to the composer", () => {
    const h = setup();
    h.hostSend({ t: "ok", req: "r9" });
    expect(h.oks).toEqual(["r9"]);
    h.hostSend({ t: "error", req: "r10", code: "delivery_failed", message: "host is gone" });
    expect(h.errors).toEqual([{ message: "host is gone", req: "r10" }]);
  });

  it("ignores unknown frames without throwing", () => {
    const h = setup();
    expect(() => {
      h.hostSend({ t: "mystery", id: "s1" });
      h.hostSend({ nope: true });
      h.router.handleFrame(null);
    }).not.toThrow();
    expect(h.store.size).toBe(0);
    expect(h.oks).toEqual([]);
    expect(h.errors).toEqual([]);
  });
});
