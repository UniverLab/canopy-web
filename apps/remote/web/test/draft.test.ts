// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DRAFT_STORAGE_KEY,
  addSection,
  classifyDraftError,
  clearDraft,
  emptyDraft,
  isBlankSection,
  loadDraft,
  moveSection,
  parseStoredDraft,
  removeSection,
  saveDraft,
  setPreset,
  setProject,
  setSkill,
  toggleSkill,
  updateSection,
  wireDraft,
} from "../src/draft.js";
import type { PromptDraft } from "../src/protocol.js";
import { FakeStorage } from "./fakes.js";

const DRAFT: PromptDraft = {
  sections: [
    { title: "Goal", content: "ship it" },
    { title: "Constraints", content: "no deps" },
    { title: "Notes", content: "keep it small" },
  ],
  preset: "review",
  skills: ["tdd", "docs"],
  project: "demo",
};

describe("draft operations", () => {
  it("starts empty", () => {
    expect(emptyDraft()).toEqual({ sections: [], skills: [] });
  });

  it("adds sections without mutating the draft", () => {
    const before = emptyDraft();
    const after = addSection(before, { title: "Goal" });
    expect(after.sections).toEqual([{ title: "Goal", content: "" }]);
    expect(before.sections).toEqual([]);
    expect(addSection(after).sections[1]).toEqual({ title: "", content: "" });
  });

  it("removes by index and ignores out-of-range indexes", () => {
    expect(removeSection(DRAFT, 1).sections.map((section) => section.title)).toEqual([
      "Goal",
      "Notes",
    ]);
    expect(removeSection(DRAFT, 9)).toBe(DRAFT);
    expect(removeSection(DRAFT, -1)).toBe(DRAFT);
  });

  it("moves sections up and down, clamped", () => {
    const up = moveSection(DRAFT, 1, -1);
    expect(up.sections.map((section) => section.title)).toEqual(["Constraints", "Goal", "Notes"]);
    const down = moveSection(DRAFT, 1, 1);
    expect(down.sections.map((section) => section.title)).toEqual(["Goal", "Notes", "Constraints"]);
    expect(moveSection(DRAFT, 0, -1)).toBe(DRAFT);
    expect(moveSection(DRAFT, 2, 1)).toBe(DRAFT);
    // The original is untouched.
    expect(DRAFT.sections.map((section) => section.title)).toEqual(["Goal", "Constraints", "Notes"]);
  });

  it("updates one section field", () => {
    const next = updateSection(DRAFT, 0, { content: "ship it today" });
    expect(next.sections[0]).toEqual({ title: "Goal", content: "ship it today" });
    expect(next.sections[1]).toBe(DRAFT.sections[1]);
    expect(updateSection(DRAFT, 5, { title: "x" })).toBe(DRAFT);
  });

  it("sets and clears the preset and project", () => {
    expect(setPreset(DRAFT, null)).not.toHaveProperty("preset");
    expect(setPreset(DRAFT, "")).not.toHaveProperty("preset");
    expect(setPreset(DRAFT, "other").preset).toBe("other");
    expect(setProject(DRAFT, null)).not.toHaveProperty("project");
    expect(setProject(DRAFT, "other").project).toBe("other");
    expect(DRAFT.preset).toBe("review");
  });

  it("adds, removes and dedupes skills", () => {
    expect(setSkill(DRAFT, "tdd", false).skills).toEqual(["docs"]);
    expect(setSkill(DRAFT, "extra", true).skills).toEqual(["tdd", "docs", "extra"]);
    expect(setSkill(DRAFT, "tdd", true)).toBe(DRAFT);
    expect(toggleSkill(DRAFT, "docs").skills).toEqual(["tdd"]);
    expect(toggleSkill(DRAFT, "extra").skills).toEqual(["tdd", "docs", "extra"]);
    expect(setSkill(DRAFT, "", true)).toBe(DRAFT);
  });
});

describe("wireDraft", () => {
  it("drops fully empty sections and always sends a skills array", () => {
    const draft: PromptDraft = {
      sections: [
        { title: "Goal", content: "ship it" },
        { title: "", content: "   " },
        { title: " Notes ", content: "" },
      ],
      skills: [],
    };
    expect(wireDraft(draft)).toEqual({
      sections: [
        { title: "Goal", content: "ship it" },
        { title: " Notes ", content: "" },
      ],
      skills: [],
    });
  });

  it("omits empty preset and project and dedupes skills", () => {
    const draft: PromptDraft = {
      sections: [],
      preset: "",
      skills: ["tdd", "tdd", ""],
      project: "",
    };
    expect(wireDraft(draft)).toEqual({ sections: [], skills: ["tdd"] });
    expect(wireDraft(DRAFT)).toEqual({
      sections: DRAFT.sections,
      preset: "review",
      skills: ["tdd", "docs"],
      project: "demo",
    });
  });

  it("recognizes blank sections", () => {
    expect(isBlankSection({ title: " ", content: "\n" })).toBe(true);
    expect(isBlankSection({ title: "x", content: "" })).toBe(false);
  });
});

describe("classifyDraftError", () => {
  it("maps the host's unknown codes to fields", () => {
    expect(classifyDraftError("unknown_preset", "no such preset")).toEqual({
      field: "preset",
      message: "no such preset",
    });
    expect(classifyDraftError("unknown_skill", "no such skill").field).toBe("skills");
    expect(classifyDraftError("unknown_project", "no such project").field).toBe("project");
  });

  it("falls back to the message's wording", () => {
    expect(classifyDraftError("bad_request", "unknown preset: fast").field).toBe("preset");
    expect(classifyDraftError("not_found", "Unknown skill \"tdd\"").field).toBe("skills");
    expect(classifyDraftError("not_found", "project demo was not found").field).toBe("project");
    expect(classifyDraftError("not_found", "unknown workdir /nope").field).toBe("project");
  });

  it("keeps unrelated errors general", () => {
    expect(classifyDraftError("internal", "boom")).toEqual({ field: null, message: "boom" });
    expect(classifyDraftError("bad_request", "unknown frame type").field).toBeNull();
  });
});

describe("draft persistence", () => {
  it("round-trips through a sessionStorage stand-in", () => {
    const storage = new FakeStorage();
    saveDraft(DRAFT, storage);
    expect(storage.getItem(DRAFT_STORAGE_KEY)).not.toBeNull();
    expect(loadDraft(storage)).toEqual(DRAFT);
    clearDraft(storage);
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
    expect(loadDraft(storage)).toEqual(emptyDraft());
  });

  it("survives malformed or partial JSON", () => {
    expect(parseStoredDraft(null)).toBeNull();
    expect(parseStoredDraft("")).toBeNull();
    expect(parseStoredDraft("{not json")).toBeNull();
    expect(parseStoredDraft("[]")).toBeNull();
    expect(parseStoredDraft(JSON.stringify({ sections: [{ title: "ok", content: "" }, null, 7] }))).toEqual({
      sections: [{ title: "ok", content: "" }],
      skills: [],
    });
    expect(
      parseStoredDraft(JSON.stringify({ sections: [], skills: ["tdd", 4], preset: "", project: 3 })),
    ).toEqual({ sections: [], skills: ["tdd"] });
  });

  it("tolerates a browser that denies storage", () => {
    const storage = new FakeStorage();
    saveDraft(DRAFT, storage);
    storage.failReads = true;
    storage.failWrites = true;
    expect(loadDraft(storage)).toEqual(emptyDraft());
    expect(() => saveDraft(DRAFT, storage)).not.toThrow();
    expect(() => clearDraft(storage)).not.toThrow();
  });

  it("does nothing without a storage", () => {
    expect(loadDraft(null)).toEqual(emptyDraft());
    expect(() => saveDraft(DRAFT, null)).not.toThrow();
    expect(() => clearDraft(null)).not.toThrow();
  });
});
