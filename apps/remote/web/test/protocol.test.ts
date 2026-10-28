// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { b64encode } from "../src/crypto.js";
import {
  buildAttach,
  buildCatalog,
  buildCompose,
  buildDetach,
  buildGraphUnwatch,
  buildGraphs,
  buildGraphWatch,
  buildInput,
  buildInputText,
  buildList,
  buildPrompt,
  buildPromptDraft,
  buildShelfGet,
  buildShelfList,
  buildSpawn,
  decodeSnapshotData,
  decodeUtf8,
  formatLastOutput,
  newReqId,
  parseCatalog,
  parseComposed,
  parseError,
  parseExited,
  parseFilePart,
  parseGraph,
  parseGraphState,
  parseGraphs,
  parseHello,
  parseOk,
  parseOut,
  parseSessionAdded,
  parseSessionItem,
  parseSessionRemoved,
  parseSessions,
  parseShelf,
  parseShelfAdded,
  parseShelfRemoved,
  parseSpawned,
  statusDot,
  workdirBasename,
} from "../src/protocol.js";

describe("builders", () => {
  it("builds the exact session frames", () => {
    expect(JSON.parse(buildList("r1"))).toEqual({ t: "list", req: "r1" });
    expect(JSON.parse(buildCatalog("r1"))).toEqual({ t: "catalog", req: "r1" });
    expect(JSON.parse(buildAttach("s1"))).toEqual({ t: "attach", id: "s1" });
    expect(JSON.parse(buildDetach("s1"))).toEqual({ t: "detach", id: "s1" });
    expect(JSON.parse(buildPrompt("r2", "s1", "hello"))).toEqual({
      t: "prompt",
      req: "r2",
      id: "s1",
      text: "hello",
    });
  });

  it("builds the exact spawn, compose and draft frames", () => {
    expect(
      JSON.parse(buildSpawn("r3", { kind: "agent", cli: "muse", workdir: "/home/u/demo" })),
    ).toEqual({ t: "spawn", req: "r3", kind: "agent", cli: "muse", workdir: "/home/u/demo" });
    expect(
      JSON.parse(
        buildSpawn("r4", {
          kind: "agent",
          cli: "muse",
          workdir: "/home/u/demo",
          name: "build",
          prompt: "do it",
          yolo: true,
        }),
      ),
    ).toEqual({
      t: "spawn",
      req: "r4",
      kind: "agent",
      cli: "muse",
      workdir: "/home/u/demo",
      name: "build",
      prompt: "do it",
      yolo: true,
    });
    // Unchecked yolo sends nothing; a missing kind is an agent.
    expect(JSON.parse(buildSpawn("r7", { cli: "muse", workdir: "/home/u/demo" }))).toEqual({
      t: "spawn",
      req: "r7",
      kind: "agent",
      cli: "muse",
      workdir: "/home/u/demo",
    });
    // A terminal is the user's shell: workdir and an optional name only.
    expect(JSON.parse(buildSpawn("r8", { kind: "terminal", workdir: "/home/u/demo" }))).toEqual({
      t: "spawn",
      req: "r8",
      kind: "terminal",
      workdir: "/home/u/demo",
    });
    expect(
      JSON.parse(
        buildSpawn("r9", {
          kind: "terminal",
          cli: "muse",
          workdir: "/home/u/demo",
          name: "shell",
          prompt: "ignored",
          yolo: true,
        }),
      ),
    ).toEqual({ t: "spawn", req: "r9", kind: "terminal", workdir: "/home/u/demo", name: "shell" });
    const draft = { sections: [{ title: "Goal", content: "ship it" }], skills: ["tdd"] };
    expect(JSON.parse(buildCompose("r5", draft))).toEqual({ t: "compose", req: "r5", draft });
    expect(JSON.parse(buildPromptDraft("r6", "s1", draft))).toEqual({
      t: "prompt",
      req: "r6",
      id: "s1",
      draft,
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

  it("parses spawned and composed", () => {
    expect(parseSpawned({ t: "spawned", req: "r1", id: "s9" })).toEqual({ req: "r1", id: "s9" });
    expect(parseSpawned({ t: "spawned", req: "r1" })).toBeNull();
    expect(parseSpawned({ t: "spawned", req: "r1", id: "" })).toBeNull();
    expect(parseComposed({ t: "composed", req: "r2", text: "hello" })).toEqual({
      req: "r2",
      text: "hello",
    });
    expect(parseComposed({ t: "composed", req: "r2" })).toBeNull();
    expect(parseComposed({ t: "ok", req: "r2" })).toBeNull();
  });

  it("reads the harness yolo flag defensively", () => {
    expect(
      parseCatalog({
        t: "catalog",
        req: "r1",
        clis: [
          { cli: "muse", label: "Muse", models: [], yolo: true },
          { cli: "claude", label: "Claude", models: [], yolo: false },
          { cli: "plain", label: "Plain", models: [] },
          { cli: "weird", label: "Weird", models: [], yolo: "yes" },
        ],
        projects: [],
        presets: [],
        skills: [],
      })?.clis,
    ).toEqual([
      { cli: "muse", label: "Muse", models: [], yolo: true },
      { cli: "claude", label: "Claude", models: [] },
      { cli: "plain", label: "Plain", models: [] },
      { cli: "weird", label: "Weird", models: [] },
    ]);
  });

  it("parses the catalog and drops malformed entries", () => {
    expect(
      parseCatalog({
        t: "catalog",
        req: "r1",
        clis: [
          { cli: "muse", label: "Muse", models: ["spark", 7] },
          { cli: "", label: "broken" },
          { label: "no cli" },
          { cli: "claude" },
        ],
        projects: [
          { name: "demo", path: "/home/u/demo" },
          { name: "no path" },
          { name: "empty path", path: "" },
        ],
        presets: [{ name: "review", preview: "look" }, { name: "" }, { preview: "orphan" }],
        skills: [{ name: "tdd", label: "TDD" }, { name: "docs" }],
      }),
    ).toEqual({
      clis: [
        { cli: "muse", label: "Muse", models: ["spark"] },
        { cli: "claude", label: "claude", models: [] },
      ],
      projects: [{ name: "demo", path: "/home/u/demo" }],
      presets: [{ name: "review", preview: "look" }],
      skills: [
        { name: "tdd", label: "TDD" },
        { name: "docs", label: "docs" },
      ],
    });
    expect(parseCatalog({ t: "catalog", req: "r1" })).toEqual({
      clis: [],
      projects: [],
      presets: [],
      skills: [],
    });
    expect(parseCatalog({ t: "sessions", items: [] })).toBeNull();
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

// The shelf half of v1: additive frames, each parsed on its own, so a
// host that sends none of them changes nothing.
describe("shelf frames", () => {
  const shelfItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    file_id: "f1",
    session_id: "s1",
    name: "gradient.png",
    mime: "image/png",
    size: 4096,
    caption: "colour wash",
    from: "muse",
    created_at: 1793100000,
    ...overrides,
  });

  it("builds the exact shelf requests", () => {
    expect(JSON.parse(buildShelfList("r1"))).toEqual({ t: "shelf_list", req: "r1" });
    expect(JSON.parse(buildShelfList("r2", "s1"))).toEqual({
      t: "shelf_list",
      req: "r2",
      id: "s1",
    });
    expect(JSON.parse(buildShelfGet("r3", "f9"))).toEqual({
      t: "shelf_get",
      req: "r3",
      file_id: "f9",
    });
  });

  it("reads hello features and treats a broken hello as featureless", () => {
    expect(parseHello({ t: "hello", features: ["shelf"] })).toEqual(["shelf"]);
    expect(parseHello({ t: "hello", features: [] })).toEqual([]);
    expect(parseHello({ t: "hello" })).toEqual([]);
    expect(parseHello({ t: "hello", features: ["shelf", 7] })).toEqual(["shelf"]);
    expect(parseHello({ t: "sessions", items: [] })).toBeNull();
    expect(parseHello(null)).toBeNull();
  });

  it("parses a shelf reply newest first, dropping broken items", () => {
    const parsed = parseShelf({
      t: "shelf",
      req: "r1",
      id: "s1",
      items: [
        shelfItem({ file_id: "old", created_at: 1793100000 }),
        shelfItem({ file_id: "new", created_at: 1793100060 }),
        shelfItem({ file_id: "" }),
        shelfItem({ session_id: 42 }),
        shelfItem({ file_id: "host", session_id: null, created_at: 1793100120 }),
      ],
    });
    expect(parsed?.req).toBe("r1");
    expect(parsed?.id).toBe("s1");
    expect(parsed?.items.map((item) => item.file_id)).toEqual(["host", "new", "old"]);
    // unix seconds in, epoch milliseconds out
    expect(parsed?.items[0]?.created_at).toBe(1793100120_000);
    expect(parsed?.items[0]?.session_id).toBeNull();
    expect(parsed?.items[1]?.caption).toBe("colour wash");
    // no id means the host's own shelf
    expect(parseShelf({ t: "shelf", req: "r2", items: [] })?.id).toBeNull();
    expect(parseShelf({ t: "shelf", req: "r2" })).toBeNull();
    expect(parseShelf({ t: "sessions", items: [] })).toBeNull();
  });

  it("parses shelf_added and shelf_removed", () => {
    expect(parseShelfAdded({ t: "shelf_added", item: shelfItem() })?.file_id).toBe("f1");
    expect(parseShelfAdded({ t: "shelf_added" })).toBeNull();
    expect(parseShelfAdded({ t: "shelf", items: [] })).toBeNull();
    expect(parseShelfRemoved({ t: "shelf_removed", file_id: "f1" })).toBe("f1");
    expect(parseShelfRemoved({ t: "shelf_removed", file_id: "" })).toBeNull();
    expect(parseShelfRemoved({ t: "shelf_removed" })).toBeNull();
  });

  it("parses file parts and refuses broken payloads", () => {
    const data = b64encode(new TextEncoder().encode("hello"));
    const part = parseFilePart({
      t: "file",
      req: "r1",
      file_id: "f1",
      part: 0,
      data,
      last: true,
    });
    expect(part?.req).toBe("r1");
    expect(part?.last).toBe(true);
    expect(part?.data).toEqual(new TextEncoder().encode("hello"));
    expect(parseFilePart({ t: "file", req: "r1", file_id: "f1", part: 0, data: "!!", last: true })).toBeNull();
    expect(parseFilePart({ t: "file", req: "r1", file_id: "", part: 0, data, last: true })).toBeNull();
    expect(parseFilePart({ t: "file", req: "r1", file_id: "f1", part: "0", data, last: true })).toBeNull();
    expect(parseFilePart({ t: "out", req: "r1" })).toBeNull();
  });

  it("ignores frames it does not know", () => {
    const unknown = { t: "shelf_v2", items: [] };
    expect(parseShelf(unknown)).toBeNull();
    expect(parseShelfAdded(unknown)).toBeNull();
    expect(parseShelfRemoved(unknown)).toBeNull();
    expect(parseFilePart(unknown)).toBeNull();
    expect(parseHello(unknown)).toBeNull();
  });
});

// The graph-watching frames: the list, the watch reply (summary plus the
// drawing the plate draws) and the live-state pushes. Malformed frames
// are rejected like the existing ones; one bad row never empties a reply.
describe("graph frames", () => {
  const summary = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "g1",
    name: "palette-loop",
    status: "running",
    workdir: "/home/u/demo",
    current_spec: "Draw the plate",
    current_node: "implementer",
    done: 1,
    total: 4,
    blocked: false,
    updated_at: 1793100000,
    ...overrides,
  });

  const state = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    t: "graph_state",
    status: "running",
    blocked: false,
    blocker: null,
    current_spec_id: "s2",
    current_node: "implementer",
    nodes: { start: "pass", implementer: "running" },
    specs: [
      { id: "s1", code: "FIX-1", name: "Lock the palette", status: "completed", attempts: 2 },
      { id: "s2", code: "FIX-2", name: "Draw the plate", status: "running", attempts: 1 },
    ],
    updated_at: 1793100000,
    ...overrides,
  });

  it("builds the exact graph requests", () => {
    expect(JSON.parse(buildGraphs("r1"))).toEqual({ t: "graphs", req: "r1" });
    expect(JSON.parse(buildGraphWatch("g1"))).toEqual({ t: "graph_watch", id: "g1" });
    expect(JSON.parse(buildGraphUnwatch("g1"))).toEqual({ t: "graph_unwatch", id: "g1" });
  });

  it("parses the graphs list and skips invalid rows", () => {
    const parsed = parseGraphs({
      t: "graphs",
      req: "r1",
      items: [summary(), summary({ id: "g2", status: "completed" }), { nope: true }],
    });
    expect(parsed).toEqual([
      {
        id: "g1",
        name: "palette-loop",
        status: "running",
        workdir: "/home/u/demo",
        current_spec: "Draw the plate",
        current_node: "implementer",
        done: 1,
        total: 4,
        blocked: false,
        updated_at: 1793100000_000,
      },
      expect.objectContaining({ id: "g2", status: "completed" }),
    ]);
    expect(parseGraphs({ t: "graphs" })).toBeNull();
    expect(parseGraphs({ t: "graphs", items: {} })).toBeNull();
    expect(parseGraphs({ t: "sessions", items: [] })).toBeNull();
    expect(parseGraphs(null)).toBeNull();
  });

  it("rejects a summary without an id or a status", () => {
    expect(parseGraphs({ t: "graphs", items: [summary({ id: "" })] })).toEqual([]);
    expect(parseGraphs({ t: "graphs", items: [summary({ status: "" })] })).toEqual([]);
    expect(parseGraphs({ t: "graphs", items: [{ name: "nameless" }] })).toEqual([]);
  });

  it("parses the watch reply with its drawing", () => {
    const doc = { name: "palette-loop", nodes: [], edges: [] };
    const parsed = parseGraph({ t: "graph", item: summary(), doc });
    expect(parsed?.summary.id).toBe("g1");
    expect(parsed?.summary.current_spec).toBe("Draw the plate");
    expect(parsed?.doc).toEqual(doc);
    // An unreadable drawing still delivers the summary: the view holds
    // the stage instead of the plate.
    expect(parseGraph({ t: "graph", item: summary() })?.doc).toBeNull();
    expect(parseGraph({ t: "graph", item: summary(), doc: "nope" })?.doc).toBeNull();
    expect(parseGraph({ t: "graph", item: { nope: true }, doc })).toBeNull();
    expect(parseGraph({ t: "graphs", items: [] })).toBeNull();
  });

  it("parses a live state with its overlay and checklist", () => {
    const parsed = parseGraphState(state());
    expect(parsed).toEqual({
      status: "running",
      blocked: false,
      blocker: null,
      current_spec_id: "s2",
      current_node: "implementer",
      nodes: { start: "pass", implementer: "running" },
      specs: [
        { id: "s1", code: "FIX-1", name: "Lock the palette", status: "completed", attempts: 2 },
        { id: "s2", code: "FIX-2", name: "Draw the plate", status: "running", attempts: 1 },
      ],
      updated_at: 1793100000_000,
    });
  });

  it("reads the blocker and tolerates thin rows", () => {
    const parsed = parseGraphState(
      state({
        blocked: true,
        blocker: "waiting on review",
        current_spec_id: "",
        current_node: null,
        nodes: { start: "pass", ghost: "exploded", "": "pass" },
        specs: [
          { id: "s9" },
          { id: "", status: "completed" },
          { id: "s10", code: "", name: "Retry", status: "interrupted", attempts: -1 },
        ],
      }),
    );
    expect(parsed?.blocked).toBe(true);
    expect(parsed?.blocker).toBe("waiting on review");
    expect(parsed?.current_spec_id).toBeNull();
    expect(parsed?.current_node).toBeNull();
    // Unknown node states and empty names never reach the overlay.
    expect(parsed?.nodes).toEqual({ start: "pass" });
    // Unknown spec states read as pending, never as completed.
    expect(parsed?.specs).toEqual([
      { id: "s9", code: null, name: "", status: "pending", attempts: 0 },
      { id: "s10", code: null, name: "Retry", status: "pending", attempts: 0 },
    ]);
  });

  it("rejects a state without a status, an overlay or a queue", () => {
    expect(parseGraphState(state({ status: "" }))).toBeNull();
    expect(parseGraphState(state({ nodes: "nope" }))).toBeNull();
    expect(parseGraphState(state({ specs: {} }))).toBeNull();
    expect(parseGraphState(state({ t: "graph" }))).toBeNull();
    expect(parseGraphState(null)).toBeNull();
  });
});
