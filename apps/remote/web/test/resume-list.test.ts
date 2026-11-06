// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResumeList } from "../src/resume-list.js";
import type { ResumeRow } from "../src/resume-list.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ROWS: ResumeRow[] = [
  {
    id: "a",
    name: "Refactor the Parser",
    cli: "muse",
    workdir: "/home/u/demo",
    started_at: NOW - 2 * HOUR,
    has_conversation: true,
  },
  {
    id: "b",
    name: "Docs pass",
    cli: "claude",
    workdir: "/home/u/other",
    started_at: NOW - 26 * HOUR,
    has_conversation: true,
  },
  {
    id: "c",
    name: "nightly build",
    cli: "muse",
    workdir: "/home/u/demo",
    started_at: NOW - 3 * DAY,
    has_conversation: false,
  },
];

describe("ResumeList", () => {
  let root: HTMLDivElement;
  let list: ResumeList;
  let resumed: string[];
  let retries: number;

  const query = <T extends Element>(selector: string): T => {
    const el = root.querySelector(selector);
    if (!el) {
      throw new Error(`missing ${selector}`);
    }
    return el as T;
  };

  const rows = (): HTMLButtonElement[] => [
    ...root.querySelectorAll<HTMLButtonElement>(".resume-row"),
  ];

  const rowText = (id: string): string =>
    query<HTMLElement>(`.resume-row[data-resume-id="${id}"]`).textContent ?? "";

  const filter = (value: string): void => {
    const input = query<HTMLInputElement>("#resume-filter");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    resumed = [];
    retries = 0;
    list = new ResumeList({
      onResume: (id) => resumed.push(id),
      onRetry: () => {
        retries += 1;
      },
      nowMs: () => NOW,
    });
    list.mount(root);
  });

  afterEach(() => {
    list.clear();
    root.remove();
    document.body.innerHTML = "";
  });

  it("says Loading until the host answers", () => {
    list.setLoading("r0");
    expect(query("#resume-status").textContent).toBe("Loading…");
    expect(rows()).toHaveLength(0);
    list.setItems(ROWS);
    expect(query("#resume-status").textContent).toBe("");
    expect(rows()).toHaveLength(3);
  });

  it("says so when there is nothing to resume", () => {
    list.setItems([]);
    expect(query("#resume-status").textContent).toBe("No past sessions to resume.");
    expect(rows()).toHaveLength(0);
  });

  it("renders name, cli, folder basename and the relative start", () => {
    list.setItems(ROWS);
    expect(rowText("a")).toContain("Refactor the Parser");
    expect(rowText("a")).toContain("muse · demo · 2h ago");
    expect(rowText("b")).toContain("claude · other · 1d ago");
    // The folder's latest with no transcript says which one it is.
    expect(rowText("c")).toContain("muse · demo · 3d ago · latest in this folder");
    expect(rowText("a")).not.toContain("latest in this folder");
  });

  it("filters name, cli and workdir case-insensitively", () => {
    list.setItems(ROWS);
    filter("REFACTOR");
    expect(rows().map((row) => row.dataset.resumeId)).toEqual(["a"]);
    filter("CLAUDE");
    expect(rows().map((row) => row.dataset.resumeId)).toEqual(["b"]);
    filter("/HOME/U/DEMO");
    expect(rows().map((row) => row.dataset.resumeId)).toEqual(["a", "c"]);
    filter("other");
    expect(rows().map((row) => row.dataset.resumeId)).toEqual(["b"]);
    // An empty filter is every row again.
    filter("");
    expect(rows()).toHaveLength(3);
    // A filter that matches nothing leaves no rows, and no empty note:
    // the host did send a history.
    filter("nothing matches");
    expect(rows()).toHaveLength(0);
    expect(query("#resume-status").textContent).toBe("");
  });

  it("taps a row once: onResume with its id, then the list is disabled", () => {
    list.setItems(ROWS);
    rows()[0]!.click();
    expect(resumed).toEqual(["a"]);
    list.setLoading("r1");
    expect(query("#resume-status").textContent).toBe("Loading…");
    expect(rows().every((row) => row.disabled)).toBe(true);
    // A disabled row never sends a second resume.
    rows()[1]!.click();
    expect(resumed).toEqual(["a"]);
  });

  it("matches its own spawned and ignores other reqs", () => {
    list.setLoading("r9");
    expect(list.handleSpawned("other")).toBe(false);
    expect(list.handleSpawned("r9")).toBe(true);
    expect(list.handleSpawned("r9")).toBe(false);
  });

  it("shows a host error above the list and re-enables it", () => {
    list.setItems(ROWS);
    list.setLoading("r4");
    expect(list.handleError("refused", "other")).toBe(false);
    expect(list.handleError("refused", "r4")).toBe(true);
    const error = query<HTMLElement>("#resume-error");
    expect(error.hidden).toBe(false);
    expect(query("#resume-error-text").textContent).toBe("refused");
    // The list is usable again, not stuck in its loading state.
    expect(query("#resume-status").textContent).toBe("");
    expect(rows().every((row) => row.disabled)).toBe(false);
    rows()[0]!.click();
    expect(resumed).toEqual(["a"]);
    // A late answer is not this pane's: no pending request, nothing consumed.
    expect(list.handleError("late", "r4")).toBe(false);
  });

  it("offers Retry beside a failed request", () => {
    list.setLoading("r6");
    list.setError("could not read the host's history");
    const error = query<HTMLElement>("#resume-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("could not read the host's history");
    query<HTMLButtonElement>("#resume-retry").click();
    expect(retries).toBe(1);
  });

  it("starts clean after clear", () => {
    list.setItems(ROWS);
    filter("muse");
    list.clear();
    list.mount(root);
    expect(rows()).toHaveLength(0);
    expect(query<HTMLInputElement>("#resume-filter").value).toBe("");
    expect(query("#resume-status").textContent).toBe("No past sessions to resume.");
  });
});
