// SPDX-License-Identifier: Apache-2.0
// The Graphs tab and the graph view outside the browser: the status chips
// and checklist marks, the list rows, the store's watch lifecycle, the
// view's header, plate, checklist and disconnect note, and the routing of
// the three graph frames. Read-only throughout: nothing here pauses.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Shell } from "../src/app.js";
import { CatalogStore } from "../src/catalog.js";
import { GraphStore } from "../src/graph-store.js";
import { plateStateOf, renderGraphView, updateGraphView } from "../src/graph-view.js";
import type { GraphViewArgs } from "../src/graph-view.js";
import {
  graphStatusIcon,
  graphStatusWord,
  renderGraphsList,
  specMark,
  statusChip,
} from "../src/graphs-list.js";
import type { GraphState, GraphSummary } from "../src/protocol.js";
import { createFrameRouter } from "../src/router.js";
import { SessionController } from "../src/session.js";
import { SessionStore } from "../src/sessions.js";
import type { GraphDocument } from "../../../../packages/plate/document.js";

/** Two agents in a pass chain: the smallest drawable plate. */
const CHAIN: GraphDocument = {
  name: "chain",
  nodes: [
    { name: "first", kind: "agent", position: 1, config: {} },
    { name: "second", kind: "agent", position: 2, config: {} },
  ],
  edges: [{ from_node: "first", to_node: "second", condition: "pass" }],
};

function summary(overrides: Partial<GraphSummary> = {}): GraphSummary {
  return {
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
    ...overrides,
  };
}

function graphState(overrides: Partial<GraphState> = {}): GraphState {
  return {
    status: "running",
    blocked: false,
    blocker: null,
    current_spec_id: "s2",
    current_node: "second",
    nodes: { first: "pass", second: "running" },
    specs: [
      { id: "s1", code: "FIX-1", name: "Lock the palette", status: "completed", attempts: 2 },
      { id: "s2", code: "FIX-2", name: "Draw the plate", status: "running", attempts: 1 },
      { id: "s3", code: null, name: "Watch it live", status: "pending", attempts: 1 },
      { id: "s4", code: "FIX-4", name: "Ship the remote", status: "failed", attempts: 3 },
    ],
    updated_at: 1793100000_000,
    ...overrides,
  };
}

function viewArgs(overrides: Partial<GraphViewArgs> = {}): GraphViewArgs {
  return {
    header: `<header class="topbar"></header>`,
    banner: "",
    id: "g1",
    name: "palette-loop",
    summary: summary(),
    doc: CHAIN,
    state: graphState(),
    receivedAt: 1793100000_000,
    connected: true,
    orientation: "horizontal",
    onBack: () => {},
    ...overrides,
  };
}

describe("the status vocabulary", () => {
  it("words a blocked graph blocked and a pausing one paused", () => {
    expect(graphStatusWord({ status: "running", blocked: true })).toBe("blocked");
    expect(graphStatusWord({ status: "pausing", blocked: false })).toBe("paused");
    expect(graphStatusWord({ status: "failed", blocked: false })).toBe("failed");
    expect(graphStatusWord({ status: "completed", blocked: false })).toBe("completed");
  });

  it("icons every chip word, and circles the unknown", () => {
    expect(graphStatusIcon("running")).toBe("loader");
    expect(graphStatusIcon("paused")).toBe("pause");
    expect(graphStatusIcon("failed")).toBe("x");
    expect(graphStatusIcon("completed")).toBe("check");
    expect(graphStatusIcon("blocked")).toBe("triangleAlert");
    expect(graphStatusIcon("mystery")).toBe("circle");
  });

  it("chips the word beside its icon, spinning only while running", () => {
    const running = statusChip(summary());
    expect(running).toContain(`data-status="running"`);
    expect(running).toContain(`chip-spin`);
    expect(running).toContain(`<svg`);
    expect(running).toContain(`>running<`);
    const blocked = statusChip(summary({ blocked: true }));
    expect(blocked).toContain(`data-status="blocked"`);
    expect(blocked).not.toContain(`chip-spin`);
  });

  it("maps each checklist status to its icon and label", () => {
    expect(specMark("completed")).toEqual({ icon: "check", label: "completed" });
    expect(specMark("running")).toEqual({ icon: "circleDot", label: "running" });
    expect(specMark("failed")).toEqual({ icon: "x", label: "failed" });
    expect(specMark("pending")).toEqual({ icon: "circle", label: "pending" });
  });
});

describe("renderGraphsList", () => {
  it("empty-states a machine with no graphs", () => {
    const root = document.createElement("div");
    renderGraphsList(root, [], { onOpen: () => {} });
    expect(root.querySelector(".empty")?.textContent).toBe("No graphs running on this machine");
    expect(root.querySelectorAll(".graph-row")).toHaveLength(0);
  });

  it("rows each graph with its chip, fraction, bar, spec and workdir", () => {
    const root = document.createElement("div");
    renderGraphsList(root, [summary(), summary({ id: "g2", name: "quality-bubble" })], {
      onOpen: () => {},
    });
    const rows = root.querySelectorAll(".graph-row");
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(first.querySelector(".graph-name")?.textContent).toBe("palette-loop");
    expect(first.querySelector(".graph-spec")?.textContent).toBe("Draw the plate");
    expect(first.querySelector(".graph-workdir")?.textContent).toBe("/home/u/demo");
    expect(first.querySelector(".status-chip")?.getAttribute("data-status")).toBe("running");
    expect(first.querySelector(".graph-count")?.textContent).toBe("1/4");
    expect(
      (first.querySelector(".progress-fill") as HTMLElement)?.style.width,
    ).toBe("25%");
  });

  it("opens the tapped graph by id and name", () => {
    const root = document.createElement("div");
    const opened: Array<[string, string]> = [];
    renderGraphsList(root, [summary()], {
      onOpen: (id, name) => opened.push([id, name]),
    });
    (root.querySelector(".graph-row") as HTMLButtonElement).click();
    expect(opened).toEqual([["g1", "palette-loop"]]);
  });
});

describe("GraphStore", () => {
  function setup(): { store: GraphStore; sent: unknown[] } {
    const sent: unknown[] = [];
    const store = new GraphStore({
      send: (data) => {
        sent.push(JSON.parse(data));
        return true;
      },
    });
    return { store, sent };
  }

  it("asks for the list with a req", () => {
    const { store, sent } = setup();
    expect(store.requestList()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "graphs" });
    expect((sent[0] as { req: string }).req).not.toBe("");
  });

  it("watches, and a fresh id starts from a clean slate", () => {
    const { store, sent } = setup();
    store.watch("g1");
    store.handleGraph({ summary: summary(), doc: CHAIN });
    store.handleGraphState(graphState());
    // Re-watching the open graph keeps what arrived; a fresh id clears it.
    store.watch("g1");
    expect(store.currentSummary()?.id).toBe("g1");
    expect(store.currentDoc()).toEqual(CHAIN);
    expect(store.currentState()?.current_node).toBe("second");
    store.watch("g2");
    expect(store.currentSummary()).toBeNull();
    expect(store.currentDoc()).toBeNull();
    expect(store.currentState()).toBeNull();
    expect(sent).toEqual([
      { t: "graph_watch", id: "g1" },
      { t: "graph_watch", id: "g1" },
      { t: "graph_watch", id: "g2" },
    ]);
    expect(store.watchedId()).toBe("g2");
  });

  it("unwatches the watched graph, and sends nothing unwatched", () => {
    const { store, sent } = setup();
    expect(store.unwatch()).toBe(true);
    expect(sent).toEqual([]);
    store.watch("g1");
    expect(store.unwatch()).toBe(true);
    expect(sent).toEqual([
      { t: "graph_watch", id: "g1" },
      { t: "graph_unwatch", id: "g1" },
    ]);
    expect(store.watchedId()).toBeNull();
  });

  it("rewatches only while a watch is open", () => {
    const { store, sent } = setup();
    expect(store.rewatch()).toBe(true);
    store.watch("g1");
    store.unwatch();
    sent.length = 0;
    expect(store.rewatch()).toBe(true);
    expect(sent).toEqual([]);
    store.watch("g1");
    sent.length = 0;
    expect(store.rewatch()).toBe(true);
    expect(sent).toEqual([{ t: "graph_watch", id: "g1" }]);
  });

  it("holds the list sorted, the watch reply and the pushed state", () => {
    const { store } = setup();
    const seen: number[] = [];
    const stop = store.subscribe(() => seen.push(store.list().length));
    store.handleGraphs([summary({ id: "g2", name: "b-second" }), summary({ name: "a-first" })]);
    expect(store.list().map((row) => row.name)).toEqual(["a-first", "b-second"]);
    store.watch("g1");
    store.handleGraph({ summary: summary(), doc: CHAIN });
    // A reply for another graph never overwrites the open one.
    store.handleGraph({ summary: summary({ id: "g9", name: "stranger" }), doc: null });
    expect(store.currentSummary()?.name).toBe("palette-loop");
    expect(store.currentDoc()).toEqual(CHAIN);
    store.handleGraphState(graphState());
    expect(store.currentState()?.current_node).toBe("second");
    expect(store.lastReceivedAt()).not.toBeNull();
    expect(seen.length).toBeGreaterThan(0);
    stop();
    store.reset();
    expect(store.list()).toEqual([]);
    expect(store.watchedId()).toBeNull();
    expect(store.currentSummary()).toBeNull();
    expect(store.currentState()).toBeNull();
    expect(store.lastReceivedAt()).toBeNull();
  });
});

describe("the graph view", () => {
  it("heads the view with the name, chip, count and blocker", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs());
    expect(root.querySelector(".graph-title")?.textContent).toBe("palette-loop");
    expect(root.querySelector("#graph-chip .status-chip")?.getAttribute("data-status")).toBe(
      "running",
    );
    expect(root.querySelector("#graph-count")?.textContent).toBe("1/4");
    expect((root.querySelector("#graph-blocker") as HTMLElement).hidden).toBe(true);

    updateGraphView(
      root,
      viewArgs({ state: graphState({ blocked: true, blocker: "waiting on review" }) }),
    );
    const blocker = root.querySelector("#graph-blocker") as HTMLElement;
    expect(blocker.hidden).toBe(false);
    expect(blocker.textContent).toBe("waiting on review");
  });

  it("heads the count and chip from the live state, not the stale summary", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs({ state: null }));
    expect(root.querySelector("#graph-count")?.textContent).toBe("1/4");
    updateGraphView(
      root,
      viewArgs({
        state: graphState({
          status: "completed",
          specs: graphState().specs.map((spec) => ({ ...spec, status: "completed" as const })),
        }),
      }),
    );
    // The summary still says running 1/4; the header says what ticks.
    expect(root.querySelector("#graph-count")?.textContent).toBe("4/4");
    expect(root.querySelector("#graph-chip .status-chip")?.getAttribute("data-status")).toBe(
      "completed",
    );
  });

  it("stages the plate and feeds it the pushed overlay", () => {
    // happy-dom drops SVG siblings after <style> on parse, so the lit ring
    // itself is asserted in plate-state.test.ts (renderPlate with a state)
    // and in the Playwright suite (a real browser); here the stage holds
    // the drawing and the view maps the push onto the overlay faithfully.
    const root = document.createElement("div");
    renderGraphView(root, viewArgs());
    const plate = root.querySelector("#graph-stage .plate-svg");
    expect(plate).not.toBeNull();
    expect(plate?.classList.contains("plate-h")).toBe(true);
    expect(plateStateOf(graphState())).toEqual({
      nodes: { first: "pass", second: "running" },
      current: "second",
    });
    expect(plateStateOf(graphState({ current_node: null }))).toEqual({
      nodes: { first: "pass", second: "running" },
      current: undefined,
    });
    expect(plateStateOf(null)).toBeUndefined();
  });

  it("draws vertical below 720 px and horizontal above", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs({ orientation: "vertical" }));
    expect(root.querySelector("#graph-stage .plate-svg")?.classList.contains("plate-v")).toBe(true);
    updateGraphView(root, viewArgs({ orientation: "horizontal" }));
    expect(root.querySelector("#graph-stage .plate-svg")?.classList.contains("plate-h")).toBe(true);
  });

  it("keeps the stage scroll across a state push", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs());
    const stage = root.querySelector("#graph-stage") as HTMLElement;
    stage.scrollTop = 42;
    stage.scrollLeft = 7;
    updateGraphView(root, viewArgs({ state: graphState({ current_node: "first" }) }));
    expect(stage.scrollTop).toBe(42);
    expect(stage.scrollLeft).toBe(7);
  });

  it("holds the stage until the drawing arrives, and past an unreadable one", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs({ doc: null, state: null }));
    expect(root.querySelector(".graph-wait")?.textContent).toBe("Waiting for the drawing…");
    expect(root.querySelector(".spec-list")?.textContent).toBe("No state yet.");
    updateGraphView(root, viewArgs({ doc: {}, state: graphState({ specs: [] }) }));
    expect(root.querySelector(".graph-wait")?.textContent).toBe("This drawing could not be read.");
    expect(root.querySelector(".spec-list")?.textContent).toBe("No specs in the queue.");
  });

  it("checks each spec row with its icon and label", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs());
    const rows = [...root.querySelectorAll("#spec-list .spec-row")];
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual([
      "completed",
      "running",
      "pending",
      "failed",
    ]);
    const marks = [...root.querySelectorAll("#spec-list .spec-mark")];
    expect(marks.map((mark) => mark.getAttribute("title"))).toEqual([
      "completed",
      "running",
      "pending",
      "failed",
    ]);
    for (const mark of marks) {
      expect(mark.getAttribute("aria-label")).toBe(mark.getAttribute("title"));
      expect(mark.querySelector("svg.icon")).not.toBeNull();
    }
    // The code rides along when the host sent one; attempts past the first.
    expect(rows[0]?.querySelector(".spec-code")?.textContent).toBe("FIX-1");
    expect(rows[2]?.querySelector(".spec-code")).toBeNull();
    expect(rows[0]?.querySelector(".spec-attempts")?.textContent).toBe("×2");
    expect(rows[1]?.querySelector(".spec-attempts")).toBeNull();
    expect(rows[3]?.querySelector(".spec-attempts")?.textContent).toBe("×3");
  });

  it("scrolls the running row into view once, when it changes", () => {
    const seen: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element): void {
      seen.push(this);
    };
    try {
      const root = document.createElement("div");
      renderGraphView(root, viewArgs());
      expect(seen.map((row) => row.getAttribute("data-spec"))).toEqual(["s2"]);
      // The same running spec never scrolls twice.
      updateGraphView(root, viewArgs());
      expect(seen).toHaveLength(1);
      updateGraphView(
        root,
        viewArgs({
          state: graphState({
            current_spec_id: "s3",
            specs: graphState().specs.map((spec) =>
              spec.id === "s2"
                ? { ...spec, status: "completed" as const }
                : spec.id === "s3"
                  ? { ...spec, status: "running" as const }
                  : spec,
            ),
          }),
        }),
      );
      expect(seen.map((row) => row.getAttribute("data-spec"))).toEqual(["s2", "s3"]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("keeps the last state with a note while disconnected", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs());
    expect((root.querySelector("#graph-note") as HTMLElement).hidden).toBe(true);
    updateGraphView(root, viewArgs({ connected: false }));
    const note = root.querySelector("#graph-note") as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent ?? "").toMatch(/^disconnected — last update \d\d:\d\d:\d\d$/);
    // The plate and the checklist stay exactly where they were.
    expect(root.querySelector("#graph-stage .plate-svg")).not.toBeNull();
    expect(root.querySelectorAll("#spec-list .spec-row")).toHaveLength(4);
  });

  it("backs out and ignores updates off the view", () => {
    const root = document.createElement("div");
    const onBack = vi.fn();
    renderGraphView(root, viewArgs({ onBack }));
    (root.querySelector("#graph-back") as HTMLButtonElement).click();
    expect(onBack).toHaveBeenCalledTimes(1);
    root.innerHTML = `<main class="sessions"></main>`;
    expect(() => updateGraphView(root, viewArgs())).not.toThrow();
  });
});

describe("routing the graph frames", () => {
  function setup(): { router: ReturnType<typeof createFrameRouter>; graphs: GraphStore } {
    const store = new SessionStore();
    const catalog = new CatalogStore();
    const graphs = new GraphStore({ send: () => true });
    const controller = new SessionController({
      send: () => true,
      terminal: () => ({
        write: () => {},
        clear: () => {},
      }),
      onExited: () => {},
    });
    const router = createFrameRouter({
      store,
      controller,
      shell: {} as Shell,
      catalog,
      graphs,
    });
    return { router, graphs };
  }

  it("routes the list, the watch reply and the pushes to the store", () => {
    const { router, graphs } = setup();
    graphs.watch("g1");
    router.handleFrame({ t: "graphs", items: [{ ...summary(), updated_at: 1793100000 }] });
    expect(graphs.list().map((row) => row.id)).toEqual(["g1"]);
    router.handleFrame({
      t: "graph",
      item: { ...summary(), updated_at: 1793100000 },
      doc: CHAIN,
    });
    expect(graphs.currentSummary()?.name).toBe("palette-loop");
    expect(graphs.currentDoc()).toEqual(CHAIN);
    router.handleFrame({
      t: "graph_state",
      status: "running",
      blocked: false,
      blocker: null,
      current_spec_id: "s2",
      current_node: "second",
      nodes: { second: "running" },
      specs: [],
      updated_at: 1793100000,
    });
    expect(graphs.currentState()?.current_node).toBe("second");
  });

  it("routes nothing without the store, and never throws", () => {
    const store = new SessionStore();
    const catalog = new CatalogStore();
    const controller = new SessionController({
      send: () => true,
      terminal: () => ({
        write: () => {},
        clear: () => {},
      }),
      onExited: () => {},
    });
    const router = createFrameRouter({ store, controller, shell: {} as Shell, catalog });
    expect(() => {
      router.handleFrame({ t: "graphs", items: [] });
      router.handleFrame({ t: "graph", item: summary(), doc: null });
      router.handleFrame({ ...graphState(), t: "graph_state" });
    }).not.toThrow();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
