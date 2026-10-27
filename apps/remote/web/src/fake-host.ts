// SPDX-License-Identifier: Apache-2.0
// Test-only entry behind fake.html (served by vite dev, never built):
// the session shell driven by a fake host over an in-memory channel.
// Playwright drives it through window.__fake. It answers catalog, spawn,
// compose and prompt exactly like the daemon's session protocol.

import { createShell } from "./app.js";
import { CatalogStore } from "./catalog.js";
import { createChannelHandler } from "./channel.js";
import { b64encode } from "./crypto.js";
import { mountCanopyBackground } from "../../../../packages/look/fondo/index.js";
import { buildCatalog, buildList, newReqId } from "./protocol.js";
import type { PromptDraft, SessionItem } from "./protocol.js";
import { createFrameRouter } from "./router.js";
import { SessionController } from "./session.js";
import { SessionStore } from "./sessions.js";
import "./styles.css";

const b64 = (text: string): string => b64encode(new TextEncoder().encode(text));

const CATALOG = {
  clis: [
    { cli: "muse", label: "Muse", models: ["spark", "core"] },
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

  const deliver = (frame: unknown): void => {
    frames.push(JSON.stringify(frame));
  };

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

  const send = (data: string): boolean => {
    const frame = JSON.parse(data) as {
      t: string;
      id?: string;
      req?: string;
      text?: string;
      cli?: string;
      model?: string;
      workdir?: string;
      name?: string;
      draft?: PromptDraft;
    };
    sent.push(frame);
    if (frame.t === "list") {
      deliver({ t: "sessions", req: frame.req, items: sessionItems() });
    } else if (frame.t === "catalog") {
      deliver({ t: "catalog", req: frame.req, ...CATALOG });
    } else if (frame.t === "attach" && typeof frame.id === "string") {
      const full = b64(SMOKE_OUTPUT);
      deliver({ t: "snapshot", id: frame.id, cols: 80, rows: 24, seq, data: full.slice(0, 10) });
      deliver({ t: "snapshot_more", id: frame.id, data: full.slice(10), last: true });
    } else if (frame.t === "spawn") {
      nextSpawn += 1;
      const id = `spawned-${nextSpawn}`;
      const item: SessionItem = {
        id,
        name: frame.name ?? id,
        cli: frame.cli ?? "",
        model: frame.model ?? "",
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
      onKeyPress: (def) => {
        controller.sendInputBytes(new Uint8Array(def.bytes));
      },
      onTerminalInput: (text) => {
        controller.sendInputText(text);
      },
      onComposerSend: (text, req) => {
        controller.sendPrompt(text, req);
      },
      onSpawn: (spawn, req) => {
        const frame = { t: "spawn", req, kind: "agent", ...spawn };
        return send(JSON.stringify(frame));
      },
      onCompose: (draft, req) => send(JSON.stringify({ t: "compose", req, draft })),
      onSendDraft: (draft, req) => controller.sendPromptDraft(draft, req),
    },
    { catalog },
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
  const router = createFrameRouter({ store, controller, shell, catalog });
  const frames = createChannelHandler({
    onSnapshot: router.handleSnapshot,
    onFrame: router.handleFrame,
  });

  shell.setLogin("smoke");
  shell.setHostLabel("smoke host");
  shell.setConnectionState("connected");
  shell.showSessions();
  send(buildList(newReqId()));
  send(buildCatalog(newReqId()));

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
    };
  }
}

main();
