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
  buildPromptDraft,
  buildPromptSchedule,
  buildResize,
  buildScheduledCancel,
  buildScheduledList,
  buildShelfDelete,
  buildShelfGet,
  buildShelfList,
  buildSpawn,
  formatLastOutput,
  newReqId,
  parseCatalog,
  parseComposed,
  parseError,
  parseExited,
  parseFilePart,
  parseForbidden,
  parseGraph,
  parseGraphState,
  parseGraphs,
  parseHello,
  parseOk,
  parseOut,
  parseResized,
  parseScheduled,
  parseScheduledList,
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
import { sanitizeRemoteError } from "../src/errors.js";

describe("builders", () => {
  it("builds the exact session frames", () => {
    expect(JSON.parse(buildList("r1"))).toEqual({ t: "list", req: "r1" });
    expect(JSON.parse(buildCatalog("r1"))).toEqual({ t: "catalog", req: "r1" });
    expect(JSON.parse(buildAttach("s1"))).toEqual({ t: "attach", id: "s1" });
    expect(JSON.parse(buildDetach("s1"))).toEqual({ t: "detach", id: "s1" });
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
    expect(JSON.parse(buildPromptSchedule("r10", "s1", draft, "2030-01-01T09:00:00.000Z"))).toEqual({
      t: "prompt_schedule",
      req: "r10",
      id: "s1",
      draft,
      fire_at: "2030-01-01T09:00:00.000Z",
    });
    expect(JSON.parse(buildScheduledList("r11", "s1"))).toEqual({
      t: "scheduled_list",
      req: "r11",
      id: "s1",
    });
    expect(JSON.parse(buildScheduledCancel("r12", "s1", "ss-3"))).toEqual({
      t: "scheduled_cancel",
      req: "r12",
      id: "s1",
      schedule_id: "ss-3",
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

  it("builds the exact resize frame", () => {
    expect(JSON.parse(buildResize("s1", 100, 40))).toEqual({
      t: "resize",
      id: "s1",
      cols: 100,
      rows: 40,
    });
    // The host parses u16 sizes: fractions floor, zeroes clamp to one.
    expect(JSON.parse(buildResize("s1", 99.7, 0))).toEqual({
      t: "resize",
      id: "s1",
      cols: 99,
      rows: 1,
    });
    // Non-finite sizes clamp to one: JSON.stringify would write null, which
    // the host's size_field rejects as a missing field.
    expect(JSON.parse(buildResize("s1", Number.NaN, Number.POSITIVE_INFINITY))).toEqual({
      t: "resize",
      id: "s1",
      cols: 1,
      rows: 1,
    });
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
        kind: "agent",
        last_output_at: 1793100000,
      }),
    ).toEqual({
      id: "s1",
      name: "build",
      cli: "muse",
      model: "spark",
      workdir: "/home/u/proj",
      status: "running",
      kind: "agent",
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
      kind: "",
      lastOutputAt: null,
    });
    expect(parseSessionItem({ name: "x" })).toBeNull();
    expect(parseSessionItem(null)).toBeNull();
  });
});

describe("frame parsers", () => {
  it("parses sessions and skips invalid items", () => {
    expect(parseSessions({ t: "sessions", req: "r1", items: [{ id: "a" }, { nope: true }] })).toEqual([
      { id: "a", name: "", cli: "", model: "", workdir: "", status: "", kind: "", lastOutputAt: null },
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

  it("parses resized frames with a valid size only", () => {
    expect(parseResized({ t: "resized", id: "a", cols: 120, rows: 40 })).toEqual({
      id: "a",
      cols: 120,
      rows: 40,
    });
    // The host's size bounds, 1..=65535 on both axes.
    expect(parseResized({ t: "resized", id: "a", cols: 1, rows: 65535 })).toEqual({
      id: "a",
      cols: 1,
      rows: 65535,
    });
    for (const bad of [
      { t: "resized", id: "a", cols: 0, rows: 40 },
      { t: "resized", id: "a", cols: 120, rows: 65536 },
      { t: "resized", id: "a", cols: 120.5, rows: 40 },
      { t: "resized", id: "a", cols: "120", rows: 40 },
      { t: "resized", id: "a", cols: 120 },
      { t: "resized", id: "", cols: 120, rows: 40 },
      { t: "resized", cols: 120, rows: 40 },
      { t: "resize", id: "a", cols: 120, rows: 40 },
      null,
      "resized",
    ]) {
      expect(parseResized(bad)).toBeNull();
    }
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

  it("parses a denied guest attach with or without a message", () => {
    expect(parseForbidden({ t: "error", code: "forbidden", id: "s9" })).toEqual({ id: "s9" });
    expect(parseForbidden({ t: "error", code: "forbidden", id: "s9", message: "no grant" })).toEqual({
      id: "s9",
    });
    expect(parseForbidden({ t: "error", code: "forbidden" })?.id).toBeNull();
    expect(parseForbidden({ t: "error", code: "forbidden", id: "" })?.id).toBeNull();
    expect(parseForbidden({ t: "error", code: "internal", message: "boom" })).toBeNull();
    expect(parseForbidden({ t: "ok", req: "r1" })).toBeNull();
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

  it("parses scheduled and scheduled_list", () => {
    const item = { id: "ss-1", fire_at: "2030-01-01T09:00:00.000Z", preview: "review it" };
    expect(parseScheduled({ t: "scheduled", req: "r1", item })).toEqual({
      req: "r1",
      item: { id: "ss-1", fireAt: "2030-01-01T09:00:00.000Z", preview: "review it" },
    });
    expect(parseScheduled({ t: "scheduled", req: "r1" })).toBeNull();
    expect(parseScheduled({ t: "scheduled", req: "r1", item: { id: "", fire_at: "", preview: 7 } })).toBeNull();
    expect(parseScheduled({ t: "ok", req: "r1" })).toBeNull();
    expect(
      parseScheduledList({ t: "scheduled_list", req: "r2", id: "s1", items: [item] }),
    ).toEqual({
      req: "r2",
      id: "s1",
      items: [{ id: "ss-1", fireAt: "2030-01-01T09:00:00.000Z", preview: "review it" }],
    });
    // Malformed entries are dropped, like a catalog frame's.
    expect(
      parseScheduledList({
        t: "scheduled_list",
        req: "r2",
        id: "s1",
        items: [item, { id: "", fire_at: "x", preview: "bad" }, null],
      })?.items,
    ).toHaveLength(1);
    expect(parseScheduledList({ t: "scheduled_list", req: "r2", id: "s1" })).toBeNull();
    expect(parseScheduledList({ t: "scheduled_list", req: "r2", id: "", items: [] })).toBeNull();
    expect(parseScheduledList({ t: "scheduled_list", req: "r2", id: "s1", items: {} })).toBeNull();
    expect(parseScheduledList({ t: "shelf", req: "r2", items: [] })).toBeNull();
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
    expect(JSON.parse(buildShelfDelete("r4", "f9"))).toEqual({
      t: "shelf_delete",
      req: "r4",
      file_id: "f9",
    });
  });

  it("reads hello features and treats a broken hello as featureless", () => {
    expect(parseHello({ t: "hello", features: ["shelf"] })).toEqual({ features: ["shelf"], harnesses: null });
    expect(parseHello({ t: "hello", features: [] })).toEqual({ features: [], harnesses: null });
    expect(parseHello({ t: "hello" })).toEqual({ features: [], harnesses: null });
    expect(parseHello({ t: "hello", features: ["shelf", 7] })).toEqual({
      features: ["shelf"],
      harnesses: null,
    });
    expect(parseHello({ t: "sessions", items: [] })).toBeNull();
    expect(parseHello(null)).toBeNull();
  });

  it("reads hello harnesses, unknown when absent or malformed", () => {
    expect(parseHello({ t: "hello", harnesses: ["muse"] })).toEqual({ features: [], harnesses: ["muse"] });
    expect(parseHello({ t: "hello", harnesses: ["muse", "", 7] })).toEqual({
      features: [],
      harnesses: ["muse"],
    });
    expect(parseHello({ t: "hello", harnesses: [] })).toEqual({ features: [], harnesses: [] });
    expect(parseHello({ t: "hello", harnesses: "muse" })).toEqual({ features: [], harnesses: null });
  });

  it("sanitizes harness failures to a name and a reason, never a path", () => {
    expect(
      sanitizeRemoteError(
        "spawn_failed",
        'spawn "opencode" failed: No such file or directory (PATH=/usr/local/bin:/usr/bin:/bin)',
      ),
    ).toBe('harness "opencode" is not installed on this host');
    expect(sanitizeRemoteError("spawn_failed", "sh: opencode: command not found")).toBe(
      'harness "opencode" is not installed on this host',
    );
    expect(sanitizeRemoteError("spawn_failed", 'spawn failed: "opencode" not found')).toBe(
      'harness "opencode" is not installed on this host',
    );
    // A quoted name outside a harness/spawn context is not a harness:
    // skill, preset and file complaints pass through untouched.
    expect(sanitizeRemoteError("unknown_skill", 'skill "tdd" not found')).toBe('skill "tdd" not found');
    expect(sanitizeRemoteError("internal", 'file "notes.md" not found')).toBe('file "notes.md" not found');
    const stripped = sanitizeRemoteError("spawn_failed", "spawn failed: signal in /home/u/demo/run.sh");
    expect(stripped).not.toContain("/");
    // A bad directory echoes what the user typed, not the host's disk.
    expect(sanitizeRemoteError("unknown_project", "unknown workdir: /home/u/nope")).toBe(
      "unknown workdir: /home/u/nope",
    );
    expect(sanitizeRemoteError("delivery_failed", "host is gone")).toBe("host is gone");
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

// The graph-watching frames: the list, the watch reply (the id, the
// document the plate draws and the first live state) and the live-state
// pushes. Shapes are the host's verbatim (graphs.rs); malformed frames
// are rejected like the existing ones; one bad row never empties a reply.
describe("graph frames", () => {
  // The host's updated_at is RFC3339 (graphs.rs:48-67,71-86).
  const AT = "2026-11-02T10:30:00.000Z";
  const AT_MS = Date.parse(AT);

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
    updated_at: AT,
    ...overrides,
  });

  const statePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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
    updated_at: AT,
    ...overrides,
  });

  const state = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    t: "graph_state",
    id: "g1",
    state: statePayload(),
    ...overrides,
  });

  const reply = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    t: "graph",
    req: "r7",
    id: "g1",
    document: { name: "palette-loop", nodes: [], edges: [] },
    state: statePayload(),
    ...overrides,
  });

  it("builds the exact graph requests", () => {
    expect(JSON.parse(buildGraphs("r1"))).toEqual({ t: "graphs", req: "r1" });
    expect(JSON.parse(buildGraphWatch("r1", "g1"))).toEqual({ t: "graph_watch", req: "r1", id: "g1" });
    expect(JSON.parse(buildGraphUnwatch("g1"))).toEqual({ t: "graph_unwatch", id: "g1" });
  });

  it("parses the graphs list and skips invalid rows", () => {
    const parsed = parseGraphs({
      t: "graphs",
      req: "r1",
      graphs: [summary(), summary({ id: "g2", status: "completed" }), { nope: true }],
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
        updated_at: AT_MS,
      },
      expect.objectContaining({ id: "g2", status: "completed" }),
    ]);
    expect(parseGraphs({ t: "graphs" })).toBeNull();
    expect(parseGraphs({ t: "graphs", graphs: {} })).toBeNull();
    // The pre-fix `items` shape answers nothing: a frame shaped like the
    // drift parses to null instead of an empty list.
    expect(parseGraphs({ t: "graphs", items: [] })).toBeNull();
    expect(parseGraphs({ t: "sessions", graphs: [] })).toBeNull();
    expect(parseGraphs(null)).toBeNull();
  });

  it("rejects a summary without an id or a status", () => {
    expect(parseGraphs({ t: "graphs", graphs: [summary({ id: "" })] })).toEqual([]);
    expect(parseGraphs({ t: "graphs", graphs: [summary({ status: "" })] })).toEqual([]);
    expect(parseGraphs({ t: "graphs", graphs: [{ name: "nameless" }] })).toEqual([]);
  });

  it("reads numeric updated_at as seconds or milliseconds", () => {
    expect(
      parseGraphs({ t: "graphs", graphs: [summary({ updated_at: 1793100000 })] })?.[0]?.updated_at,
    ).toBe(1793100000_000);
    expect(
      parseGraphs({ t: "graphs", graphs: [summary({ updated_at: 1793100000_000 })] })?.[0]
        ?.updated_at,
    ).toBe(1793100000_000);
    expect(
      parseGraphState(state({ state: statePayload({ updated_at: 1793100000 }) }))?.updated_at,
    ).toBe(1793100000_000);
  });

  it("rebuilds the watch reply summary from the document and the state", () => {
    const parsed = parseGraph(reply());
    expect(parsed?.summary).toEqual({
      id: "g1",
      name: "palette-loop",
      status: "running",
      workdir: "",
      current_spec: "Draw the plate",
      current_node: "implementer",
      done: 1,
      total: 2,
      blocked: false,
      updated_at: AT_MS,
    });
    expect(parsed?.doc).toEqual({ name: "palette-loop", nodes: [], edges: [] });
    // The reply's initial state rides along for the store.
    expect(parsed?.state.current_node).toBe("implementer");
    // A current spec id with no matching row reads as no current spec.
    expect(
      parseGraph(reply({ state: statePayload({ current_spec_id: "gone" }) }))?.summary
        .current_spec,
    ).toBe("");
    // An unreadable drawing still delivers the summary: the view holds
    // the stage instead of the plate.
    expect(parseGraph(reply({ document: "nope" }))?.doc).toBeNull();
    expect(parseGraph(reply({ document: "nope" }))?.summary.name).toBe("");
    // The legacy doc field still answers when document is absent.
    expect(
      parseGraph({ t: "graph", id: "g1", state: statePayload(), doc: { name: "old" } })?.doc,
    ).toEqual({ name: "old" });
    expect(parseGraph(reply({ id: "" }))).toBeNull();
    expect(parseGraph(reply({ state: { nope: true } }))).toBeNull();
    expect(parseGraph(reply({ state: statePayload({ status: "" }) }))).toBeNull();
    expect(parseGraph({ t: "graphs", graphs: [] })).toBeNull();
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
      updated_at: AT_MS,
    });
    // The frame id selects nothing: a push for any id parses the same.
    expect(parseGraphState(state({ id: "other" }))?.status).toBe("running");
  });

  it("reads the blocker and tolerates thin rows", () => {
    const parsed = parseGraphState(
      state({
        state: statePayload({
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

  it("reads prototype-named spec states as pending, never as inherited members", () => {
    // A word like "constructor" resolves to a prototype member through a
    // plain lookup; the checklist paint (specMark) would then read
    // undefined and throw inside the view. Own keys only, like the chips.
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const parsed = parseGraphState(
        state({ state: statePayload({ specs: [{ id: "s1", status: word }] }) }),
      );
      expect(parsed?.specs).toEqual([
        { id: "s1", code: null, name: "", status: "pending", attempts: 0 },
      ]);
    }
  });

  it("rejects a state without a status, an overlay or a queue", () => {
    expect(parseGraphState(state({ state: statePayload({ status: "" }) }))).toBeNull();
    expect(parseGraphState(state({ state: statePayload({ nodes: "nope" }) }))).toBeNull();
    expect(parseGraphState(state({ state: statePayload({ specs: {} }) }))).toBeNull();
    expect(parseGraphState(state({ state: null }))).toBeNull();
    // The pre-fix flat shape answers nothing: the payload lives nested.
    expect(parseGraphState({ t: "graph_state", id: "g1", ...statePayload() })).toBeNull();
    expect(parseGraphState(state({ t: "graph" }))).toBeNull();
    expect(parseGraphState(null)).toBeNull();
  });
});
