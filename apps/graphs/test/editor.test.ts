// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's pure halves: the topological ordering that becomes the
 * exported `position`, the unique-name suffixer, the refusal that keeps
 * `platform`, `model` and `cli` out of every document the editor
 * imports, and the localStorage serializer (round trip, malformed text,
 * throwing storage). Everything runs in the workers pool against the
 * same modules the browser bundle carries — no DOM here.
 */
import { describe, expect, it } from "vitest";
import { levelsOf, positionsOf } from "../src/editor/order.js";
import {
  addCatalogNode,
  addBlankNode,
  ensembleBound,
  exportGraph,
  importGraph,
  importNodeDocument,
} from "../src/editor/document.js";
import {
  STORAGE_KEY,
  blankState,
  clearSaved,
  deserialize,
  isSlugName,
  loadSaved,
  saveSaved,
  serialize,
  uniqueName,
  type EditorState,
  type StorageLike,
} from "../src/editor/state.js";
import { documentProblems, harnessProblems } from "../src/validate.js";
import { EDITOR_ENSEMBLE_NODE, EDITOR_IMPORT_HARNESS } from "../src/pages/copy.js";

/** A valid graph document with the sections the editor must keep. */
function fixtureDocument(): Record<string, unknown> {
  return {
    format_version: 6,
    name: "sample-graph",
    description: "A sample.",
    nodes: [
      { name: "build", kind: "agent", position: 1, config: { prompt_template: "Go." } },
      { name: "test", kind: "check", position: 2, config: { command: "npm test" } },
      { name: "gate", kind: "gate", position: 3, config: {} },
    ],
    edges: [
      { from_node: "build", to_node: "test", condition: "pass" },
      { from_node: "test", to_node: "build", condition: "fail" },
      { from_node: "test", to_node: "gate", condition: "always" },
    ],
    ensembles: [
      {
        name: "reviewers",
        kind: "parallel",
        commit_rights: false,
        prompt_template: "Review.",
        entry_from_node: "gate",
        entry_condition: "pass",
        on_pass_to: "build",
        min_pass: 1,
        timeout_minutes: 30,
      },
    ],
    infra_node: "test",
    hooks: { on_completed: [{ command: "echo done" }], on_failed: [], on_blocked: [], on_spec_completed: [] },
    presets: { quick: { content: { timeout_minutes: 5 } } },
  };
}

describe("the topological ordering", () => {
  it("ranks a chain forward and lets fail edges point backwards", () => {
    const nodes = [
      { id: "a", x: 40, y: 40 },
      { id: "b", x: 40, y: 40 },
      { id: "c", x: 40, y: 40 },
    ];
    // The export path passes only the non-fail edges: b -> a is a fail
    // edge in the document, so it never reaches this call.
    const positions = positionsOf(nodes, [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(positions.get("a")).toBe(1);
    expect(positions.get("b")).toBe(2);
    expect(positions.get("c")).toBe(3);
  });

  it("breaks ties by canvas x, then y", () => {
    const nodes = [
      { id: "right", x: 300, y: 10 },
      { id: "upper", x: 100, y: 10 },
      { id: "lower", x: 100, y: 90 },
    ];
    const positions = positionsOf(nodes, []);
    expect(positions.get("upper")).toBe(1);
    expect(positions.get("lower")).toBe(2);
    expect(positions.get("right")).toBe(3);
  });

  it("places every node of a cycle instead of stalling", () => {
    const nodes = [
      { id: "a", x: 10, y: 10 },
      { id: "b", x: 5, y: 50 },
      { id: "c", x: 80, y: 70 },
    ];
    const positions = positionsOf(nodes, [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ]);
    expect(positions.size).toBe(3);
    // The fallback takes the smallest canvas point first: b (x 5).
    expect(positions.get("b")).toBe(1);
    expect([...positions.values()].sort()).toEqual([1, 2, 3]);
  });

  it("ignores self-edges and unknown endpoints", () => {
    const positions = positionsOf([{ id: "a", x: 1, y: 1 }], [
      { from: "a", to: "a" },
      { from: "a", to: "ghost" },
      { from: "ghost", to: "a" },
    ]);
    expect(positions.get("a")).toBe(1);
  });

  it("levels imported nodes one past their deepest predecessor", () => {
    const levels = levelsOf(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 1, y: 0 },
        { id: "c", x: 2, y: 0 },
      ],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    );
    expect(levels.get("a")).toBe(0);
    expect(levels.get("b")).toBe(1);
    expect(levels.get("c")).toBe(2);
  });
});

describe("unique naming", () => {
  it("keeps a free name and suffixes a taken one", () => {
    expect(uniqueName("agent", new Set())).toBe("agent");
    expect(uniqueName("agent", new Set(["agent"]))).toBe("agent-2");
    expect(uniqueName("agent", new Set(["agent", "agent-2"]))).toBe("agent-3");
  });

  it("stays inside the 48-character slug rule while suffixing", () => {
    const base = "x".repeat(48);
    const name = uniqueName(base, new Set([base]));
    expect(name.endsWith("-2")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(48);
    expect(isSlugName(name)).toBe(true);
  });

  it("names blank nodes uniquely on the canvas", () => {
    const state = blankState();
    const first = addBlankNode(state, "agent", { x: 0, y: 0 });
    const second = addBlankNode(state, "agent", { x: 0, y: 0 });
    expect(first.name).toBe("agent");
    expect(second.name).toBe("agent-2");
    expect(state.nodes.map((node) => node.name)).toEqual(["agent", "agent-2"]);
  });
});

describe("harness-key refusal", () => {
  it("refuses an imported graph carrying platform, model or cli", () => {
    const document = fixtureDocument();
    const nodes = document["nodes"] as Array<Record<string, unknown>>;
    nodes[0] = { ...nodes[0], config: { prompt_template: "Go.", model: "codex" } };
    const result = importGraph(document);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain(EDITOR_IMPORT_HARNESS);
      expect(result.error).toContain("#/nodes/0/config/model");
      expect(result.error).toContain("platform, model or cli");
    }
  });

  it("refuses an imported node document the same way", () => {
    const result = importNodeDocument({
      format_version: 1,
      name: "bound-node",
      kind: "agent",
      description: "",
      config: { prompt_template: "x", platform: "claude" },
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain(EDITOR_IMPORT_HARNESS);
      expect(result.error).toContain("#/config/platform");
    }
  });

  it("refuses an ensemble-kind catalogue node outright", () => {
    const state = blankState();
    const result = addCatalogNode(
      state,
      { name: "crew", kind: "ensemble", description: "", config: {} },
      { x: 0, y: 0 },
    );
    expect("error" in result && result.error).toBe(EDITOR_ENSEMBLE_NODE);
    expect(state.nodes).toHaveLength(0);
  });

  it("counts a typed-in harness key as a live problem", () => {
    const state = blankState();
    addBlankNode(state, "agent", { x: 0, y: 0 });
    state.nodes[0]!.config = { cli: "opus" };
    const problems = harnessProblems("graph", exportGraph(state));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe("#/nodes/0/config/cli");
  });
});

describe("the state serializer", () => {
  function fullState(): EditorState {
    const state = blankState();
    state.name = "kept-name";
    state.description = "kept description";
    state.sections = {
      infra_node: "test",
      presets: { quick: { content: { timeout_minutes: 5 } } },
    };
    const node = addBlankNode(state, "router", { x: 120, y: 240 });
    state.edges.push({ id: "e1", from: node.id, to: node.id, condition: { route: "ship" } });
    return state;
  }

  it("round-trips a full snapshot through its JSON text", () => {
    const state = fullState();
    const text = serialize(state, "?from=hello-graph");
    const back = deserialize(text);
    expect(back).not.toBeNull();
    expect(back?.v).toBe(1);
    expect(back?.source).toBe("?from=hello-graph");
    expect(back?.state).toEqual(state);
  });

  it("answers null for text that is not a snapshot", () => {
    for (const text of ["", "not json", "[]", '{"v":2,"source":"","state":{}}', '{"v":1}']) {
      expect(deserialize(text), text).toBeNull();
    }
    // A snapshot missing a node field is refused wholesale.
    const broken = JSON.parse(serialize(fullState(), "")) as Record<string, unknown>;
    const state = broken["state"] as Record<string, unknown>;
    (state["nodes"] as Array<Record<string, unknown>>)[0] = { id: "n" };
    expect(deserialize(JSON.stringify(broken))).toBeNull();
  });

  it("stores, restores and clears under the one key, swallowing failures", () => {
    const kept = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (key) => kept.get(key) ?? null,
      setItem: (key, value) => kept.set(key, value),
      removeItem: (key) => kept.delete(key),
    };
    const state = fullState();
    saveSaved(storage, state, "?draft=x");
    expect(kept.has(STORAGE_KEY)).toBe(true);
    expect(loadSaved(storage)?.state).toEqual(state);
    clearSaved(storage);
    expect(kept.has(STORAGE_KEY)).toBe(false);
    expect(loadSaved(storage)).toBeNull();

    const broken: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadSaved(broken)).toBeNull();
    expect(() => saveSaved(broken, state, "")).not.toThrow();
    expect(() => clearSaved(broken)).not.toThrow();
    expect(loadSaved(null)).toBeNull();
    expect(() => saveSaved(null, state, "")).not.toThrow();
  });
});

describe("the document round trip", () => {
  it("keeps untouched sections and orders positions over non-fail edges", () => {
    const imported = importGraph(fixtureDocument());
    expect("state" in imported).toBe(true);
    if (!("state" in imported)) {
      return;
    }
    const state = imported.state;
    expect(state.sections["infra_node"]).toBe("test");
    expect(state.sections["ensembles"]).toBeDefined();
    expect(state.sections["hooks"]).toBeDefined();
    expect(state.sections["presets"]).toBeDefined();

    // The forward chain orders the export; the fail edge test->build may
    // point backwards and never contributes a position.
    const test = state.nodes.find((node) => node.name === "test");
    expect(test).toBeDefined();
    const exported = exportGraph(state);
    const nodes = exported["nodes"] as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node["name"])).toEqual(["build", "test", "gate"]);
    expect(nodes.map((node) => node["position"])).toEqual([1, 2, 3]);
    expect(exported["ensembles"]).toEqual(fixtureDocument()["ensembles"]);
    expect(exported["hooks"]).toEqual(fixtureDocument()["hooks"]);
    expect(exported["infra_node"]).toBe("test");
    expect(exported["presets"]).toEqual(fixtureDocument()["presets"]);
    expect(documentProblems("graph", exported)).toEqual([]);
    expect(harnessProblems("graph", exported)).toEqual([]);
  });

  it("places an imported graph in level columns and reconnects its edges", () => {
    const imported = importGraph(fixtureDocument());
    if (!("state" in imported)) {
      throw new Error("the fixture must import");
    }
    const state = imported.state;
    const byName = new Map(state.nodes.map((node) => [node.name, node]));
    const build = byName.get("build");
    const test = byName.get("test");
    const gate = byName.get("gate");
    expect(build?.x).toBeLessThan(test?.x ?? 0);
    expect(test?.x).toBeLessThan(gate?.x ?? 0);
    expect(state.edges).toHaveLength(3);
    const fail = state.edges.find((edge) => edge.condition === "fail");
    expect(fail).toBeDefined();
    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    expect(byId.get(fail?.from ?? "")?.name).toBe("test");
    expect(byId.get(fail?.to ?? "")?.name).toBe("build");
  });

  it("merges a catalogue node's preset without overwriting an opened one", () => {
    const imported = importGraph(fixtureDocument());
    if (!("state" in imported)) {
      throw new Error("the fixture must import");
    }
    const state = imported.state;
    const added = addCatalogNode(
      state,
      {
        name: "hello-node",
        kind: "agent",
        description: "",
        config: { prompt_template: "Plan." },
        preset: { name: "quick", content: { timeout_minutes: 99 } },
      },
      { x: 10, y: 10 },
    );
    expect("node" in added).toBe(true);
    // The opened document's `quick` wins: presets of an opened graph are kept.
    const presets = state.sections["presets"] as Record<string, unknown>;
    expect(presets["quick"]).toEqual({ content: { timeout_minutes: 5 } });
    // And a second node under a fresh preset name lands, referenced by the agent.
    const second = addCatalogNode(
      state,
      {
        name: "other-node",
        kind: "agent",
        description: "",
        config: {},
        preset: { name: "other", content: "Do it." },
      },
      { x: 10, y: 80 },
    );
    expect("node" in second).toBe(true);
    if ("node" in second) {
      expect(second.node.config["prompt_preset"]).toBe("other");
    }
    const merged = state.sections["presets"] as Record<string, unknown>;
    expect(merged["other"]).toEqual({ content: "Do it." });
    expect(documentProblems("graph", exportGraph(state))).toEqual([]);
  });

  it("knows which nodes an ensemble wired, so they cannot be deleted", () => {
    const imported = importGraph(fixtureDocument());
    if (!("state" in imported)) {
      throw new Error("the fixture must import");
    }
    expect(ensembleBound(imported.state, "gate")).toBe(true);
    expect(ensembleBound(imported.state, "build")).toBe(true);
    expect(ensembleBound(imported.state, "test")).toBe(false);
  });
});
