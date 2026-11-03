// SPDX-License-Identifier: Apache-2.0
// Test-only graph fixtures behind fake.html: the five graphs the remote's
// Graphs tab and graph view speak over the session wire, and the in-memory
// channel handler that answers their frames. Split out of fake-host.ts to
// keep the fake entry a readable size.
import type { GraphState, GraphSummary, NodeStatus } from "./protocol.js";
import builderGraph from "../test/fixtures/builder-graph.json" with { type: "json" };

// --- The graph fixtures ----------------------------------------------
// Five graphs over the session wire: one running with an ensemble whose
// live state advances every 2 s (and completes a spec every few ticks),
// one paused mid-queue, one failed at its gate, one completed long ago,
// and the lab's own builder loop — a plate whose failure terminals live
// in a side lane, with a `done` end and grouped error buses. The graph
// frames the remote's Graphs tab and graph view speak are answered
// exactly like the host spec describes (graphs.rs): the list carries
// `graphs`, the watch reply `id`/`document`/`state`, pushes `id`/`state`.

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

/** The paused graph's drawing: a chain parked after its first step. */
const PAUSED_DOC = {
  name: "paused-sketch",
  nodes: [
    { name: "collect", kind: "check", position: 1, config: { command: "make collect" } },
    { name: "measure", kind: "agent", position: 2, config: { prompt_template: "Measure it." } },
  ],
  edges: [{ from_node: "collect", to_node: "measure", condition: "pass" }],
};

/** The failed graph's drawing: a chain refused at its gate. */
const FAILED_DOC = {
  name: "failed-sketch",
  nodes: [
    { name: "collect", kind: "check", position: 1, config: { command: "make collect" } },
    { name: "gate", kind: "check", position: 2, config: { command: "make gate" } },
  ],
  edges: [{ from_node: "collect", to_node: "gate", condition: "pass" }],
};

/** The paused graph's live state: parked mid-queue, nothing running. */
function pausedState(nowMs: number): GraphState {
  return {
    status: "paused",
    blocked: false,
    blocker: null,
    current_spec_id: null,
    current_node: null,
    nodes: { collect: "pass" },
    specs: [
      { id: "p1", code: "PAU-1", name: "Collect the numbers", status: "completed", attempts: 1 },
      { id: "p2", code: "PAU-2", name: "Measure the gap", status: "pending", attempts: 1 },
    ],
    updated_at: nowMs,
  };
}

function pausedSummary(nowMs: number): GraphSummary {
  return {
    id: "g-paused",
    name: "paused-sketch",
    status: "paused",
    workdir: "/home/u/demo",
    current_spec: "",
    current_node: "",
    done: 1,
    total: 2,
    blocked: false,
    updated_at: nowMs,
  };
}

/** The failed graph's live state: refused at its gate, blocked on it. */
function failedState(nowMs: number): GraphState {
  return {
    status: "failed",
    blocked: true,
    blocker: "gate refused the diff",
    current_spec_id: "f3",
    current_node: "gate",
    nodes: { collect: "pass", measure: "pass", gate: "fail" },
    specs: [
      { id: "f1", code: "BRK-1", name: "Collect the numbers", status: "completed", attempts: 1 },
      { id: "f2", code: "BRK-2", name: "Measure the gap", status: "completed", attempts: 2 },
      { id: "f3", code: "BRK-3", name: "Pass the gate", status: "failed", attempts: 3 },
      { id: "f4", code: null, name: "Publish the report", status: "pending", attempts: 1 },
      { id: "f5", code: null, name: "Announce the release", status: "pending", attempts: 1 },
    ],
    updated_at: nowMs,
  };
}

function failedSummary(nowMs: number): GraphSummary {
  return {
    id: "g-failed",
    name: "failed-sketch",
    status: "failed",
    workdir: "/home/u/demo",
    current_spec: "Pass the gate",
    current_node: "gate",
    done: 2,
    total: 5,
    // Unblocked on the list, so the mix reads failed; the live state
    // still parks the open view on the gate's blocker.
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
  // The completed fixture settled a month ago: the mix covers an old,
  // finished run next to the live ones.
  const settledAt = startedAt - 30 * 24 * 3600 * 1000;
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
    updated_at: settledAt,
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
    updated_at: settledAt,
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

  // The host sends updated_at as RFC3339 (graphs.rs:48-67,71-86);
  // the fixtures keep epoch ms inside and render the wire shape here.
  const wireSummary = (row: GraphSummary): unknown => ({
    ...row,
    updated_at: new Date(row.updated_at).toISOString(),
  });
  const wireState = (state: GraphState): unknown => ({
    ...state,
    updated_at: new Date(state.updated_at).toISOString(),
  });
  // graphs.rs:119-121: {"t": "graph_state", "id": id, "state": state}.
  const stateFrame = (id: string, state: GraphState): unknown => ({
    t: "graph_state",
    id,
    state: wireState(state),
  });

  const replyFor = (id: string, nowMs: number): { document: unknown; state: GraphState } | null => {
    if (id === "g-loop") {
      return { document: LOOP_DOC, state: loopState() };
    }
    if (id === "g-done") {
      return { document: DONE_DOC, state: doneState };
    }
    if (id === "g-builder") {
      return { document: BUILDER_DOC, state: { ...BUILDER_STATE, updated_at: nowMs } };
    }
    if (id === "g-paused") {
      return { document: PAUSED_DOC, state: pausedState(nowMs) };
    }
    if (id === "g-failed") {
      return { document: FAILED_DOC, state: failedState(nowMs) };
    }
    return null;
  };

  return {
    handle(frame: Record<string, unknown>): boolean {
      if (frame.t === "graphs") {
        // graphs.rs:101-103: {"t": "graphs", "req": req, "graphs": graphs}.
        deliver({
          t: "graphs",
          req: typeof frame.req === "string" ? frame.req : null,
          graphs: [
            loopSummary(startedAt, loopState()),
            pausedSummary(startedAt),
            failedSummary(startedAt),
            doneSummary,
            builderSummary(startedAt),
          ].map(wireSummary),
        });
        return true;
      }
      if (frame.t === "graph_watch" && typeof frame.id === "string") {
        const reply = replyFor(frame.id, Date.now());
        if (reply === null) {
          return true;
        }
        watched = frame.id;
        // graphs.rs:106-116: {"t": "graph", "req", "id", "document", "state"}.
        deliver({
          t: "graph",
          req: typeof frame.req === "string" ? frame.req : null,
          id: frame.id,
          document: reply.document,
          state: wireState(reply.state),
        });
        deliver(stateFrame(frame.id, reply.state));
        if (frame.id === "g-loop" && loopTimer === null) {
          loopTimer = globalThis.setInterval(tick, 2000);
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
