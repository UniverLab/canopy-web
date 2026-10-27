// SPDX-License-Identifier: Apache-2.0
// The Prompt Builder draft: the model the sheet edits, the pure operations
// that change it, the wire form sent to the host, and its sessionStorage
// persistence. The host composes the final text (compose), so nothing here
// knows canopy's prompt rules. Every storage access is wrapped: a browser
// that denies sessionStorage must not break the sheet.

import type { PromptDraft, PromptDraftSection } from "./protocol.js";

export const DRAFT_STORAGE_KEY = "canopy.remote.prompt-draft.v1";

export interface DraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export type DraftField = "preset" | "skills" | "project";

export interface DraftError {
  field: DraftField | null;
  message: string;
}

export function emptyDraft(): PromptDraft {
  return { sections: [], skills: [] };
}

export function addSection(draft: PromptDraft, section?: Partial<PromptDraftSection>): PromptDraft {
  const next: PromptDraftSection = { title: section?.title ?? "", content: section?.content ?? "" };
  return { ...draft, sections: [...draft.sections, next] };
}

export function removeSection(draft: PromptDraft, index: number): PromptDraft {
  if (index < 0 || index >= draft.sections.length) {
    return draft;
  }
  return { ...draft, sections: draft.sections.filter((_, at) => at !== index) };
}

export function moveSection(draft: PromptDraft, index: number, delta: number): PromptDraft {
  const target = index + delta;
  if (index < 0 || index >= draft.sections.length || target < 0 || target >= draft.sections.length) {
    return draft;
  }
  const sections = [...draft.sections];
  const [moved] = sections.splice(index, 1);
  if (!moved) {
    return draft;
  }
  sections.splice(target, 0, moved);
  return { ...draft, sections };
}

export function updateSection(
  draft: PromptDraft,
  index: number,
  patch: Partial<PromptDraftSection>,
): PromptDraft {
  if (index < 0 || index >= draft.sections.length) {
    return draft;
  }
  return {
    ...draft,
    sections: draft.sections.map((section, at) => (at === index ? { ...section, ...patch } : section)),
  };
}

export function setPreset(draft: PromptDraft, preset: string | null): PromptDraft {
  const next: PromptDraft = { ...draft };
  if (preset === null || preset === "") {
    delete next.preset;
  } else {
    next.preset = preset;
  }
  return next;
}

export function setProject(draft: PromptDraft, project: string | null): PromptDraft {
  const next: PromptDraft = { ...draft };
  if (project === null || project === "") {
    delete next.project;
  } else {
    next.project = project;
  }
  return next;
}

export function setSkill(draft: PromptDraft, name: string, on: boolean): PromptDraft {
  if (name === "") {
    return draft;
  }
  const present = draft.skills.includes(name);
  if (on === present) {
    return draft;
  }
  const skills = on ? [...draft.skills, name] : draft.skills.filter((skill) => skill !== name);
  return { ...draft, skills };
}

export function toggleSkill(draft: PromptDraft, name: string): PromptDraft {
  return setSkill(draft, name, !draft.skills.includes(name));
}

export function isBlankSection(section: PromptDraftSection): boolean {
  return section.title.trim() === "" && section.content.trim() === "";
}

// The wire form: fully empty sections are dropped, skills is always an
// array, and an empty preset/project is omitted rather than sent as "".
export function wireDraft(draft: PromptDraft): PromptDraft {
  const wire: PromptDraft = {
    sections: draft.sections.filter((section) => !isBlankSection(section)),
    skills: [...new Set(draft.skills.filter((name) => name !== ""))],
  };
  if (draft.preset !== undefined && draft.preset !== "") {
    wire.preset = draft.preset;
  }
  if (draft.project !== undefined && draft.project !== "") {
    wire.project = draft.project;
  }
  return wire;
}

// Field-specific errors: codes first, then the message's own wording, so
// the message lands beside the field it is about.
export function classifyDraftError(code: string, message: string): DraftError {
  if (code === "unknown_preset") {
    return { field: "preset", message };
  }
  if (code === "unknown_skill") {
    return { field: "skills", message };
  }
  if (code === "unknown_project") {
    return { field: "project", message };
  }
  const text = message.toLowerCase();
  if (/unknown|not found|no such|missing/.test(text)) {
    if (text.includes("preset")) {
      return { field: "preset", message };
    }
    if (text.includes("skill")) {
      return { field: "skills", message };
    }
    if (text.includes("project") || text.includes("workdir")) {
      return { field: "project", message };
    }
  }
  return { field: null, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultStorage(): DraftStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function resolveStorage(storage: DraftStorage | null | undefined): DraftStorage | null {
  return storage === undefined ? defaultStorage() : storage;
}

export function parseStoredDraft(raw: string | null): PromptDraft | null {
  if (raw === null || raw === "") {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const sections: PromptDraftSection[] = [];
  if (Array.isArray(value.sections)) {
    for (const item of value.sections) {
      if (isRecord(item) && typeof item.title === "string" && typeof item.content === "string") {
        sections.push({ title: item.title, content: item.content });
      }
    }
  }
  const skills = Array.isArray(value.skills)
    ? value.skills.filter((name): name is string => typeof name === "string" && name !== "")
    : [];
  const draft: PromptDraft = { sections, skills };
  if (typeof value.preset === "string" && value.preset !== "") {
    draft.preset = value.preset;
  }
  if (typeof value.project === "string" && value.project !== "") {
    draft.project = value.project;
  }
  return draft;
}

export function loadDraft(storage?: DraftStorage | null): PromptDraft {
  const store = resolveStorage(storage);
  if (!store) {
    return emptyDraft();
  }
  try {
    return parseStoredDraft(store.getItem(DRAFT_STORAGE_KEY)) ?? emptyDraft();
  } catch {
    return emptyDraft();
  }
}

export function saveDraft(draft: PromptDraft, storage?: DraftStorage | null): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  try {
    store.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Storage unavailable or full: the in-memory draft is still the truth.
  }
}

export function clearDraft(storage?: DraftStorage | null): void {
  const store = resolveStorage(storage);
  if (!store) {
    return;
  }
  try {
    store.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Nothing to recover from.
  }
}
