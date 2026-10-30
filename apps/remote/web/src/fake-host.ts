// SPDX-License-Identifier: Apache-2.0
// Test-only entry behind fake.html (served by vite dev, never built):
// the session shell driven by a fake host over an in-memory channel.
// Playwright drives it through window.__fake. It answers catalog, spawn,
// compose and prompt exactly like the daemon's session protocol.

import { createShell } from "./app.js";
import { signOut } from "./auth.js";
import { CatalogStore } from "./catalog.js";
import { createChannelHandler } from "./channel.js";
import { b64encode } from "./crypto.js";
import { GraphStore } from "./graph-store.js";
import { createGuestSession } from "./guest.js";
import { MetricsStore } from "./metrics-store.js";
import { mountCanopyBackground } from "../../../../packages/look/fondo/index.js";
import { buildCatalog, buildList, buildSpawn, newReqId } from "./protocol.js";
import type { GraphState, GraphSummary, NodeStatus, PromptDraft, SessionItem, ShelfItem } from "./protocol.js";
import { createFrameRouter } from "./router.js";
import { SessionController } from "./session.js";
import { ShelfController } from "./shelf-controller.js";
import { SessionStore } from "./sessions.js";
import { hostShelfImage, pushedShelfImage, smokeShelfImages } from "../test/fixtures/shelf-images.js";
import type { ShelfImage } from "../test/fixtures/shelf-images.js";
import "./styles.css";

const b64 = (text: string): string => b64encode(new TextEncoder().encode(text));

const CATALOG = {
  clis: [
    { cli: "muse", label: "Muse", models: ["spark", "core"], yolo: true },
    { cli: "claude", label: "Claude", models: [] },
  ],
  projects: [
    { name: "demo", path: "/home/u/demo" },
    { name: "other", path: "/home/u/other" },
  ],
  presets: [{ name: "review", preview: "Review the current diff, then fix what you find." }],
  skills: [
    { name: "tdd", label: "TDD" },
    { name: "docs", label: "Docs" },
  ],
};

function composeText(draft: PromptDraft): string {
  const parts: string[] = [];
  if (draft.preset) {
    parts.push(`preset: ${draft.preset}`);
  }
  for (const section of draft.sections) {
    parts.push(`## ${section.title}\n${section.content}`);
  }
  if (draft.skills.length > 0) {
    parts.push(`skills: ${draft.skills.join(", ")}`);
  }
  if (draft.project) {
    parts.push(`project: ${draft.project}`);
  }
  return parts.join("\n\n");
}

// --- The graph fixtures ----------------------------------------------
// Two graphs over the session wire: one running with an ensemble whose
// live state advances every 2 s (and completes a spec every few ticks),
// one already completed. The graph frames the remote's Graphs tab and
// graph view speak are answered exactly like the host spec describes.

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

function createFakeGraphs(deliver: (frame: unknown) => void): FakeGraphs {
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
          items: [loopSummary(startedAt, loopState()), doneSummary],
        });
        return true;
      }
      if (frame.t === "graph_watch" && typeof frame.id === "string") {
        if (frame.id !== "g-loop" && frame.id !== "g-done") {
          return true;
        }
        watched = frame.id;
        if (frame.id === "g-loop") {
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

// What the smoke session prints: a real canopy-like screen, so the
// operator's screenshots show the palette, the box drawing and the block
// elements instead of two grey lines.
const SMOKE_OUTPUT = [
  "$ muse run",
  "hello from the host",
  "",
  "\x1b[30m██\x1b[31m██\x1b[32m██\x1b[33m██\x1b[34m██\x1b[35m██\x1b[36m██\x1b[37m██\x1b[0m  normal",
  "\x1b[90m██\x1b[91m██\x1b[92m██\x1b[93m██\x1b[94m██\x1b[95m██\x1b[96m██\x1b[97m██\x1b[0m  bright",
  "\x1b[38;2;63;184;176mtruecolor 3fb8b0\x1b[0m",
  "┌──────────┐",
  "│ canopy   │",
  "│ session  │",
  "└──────────┘",
  "▁▂▃▄▅▆▇█",
  "\x1b[32m●\x1b[0m smoke · running · 80×24 · 2.3k tok",
].join("\r\n") + "\r\n";

function main(): void {
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Missing #app element");
  }
  // The same honeycomb the real entry mounts, so the smoke run sees the
  // dressed page.
  const fondo = document.getElementById("fondo");
  if (fondo) {
    mountCanopyBackground(fondo, "/look/fondo/assets/");
  }
  const store = new SessionStore();
  const catalog = new CatalogStore();
  const sent: unknown[] = [];
  const terminalOutput: string[] = [];
  let seq = 7;
  let nextSpawn = 0;
  let promptError: { code: string; message: string } | null = null;

  const sessions: SessionItem[] = [
    {
      id: "smoke",
      name: "smoke",
      cli: "muse",
      model: "spark",
      workdir: "/home/u/demo",
      status: "running",
      lastOutputAt: Date.now() - 30_000,
    },
  ];

  // Deliveries land in the owner's channel handler — or the guest
  // session's, once guest mode repoints them. Late-bound because guest
  // mode returns before the owner's wiring exists.
  let deliverInto: (raw: string) => void = () => {};
  const deliver = (frame: unknown): void => {
    deliverInto(JSON.stringify(frame));
  };

  // The shelf: three images for the smoke session, one on the host's
  // own shelf, and one more the host pushes 2 s after attach.
  interface FakeShelfFile {
    item: ShelfItem;
    bytes: Uint8Array;
  }
  const startedAt = Date.now();
  const shelfFiles: FakeShelfFile[] = [];
  let shelfFileCounter = 0;
  let pushedFor: string | null = null;

  const putShelfFile = (
    image: ShelfImage,
    sessionId: string | null,
    from: string,
    ageMs: number,
  ): ShelfItem => {
    shelfFileCounter += 1;
    const item: ShelfItem = {
      file_id: `f${shelfFileCounter}`,
      session_id: sessionId,
      name: image.name,
      mime: image.mime,
      size: image.bytes.length,
      caption: image.caption,
      from,
      created_at: startedAt - ageMs,
    };
    shelfFiles.push({ item, bytes: image.bytes });
    return item;
  };

  for (const [index, image] of smokeShelfImages().entries()) {
    putShelfFile(image, "smoke", "muse", (index + 1) * 60_000);
  }
  putShelfFile(hostShelfImage(), null, "canopy", 5 * 60_000);

  const shelfItemsFor = (sessionId: string | null): ShelfItem[] =>
    shelfFiles
      .filter((file) => file.item.session_id === sessionId)
      .map((file) => file.item)
      .sort((a, b) => b.created_at - a.created_at);

  const sessionItems = () =>
    sessions.map((item) => ({
      id: item.id,
      name: item.name,
      cli: item.cli,
      model: item.model,
      workdir: item.workdir,
      status: item.status,
      last_output_at: item.lastOutputAt === null ? null : Math.floor(item.lastOutputAt / 1000),
    }));

  const fakeGraphs = createFakeGraphs(deliver);

  // --- The host metrics fixture ---------------------------------------
  // A watch is answered with a frame at once and then every interval,
  // until unwatch. ?metrics=silent never answers, so the strip-hiding
  // path has a host of its own.
  const metricsSilent = new URLSearchParams(globalThis.location.search).get("metrics") === "silent";
  let metricsCount = 0;
  let metricsTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  const metricsFrame = (patch: Record<string, unknown> = {}): unknown => {
    metricsCount += 1;
    return {
      t: "host.metrics",
      sampled_at: Date.now(),
      metrics: {
        cpu_usage: 10 + ((metricsCount * 7) % 60),
        cpu_temperature_c: 54,
        cpu_temp_source: "coretemp",
        memory_used_mb: 3200,
        memory_total_mb: 8192,
        gpu: {
          usage: 40,
          temperature_c: 62,
          name: "GeForce GTX",
          vram_used_mb: 1024,
          vram_total_mb: 8192,
        },
        power: { watts: 65, limit_watts: 120, source: "gpu" },
        ...patch,
      },
    };
  };

  const stopMetrics = (): void => {
    if (metricsTimer !== null) {
      globalThis.clearInterval(metricsTimer);
      metricsTimer = null;
    }
  };

  const startMetrics = (intervalSec: number): void => {
    // A watch while already pushing changes nothing: the subscription is
    // idempotent, so a duplicate watch never resets the pushed samples.
    if (metricsTimer !== null) {
      return;
    }
    if (metricsSilent) {
      return;
    }
    deliver(metricsFrame());
    const interval = Math.min(60, Math.max(5, Math.floor(intervalSec)));
    metricsTimer = globalThis.setInterval(() => deliver(metricsFrame()), interval * 1000);
  };

  // Guest mode (?screen=guest): the hub's grant over the sessions the
  // owner holds, enforced the way the hub enforces it — the list carries
  // only granted ids and any other attach is forbidden. `grant=none`
  // names no session, so the guest is untrusted: an empty list and every
  // attach denied.
  const fakeParams = new URLSearchParams(globalThis.location.search);
  const guestGrant: string[] | null =
    fakeParams.get("screen") === "guest" ? (fakeParams.get("grant")?.split(",") ?? ["smoke"]) : null;

  const send = (data: string): boolean => {
    const frame = JSON.parse(data) as {
      t: string;
      id?: string;
      req?: string;
      text?: string;
      kind?: string;
      cli?: string;
      workdir?: string;
      name?: string;
      file_id?: string;
      interval?: number;
      draft?: PromptDraft;
    };
    sent.push(frame);
    if (frame.t === "list") {
      if (guestGrant === null) {
        deliver({ t: "sessions", req: frame.req, items: sessionItems() });
      } else {
        // The owner holds smoke and secret; the grant decides what the
        // guest's list carries.
        const held = [
          ...sessionItems(),
          {
            id: "secret",
            name: "secret",
            cli: "muse",
            model: "spark",
            workdir: "/home/u/secret",
            status: "running",
            last_output_at: null,
          },
        ];
        deliver({ t: "sessions", req: frame.req, items: held.filter((item) => guestGrant.includes(item.id)) });
      }
    } else if (frame.t === "catalog") {
      deliver({ t: "catalog", req: frame.req, ...CATALOG });
    } else if (fakeGraphs.handle(frame)) {
      // graphs, graph_watch and graph_unwatch: answered by the fixtures.
    } else if (frame.t === "host.metrics.watch") {
      startMetrics(typeof frame.interval === "number" ? frame.interval : 10);
    } else if (frame.t === "host.metrics.unwatch") {
      stopMetrics();
    } else if (frame.t === "attach" && typeof frame.id === "string") {
      if (guestGrant !== null && !guestGrant.includes(frame.id)) {
        deliver({ t: "error", code: "forbidden", id: frame.id });
      } else {
        const full = b64(SMOKE_OUTPUT);
        deliver({ t: "snapshot", id: frame.id, cols: 80, rows: 24, seq, data: full.slice(0, 10) });
        deliver({ t: "snapshot_more", id: frame.id, data: full.slice(10), last: true });
        const attached = frame.id;
        if (pushedFor === null) {
          pushedFor = attached;
          globalThis.setTimeout(() => {
            const item = putShelfFile(pushedShelfImage(), attached, "muse", 0);
            deliver({ t: "shelf_added", item });
          }, 2000);
        }
      }
    } else if (frame.t === "shelf_list") {
      const id = typeof frame.id === "string" && frame.id !== "" ? frame.id : null;
      const reply: Record<string, unknown> = {
        t: "shelf",
        req: frame.req,
        items: shelfItemsFor(id),
      };
      if (id !== null) {
        reply.id = id;
      }
      deliver(reply);
    } else if (frame.t === "shelf_get" && typeof frame.req === "string" && typeof frame.file_id === "string") {
      const file = shelfFiles.find((row) => row.item.file_id === frame.file_id);
      if (!file) {
        deliver({ t: "error", req: frame.req, code: "not_found", message: "no such file" });
      } else {
        // 12 KiB parts, so even the smallest shelf crosses a boundary.
        const PART = 12 * 1024;
        const total = file.bytes.length;
        const partCount = Math.max(1, Math.ceil(total / PART));
        for (let part = 0; part < partCount; part += 1) {
          const slice = file.bytes.subarray(part * PART, Math.min(total, (part + 1) * PART));
          deliver({
            t: "file",
            req: frame.req,
            file_id: file.item.file_id,
            part,
            data: b64encode(slice),
            last: part === partCount - 1,
          });
        }
      }
    } else if (frame.t === "spawn") {
      nextSpawn += 1;
      const id = `spawned-${nextSpawn}`;
      const terminal = frame.kind === "terminal";
      const item: SessionItem = {
        id,
        name: frame.name ?? id,
        cli: terminal ? "" : (frame.cli ?? ""),
        model: "",
        workdir: frame.workdir ?? "",
        status: "running",
        lastOutputAt: null,
      };
      sessions.push(item);
      deliver({ t: "spawned", req: frame.req, id });
      deliver({ t: "session_added", item: sessionItems()[sessions.length - 1] });
    } else if (frame.t === "compose") {
      const draft = frame.draft ?? { sections: [], skills: [] };
      deliver({ t: "composed", req: frame.req, text: composeText(draft) });
    } else if (frame.t === "prompt" && typeof frame.req === "string") {
      if (promptError) {
        deliver({ t: "error", req: frame.req, code: promptError.code, message: promptError.message });
        promptError = null;
      } else {
        deliver({ t: "ok", req: frame.req });
      }
    }
    return true;
  };

  // Guest mode: the /g/ session wiring against the fake host — no relay,
  // no peer, the same guest views, store, controller and router that
  // production mounts, already connected.
  if (fakeParams.get("screen") === "guest") {
    const session = createGuestSession(root, {
      login: "guest-user",
      send,
      onRetry: () => {},
      onSignOut: () => {},
      onForgetDevice: () => {},
    });
    deliverInto = (raw: string) => session.push(raw);
    session.view.setConnectionState("connected");
    session.view.showList();
    send(buildList(newReqId()));
    window.__fake = {
      sent: () => [...sent],
      clearSent: () => {
        sent.length = 0;
      },
      terminalText: () => "",
      pushOut: (text: string) => {
        seq += 1;
        deliver({ t: "out", id: "smoke", seq, data: b64(text) });
      },
      failNextPrompt: (code: string, message: string) => {
        promptError = { code, message };
      },
      graphTick: () => {
        fakeGraphs.tick();
      },
      pushMetrics: (patch?: Record<string, unknown>) => {
        deliver(metricsFrame(patch ?? {}));
      },
      guestOpen: (id: string) => session.open(id),
    };
    return;
  }

  // The shelf controller and the graph store the real entry point wires
  // the same way.
  const shelf = new ShelfController({ send, sessions: store });
  const graphs = new GraphStore({ send });
  const metrics = new MetricsStore({ send });

  const shell = createShell(
    root,
    store,
    {
      onPair: () => {},
      onConnect: () => {},
      onDisconnect: () => {},
      onRetry: () => {},
      onPairAgain: () => {},
      onOpenSession: (id) => {
        shell.showSession(id, store.get(id)?.name ?? id);
        controller.open(id);
      },
      onLeaveSession: () => {
        controller.close();
        shell.showSessions();
      },
      onSignOut: () => void doFakeSignOut(),
      onForgetDevice: () => void doFakeSignOut(),
      onKeyPress: (bytes) => {
        controller.sendInputBytes(bytes);
      },
      onTerminalInput: (bytes) => {
        controller.sendInputBytes(bytes);
      },
      onComposerSend: (text, req) => {
        controller.sendPrompt(text, req);
      },
      onSpawn: (spawn, req) => send(buildSpawn(req, spawn)),
      onCompose: (draft, req) => send(JSON.stringify({ t: "compose", req, draft })),
      onSendDraft: (draft, req) => controller.sendPromptDraft(draft, req),
      onGraphsRequest: () => {
        graphs.requestList();
      },
      onWatchGraph: (id) => {
        graphs.watch(id);
      },
      onUnwatchGraph: () => {
        graphs.unwatch();
      },
      onWatchMetrics: () => {
        metrics.watch();
      },
      onUnwatchMetrics: () => {
        metrics.unwatch();
      },
    },
    { catalog, shelf, graphs, metrics },
  );

  const controller = new SessionController({
    send,
    terminal: () => ({
      write: (text) => {
        // Recorded here, not read back from the DOM: the WebGL renderer
        // has no .xterm-rows text to assert on.
        terminalOutput.push(text);
        shell.writeTerminal(text);
      },
      clear: () => {
        terminalOutput.length = 0;
        shell.clearTerminal();
      },
    }),
    onExited: (_id, code) => shell.showSessionExited(code),
  });

  // The smoke test drives the same routing the app uses.
  const router = createFrameRouter({ store, controller, shell, catalog, shelf, graphs, metrics });
  const frames = createChannelHandler({
    onSnapshot: router.handleSnapshot,
    onFrame: router.handleFrame,
  });
  deliverInto = (raw: string) => frames.push(raw);

  // The real sign-out POST, so Playwright can stub or refuse /auth/logout
  // and watch the shell land on the sign-in screen or hold its error.
  async function doFakeSignOut(): Promise<void> {
    shell.setSignOutError(null);
    try {
      await signOut();
    } catch (err) {
      shell.setSignOutError(err instanceof Error ? err.message : "Could not sign out");
      return;
    }
    controller.close();
    shell.setLogin(null);
    shell.showSignIn();
  }

  // The host greets first: hello.features is what turns the shelf UI on.
  deliver({ t: "hello", features: ["shelf"] });

  // Playwright picks the opening screen: the sessions home by default,
  // the hosts list for the sign-out walk, the sign-in for the colophon.
  const screen = new URLSearchParams(globalThis.location.search).get("screen");
  shell.setLogin("smoke");
  if (screen === "signin") {
    shell.setLogin(null);
    shell.showSignIn();
  } else if (screen === "hosts") {
    shell.setPairedHosts([{ host_id: "h1", label: "demo host" }]);
    shell.showHosts();
  } else {
    shell.setHostLabel("smoke host");
    shell.setConnectionState("connected");
    shell.showSessions();
    send(buildList(newReqId()));
    send(buildCatalog(newReqId()));
  }

  window.__fake = {
    sent: () => [...sent],
    clearSent: () => {
      sent.length = 0;
    },
    terminalText: () => terminalOutput.join(""),
    pushOut: (text: string) => {
      seq += 1;
      deliver({ t: "out", id: "smoke", seq, data: b64(text) });
    },
    failNextPrompt: (code: string, message: string) => {
      promptError = { code, message };
    },
    graphTick: () => {
      fakeGraphs.tick();
    },
    pushMetrics: (patch?: Record<string, unknown>) => {
      deliver(metricsFrame(patch ?? {}));
    },
  };
}

declare global {
  interface Window {
    __fake: {
      sent: () => unknown[];
      clearSent: () => void;
      terminalText: () => string;
      pushOut: (text: string) => void;
      failNextPrompt: (code: string, message: string) => void;
      /** Advance the running graph fixture one step and push its state. */
      graphTick: () => void;
      /** Push one metrics frame, with the patch merged over the fixture. */
      pushMetrics: (patch?: Record<string, unknown>) => void;
      /** Guest mode only: open one session by id, listed or not. */
      guestOpen?: (id: string) => void;
    };
  }
}

main();
