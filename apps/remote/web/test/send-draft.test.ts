// SPDX-License-Identifier: Apache-2.0
// The Prompt Builder's send path end to end: the shell's Send ships
// prompt{id,draft} through the controller and the host's ok closes the
// sheet, so the exact frame and the reply matching share one test.

import { afterEach, describe, expect, it } from "vitest";
import { createShell } from "../src/app.js";
import type { Shell } from "../src/app.js";
import { CatalogStore } from "../src/catalog.js";
import { createChannelHandler } from "../src/channel.js";
import type { PromptDraft } from "../src/protocol.js";
import { createFrameRouter } from "../src/router.js";
import { SessionController } from "../src/session.js";
import { SessionStore } from "../src/sessions.js";
import { FakeDataChannel } from "./fakes.js";

const DRAFT: PromptDraft = {
  sections: [{ title: "Goal", content: "ship it" }],
  preset: "review",
  skills: ["tdd"],
  project: "demo",
};

describe("SessionController.sendPromptDraft", () => {
  it("refuses without an open session", () => {
    const sent: string[] = [];
    const controller = new SessionController({
      send: (data) => {
        sent.push(data);
        return true;
      },
      terminal: () => null,
    });
    expect(controller.sendPromptDraft(DRAFT, "r1")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("sends the exact prompt-with-draft frame for the open session", () => {
    const sent: string[] = [];
    const controller = new SessionController({
      send: (data) => {
        sent.push(data);
        return true;
      },
      terminal: () => null,
    });
    controller.open("s1");
    sent.length = 0;
    expect(controller.sendPromptDraft(DRAFT, "r2")).toBe(true);
    expect(JSON.parse(sent[0] ?? "null")).toEqual({
      t: "prompt",
      req: "r2",
      id: "s1",
      draft: DRAFT,
    });
  });

  it("reports a failed send", () => {
    const controller = new SessionController({
      send: () => false,
      terminal: () => null,
    });
    controller.open("s1");
    expect(controller.sendPromptDraft(DRAFT, "r3")).toBe(false);
  });
});

describe("Prompt Builder send through the shell", () => {
  let root: HTMLDivElement | null = null;
  let shell: Shell | null = null;

  afterEach(() => {
    shell?.dispose();
    shell = null;
    root?.remove();
    root = null;
    document.body.innerHTML = "";
  });

  it("sends the built draft and closes on the host's ok", () => {
    const channel = new FakeDataChannel("canopy-session-v1", { ordered: true });
    const store = new SessionStore();
    const catalog = new CatalogStore();
    catalog.replace({
      clis: [{ cli: "muse", label: "Muse", models: [] }],
      projects: [{ name: "demo", path: "/home/u/demo" }],
      presets: [{ name: "review", preview: "Review the diff." }],
      skills: [{ name: "tdd", label: "TDD" }],
    });
    root = document.createElement("div");
    document.body.appendChild(root);

    let controller: SessionController | null = null;
    shell = createShell(
      root,
      store,
      {
        onPair: () => {},
        onConnect: () => {},
        onDisconnect: () => {},
        onRetry: () => {},
        onPairAgain: () => {},
        onOpenSession: () => {},
        onLeaveSession: () => {},
        onKeyPress: () => {},
        onTerminalInput: () => {},
        onComposerSend: () => {},
        onSpawn: () => true,
        onCompose: () => true,
        onSendDraft: (draft, req) => controller?.sendPromptDraft(draft, req) ?? false,
      },
      { catalog },
    );
    controller = new SessionController({
      send: (data) => {
        channel.send(data);
        return true;
      },
      terminal: () => ({ write: () => {}, clear: () => {} }),
    });
    const router = createFrameRouter({ store, controller, shell, catalog });
    const frames = createChannelHandler({
      onSnapshot: router.handleSnapshot,
      onFrame: router.handleFrame,
    });
    channel.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === "string") {
        frames.push(ev.data);
      }
    };

    shell.showSession("s1", "build");
    controller.open("s1");
    channel.sent.length = 0;

    shell.showBuilder();
    const title = root.querySelector<HTMLInputElement>(".section-title");
    if (!title) {
      throw new Error("missing section title");
    }
    title.value = "Goal";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("#builder-send")?.click();

    expect(channel.sent).toHaveLength(1);
    const frame = JSON.parse(channel.sent[0] ?? "null") as { t: string; req: string; id: string; draft: PromptDraft };
    expect(frame).toEqual({
      t: "prompt",
      req: frame.req,
      id: "s1",
      draft: { sections: [{ title: "Goal", content: "" }], skills: [] },
    });
    expect(root.querySelector(".sheet-overlay")).not.toBeNull();

    channel.deliver(JSON.stringify({ t: "ok", req: frame.req }));
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });
});
