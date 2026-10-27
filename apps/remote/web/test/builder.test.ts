// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Builder } from "../src/builder.js";
import { CatalogStore } from "../src/catalog.js";
import { DRAFT_STORAGE_KEY, saveDraft } from "../src/draft.js";
import type { PromptDraft } from "../src/protocol.js";
import type { Catalog } from "../src/protocol.js";
import { FakeStorage } from "./fakes.js";

const CATALOG: Catalog = {
  clis: [{ cli: "muse", label: "Muse", models: ["spark"] }],
  projects: [
    { name: "demo", path: "/home/u/demo" },
    { name: "other", path: "/home/u/other" },
  ],
  presets: [
    { name: "review", preview: "Review the diff." },
    { name: "plan", preview: "Plan it first." },
  ],
  skills: [
    { name: "tdd", label: "TDD" },
    { name: "docs", label: "Docs" },
  ],
};

const STORED: PromptDraft = {
  sections: [
    { title: "Goal", content: "ship it" },
    { title: "Notes", content: "" },
  ],
  preset: "review",
  skills: ["tdd"],
  project: "demo",
};

describe("Builder", () => {
  let root: HTMLDivElement;
  let catalog: CatalogStore;
  let builder: Builder;
  let storage: FakeStorage;
  let composed: { draft: PromptDraft; req: string }[];
  let sends: { draft: PromptDraft; req: string }[];
  let connected: boolean;

  const query = <T extends Element>(selector: string): T => {
    const el = root.querySelector(selector);
    if (!el) {
      throw new Error(`missing ${selector}`);
    }
    return el as T;
  };

  const open = (): void => {
    builder.open(root);
  };

  const setValue = (selector: string, value: string): void => {
    const el = query<HTMLInputElement | HTMLTextAreaElement>(selector);
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const select = (selector: string, value: string): void => {
    const el = query<HTMLSelectElement>(selector);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const toggle = (name: string): void => {
    const box = [...root.querySelectorAll<HTMLInputElement>(".builder-skill")].find(
      (input) => input.value === name,
    );
    if (!box) {
      throw new Error(`missing skill ${name}`);
    }
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const titles = (): string[] =>
    [...root.querySelectorAll<HTMLInputElement>(".section-title")].map((input) => input.value);

  const stored = (): PromptDraft | null => {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as PromptDraft);
  };

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    catalog = new CatalogStore();
    catalog.replace(CATALOG);
    storage = new FakeStorage();
    composed = [];
    sends = [];
    connected = true;
    builder = new Builder(
      catalog,
      {
        onCompose: (draft, req) => {
          composed.push({ draft, req });
          return connected;
        },
        onSend: (draft, req) => {
          sends.push({ draft, req });
          return connected;
        },
      },
      storage,
    );
  });

  afterEach(() => {
    builder.close();
    root.remove();
    document.body.innerHTML = "";
  });

  it("opens with one empty section", () => {
    open();
    expect(builder.isOpen).toBe(true);
    expect(root.querySelectorAll(".builder-section")).toHaveLength(1);
    expect(titles()).toEqual([""]);
    expect(query<HTMLSelectElement>("#builder-preset").value).toBe("");
    expect(query<HTMLSelectElement>("#builder-project").value).toBe("");
  });

  it("loads the saved draft, including preset preview and skills", () => {
    saveDraft(STORED, storage);
    open();
    expect(titles()).toEqual(["Goal", "Notes"]);
    expect(query<HTMLSelectElement>("#builder-preset").value).toBe("review");
    expect(query("#builder-preset-preview").textContent).toBe("Review the diff.");
    expect(query<HTMLSelectElement>("#builder-project").value).toBe("demo");
    const skills = [...root.querySelectorAll<HTMLInputElement>(".builder-skill")];
    expect(skills.map((box) => box.value)).toEqual(["tdd", "docs"]);
    expect(skills.map((box) => box.checked)).toEqual([true, false]);
  });

  it("adds, moves and removes sections", () => {
    open();
    setValue(".section-title", "A");
    query<HTMLButtonElement>("#builder-add-section").click();
    expect(root.querySelectorAll(".builder-section")).toHaveLength(2);
    setValue('.section-title[data-index="1"]', "B");
    expect(titles()).toEqual(["A", "B"]);

    query<HTMLButtonElement>('.section-down[data-index="0"]').click();
    expect(titles()).toEqual(["B", "A"]);
    expect(stored()?.sections.map((section) => section.title)).toEqual(["B", "A"]);

    query<HTMLButtonElement>('.section-up[data-index="1"]').click();
    expect(titles()).toEqual(["A", "B"]);

    query<HTMLButtonElement>('.section-remove[data-index="0"]').click();
    expect(titles()).toEqual(["B"]);
    expect(stored()?.sections.map((section) => section.title)).toEqual(["B"]);
  });

  it("composes the wire draft and shows the text read-only", () => {
    open();
    setValue(".section-title", "Goal");
    setValue(".section-content", "ship it");
    query<HTMLButtonElement>("#builder-add-section").click();
    setValue('.section-title[data-index="1"]', "   ");
    select("#builder-preset", "review");
    select("#builder-project", "demo");
    toggle("tdd");

    query<HTMLButtonElement>("#builder-preview").click();
    expect(composed).toHaveLength(1);
    expect(composed[0]?.draft).toEqual({
      sections: [{ title: "Goal", content: "ship it" }],
      preset: "review",
      skills: ["tdd"],
      project: "demo",
    });

    const req = composed[0]?.req ?? "";
    expect(builder.handleComposed("other", "nope")).toBe(false);
    expect(builder.handleComposed(req, "# Goal\n\nship it")).toBe(true);
    const pre = query<HTMLElement>("#builder-composed");
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toBe("# Goal\n\nship it");
    expect(pre.hidden).toBe(false);
  });

  it("drops a stale preview when the draft changes", () => {
    open();
    query<HTMLButtonElement>("#builder-preview").click();
    builder.handleComposed(composed[0]?.req ?? "", "old text");
    expect(query<HTMLElement>("#builder-composed").hidden).toBe(false);
    setValue(".section-title", "new");
    expect(query<HTMLElement>("#builder-composed").hidden).toBe(true);
    expect(query("#builder-composed").textContent).toBe("");
    // A compose reply that lands after the edit is ignored.
    expect(builder.handleComposed(composed[0]?.req ?? "", "late text")).toBe(false);
    expect(query<HTMLElement>("#builder-composed").hidden).toBe(true);
  });

  it("sends the draft to the open session and clears it on the matching ok", () => {
    open();
    setValue(".section-title", "Goal");
    setValue(".section-content", "ship it");
    select("#builder-project", "demo");
    toggle("docs");
    query<HTMLButtonElement>("#builder-send").click();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.draft).toEqual({
      sections: [{ title: "Goal", content: "ship it" }],
      skills: ["docs"],
      project: "demo",
    });
    const req = sends[0]?.req ?? "";
    expect(builder.handleOk("other")).toBe(false);
    expect(builder.isOpen).toBe(true);
    expect(builder.handleOk(req)).toBe(true);
    expect(builder.isOpen).toBe(false);
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();

    // A new draft starts over.
    open();
    expect(titles()).toEqual([""]);
    const skills = [...root.querySelectorAll<HTMLInputElement>(".builder-skill")];
    expect(skills.every((box) => !box.checked)).toBe(true);
    expect(query<HTMLSelectElement>("#builder-preset").value).toBe("");
    expect(query<HTMLSelectElement>("#builder-project").value).toBe("");
  });

  it("keeps the draft across closing and reopening", () => {
    open();
    setValue(".section-title", "Goal");
    setValue(".section-content", "keep me");
    select("#builder-preset", "plan");
    expect(stored()?.preset).toBe("plan");
    query<HTMLButtonElement>("#builder-close").click();
    expect(builder.isOpen).toBe(false);
    expect(storage.getItem(DRAFT_STORAGE_KEY)).not.toBeNull();

    open();
    expect(titles()).toEqual(["Goal"]);
    expect(query<HTMLTextAreaElement>(".section-content").value).toBe("keep me");
    expect(query<HTMLSelectElement>("#builder-preset").value).toBe("plan");
    expect(query("#builder-preset-preview").textContent).toBe("Plan it first.");
  });

  it("keeps the draft in memory even when storage denies writes", () => {
    storage.failWrites = true;
    open();
    setValue(".section-title", "Goal");
    query<HTMLButtonElement>("#builder-close").click();
    open();
    expect(titles()).toEqual(["Goal"]);
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("shows skill names the catalog still lists plus draft extras", () => {
    saveDraft({ sections: [], skills: ["tdd", "legacy"] }, storage);
    open();
    const boxes = [...root.querySelectorAll<HTMLInputElement>(".builder-skill")];
    expect(boxes.map((box) => box.value)).toEqual(["tdd", "docs", "legacy"]);
    expect(boxes.map((box) => box.checked)).toEqual([true, false, true]);
    toggle("legacy");
    expect(stored()?.skills).toEqual(["tdd"]);
  });

  it("shows unknown preset, skill and project errors beside their fields", () => {
    open();
    query<HTMLButtonElement>("#builder-preview").click();
    expect(builder.handleError("unknown preset: fast", composed[0]?.req ?? "", "unknown_preset")).toBe(
      true,
    );
    expect(query<HTMLElement>("#builder-preset-error").hidden).toBe(false);
    expect(query("#builder-preset-error").textContent).toBe("unknown preset: fast");

    query<HTMLButtonElement>("#builder-send").click();
    builder.handleError("unknown skill: tdd", sends[0]?.req ?? "", "unknown_skill");
    expect(query<HTMLElement>("#builder-skills-error").hidden).toBe(false);
    expect(query("#builder-skills-error").textContent).toBe("unknown skill: tdd");

    query<HTMLButtonElement>("#builder-send").click();
    builder.handleError("unknown project demo", sends[1]?.req ?? "", "unknown_project");
    expect(query<HTMLElement>("#builder-project-error").hidden).toBe(false);

    query<HTMLButtonElement>("#builder-send").click();
    builder.handleError("internal trouble", sends[2]?.req ?? "", "internal");
    expect(query<HTMLElement>("#builder-error").hidden).toBe(false);
    expect(query("#builder-error").textContent).toBe("internal trouble");

    // A stale reply is ignored.
    expect(builder.handleError("late", "no-such-req", "internal")).toBe(false);
    // The form keeps its draft on error.
    expect(builder.isOpen).toBe(true);
    expect(titles()).toEqual([""]);
  });

  it("says so when the sheet is not connected", () => {
    connected = false;
    open();
    query<HTMLButtonElement>("#builder-preview").click();
    expect(query("#builder-error").textContent).toBe("Not connected");
    query<HTMLButtonElement>("#builder-send").click();
    expect(query("#builder-error").textContent).toBe("Not connected");
    expect(composed).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });

  it("shows the preset preview when the preset changes", () => {
    open();
    expect(query("#builder-preset-preview").textContent).toBe("");
    select("#builder-preset", "review");
    expect(query("#builder-preset-preview").textContent).toBe("Review the diff.");
    select("#builder-preset", "");
    expect(query("#builder-preset-preview").textContent).toBe("");
  });
});
