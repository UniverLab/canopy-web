// SPDX-License-Identifier: Apache-2.0
// The Graphs tab and the graph view outside the browser: the status chips
// and checklist marks, the list rows, the store's watch lifecycle, the
// view's header, plate, checklist and disconnect note, the pause/continue
// control through the route, and the routing of the graph frames. The
// fake host answers pauses the way the real one does.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Shell } from "../src/app.js";
import { CatalogStore } from "../src/catalog.js";
import { createFakeGraphs } from "../src/fake-graphs.js";
import { GraphRoute } from "../src/graph-route.js";
import { GraphStore } from "../src/graph-store.js";
import { controlForStatus, plateStateOf, renderGraphView, updateGraphView } from "../src/graph-view.js";
import type { GraphViewArgs } from "../src/graph-view.js";
import {
  graphStatusIcon,
  graphStatusWord,
  renderGraphsList,
  specMark,
  statusChip,
} from "../src/graphs-list.js";
import type { GraphState, GraphSummary } from "../src/protocol.js";
import { buildGraphControl, parseGraph, parseGraphState, parseGraphs } from "../src/protocol.js";
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
    canControl: false,
    controlPending: false,
    controlError: null,
    onControl: () => {},
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
    // Host statuses are any string; a prototype key must circle too, never
    // resolve to Object and throw inside icon().
    expect(graphStatusIcon("constructor")).toBe("circle");
    expect(graphStatusIcon("__proto__")).toBe("circle");
    expect(graphStatusIcon("toString")).toBe("circle");
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

  it("escapes a hostile status word in the chip's attributes and label", () => {
    const hostile = statusChip(summary({ status: `"><img src=x onerror=alert(1)>` }));
    // The quote and angle brackets are entities, so no element opens — the
    // word stays one attribute value and one text node.
    expect(hostile).not.toContain(`<img`);
    expect(hostile).toContain(`&quot;&gt;&lt;img`);
    // The chip still renders its icon and never throws on the word.
    expect(hostile).toContain(`<svg`);
    expect(statusChip(summary({ status: "constructor" }))).toContain(`<svg`);
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
    renderGraphsList(root, [], { onOpen: () => {}, onReload: () => {} }, true);
    expect(root.querySelector(".empty")?.textContent).toBe("No graphs running on this machine");
    expect(root.querySelectorAll(".graph-row")).toHaveLength(0);
  });

  it("shows loading instead of the empty state while the list is on its way", () => {
    const root = document.createElement("div");
    renderGraphsList(root, [], { onOpen: () => {}, onReload: () => {} }, false);
    expect(root.querySelector(".empty")?.textContent).toMatch(/Loading graphs/);
    expect(root.querySelector('[role="status"]')?.textContent).toMatch(/Loading graphs/);
    expect(root.querySelectorAll(".graph-row")).toHaveLength(0);
  });

  it("reloads the list from the header button", () => {
    const root = document.createElement("div");
    let reloads = 0;
    renderGraphsList(root, [], { onOpen: () => {}, onReload: () => { reloads += 1; } }, true);
    (root.querySelector("#graphs-reload") as HTMLButtonElement).click();
    expect(reloads).toBe(1);
  });

  it("rows each graph with its chip, fraction, bar, spec and workdir", () => {
    const root = document.createElement("div");
    renderGraphsList(root, [summary(), summary({ id: "g2", name: "quality-bubble" })], {
      onOpen: () => {},
      onReload: () => {},
    }, true);
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
      onReload: () => {},
    }, true);
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
    store.handleGraph({ summary: summary(), doc: CHAIN, state: graphState() });
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
    // Every watch carries its own non-empty req, so the host can answer it.
    expect(sent).toHaveLength(3);
    const ids = ["g1", "g1", "g2"];
    for (const [index, frame] of sent.entries()) {
      expect(frame).toMatchObject({ t: "graph_watch", id: ids[index] });
      expect(typeof (frame as { req: unknown }).req).toBe("string");
      expect((frame as { req: string }).req).not.toBe("");
    }
    const reqs = sent.map((frame) => (frame as { req: string }).req);
    expect(new Set(reqs).size).toBe(3);
    expect(store.watchedId()).toBe("g2");
  });

  it("unwatches the watched graph, and sends nothing unwatched", () => {
    const { store, sent } = setup();
    expect(store.unwatch()).toBe(true);
    expect(sent).toEqual([]);
    store.watch("g1");
    expect(store.unwatch()).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ t: "graph_watch", id: "g1" });
    expect((sent[0] as { req: string }).req).not.toBe("");
    expect(sent[1]).toEqual({ t: "graph_unwatch", id: "g1" });
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
    // The rewatch is a fresh request with its own non-empty req.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "graph_watch", id: "g1" });
    expect(typeof (sent[0] as { req: unknown }).req).toBe("string");
    expect((sent[0] as { req: string }).req).not.toBe("");
  });

  it("claims only the error answering the latest watch", () => {
    const { store, sent } = setup();
    // No watch yet: nothing is claimed, and nobody is notified.
    const seen: Array<string | null> = [];
    store.subscribe(() => seen.push(store.watchError()));
    expect(store.handleWatchError("late", "r-stale")).toBe(false);
    expect(store.handleWatchError("late", null)).toBe(false);
    expect(store.watchError()).toBeNull();
    store.watch("g1");
    const first = (sent[0] as { req: string }).req;
    store.watch("g1");
    const latest = (sent[1] as { req: string }).req;
    // A stale req and a missing one fall through to the sheets.
    expect(store.handleWatchError("stale", first)).toBe(false);
    expect(store.handleWatchError("missing", null)).toBe(false);
    expect(store.watchError()).toBeNull();
    // The latest watch's error is kept, and the view is notified.
    expect(store.handleWatchError("graph_watch: missing field 'req'", latest)).toBe(true);
    expect(store.watchError()).toBe("graph_watch: missing field 'req'");
    expect(seen).toEqual(["graph_watch: missing field 'req'"]);
  });

  it("clears the failed watch on the next watch, reply or reset", () => {
    const { store, sent } = setup();
    store.watch("g1");
    const req = (sent[0] as { req: string }).req;
    expect(store.handleWatchError("no such graph", req)).toBe(true);
    // A fresh watch clears it before the host even answers.
    store.watch("g1");
    expect(store.watchError()).toBeNull();
    const again = (sent[1] as { req: string }).req;
    expect(store.handleWatchError("no such graph", again)).toBe(true);
    // A late reply still wins over the failure.
    store.handleGraph({ summary: summary(), doc: CHAIN, state: graphState() });
    expect(store.watchError()).toBeNull();
    expect(store.handleWatchError("no such graph", again)).toBe(true);
    store.reset();
    expect(store.watchError()).toBeNull();
    expect(store.handleWatchError("no such graph", again)).toBe(false);
  });

  it("tracks whether the list has arrived yet", () => {
    const { store } = setup();
    expect(store.hasListed()).toBe(false);
    store.handleGraphs([]);
    expect(store.hasListed()).toBe(true);
    store.reset();
    expect(store.hasListed()).toBe(false);
  });

  it("holds the list sorted, the watch reply and the pushed state", () => {
    const { store } = setup();
    const seen: number[] = [];
    const stop = store.subscribe(() => seen.push(store.list().length));
    store.handleGraphs([summary({ id: "g2", name: "b-second" }), summary({ name: "a-first" })]);
    expect(store.list().map((row) => row.name)).toEqual(["a-first", "b-second"]);
    store.watch("g1");
    store.handleGraph({ summary: summary(), doc: CHAIN, state: graphState() });
    // A reply for another graph never overwrites the open one.
    store.handleGraph({
      summary: summary({ id: "g9", name: "stranger" }),
      doc: null,
      state: graphState(),
    });
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

  it("paints the reply's initial state without waiting for a push", () => {
    const { store } = setup();
    store.watch("g1");
    store.handleGraph({ summary: summary(), doc: CHAIN, state: graphState() });
    // No push arrived: the reply alone set the state, exactly like one.
    expect(store.currentState()?.current_node).toBe("second");
    expect(store.lastReceivedAt()).not.toBeNull();
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

  it("mounts one viewer with the three overlaid controls", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs());
    const plate = root.querySelector<HTMLElement>("#graph-stage figure.plate");
    expect(plate?.classList.contains("is-live")).toBe(true);
    const controls = [...root.querySelectorAll<HTMLButtonElement>(".plate-controls button")];
    expect(controls.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Zoom out",
      "Zoom in",
      "Fit the graph",
    ]);
    expect(plate?.style.getPropertyValue("--plate-ratio")).not.toBe("");
  });

  it("keeps the viewer's transform across a state push", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs());
    const zoomIn = root.querySelector<HTMLButtonElement>('.plate-controls button[aria-label="Zoom in"]');
    zoomIn?.click();
    const zoomed = root.querySelector<SVGSVGElement>("#graph-stage .plate-svg")?.style.transform ?? "";
    expect(zoomed).toContain("scale(1.25)");
    updateGraphView(root, viewArgs({ state: graphState({ current_node: "first" }) }));
    // The push swapped the drawing but painted the same view on it.
    const after = root.querySelector<SVGSVGElement>("#graph-stage .plate-svg");
    expect(after?.style.transform).toBe(zoomed);
  });

  it("holds the stage until the drawing arrives, and past an unreadable one", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs({ doc: null, state: null }));
    expect(root.querySelector(".graph-wait")?.textContent).toBe("Waiting for the drawing…");
    expect(root.querySelector(".spec-list")?.textContent).toBe("Waiting for the specs…");
    updateGraphView(root, viewArgs({ doc: {}, state: graphState({ specs: [] }) }));
    expect(root.querySelector(".graph-wait")?.textContent).toBe("This drawing could not be read.");
    expect(root.querySelector(".spec-list")?.textContent).toBe("No specs in the queue.");
  });

  it("heads the queue Specs and shows a failed watch instead of waiting", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs({ doc: null, state: null }));
    expect(root.querySelector("main.graph-view h2")?.textContent).toBe("Specs");
    // The failed watch replaces exactly the waiting line, before the reply.
    updateGraphView(root, viewArgs({ doc: null, state: null, watchError: "no such graph" }));
    expect(root.querySelector(".graph-wait")?.textContent).toBe(
      "Could not open this graph: no such graph",
    );
    // The message is host text: markup in it never becomes elements.
    updateGraphView(
      root,
      viewArgs({ doc: null, state: null, watchError: `<img src=x onerror=alert(1)>` }),
    );
    expect(root.querySelector(".graph-wait")?.querySelector("img")).toBeNull();
    expect(root.querySelector(".graph-wait")?.innerHTML).toContain("&lt;img");
    // A later reply clears it: the plate takes the stage.
    updateGraphView(root, viewArgs({ watchError: null }));
    expect(root.querySelector("#graph-stage .plate-svg")).not.toBeNull();
    expect(root.querySelector(".graph-wait")).toBeNull();
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

  it("finds the running row even when its id breaks a CSS selector", () => {
    // The id is host text: as a selector fragment a backslash turns into an
    // escape (the row is missed) and a newline throws in a real browser, so
    // the view must match the attribute exactly instead of interpolating.
    const seen: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element): void {
      seen.push(this);
    };
    try {
      const root = document.createElement("div");
      const hostile = graphState({
        current_spec_id: "line1\nline2",
        specs: [
          { id: "line1\nline2", code: "FIX-9", name: "Odd id", status: "running", attempts: 1 },
          { id: "a\\b", code: "FIX-10", name: "Escaped id", status: "pending", attempts: 1 },
        ],
      });
      renderGraphView(root, viewArgs({ state: hostile }));
      expect(root.querySelectorAll("#spec-list .spec-row")).toHaveLength(2);
      expect(seen.map((row) => row.getAttribute("data-spec"))).toEqual(["line1\nline2"]);
      // Moving the running flag to the backslash id still finds and scrolls it.
      updateGraphView(
        root,
        viewArgs({
          state: graphState({
            current_spec_id: "a\\b",
            specs: [
              { id: "line1\nline2", code: "FIX-9", name: "Odd id", status: "completed", attempts: 1 },
              { id: "a\\b", code: "FIX-10", name: "Escaped id", status: "running", attempts: 1 },
            ],
          }),
        }),
      );
      expect(seen.map((row) => row.getAttribute("data-spec"))).toEqual(["line1\nline2", "a\\b"]);
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

describe("pausing and continuing", () => {
  it("builds the graph_control frame the host contract quotes", () => {
    expect(JSON.parse(buildGraphControl("r1", "g-loop", "pause"))).toEqual({
      t: "graph_control",
      req: "r1",
      id: "g-loop",
      action: "pause",
    });
    expect(JSON.parse(buildGraphControl("r2", "g-loop", "continue"))).toEqual({
      t: "graph_control",
      req: "r2",
      id: "g-loop",
      action: "continue",
    });
  });

  it("offers pause while running, continue while parked or refused", () => {
    expect(controlForStatus("running")).toBe("pause");
    expect(controlForStatus("paused")).toBe("continue");
    expect(controlForStatus("failed")).toBe("continue");
    // Anything else — pausing, finished, or a hostile word — offers none.
    for (const status of ["pausing", "completed", "draft", "", "constructor"]) {
      expect(controlForStatus(status)).toBeNull();
    }
  });

  it("hides the control without the hello feature, and past any status it serves", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs({ canControl: false }));
    expect((root.querySelector("#graph-action") as HTMLElement).hidden).toBe(true);
    for (const status of ["completed", "draft"]) {
      updateGraphView(
        root,
        viewArgs({
          canControl: true,
          state: graphState({ status }),
          summary: summary({ status }),
        }),
      );
      expect((root.querySelector("#graph-action") as HTMLElement).hidden).toBe(true);
    }
  });

  it("pauses through the button and keeps its node across pushes", () => {
    const root = document.createElement("div");
    const onControl = vi.fn();
    renderGraphView(root, viewArgs({ canControl: true, onControl }));
    const button = root.querySelector<HTMLButtonElement>("#graph-action");
    expect(button?.hidden).toBe(false);
    expect(button?.textContent).toContain("Pause");
    button?.click();
    expect(onControl).toHaveBeenCalledWith("pause");
    // A push repaints it in place: the same node, still offering Pause.
    updateGraphView(
      root,
      viewArgs({ canControl: true, onControl, state: graphState({ current_node: "first" }) }),
    );
    expect(root.querySelector("#graph-action")).toBe(button);
    expect(button?.textContent).toContain("Pause");
    // Pausing parks the label and the click; parked and refused continue.
    updateGraphView(
      root,
      viewArgs({
        canControl: true,
        onControl,
        state: graphState({ status: "pausing" }),
        summary: summary({ status: "pausing" }),
      }),
    );
    expect(root.querySelector("#graph-action")).toBe(button);
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Pausing...");
    updateGraphView(
      root,
      viewArgs({
        canControl: true,
        onControl,
        state: graphState({ status: "paused" }),
        summary: summary({ status: "paused" }),
      }),
    );
    expect(root.querySelector("#graph-action")).toBe(button);
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toContain("Continue");
    button?.click();
    expect(onControl).toHaveBeenCalledWith("continue");
  });

  it("disables the control while its request is in flight", () => {
    const root = document.createElement("div");
    renderGraphView(root, viewArgs({ canControl: true, controlPending: true }));
    const button = root.querySelector<HTMLButtonElement>("#graph-action");
    expect(button?.hidden).toBe(false);
    expect(button?.disabled).toBe(true);
  });

  it("shows a refused control on the note, beating the disconnect line", () => {
    const root = document.createElement("div");
    const hostile = `<img src=x onerror=alert(1)>`;
    renderGraphView(
      root,
      viewArgs({ canControl: true, connected: false, controlError: hostile }),
    );
    const note = root.querySelector("#graph-note") as HTMLElement;
    expect(note.hidden).toBe(false);
    // The message is host text: markup in it never becomes elements, and
    // it wins over the disconnected line the same view would show.
    expect(note.textContent).toBe(hostile);
    expect(note.querySelector("img")).toBeNull();
    expect(note.textContent).not.toMatch(/^disconnected/);
  });
});

describe("the graph route's pause and continue", () => {
  function setupRoute(): {
    route: GraphRoute;
    graphs: GraphStore;
    root: HTMLElement;
    sent: Array<Record<string, unknown>>;
    routeName: { current: string };
    cleanup: () => void;
  } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const sent: Array<Record<string, unknown>> = [];
    const graphs = new GraphStore({
      send: (data) => {
        sent.push(JSON.parse(data) as Record<string, unknown>);
        return true;
      },
    });
    const routeName = { current: "sessions" };
    const route = new GraphRoute(
      root,
      graphs,
      null,
      {
        onGraphsRequest: () => {},
        onWatchGraph: () => {},
        onUnwatchGraph: () => {},
        onGraphControl: (req, id, action) => {
          sent.push({ t: "graph_control", req, id, action });
          return true;
        },
      },
      {
        listSessions: () => [],
        sessionsLoaded: () => false,
        openSession: () => {},
        newSession: () => {},
        render: () => {},
        openGraph: () => {},
        leaveToSessions: () => {},
        header: () => "",
        banner: () => "",
        wireBanner: () => {},
        connectionState: () => "connected",
        route: () => routeName.current,
      },
    );
    return { route, graphs, root, sent, routeName, cleanup: () => root.remove() };
  }

  function openRunningGraph(ctx: ReturnType<typeof setupRoute>): void {
    ctx.route.open("g1", "palette-loop");
    ctx.route.handleHello(["graph_control"]);
    ctx.graphs.watch("g1");
    ctx.graphs.handleGraph({ summary: summary(), doc: CHAIN, state: graphState() });
    ctx.routeName.current = "graph";
    ctx.route.mountGraph();
  }

  function controlFrames(ctx: ReturnType<typeof setupRoute>): Array<Record<string, unknown>> {
    return ctx.sent.filter((frame) => frame.t === "graph_control");
  }

  it("sends nothing without the hello feature", () => {
    const ctx = setupRoute();
    try {
      ctx.route.open("g1", "palette-loop");
      ctx.route.requestControl("pause");
      expect(controlFrames(ctx)).toEqual([]);
    } finally {
      ctx.cleanup();
    }
  });

  it("pauses through the button and clears the pending request on ok", () => {
    const ctx = setupRoute();
    try {
      openRunningGraph(ctx);
      const button = ctx.root.querySelector<HTMLButtonElement>("#graph-action");
      expect(button?.hidden).toBe(false);
      button?.click();
      const frames = controlFrames(ctx);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ id: "g1", action: "pause" });
      const req = frames[0]?.req as string;
      expect(req).not.toBe("");
      // The in-flight request disables the same button node.
      expect(button?.disabled).toBe(true);
      // A second ask while one is in flight sends nothing.
      ctx.route.requestControl("pause");
      expect(controlFrames(ctx)).toHaveLength(1);
      expect(ctx.route.handleControlOk(req)).toBe(true);
      expect(ctx.route.args().controlPending).toBe(false);
      expect(button?.disabled).toBe(false);
      // A stranger's ok changes nothing.
      expect(ctx.route.handleControlOk("r-stale")).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });

  it("shows a refusal on the note and clears it on the next success", () => {
    const ctx = setupRoute();
    try {
      openRunningGraph(ctx);
      const button = ctx.root.querySelector<HTMLButtonElement>("#graph-action");
      button?.click();
      const req = controlFrames(ctx)[0]?.req as string;
      expect(ctx.route.handleControlError(req, "graph is not running")).toBe(true);
      const note = ctx.root.querySelector("#graph-note") as HTMLElement;
      expect(note.hidden).toBe(false);
      expect(note.textContent).toBe("graph is not running");
      expect(button?.disabled).toBe(false);
      // The next successful action clears the note.
      button?.click();
      const again = controlFrames(ctx)[1]?.req as string;
      expect(ctx.route.handleControlOk(again)).toBe(true);
      expect((ctx.root.querySelector("#graph-note") as HTMLElement).hidden).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });

  it("drops the button on an older hello, and the request on leave", () => {
    const ctx = setupRoute();
    try {
      openRunningGraph(ctx);
      expect(
        (ctx.root.querySelector("#graph-action") as HTMLElement).hidden,
      ).toBe(false);
      // A reconnect to an older host greets without the feature: the
      // button goes, with the pending request and the note behind it.
      ctx.route.handleHello([]);
      expect(ctx.route.args().canControl).toBe(false);
      expect(
        (ctx.root.querySelector("#graph-action") as HTMLElement).hidden,
      ).toBe(true);
      // ...and leaving the view forgets a refusal, never the flag's story.
      ctx.route.handleHello(["graph_control"]);
      ctx.route.requestControl("pause");
      const req = controlFrames(ctx)[0]?.req as string;
      ctx.route.handleControlError(req, "graph is not running");
      expect(ctx.route.args().controlError).toBe("graph is not running");
      ctx.route.leave();
      expect(ctx.route.args().controlPending).toBe(false);
      expect(ctx.route.args().controlError).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });
});

describe("routing the graph frames", () => {
  function setup(): {
    router: ReturnType<typeof createFrameRouter>;
    graphs: GraphStore;
    sent: unknown[];
  } {
    const store = new SessionStore();
    const catalog = new CatalogStore();
    const sent: unknown[] = [];
    const graphs = new GraphStore({
      send: (data) => {
        sent.push(JSON.parse(data));
        return true;
      },
    });
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
    return { router, graphs, sent };
  }

  it("routes the list, the watch reply and the pushes to the store", () => {
    const { router, graphs } = setup();
    graphs.watch("g1");
    router.handleFrame({
      t: "graphs",
      req: "r1",
      graphs: [{ ...summary(), updated_at: "2026-11-02T10:30:00.000Z" }],
    });
    expect(graphs.list().map((row) => row.id)).toEqual(["g1"]);
    const doc = { ...CHAIN, name: "palette-loop" };
    router.handleFrame({
      t: "graph",
      req: "r7",
      id: "g1",
      document: doc,
      state: { ...graphState(), updated_at: "2026-11-02T10:30:00.000Z" },
    });
    expect(graphs.currentSummary()?.name).toBe("palette-loop");
    expect(graphs.currentDoc()).toEqual(doc);
    // The reply's initial state already landed: the view never waits.
    expect(graphs.currentState()?.current_node).toBe("second");
    router.handleFrame({
      t: "graph_state",
      id: "g1",
      state: {
        status: "running",
        blocked: false,
        blocker: null,
        current_spec_id: "s2",
        current_node: "first",
        nodes: { first: "running" },
        specs: [],
        updated_at: "2026-11-02T10:31:00.000Z",
      },
    });
    expect(graphs.currentState()?.current_node).toBe("first");
  });

  it("routes a failed watch to the store, never to a sheet", () => {
    const { router, graphs, sent } = setup();
    graphs.watch("g1");
    const req = (sent[0] as { req: string }).req;
    // The shell stub owns no sheets: falling through would throw on the
    // missing sheetError, so this pins the store's claim.
    expect(() =>
      router.handleFrame({ t: "error", req, code: "not_found", message: "no such graph" }),
    ).not.toThrow();
    expect(graphs.watchError()).toBe("no such graph");
  });

  it("routes hello, ok and control errors through the graph control", () => {
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
    const graphHello = vi.fn();
    const graphControlOk = vi.fn().mockReturnValue(true);
    const graphControlError = vi.fn().mockReturnValue(true);
    const sheetOk = vi.fn();
    const sheetError = vi.fn();
    const router = createFrameRouter({
      store,
      controller,
      catalog,
      graphs,
      shell: {
        graphHello,
        graphControlOk,
        graphControlError,
        sheetOk,
        sheetError,
      } as unknown as Shell,
    });
    router.handleFrame({ t: "hello", features: ["graph_control"], harnesses: [] });
    expect(graphHello).toHaveBeenCalledWith(["graph_control"]);
    router.handleFrame({ t: "ok", req: "r1" });
    expect(graphControlOk).toHaveBeenCalledWith("r1");
    expect(sheetOk).not.toHaveBeenCalled();
    router.handleFrame({ t: "error", req: "r2", code: "busy", message: "graph is not running" });
    expect(graphControlError).toHaveBeenCalledWith("r2", "graph is not running");
    expect(sheetError).not.toHaveBeenCalled();
  });

  it("falls through to the sheets when the graph route declines", () => {
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
    const sheetOk = vi.fn();
    const sheetError = vi.fn();
    const router = createFrameRouter({
      store,
      controller,
      catalog,
      graphs,
      shell: {
        graphControlOk: () => false,
        graphControlError: () => false,
        sheetOk,
        sheetError,
      } as unknown as Shell,
    });
    router.handleFrame({ t: "ok", req: "r1" });
    expect(sheetOk).toHaveBeenCalledWith("r1");
    router.handleFrame({ t: "error", req: "r2", code: "busy", message: "graph is not running" });
    expect(sheetError).toHaveBeenCalledWith("graph is not running", "r2", "busy");
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
      router.handleFrame({ t: "graphs", req: "r1", graphs: [] });
      router.handleFrame({ t: "graph", req: "r7", id: "g1", document: CHAIN, state: graphState() });
      router.handleFrame({ t: "graph_state", id: "g1", state: graphState() });
    }).not.toThrow();
  });
});

describe("the fake graphs host", () => {
  it("refuses a watch without a req exactly like the host", () => {
    const delivered: unknown[] = [];
    const fake = createFakeGraphs((frame) => delivered.push(frame));
    expect(fake.handle({ t: "graph_watch", id: "g-loop" })).toBe(true);
    expect(delivered).toEqual([
      { t: "error", code: "bad_request", message: "graph_watch: missing field 'req'" },
    ]);
    // The host names the req first: without an id either, the same refusal.
    expect(fake.handle({ t: "graph_watch" })).toBe(true);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toEqual(delivered[0]);
  });

  it("echoes the watch's req in the graph reply", () => {
    const delivered: unknown[] = [];
    const fake = createFakeGraphs((frame) => delivered.push(frame));
    expect(fake.handle({ t: "graph_watch", req: "r9", id: "g-loop" })).toBe(true);
    const reply = delivered.find((frame) => (frame as { t: string }).t === "graph") as {
      req: string;
    };
    expect(reply.req).toBe("r9");
    fake.handle({ t: "graph_unwatch", id: "g-loop" });
  });

  it("pauses the running fixture through pausing to paused, then continues it", () => {
    const delivered: unknown[] = [];
    const fake = createFakeGraphs((frame) => delivered.push(frame));
    // A control without a req is a bad_request, like the watch.
    expect(fake.handle({ t: "graph_control", id: "g-loop", action: "pause" })).toBe(true);
    expect(delivered.at(-1)).toMatchObject({ t: "error", code: "bad_request" });
    // An unknown id is a not_found.
    expect(fake.handle({ t: "graph_control", req: "r1", id: "nope", action: "pause" })).toBe(true);
    expect(delivered.at(-1)).toMatchObject({ t: "error", req: "r1", code: "not_found" });
    // Watching arms the ticks the pause settles on.
    expect(fake.handle({ t: "graph_watch", req: "rw", id: "g-loop" })).toBe(true);
    delivered.length = 0;
    expect(fake.handle({ t: "graph_control", req: "r2", id: "g-loop", action: "pause" })).toBe(true);
    expect(delivered[0]).toMatchObject({ t: "ok", req: "r2" });
    expect(delivered[1]).toMatchObject({ t: "graph_state", id: "g-loop" });
    expect((delivered[1] as { state: { status: string } }).state.status).toBe("pausing");
    // Neither direction moves twice: pausing is neither running nor parked.
    expect(fake.handle({ t: "graph_control", req: "r3", id: "g-loop", action: "pause" })).toBe(true);
    expect(delivered.at(-1)).toMatchObject({ t: "error", req: "r3", code: "busy" });
    expect(fake.handle({ t: "graph_control", req: "r4", id: "g-loop", action: "continue" })).toBe(true);
    expect(delivered.at(-1)).toMatchObject({ t: "error", req: "r4", code: "busy" });
    // The next tick settles the pause and pushes it live.
    fake.tick();
    expect((delivered.at(-1) as { state: { status: string } }).state.status).toBe("paused");
    // Parked continues; running does not.
    expect(fake.handle({ t: "graph_control", req: "r5", id: "g-loop", action: "continue" })).toBe(true);
    expect(delivered.at(-2)).toMatchObject({ t: "ok", req: "r5" });
    expect((delivered.at(-1) as { state: { status: string } }).state.status).toBe("running");
    expect(fake.handle({ t: "graph_control", req: "r6", id: "g-loop", action: "continue" })).toBe(true);
    expect(delivered.at(-1)).toMatchObject({ t: "error", req: "r6", code: "busy" });
    // A completed graph answers busy either way.
    expect(fake.handle({ t: "graph_control", req: "r7", id: "g-done", action: "continue" })).toBe(true);
    expect(delivered.at(-1)).toMatchObject({ t: "error", req: "r7", code: "busy" });
    fake.handle({ t: "graph_unwatch", id: "g-loop" });
  });
});

// The host contract vectors: verbatim host frames (graphs.rs shapes,
// RFC3339 timestamps, never a live daemon) through the parsers, the
// store and the views — the drift that emptied the tab cannot return.
describe("the host contract vectors", () => {
  const AT = "2026-11-02T10:30:00.000Z";

  const hostRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "g1",
    name: "palette-loop",
    status: "running",
    workdir: "demo",
    current_spec: "Draw the plate",
    current_node: "implementer",
    done: 1,
    total: 4,
    blocked: false,
    updated_at: AT,
    ...overrides,
  });

  const hostState = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
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
    updated_at: AT,
    ...overrides,
  });

  it("lists three running graphs with spinner chips", () => {
    const parsed = parseGraphs({
      t: "graphs",
      req: "r1",
      graphs: [
        hostRow(),
        hostRow({ id: "g2", name: "quality-bubble", current_spec: "Measure the gap" }),
        hostRow({ id: "g3", name: "canopy-builder", current_spec: "Draw the lane" }),
      ],
    });
    if (parsed === null) {
      throw new Error("the verbatim graphs frame did not parse");
    }
    const store = new GraphStore({ send: () => true });
    store.handleGraphs(parsed);
    const root = document.createElement("div");
    renderGraphsList(root, store.list(), { onOpen: () => {}, onReload: () => {} }, true);
    const rows = root.querySelectorAll(".graph-row");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const chip = row.querySelector(".status-chip");
      expect(chip?.getAttribute("data-status")).toBe("running");
      expect(chip?.classList.contains("chip-spin")).toBe(true);
    }
  });

  it("paints the reply's name, plate and state with no push", () => {
    const parsed = parseGraph({
      t: "graph",
      req: "r7",
      id: "g1",
      document: { ...CHAIN, name: "palette-loop" },
      state: hostState(),
    });
    if (parsed === null) {
      throw new Error("the verbatim graph reply did not parse");
    }
    const store = new GraphStore({ send: () => true });
    store.watch("g1");
    store.handleGraph(parsed);
    // No push arrived: name, plate and checklist all come from the reply.
    const root = document.createElement("div");
    renderGraphView(
      root,
      viewArgs({
        name: store.currentSummary()?.name ?? "",
        summary: store.currentSummary(),
        doc: store.currentDoc(),
        state: store.currentState(),
        receivedAt: store.lastReceivedAt(),
      }),
    );
    expect(root.querySelector(".graph-title")?.textContent).toBe("palette-loop");
    expect(root.querySelector("#graph-stage .plate-svg")).not.toBeNull();
    expect(root.querySelector("#graph-count")?.textContent).toBe("1/4");
    expect(root.querySelectorAll("#spec-list .spec-row")).toHaveLength(4);
  });

  it("repaints the overlay from a verbatim state push", () => {
    const reply = parseGraph({
      t: "graph",
      req: "r7",
      id: "g1",
      document: { ...CHAIN, name: "palette-loop" },
      state: hostState(),
    });
    if (reply === null) {
      throw new Error("the verbatim graph reply did not parse");
    }
    const store = new GraphStore({ send: () => true });
    store.watch("g1");
    store.handleGraph(reply);
    const root = document.createElement("div");
    const args = (): GraphViewArgs =>
      viewArgs({
        summary: store.currentSummary(),
        doc: store.currentDoc(),
        state: store.currentState(),
        receivedAt: store.lastReceivedAt(),
      });
    renderGraphView(root, args());
    const push = parseGraphState({
      t: "graph_state",
      id: "g1",
      state: hostState({ current_node: "first", nodes: { first: "running" } }),
    });
    if (push === null) {
      throw new Error("the verbatim state push did not parse");
    }
    store.handleGraphState(push);
    updateGraphView(root, args());
    expect(plateStateOf(store.currentState())).toEqual({
      nodes: { first: "running" },
      current: "first",
    });
  });

  it("never lets one bad row empty the list", () => {
    const parsed = parseGraphs({
      t: "graphs",
      req: "r1",
      graphs: [hostRow(), { name: "nameless" }, hostRow({ id: "g2", name: "quality-bubble" })],
    });
    expect(parsed?.map((row) => row.id)).toEqual(["g1", "g2"]);
    const root = document.createElement("div");
    renderGraphsList(root, parsed ?? [], { onOpen: () => {}, onReload: () => {} }, true);
    expect(root.querySelectorAll(".graph-row")).toHaveLength(2);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
