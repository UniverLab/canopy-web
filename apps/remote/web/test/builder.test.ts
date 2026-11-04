// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Builder } from "../src/builder.js";
import { CatalogStore } from "../src/catalog.js";
import { DRAFT_STORAGE_KEY, saveDraft } from "../src/draft.js";
import type { SectionKind } from "../src/draft.js";
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
    { title: "goal", content: "ship it" },
    { title: "instruction", content: "" },
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

  const setContent = (selector: string, value: string): void => {
    const el = query<HTMLTextAreaElement>(selector);
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const setKind = (index: number, kind: SectionKind): void => {
    const el = query<HTMLSelectElement>(`.section-kind[data-index="${index}"]`);
    el.value = kind;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const select = (selector: string, value: string): void => {
    const el = query<HTMLSelectElement>(selector);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const addKind = (kind: SectionKind): void => {
    select("#builder-add-section", kind);
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

  const kinds = (): string[] =>
    [...root.querySelectorAll<HTMLSelectElement>(".section-kind")].map((select) => select.value);

  const contents = (): string[] =>
    [...root.querySelectorAll<HTMLTextAreaElement>(".section-content")].map((area) => area.value);

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

  it("opens with one Instruction section and no free title field", () => {
    open();
    expect(builder.isOpen).toBe(true);
    expect(root.querySelectorAll(".builder-section")).toHaveLength(1);
    expect(kinds()).toEqual(["instruction"]);
    expect(root.querySelectorAll(".section-title")).toHaveLength(0);
    expect(query<HTMLSelectElement>("#builder-preset").value).toBe("");
    expect(query<HTMLSelectElement>("#builder-project").value).toBe("");
  });

  it("loads the saved draft, including kinds, preset preview and skills", () => {
    saveDraft(STORED, storage);
    open();
    expect(kinds()).toEqual(["goal", "instruction"]);
    expect(contents()).toEqual(["ship it", ""]);
    expect(query<HTMLSelectElement>("#builder-preset").value).toBe("review");
    expect(query("#builder-preset-preview").textContent).toBe("Review the diff.");
    expect(query<HTMLSelectElement>("#builder-project").value).toBe("demo");
    const skills = [...root.querySelectorAll<HTMLInputElement>(".builder-skill")];
    expect(skills.map((box) => box.value)).toEqual(["tdd", "docs"]);
    expect(skills.map((box) => box.checked)).toEqual([true, false]);
  });

  it("loads a legacy free-title draft with kinds derived from the titles", () => {
    storage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        sections: [
          { title: "Goal", content: "ship it" },
          { title: "Notes", content: "keep" },
        ],
        skills: [],
      }),
    );
    open();
    expect(kinds()).toEqual(["goal", "instruction"]);
    expect(contents()).toEqual(["ship it", "keep"]);
    expect(query<HTMLElement>("#builder-error").hidden).toBe(true);
  });

  it("starts fresh with an error when the saved draft is unreadable", () => {
    storage.setItem(DRAFT_STORAGE_KEY, "{not json");
    open();
    expect(kinds()).toEqual(["instruction"]);
    const error = query("#builder-error");
    expect(error.textContent).toBe("Saved draft was unreadable; started fresh.");
    expect((error as HTMLElement).hidden).toBe(false);
  });

  it("appends the kind chosen in the Add section menu", () => {
    open();
    const menu = query<HTMLSelectElement>("#builder-add-section");
    expect(menu.value).toBe("");
    expect([...menu.options].map((option) => option.value)).toEqual([
      "",
      "goal",
      "context",
      "instruction",
      "resources",
      "constraints",
      "tools",
    ]);
    expect([...menu.options].map((option) => option.textContent)).toEqual([
      "Choose kind…",
      "Goal",
      "Context",
      "Instruction",
      "Resources",
      "Constraints",
      "Tools",
    ]);

    // Re-choosing the placeholder adds nothing.
    select("#builder-add-section", "");
    expect(root.querySelectorAll(".builder-section")).toHaveLength(1);

    addKind("tools");
    expect(kinds()).toEqual(["instruction", "tools"]);
    expect(stored()?.sections.map((section) => section.title)).toEqual(["instruction", "tools"]);
    // Choosing re-renders, so the menu is back at its placeholder.
    expect(query<HTMLSelectElement>("#builder-add-section").value).toBe("");
  });

  it("changes a section's kind through its selector", () => {
    saveDraft(STORED, storage);
    open();
    setKind(1, "constraints");
    expect(kinds()).toEqual(["goal", "constraints"]);
    expect(stored()?.sections.map((section) => section.title)).toEqual(["goal", "constraints"]);
    // Content is untouched by the kind change.
    expect(contents()).toEqual(["ship it", ""]);
  });

  it("adds, moves and removes sections", () => {
    open();
    setContent(".section-content", "A");
    addKind("goal");
    expect(root.querySelectorAll(".builder-section")).toHaveLength(2);
    setContent('.section-content[data-index="1"]', "B");
    expect(kinds()).toEqual(["instruction", "goal"]);

    query<HTMLButtonElement>('.section-down[data-index="0"]').click();
    expect(kinds()).toEqual(["goal", "instruction"]);
    expect(contents()).toEqual(["B", "A"]);
    expect(stored()?.sections.map((section) => section.title)).toEqual(["goal", "instruction"]);

    query<HTMLButtonElement>('.section-up[data-index="1"]').click();
    expect(kinds()).toEqual(["instruction", "goal"]);

    query<HTMLButtonElement>('.section-remove[data-index="0"]').click();
    expect(kinds()).toEqual(["goal"]);
    expect(stored()?.sections.map((section) => section.title)).toEqual(["goal"]);
  });

  it("composes the wire draft with generated titles and shows the text read-only", () => {
    open();
    setContent(".section-content", "ship it");
    addKind("instruction");
    setContent('.section-content[data-index="1"]', "   ");
    addKind("goal");
    setContent('.section-content[data-index="2"]', "the goal");
    select("#builder-preset", "review");
    select("#builder-project", "demo");
    toggle("tdd");

    query<HTMLButtonElement>("#builder-preview").click();
    expect(composed).toHaveLength(1);
    expect(composed[0]?.draft).toEqual({
      sections: [
        { title: "instruction", content: "ship it" },
        { title: "goal", content: "the goal" },
      ],
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
    setContent(".section-content", "new");
    expect(query<HTMLElement>("#builder-composed").hidden).toBe(true);
    expect(query("#builder-composed").textContent).toBe("");
    // A compose reply that lands after the edit is ignored.
    expect(builder.handleComposed(composed[0]?.req ?? "", "late text")).toBe(false);
    expect(query<HTMLElement>("#builder-composed").hidden).toBe(true);
  });

  it("drops a stale preview when a kind changes", () => {
    open();
    setContent(".section-content", "words");
    query<HTMLButtonElement>("#builder-preview").click();
    builder.handleComposed(composed[0]?.req ?? "", "old text");
    setKind(0, "goal");
    expect(query<HTMLElement>("#builder-composed").hidden).toBe(true);
  });

  it("sends the draft to the open session and clears it on the matching ok", () => {
    open();
    setKind(0, "goal");
    setContent(".section-content", "ship it");
    select("#builder-project", "demo");
    toggle("docs");
    query<HTMLButtonElement>("#builder-send").click();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.draft).toEqual({
      sections: [{ title: "goal", content: "ship it" }],
      skills: ["docs"],
      project: "demo",
    });
    const req = sends[0]?.req ?? "";
    expect(builder.handleOk("other")).toBe(false);
    expect(builder.isOpen).toBe(true);
    expect(builder.handleOk(req)).toBe(true);
    expect(builder.isOpen).toBe(false);
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();

    // A new draft starts over with one Instruction section.
    open();
    expect(kinds()).toEqual(["instruction"]);
    const skills = [...root.querySelectorAll<HTMLInputElement>(".builder-skill")];
    expect(skills.every((box) => !box.checked)).toBe(true);
    expect(query<HTMLSelectElement>("#builder-preset").value).toBe("");
    expect(query<HTMLSelectElement>("#builder-project").value).toBe("");
  });

  it("keeps the draft across closing and reopening", () => {
    open();
    setKind(0, "goal");
    setContent(".section-content", "keep me");
    select("#builder-preset", "plan");
    expect(stored()?.preset).toBe("plan");
    query<HTMLButtonElement>("#builder-close").click();
    expect(builder.isOpen).toBe(false);
    expect(storage.getItem(DRAFT_STORAGE_KEY)).not.toBeNull();

    open();
    expect(kinds()).toEqual(["goal"]);
    expect(query<HTMLTextAreaElement>(".section-content").value).toBe("keep me");
    expect(query<HTMLSelectElement>("#builder-preset").value).toBe("plan");
    expect(query("#builder-preset-preview").textContent).toBe("Plan it first.");
  });

  it("keeps the draft in memory even when storage denies writes", () => {
    storage.failWrites = true;
    open();
    setKind(0, "goal");
    query<HTMLButtonElement>("#builder-close").click();
    open();
    expect(kinds()).toEqual(["goal"]);
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
    setContent(".section-content", "words");
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
    expect(kinds()).toEqual(["instruction"]);
  });

  it("keeps a draft preset and project the catalog no longer lists selectable", () => {
    saveDraft({ sections: [], skills: [], preset: "gone", project: "gone-project" }, storage);
    open();
    const preset = query<HTMLSelectElement>("#builder-preset");
    expect(preset.value).toBe("gone");
    expect([...preset.options].map((option) => option.value)).toEqual(["", "review", "plan", "gone"]);
    expect(preset.selectedOptions[0]?.textContent).toBe("gone (not in catalog)");
    const project = query<HTMLSelectElement>("#builder-project");
    expect(project.value).toBe("gone-project");
    expect([...project.options].map((option) => option.value)).toEqual([
      "",
      "demo",
      "other",
      "gone-project",
    ]);

    // Choosing the empty option clears them, so the next send no longer
    // carries the values the host just rejected.
    select("#builder-preset", "");
    select("#builder-project", "");
    expect(query<HTMLSelectElement>("#builder-preset").value).toBe("");
    expect(query<HTMLSelectElement>("#builder-project").value).toBe("");
    query<HTMLButtonElement>("#builder-send").click();
    expect(sends[0]?.draft).toEqual({ sections: [], skills: [] });
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
