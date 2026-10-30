// SPDX-License-Identifier: Apache-2.0
// The production frame wiring, driven through a fake data channel exactly
// as main.ts chains it: channel text → snapshot assembler → router.

import { describe, expect, it } from "vitest";
import type { Shell } from "../src/app.js";
import { CatalogStore } from "../src/catalog.js";
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
  catalog: CatalogStore;
  controller: SessionController;
  written: string[];
  terminals: { id: string; cols: number; rows: number }[];
  oks: string[];
  errors: { message: string; req: string | null }[];
  exits: number[];
  spawned: { req: string; id: string }[];
  composed: { req: string; text: string }[];
  sheetOks: string[];
  sheetErrors: { message: string; req: string | null; code: string }[];
  hostSend: (frame: unknown) => void;
}

function setup(onForbidden?: (id: string | null) => void): Harness {
  const channel = new FakeDataChannel("canopy-session-v1", { ordered: true });
  const store = new SessionStore();
  const catalog = new CatalogStore();
  const written: string[] = [];
  const terminals: Harness["terminals"] = [];
  const oks: string[] = [];
  const errors: Harness["errors"] = [];
  const exits: number[] = [];
  const spawned: Harness["spawned"] = [];
  const composed: Harness["composed"] = [];
  const sheetOks: string[] = [];
  const sheetErrors: Harness["sheetErrors"] = [];
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
    sheetSpawned: (req: string, id: string) => {
      spawned.push({ req, id });
    },
    sheetComposed: (req: string, text: string) => {
      composed.push({ req, text });
    },
    sheetOk: (req: string) => {
      sheetOks.push(req);
    },
    sheetError: (message: string, req: string | null, code: string) => {
      sheetErrors.push({ message, req, code });
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
  const router = createFrameRouter({ store, controller, shell, catalog, onForbidden });
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
    catalog,
    controller,
    written,
    terminals,
    oks,
    errors,
    exits,
    spawned,
    composed,
    sheetOks,
    sheetErrors,
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

  it("routes ok and error replies to the composer and the sheets", () => {
    const h = setup();
    h.hostSend({ t: "ok", req: "r9" });
    expect(h.oks).toEqual(["r9"]);
    expect(h.sheetOks).toEqual(["r9"]);
    h.hostSend({ t: "error", req: "r10", code: "delivery_failed", message: "host is gone" });
    expect(h.errors).toEqual([{ message: "host is gone", req: "r10" }]);
    expect(h.sheetErrors).toEqual([
      { message: "host is gone", req: "r10", code: "delivery_failed" },
    ]);
  });

  it("routes a denied guest attach to onForbidden, past the composer", () => {
    const denied: (string | null)[] = [];
    const h = setup((id) => denied.push(id));
    h.hostSend({ t: "error", code: "forbidden", id: "s9" });
    expect(denied).toEqual(["s9"]);
    expect(h.errors).toEqual([]);
    expect(h.sheetErrors).toEqual([]);
  });

  it("falls a forbidden frame through to the generic error without a guest handler", () => {
    const h = setup();
    // With a message the owner flow sees a plain error, as before.
    h.hostSend({ t: "error", code: "forbidden", id: "s9", message: "no grant" });
    expect(h.errors).toEqual([{ message: "no grant", req: null }]);
    // Without one the frame parses to nothing and lands nowhere.
    h.hostSend({ t: "error", code: "forbidden", id: "s9" });
    expect(h.errors).toHaveLength(1);
    expect(h.sheetErrors).toHaveLength(1);
  });

  it("caches the catalog and routes spawned and composed to the shell", () => {
    const h = setup();
    h.hostSend({
      t: "catalog",
      req: "r1",
      clis: [{ cli: "muse", label: "Muse", models: ["spark"] }],
      projects: [{ name: "demo", path: "/home/u/demo" }],
      presets: [{ name: "review", preview: "look" }],
      skills: [{ name: "tdd", label: "TDD" }],
    });
    expect(h.catalog.isLoaded).toBe(true);
    expect(h.catalog.clis.map((cli) => cli.cli)).toEqual(["muse"]);
    expect(h.catalog.projects.map((project) => project.name)).toEqual(["demo"]);
    expect(h.catalog.presets.map((preset) => preset.name)).toEqual(["review"]);
    expect(h.catalog.skills.map((skill) => skill.name)).toEqual(["tdd"]);

    h.hostSend({ t: "spawned", req: "r2", id: "s9" });
    expect(h.spawned).toEqual([{ req: "r2", id: "s9" }]);
    h.hostSend({ t: "composed", req: "r3", text: "# Goal" });
    expect(h.composed).toEqual([{ req: "r3", text: "# Goal" }]);
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
    expect(h.spawned).toEqual([]);
    expect(h.composed).toEqual([]);
  });
});
