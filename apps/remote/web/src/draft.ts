// SPDX-License-Identifier: Apache-2.0
// The Prompt Builder draft: the model the sheet edits, the pure operations
// that change it, the wire form sent to the host, and its sessionStorage
// persistence. The host composes the final text (compose), so nothing here
// knows canopy's prompt rules beyond the section kinds below. Every storage
// access is wrapped: a browser that denies sessionStorage must not break
// the sheet.
//
// Section kinds (read from harness-canopy
// src/domain/prompt_draft.rs at commit c33f0bc, file last touched in
// e8d292a): `build_prompt_body` groups sections into goal, context,
// instruction (+ preset), resources, constraints and tools (+ skills), in
// that order. A section's kind is the prefix of its title — `instruction`,
// `instruction_2`, … — matched by `section_matches` (exact or
// `kind_` + suffix). The sheet edits the kind through a picker and the
// wire titles are numbered per kind, so the host needs no change.

import type { PromptDraft, PromptDraftSection } from "./protocol.js";

export const DRAFT_STORAGE_KEY = "canopy.remote.prompt-draft.v1";

/** The six section kinds `build_prompt_body` groups, in its group order. */
export type SectionKind = "goal" | "context" | "instruction" | "resources" | "constraints" | "tools";

export const SECTION_KINDS: readonly SectionKind[] = [
  "goal",
  "context",
  "instruction",
  "resources",
  "constraints",
  "tools",
];

/** The picker's label for a kind: capitalized (`tools` → `Tools`). */
export function sectionLabel(kind: SectionKind): string {
  return kind[0].toUpperCase() + kind.slice(1);
}

/**
 * The kind a title names: the `section_matches` prefix rule (exact or
 * `kind_` + suffix), case-insensitive, falling back to the TUI's default
 * section, Instruction. Legacy free titles resolve through the same rule.
 */
export function kindFromTitle(title: string): SectionKind {
  const text = title.trim().toLowerCase();
  for (const kind of SECTION_KINDS) {
    if (text === kind || text.startsWith(`${kind}_`)) {
      return kind;
    }
  }
  return "instruction";
}

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

export function addSection(draft: PromptDraft, kind: SectionKind): PromptDraft {
  return { ...draft, sections: [...draft.sections, { title: kind, content: "" }] };
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
  return section.content.trim() === "";
}

// The wire form: sections with no content are dropped (the host would drop
// their empty content anyway), the survivors take titles numbered per kind
// — the first keeps the bare kind, later ones take `_2`, `_3`, … — skills
// is always an array, and an empty preset/project is omitted, never "".
export function wireDraft(draft: PromptDraft): PromptDraft {
  const counts = {} as Record<SectionKind, number>;
  const sections = [];
  for (const section of draft.sections) {
    if (isBlankSection(section)) {
      continue;
    }
    const kind = kindFromTitle(section.title);
    const occurrence = (counts[kind] || 0) + 1;
    counts[kind] = occurrence;
    sections.push({
      title: occurrence === 1 ? kind : `${kind}_${occurrence}`,
      content: section.content,
    });
  }
  const wire: PromptDraft = {
    sections,
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

// The stored text itself, for callers that must tell "no draft" from an
// unreadable one. Null when nothing is stored or storage is denied.
export function readRawDraft(storage?: DraftStorage | null): string | null {
  const store = resolveStorage(storage);
  if (!store) {
    return null;
  }
  try {
    return store.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
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
