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

describe("SessionController scheduled prompts", () => {
  const open = (): { controller: SessionController; sent: string[] } => {
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
    return { controller, sent };
  };

  it("refuses without an open session", () => {
    const controller = new SessionController({ send: () => true, terminal: () => null });
    expect(controller.sendPromptSchedule(DRAFT, "2030-01-01T09:00:00.000Z", "r1")).toBe(false);
    expect(controller.sendScheduledList("r2")).toBe(false);
    expect(controller.sendScheduledCancel("ss-1", "r3")).toBe(false);
  });

  it("sends the exact schedule frames for the open session", () => {
    const { controller, sent } = open();
    expect(controller.sendPromptSchedule(DRAFT, "2030-01-01T09:00:00.000Z", "r4")).toBe(true);
    expect(controller.sendScheduledList("r5")).toBe(true);
    expect(controller.sendScheduledCancel("ss-1", "r6")).toBe(true);
    expect(sent.map((raw) => JSON.parse(raw))).toEqual([
      {
        t: "prompt_schedule",
        req: "r4",
        id: "s1",
        draft: DRAFT,
        fire_at: "2030-01-01T09:00:00.000Z",
      },
      { t: "scheduled_list", req: "r5", id: "s1" },
      { t: "scheduled_cancel", req: "r6", id: "s1", schedule_id: "ss-1" },
    ]);
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
        onSignOut: () => {},
        onForgetDevice: () => {},
        onKeyPress: () => {},
        onTerminalInput: () => {},
        onControlSize: () => {},
        onSpawn: () => true,
        onCompose: () => true,
        onSendDraft: (draft, req) => controller?.sendPromptDraft(draft, req) ?? false,
        onSchedule: (draft, fireAt, req) => controller?.sendPromptSchedule(draft, fireAt, req) ?? false,
        onScheduledList: (req) => controller?.sendScheduledList(req) ?? false,
        onScheduledCancel: (scheduleId, req) => controller?.sendScheduledCancel(scheduleId, req) ?? false,
        onGraphsRequest: () => {},
        onWatchGraph: () => {},
        onUnwatchGraph: () => {},
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

    shell.showBuilder();
    // Opening the sheet lists the session's schedules; Send is what this
    // test counts, so drop the list frame before clicking it.
    expect(channel.sent.map((raw) => (JSON.parse(raw) as { t: string }).t)).toEqual([
      "attach",
      "scheduled_list",
    ]);
    channel.sent.length = 0;
    const kind = root.querySelector<HTMLSelectElement>(".section-kind");
    if (!kind) {
      throw new Error("missing section kind");
    }
    kind.value = "goal";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    const content = root.querySelector<HTMLTextAreaElement>(".section-content");
    if (!content) {
      throw new Error("missing section content");
    }
    content.value = "ship it";
    content.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("#builder-send")?.click();

    expect(channel.sent).toHaveLength(1);
    const frame = JSON.parse(channel.sent[0] ?? "null") as { t: string; req: string; id: string; draft: PromptDraft };
    expect(frame).toEqual({
      t: "prompt",
      req: frame.req,
      id: "s1",
      draft: { sections: [{ title: "goal", content: "ship it" }], skills: [] },
    });
    expect(root.querySelector(".sheet-overlay")).not.toBeNull();

    channel.deliver(JSON.stringify({ t: "ok", req: frame.req }));
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });
});
