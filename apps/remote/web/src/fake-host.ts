// SPDX-License-Identifier: Apache-2.0
// Test-only entry behind fake.html (served by vite dev, never built):
// the session shell driven by a fake host over an in-memory channel.
// Playwright drives it through window.__fake. It answers catalog, spawn,
// compose and prompt exactly like the daemon's session protocol.

import type { Terminal } from "@xterm/xterm";
import { createShell } from "./app.js";
import { signOut } from "./auth.js";
import { CatalogStore } from "./catalog.js";
import { createChannelHandler } from "./channel.js";
import { b64decode, b64encode, sha256Hex } from "./crypto.js";
import { createFakeGraphs } from "./fake-graphs.js";
import { GraphStore } from "./graph-store.js";
import { createGuestSession } from "./guest.js";
import { MetricsStore } from "./metrics-store.js";
import { buildCatalog, buildList, buildSpawn, newReqId } from "./protocol.js";
import type { PromptDraft, SessionItem, ShelfItem } from "./protocol.js";
import { createFrameRouter } from "./router.js";
import { SessionController } from "./session.js";
import { ShelfController } from "./shelf-controller.js";
import { openSessionName, SessionStore } from "./sessions.js";
import { MAX_UPLOAD_BYTES } from "./upload.js";
import { hostShelfImage, pushedShelfImage, smokeShelfImages } from "../test/fixtures/shelf-images.js";
import type { ShelfImage } from "../test/fixtures/shelf-images.js";
import "./styles.css";

const b64 = (text: string): string => b64encode(new TextEncoder().encode(text));

// The terminal's recorded writes are bytes, exactly as xterm receives them;
// joining them before decoding keeps a character split across frames whole.
const joinBytes = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
};

const textOf = (chunks: Uint8Array[]): string => new TextDecoder().decode(joinBytes(chunks));

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

// The fullscreen fixture for the alternate-buffer e2e: cursor-addressed
// numbered rows 01–24 painted into the alternate screen, the way a TUI
// paints a frame. Row 12 fills all 80 columns so the e2e can prove the
// right edge survives the fit.
const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";

function altRow(n: number): string {
  const label = `alt-row ${String(n).padStart(2, "0")}`;
  if (n === 12) {
    return `\x1b[${n};1H${label}-${"w".repeat(80 - label.length - 1 - 4)}|END`;
  }
  return `\x1b[${n};1H${label} · fullscreen ${n}`;
}

const ALT_SCREEN = ALT_ENTER + Array.from({ length: 24 }, (_, i) => altRow(i + 1)).join("");

function main(): void {
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Missing #app element");
  }
  const store = new SessionStore();
  const catalog = new CatalogStore();
  const sent: unknown[] = [];
  const terminalOutput: Uint8Array[] = [];
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
      kind: "agent",
      lastOutputAt: Date.now() - 30_000,
    },
    {
      id: "shell",
      name: "shell",
      cli: "",
      model: "",
      workdir: "/home/u/demo",
      status: "running",
      kind: "terminal",
      lastOutputAt: Date.now() - 120_000,
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
  // own shelf, one on the terminal's shelf the bridge never sends, and
  // one more the host pushes 2 s after attach.
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
  // A file on the terminal's own shelf that the bridge never sends:
  // shelf_list for a terminal session answers empty, so it never
  // surfaces in the union.
  putShelfFile(
    {
      name: "terminal-note.txt",
      mime: "text/plain",
      caption: "a terminal's note",
      bytes: new TextEncoder().encode("the bridge never sends terminal shelves\n"),
    },
    "shell",
    "shell",
    30_000,
  );

  const shelfItemsFor = (sessionId: string | null): ShelfItem[] => {
    if (sessionId !== null && sessions.find((item) => item.id === sessionId)?.kind === "terminal") {
      return [];
    }
    return shelfFiles
      .filter((file) => file.item.session_id === sessionId)
      .map((file) => file.item)
      .sort((a, b) => b.created_at - a.created_at);
  };

  // The upload half of the shelf: ?upload=off advertises no shelf_upload,
  // ?upload=denied advertises it but refuses every begin with forbidden
  // (a guest whose grant lacks upload), and otherwise a begun file is
  // stored on the target shelf with the mime the host sniffs.
  const uploadMode = new URLSearchParams(globalThis.location.search).get("upload");

  interface FakeUpload {
    fileId: string;
    sessionId: string | null;
    name: string;
    size: number;
    mime: string;
    sha256: string;
    parts: Map<number, Uint8Array>;
  }

  const uploads = new Map<string, FakeUpload>();
  let uploadCounter = 0;
  const MIME_BY_EXT: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    htm: "text/html",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    zip: "application/zip",
  };

  const sniffMime = (name: string, provided: string | undefined): string => {
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
    return MIME_BY_EXT[ext] ?? (provided !== undefined && provided !== "" ? provided : "application/octet-stream");
  };

  const finishUpload = async (upload: FakeUpload): Promise<void> => {
    const ordered = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]);
    const total = ordered.reduce((sum, [, bytes]) => sum + bytes.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const [, part] of ordered) {
      bytes.set(part, offset);
      offset += part.length;
    }
    if ((await sha256Hex(bytes)) !== upload.sha256) {
      uploads.delete(upload.fileId);
      deliver({ t: "error", code: "checksum_mismatch", message: "checksum mismatch", file_id: upload.fileId });
      return;
    }
    uploads.delete(upload.fileId);
    const workdir = sessions.find((item) => item.id === upload.sessionId)?.workdir ?? "/home/u/demo";
    const item: ShelfItem = {
      file_id: upload.fileId,
      session_id: upload.sessionId,
      name: upload.name,
      mime: upload.mime,
      size: bytes.length,
      caption: null,
      from: "you",
      created_at: Date.now(),
      path: `${workdir}/${upload.name}`,
      origin: "device",
    };
    shelfFiles.push({ item, bytes });
    deliver({ t: "shelf_added", item });
  };

  const sessionItems = () =>
    sessions.map((item) => ({
      id: item.id,
      name: item.name,
      cli: item.cli,
      model: item.model,
      workdir: item.workdir,
      status: item.status,
      kind: item.kind,
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
      size?: number;
      sha256?: string;
      mime?: string;
      part?: number;
      data?: string;
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
            kind: "agent",
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
    } else if (frame.t === "shelf_put_begin" && typeof frame.req === "string") {
      if (uploadMode === "denied") {
        deliver({ t: "error", req: frame.req, code: "forbidden", message: "upload not allowed" });
      } else if (
        typeof frame.name !== "string" ||
        frame.name === "" ||
        typeof frame.size !== "number" ||
        typeof frame.sha256 !== "string"
      ) {
        deliver({ t: "error", req: frame.req, code: "bad_request", message: "bad upload" });
      } else if (frame.size > MAX_UPLOAD_BYTES) {
        deliver({ t: "error", req: frame.req, code: "too_large", message: "file is larger than 20 MiB" });
      } else {
        uploadCounter += 1;
        const fileId = `u${uploadCounter}`;
        uploads.set(fileId, {
          fileId,
          sessionId: typeof frame.id === "string" && frame.id !== "" ? frame.id : null,
          name: frame.name,
          size: frame.size,
          mime: sniffMime(frame.name, frame.mime),
          sha256: frame.sha256,
          parts: new Map(),
        });
        deliver({ t: "shelf_put_ready", req: frame.req, file_id: fileId });
      }
    } else if (frame.t === "shelf_put_part" && typeof frame.file_id === "string") {
      const upload = uploads.get(frame.file_id);
      if (!upload || typeof frame.part !== "number" || typeof frame.data !== "string") {
        deliver({ t: "error", code: "bad_request", message: "bad part", file_id: frame.file_id });
      } else {
        upload.parts.set(frame.part, b64decode(frame.data));
        if ((frame.part + 1) % 8 === 0) {
          deliver({ t: "shelf_put_ack", file_id: frame.file_id, part: frame.part });
        }
      }
    } else if (frame.t === "shelf_put_end" && typeof frame.file_id === "string") {
      const upload = uploads.get(frame.file_id);
      if (upload) {
        void finishUpload(upload);
      } else {
        deliver({ t: "error", code: "not_found", message: "no such upload", file_id: frame.file_id });
      }
    } else if (frame.t === "shelf_put_abort" && typeof frame.file_id === "string") {
      uploads.delete(frame.file_id);
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
        kind: terminal ? "terminal" : "agent",
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
    const guestOutput: Uint8Array[] = [];
    const session = createGuestSession(root, {
      login: "guest-user",
      send,
      onRetry: () => {},
      onSignOut: () => {},
      onForgetDevice: () => {},
      onTerminalBytes: (bytes) => {
        guestOutput.push(bytes);
      },
      onTerminalClear: () => {
        guestOutput.length = 0;
      },
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
      terminalText: () => textOf(guestOutput),
      pushOut: (text: string) => {
        seq += 1;
        deliver({ t: "out", id: "smoke", seq, data: b64(text) });
      },
      pushOutSplit: (text: string, cut: number) => {
        const bytes = new TextEncoder().encode(text);
        seq += 1;
        deliver({ t: "out", id: "smoke", seq, data: b64encode(bytes.slice(0, cut)) });
        seq += 1;
        deliver({ t: "out", id: "smoke", seq, data: b64encode(bytes.slice(cut)) });
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
      onOpenSession: (id, spawnName) => {
        shell.showSession(id, openSessionName(id, store, spawnName));
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
      onControlSize: (cols, rows) => {
        controller.sendResize(cols, rows);
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
      write: (bytes) => {
        // Recorded here, not read back from the DOM: the WebGL renderer
        // has no .xterm-rows text to assert on.
        terminalOutput.push(bytes);
        shell.writeTerminal(bytes);
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

  // The host greets first: hello.features is what turns the shelf UI on,
  // and hello.harnesses is what the New dialog may offer (both installed).
  deliver({
    t: "hello",
    features: uploadMode === "off" ? ["shelf"] : ["shelf", "shelf_upload"],
    harnesses: ["muse", "claude"],
  });

  // Playwright picks the opening screen: the sessions home by default,
  // the hosts list for the sign-out walk, the sign-in for the colophon,
  // the pair form for the header-band look.
  const screen = new URLSearchParams(globalThis.location.search).get("screen");
  shell.setLogin("smoke");
  if (screen === "signin") {
    shell.setLogin(null);
    shell.showSignIn();
  } else if (screen === "pair") {
    shell.showPair();
    shell.setOnlineHosts([{ host_id: "0123456789abcdef", label: "demo host" }]);
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
    terminalText: () => textOf(terminalOutput),
    pushOut: (text: string) => {
      seq += 1;
      deliver({ t: "out", id: "smoke", seq, data: b64(text) });
    },
    pushOutSplit: (text: string, cut: number) => {
      const bytes = new TextEncoder().encode(text);
      seq += 1;
      deliver({ t: "out", id: "smoke", seq, data: b64encode(bytes.slice(0, cut)) });
      seq += 1;
      deliver({ t: "out", id: "smoke", seq, data: b64encode(bytes.slice(cut)) });
    },
    pushAltScreen: () => {
      seq += 1;
      deliver({ t: "out", id: "smoke", seq, data: b64(ALT_SCREEN) });
    },
    exitAltScreen: () => {
      seq += 1;
      deliver({ t: "out", id: "smoke", seq, data: b64(ALT_EXIT) });
    },
    bufferState: () => {
      const host = document.querySelector(".term-host") as (HTMLElement & { __xterm?: Terminal }) | null;
      const term = host?.__xterm;
      if (!term) {
        return null;
      }
      const active = term.buffer.active;
      const rows: string[] = [];
      for (let y = active.viewportY; y < active.viewportY + term.rows; y += 1) {
        rows.push(active.getLine(y)?.translateToString() ?? "");
      }
      return { type: active.type, rows, viewportY: active.viewportY, baseY: active.baseY };
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
      /** Push one frame whose UTF-8 bytes are cut at `cut`, splitting a character. */
      pushOutSplit: (text: string, cut: number) => void;
      /** Paint the numbered-rows fullscreen fixture into the alternate buffer. */
      pushAltScreen?: () => void;
      /** Leave the alternate screen, back to the shell. */
      exitAltScreen?: () => void;
      /** The visible viewport rows plus the active buffer type, or null. */
      bufferState?: () => { type: string; rows: string[]; viewportY: number; baseY: number } | null;
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
