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
import { ShelfController } from "../src/shelf-controller.js";
import type { ShelfFrames } from "../src/shelf-controller.js";
import { SessionStore } from "../src/sessions.js";
import { FakeDataChannel, textOf } from "./fakes.js";

const b64 = (text: string): string => b64encode(new TextEncoder().encode(text));

interface Harness {
  router: FrameRouter;
  store: SessionStore;
  catalog: CatalogStore;
  controller: SessionController;
  written: Uint8Array[];
  terminals: { id: string; cols: number; rows: number }[];
  resizes: { id: string; cols: number; rows: number }[];
  exits: number[];
  spawned: { req: string; id: string }[];
  composed: { req: string; text: string }[];
  scheduled: { req: string; item: unknown }[];
  scheduledLists: { req: string; items: unknown[] }[];
  sheetOks: string[];
  sheetErrors: { message: string; req: string | null; code: string }[];
  hostSend: (frame: unknown) => void;
}

function setup(onForbidden?: (id: string | null) => void, shelf?: ShelfFrames): Harness {
  const channel = new FakeDataChannel("canopy-session-v1", { ordered: true });
  const store = new SessionStore();
  const catalog = new CatalogStore();
  const written: Uint8Array[] = [];
  const terminals: Harness["terminals"] = [];
  const resizes: Harness["resizes"] = [];
  const exits: number[] = [];
  const spawned: Harness["spawned"] = [];
  const composed: Harness["composed"] = [];
  const scheduled: Harness["scheduled"] = [];
  const scheduledLists: Harness["scheduledLists"] = [];
  const sheetOks: string[] = [];
  const sheetErrors: Harness["sheetErrors"] = [];
  // Only the methods the router calls; main.ts wires the real shell.
  const shell = {
    ensureTerminal: (id: string, cols: number, rows: number) => {
      terminals.push({ id, cols, rows });
    },
    sessionResized: (id: string, cols: number, rows: number) => {
      resizes.push({ id, cols, rows });
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
    sheetScheduled: (req: string, item: unknown) => {
      scheduled.push({ req, item });
    },
    sheetScheduledList: (req: string, items: unknown[]) => {
      scheduledLists.push({ req, items });
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
      write: (data: Uint8Array) => written.push(data),
      clear: () => {},
    }),
    onExited: (_id, code) => shell.showSessionExited(code),
  });
  const router = createFrameRouter({ store, controller, shell, catalog, onForbidden, shelf });
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
    resizes,
    exits,
    spawned,
    composed,
    scheduled,
    scheduledLists,
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
    expect(textOf(h.written)).toBe("hello");
    h.hostSend({ t: "out", id: "s1", seq: 8, data: b64("!") });
    expect(textOf(h.written)).toBe("hello!");
  });

  it("routes ok and error replies to the sheets", () => {
    const h = setup();
    h.hostSend({ t: "ok", req: "r9" });
    expect(h.sheetOks).toEqual(["r9"]);
    h.hostSend({ t: "error", req: "r10", code: "delivery_failed", message: "host is gone" });
    expect(h.sheetErrors).toEqual([
      { message: "host is gone", req: "r10", code: "delivery_failed" },
    ]);
  });

  it("routes a shelf delete ok to the shelf before the sheets", () => {
    const sent: string[] = [];
    const shelf = new ShelfController({
      send: (data) => {
        sent.push(data);
        return true;
      },
    });
    shelf.handleHello(["shelf"]);
    const h = setup(undefined, shelf);
    shelf.deleteFile({
      file_id: "f1",
      session_id: "s1",
      name: "a.png",
      mime: "image/png",
      size: 1,
      caption: null,
      from: "muse",
      created_at: 1,
    });
    const req = (JSON.parse(sent[sent.length - 1] ?? "") as { req: string }).req;
    h.hostSend({ t: "ok", req });
    expect(h.sheetOks).toEqual([]);
    h.hostSend({ t: "ok", req: "r-other" });
    expect(h.sheetOks).toEqual(["r-other"]);
  });

  it("spawn_error_hides_paths", () => {
    const h = setup();
    h.hostSend({
      t: "error",
      req: "r11",
      code: "spawn_failed",
      message: 'spawn "opencode" failed: No such file or directory (PATH=/usr/local/bin:/usr/bin:/bin)',
    });
    expect(h.sheetErrors).toEqual([
      { message: 'harness "opencode" is not installed on this host', req: "r11", code: "spawn_failed" },
    ]);
    for (const seen of h.sheetErrors.map((entry) => entry.message)) {
      expect(seen).toContain("opencode");
      expect(seen).not.toContain("/");
      expect(seen).not.toContain("usr/bin");
    }
    // A bad directory still echoes what the user typed, paths and all.
    h.hostSend({ t: "error", req: "r12", code: "unknown_project", message: "unknown workdir: /home/u/nope" });
    expect(h.sheetErrors[1]?.message).toBe("unknown workdir: /home/u/nope");
  });

  it("routes a denied guest attach to onForbidden, past the sheets", () => {
    const denied: (string | null)[] = [];
    const h = setup((id) => denied.push(id));
    h.hostSend({ t: "error", code: "forbidden", id: "s9" });
    expect(denied).toEqual(["s9"]);
    expect(h.sheetErrors).toEqual([]);
  });

  it("falls a forbidden frame through to the generic error without a guest handler", () => {
    const h = setup();
    // With a message the owner flow sees a plain error, as before.
    h.hostSend({ t: "error", code: "forbidden", id: "s9", message: "no grant" });
    expect(h.sheetErrors).toEqual([{ message: "no grant", req: null, code: "forbidden" }]);
    // Without one the frame parses to nothing and lands nowhere.
    h.hostSend({ t: "error", code: "forbidden", id: "s9" });
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

  it("routes scheduled and scheduled_list to the shell", () => {
    const h = setup();
    const item = { id: "ss-1", fire_at: "2030-01-01T09:00:00.000Z", preview: "review it" };
    h.hostSend({ t: "scheduled", req: "r4", item });
    expect(h.scheduled).toEqual([
      {
        req: "r4",
        item: { id: "ss-1", fireAt: "2030-01-01T09:00:00.000Z", preview: "review it" },
      },
    ]);
    h.hostSend({ t: "scheduled_list", req: "r5", id: "s1", items: [item] });
    expect(h.scheduledLists).toEqual([
      {
        req: "r5",
        items: [{ id: "ss-1", fireAt: "2030-01-01T09:00:00.000Z", preview: "review it" }],
      },
    ]);
    // Malformed schedule frames land nowhere, like any unknown frame.
    h.hostSend({ t: "scheduled", req: "r6" });
    h.hostSend({ t: "scheduled_list", req: "r7", id: "s1", items: {} });
    expect(h.scheduled).toHaveLength(1);
    expect(h.scheduledLists).toHaveLength(1);
  });

  it("routes hello harnesses to the catalog's installed set", () => {
    const h = setup();
    h.hostSend({
      t: "catalog",
      req: "r1",
      clis: [
        { cli: "muse", label: "Muse", models: [] },
        { cli: "opencode", label: "opencode", models: [] },
      ],
      projects: [],
      presets: [],
      skills: [],
    });
    expect(h.catalog.availableClis.map((cli) => cli.cli)).toEqual(["muse", "opencode"]);
    h.hostSend({ t: "hello", features: [], harnesses: ["muse"] });
    expect(h.catalog.availableClis.map((cli) => cli.cli)).toEqual(["muse"]);
    // An old host says nothing: everything is offered again.
    h.hostSend({ t: "hello", features: [] });
    expect(h.catalog.availableClis.map((cli) => cli.cli)).toEqual(["muse", "opencode"]);
  });

  it("routes the attached session's resized frame to the shell, only that one", () => {
    const h = setup();
    // Nothing attached: dropped.
    h.hostSend({ t: "resized", id: "s1", cols: 100, rows: 30 });
    expect(h.resizes).toEqual([]);
    h.controller.open("s1");
    h.hostSend({ t: "resized", id: "s1", cols: 100, rows: 30 });
    h.hostSend({ t: "resized", id: "s2", cols: 90, rows: 20 });
    // Malformed: dropped like an unknown frame, never an error.
    h.hostSend({ t: "resized", id: "s1", cols: 0, rows: 30 });
    h.hostSend({ t: "resized", id: "s1", cols: "100", rows: 30 });
    expect(h.resizes).toEqual([{ id: "s1", cols: 100, rows: 30 }]);
    expect(h.sheetErrors).toEqual([]);
  });

  it("drops resized for a shell that does not follow it", () => {
    const h = setup();
    const bare = createFrameRouter({
      store: h.store,
      controller: h.controller,
      catalog: h.catalog,
      shell: {
        ensureTerminal: () => {},
        sheetSpawned: () => {},
        sheetComposed: () => {},
        sheetScheduled: () => {},
        sheetScheduledList: () => {},
        sheetOk: () => {},
        sheetError: () => {},
      },
    });
    h.controller.open("s1");
    expect(() => bare.handleFrame({ t: "resized", id: "s1", cols: 100, rows: 30 })).not.toThrow();
  });

  it("ignores unknown frames without throwing", () => {
    const h = setup();
    expect(() => {
      h.hostSend({ t: "mystery", id: "s1" });
      h.hostSend({ nope: true });
      h.router.handleFrame(null);
    }).not.toThrow();
    expect(h.store.size).toBe(0);
    expect(h.sheetOks).toEqual([]);
    expect(h.sheetErrors).toEqual([]);
    expect(h.spawned).toEqual([]);
    expect(h.composed).toEqual([]);
  });
});
