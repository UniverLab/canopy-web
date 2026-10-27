// SPDX-License-Identifier: Apache-2.0
// Test-only entry behind fake.html (served by vite dev, never built):
// the session shell driven by a fake host over an in-memory channel.
// Playwright drives it through window.__fake.

import { createShell } from "./app.js";
import { createChannelHandler } from "./channel.js";
import { b64encode } from "./crypto.js";
import { buildList, newReqId } from "./protocol.js";
import { createFrameRouter } from "./router.js";
import { SessionController } from "./session.js";
import { SessionStore } from "./sessions.js";
import "./styles.css";

const b64 = (text: string): string => b64encode(new TextEncoder().encode(text));

const SESSION = {
  id: "smoke",
  name: "smoke",
  cli: "muse",
  model: "spark",
  workdir: "/home/u/demo",
  status: "running",
  last_output_at: Math.floor(Date.now() / 1000) - 30,
};

function main(): void {
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("Missing #app element");
  }
  const store = new SessionStore();
  const sent: unknown[] = [];
  let seq = 7;
  let promptError: { code: string; message: string } | null = null;

  const deliver = (frame: unknown): void => {
    frames.push(JSON.stringify(frame));
  };

  const send = (data: string): boolean => {
    const frame = JSON.parse(data) as { t: string; id?: string; req?: string; text?: string };
    sent.push(frame);
    if (frame.t === "list") {
      deliver({ t: "sessions", req: frame.req, items: [SESSION] });
    } else if (frame.t === "attach" && frame.id === "smoke") {
      const full = b64("$ muse run\nhello from the host\n");
      deliver({ t: "snapshot", id: "smoke", cols: 80, rows: 24, seq, data: full.slice(0, 10) });
      deliver({ t: "snapshot_more", id: "smoke", data: full.slice(10), last: true });
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

  const shell = createShell(root, store, {
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
    onNew: () => {},
    onBuilder: () => {},
  });

  const controller = new SessionController({
    send,
    terminal: () => ({
      write: (text) => shell.writeTerminal(text),
      clear: () => shell.clearTerminal(),
    }),
    onExited: (_id, code) => shell.showSessionExited(code),
  });

  // The smoke test drives the same routing the app uses.
  const router = createFrameRouter({ store, controller, shell });
  const frames = createChannelHandler({
    onSnapshot: router.handleSnapshot,
    onFrame: router.handleFrame,
  });

  shell.setLogin("smoke");
  shell.setHostLabel("smoke host");
  shell.setConnectionState("connected");
  shell.showSessions();
  send(buildList(newReqId()));

  window.__fake = {
    sent: () => [...sent],
    clearSent: () => {
      sent.length = 0;
    },
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
      pushOut: (text: string) => void;
      failNextPrompt: (code: string, message: string) => void;
    };
  }
}

main();
