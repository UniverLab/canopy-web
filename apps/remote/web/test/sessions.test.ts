// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSessions, SessionStore } from "../src/sessions.js";
import type { SessionItem } from "../src/protocol.js";

const NOW = 1793100000_000;

function item(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: "s1",
    name: "build",
    cli: "muse",
    model: "spark",
    workdir: "/home/u/proj",
    status: "running",
    lastOutputAt: NOW - 12_000,
    ...overrides,
  };
}

describe("SessionStore", () => {
  it("replaces, adds, removes and marks exited with notifications", () => {
    const store = new SessionStore();
    const seen: number[] = [];
    const stop = store.subscribe(() => seen.push(store.size));
    store.replace([item(), item({ id: "s2", name: "docs" })]);
    expect(store.list().map((row) => row.id)).toEqual(["s1", "s2"]);
    store.add(item({ id: "s3", name: "aaa" }));
    expect(store.list().map((row) => row.id)).toEqual(["s3", "s1", "s2"]);
    store.markExited("s1");
    expect(store.get("s1")?.status).toBe("exited");
    store.remove("s2");
    expect(store.get("s2")).toBeNull();
    expect(seen).toEqual([2, 3, 3, 2]);
    stop();
    store.remove("s1");
    expect(seen).toEqual([2, 3, 3, 2]);
  });

  it("ignores removals and exits of unknown sessions", () => {
    const store = new SessionStore();
    const notify = vi.fn();
    store.subscribe(notify);
    store.remove("ghost");
    store.markExited("ghost");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("renderSessions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function render(items: SessionItem[]) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opened: string[] = [];
    let news = 0;
    renderSessions(root, items, NOW, {
      onOpen: (id) => opened.push(id),
      onNew: () => {
        news += 1;
      },
    });
    return { root, opened, news: () => news };
  }

  it("shows name, cli and model, workdir basename, dot and age", () => {
    const { root, opened } = render([item()]);
    const row = root.querySelector<HTMLButtonElement>('[data-session="s1"]');
    expect(row?.querySelector(".session-name")?.textContent).toBe("build");
    expect(row?.querySelector(".session-sub")?.textContent).toBe("muse · spark · proj");
    expect(row?.querySelector(".session-age")?.textContent).toBe("last output 12s ago");
    expect(row?.querySelector(".dot-run")).not.toBeNull();
    row?.click();
    expect(opened).toEqual(["s1"]);
  });

  it("marks what each row is: bot, shell or the square of a dead one", () => {
    const { root } = render([
      item({ id: "agent", cli: "muse" }),
      item({ id: "shell", cli: "" }),
      item({ id: "dead", cli: "muse", status: "exited" }),
    ]);
    const kind = (id: string) =>
      root.querySelector(`[data-session="${id}"] .session-kind`)?.getAttribute("data-kind");
    expect(kind("agent")).toBe("bot");
    expect(kind("shell")).toBe("squareTerminal");
    expect(kind("dead")).toBe("square");
    for (const id of ["agent", "shell", "dead"]) {
      expect(root.querySelector(`[data-session="${id}"] .session-kind svg`), id).not.toBeNull();
    }
  });

  it("renders the dead dot for exited sessions", () => {
    const { root } = render([item({ status: "exited" })]);
    expect(root.querySelector(".dot-dead")).not.toBeNull();
  });

  it("shows the New button and the empty state", () => {
    const empty = render([]);
    expect(empty.root.querySelector(".empty")?.textContent).toContain("No sessions");
    empty.root.querySelector<HTMLButtonElement>("#session-new")?.click();
    expect(empty.news()).toBe(1);
  });

  it("escapes session names", () => {
    const { root } = render([item({ name: "<img src=x>" })]);
    expect(root.querySelector(".session-name")?.innerHTML).toBe("&lt;img src=x&gt;");
  });

  it("renders the guest list with no New button", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opened: string[] = [];
    renderSessions(
      root,
      [item()],
      NOW,
      {
        onOpen: (id) => opened.push(id),
        onNew: () => {},
      },
      undefined,
      true,
      true,
    );
    expect(root.querySelector(".sessions-head h2")?.textContent).toBe("Shared sessions");
    expect(root.querySelector("#session-new")).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-session="s1"]')?.click();
    expect(opened).toEqual(["s1"]);
  });

  it("tells a guest what an empty grant means", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const callbacks = {
      onOpen: () => {},
      onNew: () => {},
    };
    renderSessions(root, [], NOW, callbacks, undefined, true, true);
    expect(root.querySelector("p.empty")?.textContent).toBe("No sessions shared with you.");
    renderSessions(root, [], NOW, callbacks, undefined, false, true);
    expect(root.querySelector("p.empty")?.textContent).toBe("Connecting to the host…");
  });
});
