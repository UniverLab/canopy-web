// SPDX-License-Identifier: Apache-2.0
// Test-only graph fixtures behind fake.html: the three graphs the remote's
// Graphs tab and graph view speak over the session wire, and the in-memory
// channel handler that answers their frames. Split out of fake-host.ts to
// keep the fake entry a readable size.
import type { GraphState, GraphSummary, NodeStatus } from "./protocol.js";
import builderGraph from "../test/fixtures/builder-graph.json" with { type: "json" };

// --- The graph fixtures ----------------------------------------------
// Three graphs over the session wire: one running with an ensemble whose
// live state advances every 2 s (and completes a spec every few ticks),
// one already completed, and the lab's own builder loop — a plate whose
// failure terminals live in a side lane, with a `done` end and grouped
// error buses. The graph frames the remote's Graphs tab and graph view
// speak are answered exactly like the host spec describes.

/** The running graph's drawing: two checks, an agent, a commit and an ensemble. */
const LOOP_DOC = {
  name: "palette-loop",
  nodes: [
    { name: "start", kind: "check", position: 1, config: { command: "test -f package.json" } },
    { name: "implementer", kind: "agent", position: 2, config: { prompt_template: "Draw it." } },
    { name: "full-gates", kind: "check", position: 3, config: { command: "npm test" } },
    { name: "commit", kind: "check", position: 4, config: { command: "git diff --quiet" } },
  ],
  edges: [
    { from_node: "start", to_node: "implementer", condition: "pass" },
    { from_node: "full-gates", to_node: "commit", condition: "always" },
    { from_node: "full-gates", to_node: "implementer", condition: "fail" },
  ],
  ensembles: [
    {
      name: "review",
      kind: "parallel",
      min_pass: 1,
      members: [{ model: "muse" }, { model: "spark" }],
      entry_from_node: "implementer",
      entry_condition: "pass",
      on_pass_to: "full-gates",
      on_fail_to: "implementer",
    },
  ],
};

/** The completed graph's drawing: a plain three-step chain. */
const DONE_DOC = {
  name: "quality-bubble",
  nodes: [
    { name: "collect", kind: "check", position: 1, config: { command: "make collect" } },
    { name: "measure", kind: "agent", position: 2, config: { prompt_template: "Measure it." } },
    { name: "report", kind: "check", position: 3, config: { command: "make report" } },
  ],
  edges: [
    { from_node: "collect", to_node: "measure", condition: "pass" },
    { from_node: "measure", to_node: "report", condition: "pass" },
  ],
};

/**
 * The builder loop's drawing: the real canopy-builder document, copied
 * verbatim from apps/graphs/test/fixtures/graphs/canopy-builder/graph.json
 * so the phone sees the plate this spec restates — handlers in the side
 * lane, grouped inputs, and the `done` end after Relock repo.
 */
const BUILDER_DOC = builderGraph;

/** The builder's live state: on the first rank, nothing completed yet. */
const BUILDER_STATE: GraphState = {
  status: "running",
  blocked: false,
  blocker: null,
  current_spec_id: "b1",
  current_node: "Lock repo",
  nodes: { Start: "pass", "Lock repo": "running" },
  specs: [{ id: "b1", code: "LANE-1", name: "Draw the lane", status: "running", attempts: 1 }],
  updated_at: 0,
};

function builderSummary(nowMs: number): GraphSummary {
  return {
    id: "g-builder",
    name: "canopy-builder",
    status: "running",
    workdir: "/home/u/demo",
    current_spec: "Draw the lane",
    current_node: "Lock repo",
    done: 0,
    total: 3,
    blocked: false,
    updated_at: nowMs,
  };
}

/** The drawn units of the running graph, in walk order. */
const LOOP_UNITS = ["start", "implementer", "1·muse", "2·spark", "full-gates", "commit"];
/** The unit that runs at each tick of one round. */
const LOOP_STEPS = ["start", "implementer", "1·muse", "full-gates", "commit"];

function loopSummary(nowMs: number, state: GraphState): GraphSummary {
  const spec = state.specs.find((row) => row.status === "running");
  return {
    id: "g-loop",
    name: "palette-loop",
    status: state.status,
    workdir: "/home/u/demo",
    current_spec: spec === undefined ? "" : spec.name,
    current_node: state.current_node ?? "",
    done: state.specs.filter((row) => row.status === "completed").length,
    total: state.specs.length,
    blocked: state.blocked,
    updated_at: nowMs,
  };
}

/** The running overlay at one step: everything behind is passed. */
function loopOverlay(step: number): { current: string; nodes: Record<string, NodeStatus> } {
  const current = LOOP_STEPS[step % LOOP_STEPS.length];
  const currentRank = LOOP_UNITS.indexOf(current);
  const nodes: Record<string, NodeStatus> = {};
  for (const [rank, unit] of LOOP_UNITS.entries()) {
    if (unit === current) {
      nodes[unit] = "running";
    } else if (rank < currentRank) {
      nodes[unit] = "pass";
    }
  }
  // The ensemble runs in parallel: the second member may already be done.
  if (current === "1·muse") {
    nodes["2·spark"] = "pass";
  }
  return { current, nodes };
}

interface FakeGraphs {
  handle: (frame: Record<string, unknown>) => boolean;
  tick: () => void;
}

export function createFakeGraphs(deliver: (frame: unknown) => void): FakeGraphs {
  const startedAt = Date.now();
  const specs = (): GraphState["specs"] => [
    { id: "s1", code: "FIX-1", name: "Lock the palette", status: "completed", attempts: 2 },
    { id: "s2", code: "FIX-2", name: "Draw the plate", status: "running", attempts: 1 },
    { id: "s3", code: "FIX-3", name: "Watch it live", status: "pending", attempts: 1 },
    { id: "s4", code: null, name: "Ship the remote", status: "pending", attempts: 1 },
  ];
  const doneSpecs: GraphState["specs"] = [
    { id: "q1", code: "QA-1", name: "Collect the numbers", status: "completed", attempts: 1 },
    { id: "q2", code: "QA-2", name: "Measure the gap", status: "completed", attempts: 3 },
    { id: "q3", code: "QA-3", name: "Publish the report", status: "completed", attempts: 1 },
  ];
  const doneState: GraphState = {
    status: "completed",
    blocked: false,
    blocker: null,
    current_spec_id: null,
    current_node: null,
    nodes: { collect: "pass", measure: "pass", report: "pass" },
    specs: doneSpecs,
    updated_at: startedAt,
  };
  const doneSummary: GraphSummary = {
    id: "g-done",
    name: "quality-bubble",
    status: "completed",
    workdir: "/home/u/other",
    current_spec: "",
    current_node: "",
    done: 3,
    total: 3,
    blocked: false,
    updated_at: startedAt,
  };

  let loopStep = 0;
  let loopSpecs = specs();
  let loopStatus = "running";
  let loopTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  let watched: string | null = null;

  const loopState = (): GraphState => {
    const overlay = loopOverlay(loopStep);
    return {
      status: loopStatus,
      blocked: false,
      blocker: null,
      current_spec_id: loopSpecs.find((row) => row.status === "running")?.id ?? null,
      current_node: overlay.current,
      nodes: overlay.nodes,
      specs: loopSpecs,
      updated_at: Date.now(),
    };
  };

  /** Finish the running spec, promote the next, end the run when empty. */
  const completeSpec = (): void => {
    loopSpecs = loopSpecs.map((row) => {
      if (row.status === "running") {
        return { ...row, status: "completed" as const };
      }
      if (row.status === "pending") {
        return row;
      }
      return row;
    });
    const next = loopSpecs.find((row) => row.status === "pending");
    if (next !== undefined) {
      loopSpecs = loopSpecs.map((row) => (row.id === next.id ? { ...row, status: "running" as const } : row));
      return;
    }
    loopStatus = "completed";
    if (loopTimer !== null) {
      globalThis.clearInterval(loopTimer);
      loopTimer = null;
    }
  };

  const tick = (): void => {
    if (watched !== "g-loop" || loopStatus !== "running") {
      return;
    }
    loopStep += 1;
    if (loopStep >= LOOP_STEPS.length) {
      loopStep = 0;
      completeSpec();
    }
    deliver(stateFrame("g-loop", loopState()));
  };

  const stateFrame = (id: string, state: GraphState): unknown => ({ t: "graph_state", id, ...state });

  return {
    handle(frame: Record<string, unknown>): boolean {
      if (frame.t === "graphs") {
        deliver({
          t: "graphs",
          req: typeof frame.req === "string" ? frame.req : null,
          items: [loopSummary(startedAt, loopState()), doneSummary, builderSummary(startedAt)],
        });
        return true;
      }
      if (frame.t === "graph_watch" && typeof frame.id === "string") {
        if (frame.id !== "g-loop" && frame.id !== "g-done" && frame.id !== "g-builder") {
          return true;
        }
        watched = frame.id;
        if (frame.id === "g-builder") {
          deliver({
            t: "graph",
            item: builderSummary(Date.now()),
            doc: BUILDER_DOC,
          });
          deliver(stateFrame("g-builder", { ...BUILDER_STATE, updated_at: Date.now() }));
        } else if (frame.id === "g-loop") {
          deliver({ t: "graph", item: loopSummary(Date.now(), loopState()), doc: LOOP_DOC });
          deliver(stateFrame("g-loop", loopState()));
          if (loopTimer === null) {
            loopTimer = globalThis.setInterval(tick, 2000);
          }
        } else {
          deliver({ t: "graph", item: doneSummary, doc: DONE_DOC });
          deliver(stateFrame("g-done", doneState));
        }
        return true;
      }
      if (frame.t === "graph_unwatch") {
        if (frame.id === "g-loop" && loopTimer !== null) {
          globalThis.clearInterval(loopTimer);
          loopTimer = null;
        }
        if (watched === frame.id) {
          watched = null;
        }
        return true;
      }
      return false;
    },
    tick,
  };
}
