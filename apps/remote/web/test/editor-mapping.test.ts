// SPDX-License-Identifier: Apache-2.0
/**
 * The remote editor's document mapping: `spec`/`next` against Start and
 * terminal nodes, the ensemble round trip, and the dissolve under two
 * members. Every exported document here also faces the catalogue's own
 * validator — the editor never writes one it refuses.
 */
import { describe, expect, it } from "vitest";
import { documentProblems, harnessProblems } from "../../../graphs/src/validate.js";
import {
  NEXT_PROBLEM,
  SPEC_PROBLEM,
  connectEditor,
  dissolveEnsemble,
  ensembleProblems,
  exportGraph,
  exportProblems,
  flowProblems,
  importGraph,
  makeEnsemble,
  removeEditorNode,
} from "../src/editor/mapping.js";
import {
  NEXT_ID,
  SPEC_ID,
  blankEditorState,
  newEditorId,
  type EditorState,
} from "../src/editor/state.js";

/** A blank canvas with one agent and one check, unconnected. */
function staged(): { state: EditorState; agent: string; check: string } {
  const state = blankEditorState();
  const agent = newEditorId();
  const check = newEditorId();
  state.nodes.push(
    { id: agent, name: "agent", kind: "agent", config: { prompt_template: "Do it." }, x: 380, y: 260 },
    { id: check, name: "check", kind: "check", config: { command: "npm test" }, x: 740, y: 260 },
  );
  return { state, agent, check };
}

/** True when the document is one the catalogue would share. */
function shareable(document: unknown): boolean {
  return (
    documentProblems("graph", document).length === 0 &&
    harnessProblems("graph", document).length === 0
  );
}

describe("spec and next", () => {
  it("reports both problems on a blank canvas", () => {
    expect(flowProblems(blankEditorState())).toEqual([SPEC_PROBLEM, NEXT_PROBLEM]);
    expect(exportProblems(blankEditorState())).toContain(SPEC_PROBLEM);
    expect(exportProblems(blankEditorState())).toContain(NEXT_PROBLEM);
  });

  it("exports spec as Start at position 1 and drops edges into next", () => {
    const { state, agent, check } = staged();
    connectEditor(state, SPEC_ID, agent, "pass");
    connectEditor(state, agent, check, "pass");
    connectEditor(state, check, NEXT_ID, "pass");
    expect(flowProblems(state)).toEqual([]);
    const document = exportGraph(state);
    expect(shareable(document)).toBe(true);
    const nodes = document["nodes"] as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node["name"])).toEqual(["Start", "agent", "check"]);
    expect(nodes[0]).toEqual({ name: "Start", kind: "check", position: 1, config: { command: "true" } });
    expect(nodes.map((node) => node["position"])).toEqual([1, 2, 3]);
    const edges = document["edges"] as Array<Record<string, unknown>>;
    expect(edges).toEqual([
      { from_node: "Start", to_node: "agent", condition: "pass" },
      { from_node: "agent", to_node: "check", condition: "pass" },
    ]);
  });

  it("still reports nothing reaches next when next is unwired", () => {
    const { state, agent } = staged();
    connectEditor(state, SPEC_ID, agent, "pass");
    expect(flowProblems(state)).toEqual([NEXT_PROBLEM]);
  });

  it("turns Start into spec and terminal nodes into passes to next on import", () => {
    const result = importGraph({
      format_version: 6,
      name: "chain",
      description: "",
      nodes: [
        { name: "Start", kind: "check", position: 1, config: { command: "true" } },
        { name: "build", kind: "agent", position: 2, config: { prompt_template: "Go." } },
        { name: "gate", kind: "gate", position: 3, config: {} },
      ],
      edges: [
        { from_node: "Start", to_node: "build", condition: "pass" },
        { from_node: "build", to_node: "gate", condition: "pass" },
      ],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    const { state } = result;
    // Start is gone as a node; spec carries its wiring.
    expect(state.nodes.map((node) => node.name).sort()).toEqual(["build", "gate", "next", "spec"]);
    const nameOf = (id: string): string => state.nodes.find((node) => node.id === id)?.name ?? "?";
    const pairs = state.edges.map((edge) => `${nameOf(edge.from)}→${nameOf(edge.to)}:${JSON.stringify(edge.condition)}`);
    expect(pairs).toContain("spec→build:\"pass\"");
    expect(pairs).toContain("build→gate:\"pass\"");
    // The terminal gate ends at next; nothing dangles.
    expect(pairs).toContain("gate→next:\"pass\"");
    expect(flowProblems(state)).toEqual([]);
    expect(shareable(exportGraph(state))).toBe(true);
  });

  it("ends a node with only a fail exit at next on import", () => {
    const result = importGraph({
      format_version: 6,
      name: "failing",
      description: "",
      nodes: [
        { name: "Start", kind: "check", position: 1, config: { command: "true" } },
        { name: "risky", kind: "agent", position: 2, config: {} },
        { name: "retry", kind: "agent", position: 3, config: {} },
      ],
      edges: [
        { from_node: "Start", to_node: "risky", condition: "pass" },
        { from_node: "risky", to_node: "retry", condition: "fail" },
      ],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    const { state } = result;
    const idOf = (name: string): string => state.nodes.find((node) => node.name === name)?.id ?? "";
    // risky has no pass or always exit, so it ends at next too.
    expect(state.edges).toContainEqual(expect.objectContaining({ from: idOf("risky"), to: NEXT_ID }));
    expect(state.edges).toContainEqual(expect.objectContaining({ from: idOf("retry"), to: NEXT_ID }));
  });

  it("refuses a harness-bound document with the harness reason", () => {
    const result = importGraph({
      format_version: 6,
      name: "bound",
      description: "",
      nodes: [{ name: "Start", kind: "check", position: 1, config: { command: "true" } }],
      edges: [],
      ensembles: [
        {
          name: "crew",
          commit_rights: false,
          prompt_template: "Go.",
          entry_from_node: "Start",
          entry_condition: "pass",
          on_pass_to: "Start",
          min_pass: 1,
          timeout_minutes: 30,
          members: [{ platform: "muse" }],
        },
      ],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("binds a harness");
    }
  });
});

describe("ensembles", () => {
  /** Three agents grouped, wired spec → ensemble → check → next. */
  function ensembled(): EditorState {
    const state = blankEditorState();
    const ids = ["a1", "a2", "a3"].map((name, index) => {
      const id = newEditorId();
      state.nodes.push({ id, name, kind: "agent", config: {}, x: 400 + index * 60, y: 260 });
      return id;
    });
    const made = makeEnsemble(state, ids);
    if ("error" in made) {
      throw new Error(made.error);
    }
    made.ensemble.name = "reviewers";
    made.ensemble.kind = "parallel";
    made.ensemble.min_pass = 2;
    made.ensemble.prompt = "Review the diff.";
    made.ensemble.overrides[ids[0] as string] = "Review for correctness.";
    const check = newEditorId();
    state.nodes.push({ id: check, name: "gate", kind: "gate", config: {}, x: 800, y: 260 });
    connectEditor(state, SPEC_ID, made.ensemble.id, "pass");
    connectEditor(state, made.ensemble.id, check, "pass");
    connectEditor(state, check, NEXT_ID, "pass");
    return state;
  }

  it("refuses groups outside 2–8 standing agents", () => {
    const state = blankEditorState();
    expect(makeEnsemble(state, [SPEC_ID, NEXT_ID])).toEqual({
      error: expect.stringContaining("2–8 agent nodes"),
    });
    const solo = newEditorId();
    state.nodes.push({ id: solo, name: "solo", kind: "agent", config: {}, x: 0, y: 0 });
    expect(makeEnsemble(state, [solo])).toEqual({ error: expect.stringContaining("2–8") });
  });

  it("round-trips through the document with its wiring", () => {
    const state = ensembled();
    expect(ensembleProblems(state)).toEqual([]);
    expect(flowProblems(state)).toEqual([]);
    const document = exportGraph(state);
    expect(shareable(document)).toBe(true);
    const ensembles = document["ensembles"] as Array<Record<string, unknown>>;
    expect(ensembles).toHaveLength(1);
    expect(ensembles[0]).toMatchObject({
      name: "reviewers",
      kind: "parallel",
      prompt_template: "Review the diff.",
      entry_from_node: "Start",
      entry_condition: "pass",
      on_pass_to: "gate",
      min_pass: 2,
      timeout_minutes: 30,
    });
    const members = ensembles[0]?.["members"] as Array<Record<string, unknown>>;
    expect(members).toHaveLength(3);
    expect(members[0]).toEqual({ prompt_override: "Review for correctness." });
    // Members are not top-level nodes.
    const names = (document["nodes"] as Array<Record<string, unknown>>).map((node) => node["name"]);
    expect(names).toEqual(["Start", "gate"]);

    const back = importGraph(document);
    expect("error" in back).toBe(false);
    if ("error" in back) {
      return;
    }
    const imported = back.state;
    expect(imported.ensembles).toHaveLength(1);
    const ensemble = imported.ensembles[0];
    expect(ensemble?.name).toBe("reviewers");
    expect(ensemble?.kind).toBe("parallel");
    expect(ensemble?.min_pass).toBe(2);
    expect(ensemble?.prompt).toBe("Review the diff.");
    expect(ensemble?.members).toHaveLength(3);
    const first = ensemble?.members[0] as string;
    expect(ensemble?.overrides[first]).toBe("Review for correctness.");
    expect(flowProblems(imported)).toEqual([]);
    expect(ensembleProblems(imported)).toEqual([]);
    // And the re-import exports the same shape again.
    const again = exportGraph(imported);
    expect(shareable(again)).toBe(true);
    expect((again["ensembles"] as Array<unknown>)).toHaveLength(1);
  });

  it("blocks export while an ensemble is half-wired", () => {
    const state = blankEditorState();
    const ids = [newEditorId(), newEditorId()];
    ids.forEach((id, index) => {
      state.nodes.push({ id, name: `m${index}`, kind: "agent", config: {}, x: 0, y: 0 });
    });
    const made = makeEnsemble(state, ids);
    if ("error" in made) {
      throw new Error(made.error);
    }
    expect(ensembleProblems(state)).toEqual([
      `ensemble ${made.ensemble.name} is not connected`,
      `ensemble ${made.ensemble.name} has no pass exit`,
    ]);
    // The half-wired ensemble stays out rather than breaking the document.
    expect(shareable(exportGraph(state))).toBe(true);
    expect(exportGraph(state)["ensembles"]).toBeUndefined();
  });

  it("dissolves below 2 members and frees the survivor", () => {
    const state = ensembled();
    const ensemble = state.ensembles[0];
    if (ensemble === undefined) {
      throw new Error("the ensemble was not built");
    }
    const [first, second] = ensemble.members;
    expect(removeEditorNode(state, first as string)).toEqual({ dissolved: null });
    expect(state.ensembles).toHaveLength(1);
    const dissolved = removeEditorNode(state, second as string);
    expect(dissolved).toEqual({ dissolved: "reviewers" });
    expect(state.ensembles).toHaveLength(0);
    // The survivor stands alone with the ensemble's edges gone.
    expect(state.edges.some((edge) => edge.from === ensemble.id || edge.to === ensemble.id)).toBe(false);
    expect(state.nodes.some((node) => node.id === ensemble.members[0])).toBe(true);
  });

  it("dissolves the whole ensemble on request", () => {
    const state = ensembled();
    const ensemble = state.ensembles[0];
    if (ensemble === undefined) {
      throw new Error("the ensemble was not built");
    }
    expect(dissolveEnsemble(state, ensemble.id)).toBe("reviewers");
    expect(state.ensembles).toHaveLength(0);
    // The ensemble's own edges went; the check still ends at next.
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0]?.to).toBe(NEXT_ID);
    expect(state.nodes.filter((node) => node.kind === "agent")).toHaveLength(3);
  });
});
