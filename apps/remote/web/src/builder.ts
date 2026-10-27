// SPDX-License-Identifier: Apache-2.0
// The Prompt Builder sheet, opened from the session composer. Ordered
// sections with add / remove / move, an optional preset with its preview,
// skills, and an optional project — all from the host catalog. Preview
// asks the host to compose (compose/composed) and shows the text
// read-only; Send ships prompt{id,draft} to the open session. The host
// owns the prompt rules; the browser only sends the draft.

import { CatalogStore } from "./catalog.js";
import {
  addSection,
  classifyDraftError,
  clearDraft,
  emptyDraft,
  loadDraft,
  moveSection,
  removeSection,
  saveDraft,
  setPreset,
  setProject,
  setSkill,
  updateSection,
  wireDraft,
} from "./draft.js";
import type { DraftStorage } from "./draft.js";
import { newReqId } from "./protocol.js";
import type { PromptDraft } from "./protocol.js";
import { Sheet, esc } from "./sheet.js";

export interface BuilderCallbacks {
  /** Returns false when the frame could not be sent (no connection). */
  onCompose: (draft: PromptDraft, req: string) => boolean;
  onSend: (draft: PromptDraft, req: string) => boolean;
}

interface BuilderState {
  draft: PromptDraft;
  preview: string | null;
  error: string | null;
  presetError: string | null;
  skillsError: string | null;
  projectError: string | null;
  previewReq: string | null;
  sendReq: string | null;
}

function freshState(): BuilderState {
  return {
    draft: emptyDraft(),
    preview: null,
    error: null,
    presetError: null,
    skillsError: null,
    projectError: null,
    previewReq: null,
    sendReq: null,
  };
}

export class Builder {
  private readonly catalog: CatalogStore;
  private readonly callbacks: BuilderCallbacks;
  private readonly storage: DraftStorage | null | undefined;
  private readonly sheet: Sheet;
  private state: BuilderState = freshState();
  private unsubscribe: (() => void) | null = null;
  private body: HTMLElement | null = null;
  private initialized = false;

  constructor(catalog: CatalogStore, callbacks: BuilderCallbacks, storage?: DraftStorage | null) {
    this.catalog = catalog;
    this.callbacks = callbacks;
    this.storage = storage;
    this.sheet = new Sheet({ kind: "builder", title: "Prompt Builder" }, () => this.close());
  }

  get isOpen(): boolean {
    return this.sheet.isOpen;
  }

  open(parent: HTMLElement): void {
    if (this.sheet.isOpen) {
      return;
    }
    // The in-memory draft wins for the life of the page; sessionStorage
    // only seeds the first open (a reload) and mirrors every edit.
    const previous = this.state.draft;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.state = freshState();
    this.state.draft = this.initialized ? previous : loadDraft(this.storage);
    this.initialized = true;
    if (this.state.draft.sections.length === 0) {
      this.state.draft = addSection(this.state.draft);
    }
    this.body = this.sheet.mount(parent);
    this.render();
    this.unsubscribe = this.catalog.subscribe(() => {
      if (this.sheet.isOpen) {
        this.render();
      }
    });
  }

  // Closing keeps the draft: memory and sessionStorage both still hold it.
  close(): void {
    this.state.previewReq = null;
    this.state.sendReq = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.body = null;
    this.sheet.close();
  }

  handleComposed(req: string, text: string): boolean {
    if (this.state.previewReq === null || this.state.previewReq !== req) {
      return false;
    }
    this.state.previewReq = null;
    this.state.preview = text;
    const pre = this.body?.querySelector<HTMLElement>("#builder-composed");
    if (pre) {
      pre.textContent = text;
      pre.hidden = false;
    }
    return true;
  }

  handleOk(req: string): boolean {
    if (this.state.sendReq === null || this.state.sendReq !== req) {
      return false;
    }
    this.state.sendReq = null;
    this.state.draft = emptyDraft();
    clearDraft(this.storage);
    this.state.preview = null;
    this.close();
    return true;
  }

  handleError(message: string, req: string | null, code: string): boolean {
    const previewMatch = this.state.previewReq !== null && (req === null || this.state.previewReq === req);
    const sendMatch = this.state.sendReq !== null && (req === null || this.state.sendReq === req);
    if (!previewMatch && !sendMatch) {
      return false;
    }
    if (previewMatch) {
      this.state.previewReq = null;
    }
    if (sendMatch) {
      this.state.sendReq = null;
    }
    const classified = classifyDraftError(code, message);
    if (classified.field === "preset") {
      this.state.presetError = classified.message;
    } else if (classified.field === "skills") {
      this.state.skillsError = classified.message;
    } else if (classified.field === "project") {
      this.state.projectError = classified.message;
    } else {
      this.state.error = classified.message;
    }
    this.renderErrors();
    return true;
  }

  private save(): void {
    saveDraft(this.state.draft, this.storage);
  }

  private render(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    body.innerHTML = `
      <form id="builder-form" class="builder-form">
        <section class="builder-sections">
          <h3>Sections</h3>
          <ol class="builder-section-list" id="builder-section-list">${this.sectionsHtml()}</ol>
          <button type="button" id="builder-add-section">Add section</button>
        </section>
        <label>Preset
          <select id="builder-preset">${this.presetOptions()}</select>
        </label>
        <p class="preset-preview" id="builder-preset-preview">${esc(this.selectedPreset()?.preview ?? "")}</p>
        <p class="field-error" id="builder-preset-error" role="alert"${this.errorAttr(this.state.presetError)}>${esc(this.state.presetError ?? "")}</p>
        <fieldset class="builder-skills">
          <legend>Skills</legend>
          <div class="skill-list" id="builder-skills">${this.skillsHtml()}</div>
        </fieldset>
        <p class="field-error" id="builder-skills-error" role="alert"${this.errorAttr(this.state.skillsError)}>${esc(this.state.skillsError ?? "")}</p>
        <label>Project
          <select id="builder-project">${this.projectOptions()}</select>
        </label>
        <p class="field-error" id="builder-project-error" role="alert"${this.errorAttr(this.state.projectError)}>${esc(this.state.projectError ?? "")}</p>
        <p class="sheet-error" id="builder-error" role="alert"${this.errorAttr(this.state.error)}>${esc(this.state.error ?? "")}</p>
        <pre class="builder-preview" id="builder-composed" aria-live="polite"${this.state.preview === null ? " hidden" : ""}>${esc(this.state.preview ?? "")}</pre>
        <div class="sheet-actions">
          <button type="button" id="builder-preview">Preview</button>
          <button type="button" class="primary" id="builder-send">Send</button>
        </div>
      </form>`;
    this.wire();
    this.syncSelects();
  }

  // happy-dom (and some browsers) pick the first non-empty option from
  // innerHTML; assign the current state explicitly so the UI is truthful.
  private syncSelects(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    const preset = body.querySelector<HTMLSelectElement>("#builder-preset");
    const project = body.querySelector<HTMLSelectElement>("#builder-project");
    if (preset) {
      preset.value = this.state.draft.preset ?? "";
    }
    if (project) {
      project.value = this.state.draft.project ?? "";
    }
  }

  private sectionsHtml(): string {
    const sections = this.state.draft.sections;
    return sections
      .map((section, index) => {
        const last = index === sections.length - 1;
        return `
          <li class="builder-section" data-index="${index}">
            <label>Title
              <input class="section-title" data-index="${index}" autocomplete="off" value="${esc(section.title)}">
            </label>
            <label>Content
              <textarea class="section-content" data-index="${index}" rows="3">${esc(section.content)}</textarea>
            </label>
            <div class="section-actions">
              <button type="button" class="section-up" data-index="${index}"${index === 0 ? " disabled" : ""}>Up</button>
              <button type="button" class="section-down" data-index="${index}"${last ? " disabled" : ""}>Down</button>
              <button type="button" class="section-remove" data-index="${index}">Remove</button>
            </div>
          </li>`;
      })
      .join("");
  }

  private presetOptions(): string {
    const presets = this.catalog.presets;
    const selected = this.state.draft.preset ?? "";
    const head = `<option value=""${selected === "" ? " selected" : ""}>No preset</option>`;
    const options = presets.map(
      (preset) =>
        `<option value="${esc(preset.name)}"${preset.name === selected ? " selected" : ""}>${esc(preset.name)}</option>`,
    );
    // A preset the draft still carries but the host no longer lists stays
    // visible (like an unknown skill), so the picker shows what Send will
    // send and choosing "No preset" can clear it.
    if (selected !== "" && !presets.some((preset) => preset.name === selected)) {
      options.push(
        `<option value="${esc(selected)}" selected>${esc(selected)} (not in catalog)</option>`,
      );
    }
    return head + options.join("");
  }

  // Skills from the catalog plus any the draft still carries, so a skill
  // the host no longer lists can still be seen and unchecked.
  private skillOptions(): { name: string; label: string; checked: boolean }[] {
    const options: { name: string; label: string; checked: boolean }[] = [];
    for (const skill of this.catalog.skills) {
      options.push({
        name: skill.name,
        label: skill.label,
        checked: this.state.draft.skills.includes(skill.name),
      });
    }
    const known = new Set(options.map((option) => option.name));
    for (const name of this.state.draft.skills) {
      if (!known.has(name)) {
        options.push({ name, label: name, checked: true });
      }
    }
    return options;
  }

  private skillsHtml(): string {
    return this.skillOptions()
      .map(
        (option) =>
          `<label class="skill"><input type="checkbox" class="builder-skill" value="${esc(option.name)}"${option.checked ? " checked" : ""}> ${esc(option.label)}</label>`,
      )
      .join("");
  }

  private projectOptions(): string {
    const projects = this.catalog.projects;
    const selected = this.state.draft.project ?? "";
    const head = `<option value=""${selected === "" ? " selected" : ""}>No project</option>`;
    const options = projects.map(
      (project) =>
        `<option value="${esc(project.name)}"${project.name === selected ? " selected" : ""}>${esc(project.name)}</option>`,
    );
    // Same as the preset: a project the catalog dropped stays visible so the
    // picker never claims "No project" while the draft still sends one.
    if (selected !== "" && !projects.some((project) => project.name === selected)) {
      options.push(
        `<option value="${esc(selected)}" selected>${esc(selected)} (not in catalog)</option>`,
      );
    }
    return head + options.join("");
  }

  private selectedPreset() {
    const name = this.state.draft.preset;
    return name === undefined ? null : this.catalog.findPreset(name);
  }

  private errorAttr(message: string | null): string {
    return message === null ? " hidden" : "";
  }

  private wire(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    body.querySelector("#builder-form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.send();
    });
    body.querySelector("#builder-add-section")?.addEventListener("click", () => {
      this.state.draft = addSection(this.state.draft);
      this.save();
      this.invalidatePreview();
      this.render();
    });
    for (const button of body.querySelectorAll<HTMLButtonElement>(".section-up, .section-down")) {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.index);
        const delta = button.classList.contains("section-up") ? -1 : 1;
        this.state.draft = moveSection(this.state.draft, index, delta);
        this.save();
        this.invalidatePreview();
        this.render();
      });
    }
    for (const button of body.querySelectorAll<HTMLButtonElement>(".section-remove")) {
      button.addEventListener("click", () => {
        this.state.draft = removeSection(this.state.draft, Number(button.dataset.index));
        this.save();
        this.invalidatePreview();
        this.render();
      });
    }
    for (const input of body.querySelectorAll<HTMLInputElement>(".section-title")) {
      input.addEventListener("input", () => {
        this.state.draft = updateSection(this.state.draft, Number(input.dataset.index), {
          title: input.value,
        });
        this.save();
        this.invalidatePreview();
      });
    }
    for (const area of body.querySelectorAll<HTMLTextAreaElement>(".section-content")) {
      area.addEventListener("input", () => {
        this.state.draft = updateSection(this.state.draft, Number(area.dataset.index), {
          content: area.value,
        });
        this.save();
        this.invalidatePreview();
      });
    }
    body.querySelector<HTMLSelectElement>("#builder-preset")?.addEventListener("change", (ev) => {
      this.state.draft = setPreset(this.state.draft, (ev.target as HTMLSelectElement).value);
      this.save();
      this.invalidatePreview();
      const preview = body.querySelector<HTMLElement>("#builder-preset-preview");
      if (preview) {
        preview.textContent = this.selectedPreset()?.preview ?? "";
      }
    });
    for (const box of body.querySelectorAll<HTMLInputElement>(".builder-skill")) {
      box.addEventListener("change", () => {
        this.state.draft = setSkill(this.state.draft, box.value, box.checked);
        this.save();
        this.invalidatePreview();
      });
    }
    body.querySelector<HTMLSelectElement>("#builder-project")?.addEventListener("change", (ev) => {
      this.state.draft = setProject(this.state.draft, (ev.target as HTMLSelectElement).value);
      this.save();
      this.invalidatePreview();
    });
    body.querySelector("#builder-preview")?.addEventListener("click", () => this.preview());
    body.querySelector("#builder-send")?.addEventListener("click", () => this.send());
  }

  // The composed text describes the draft it came from; any edit makes it
  // stale, so drop it (and any compose still in flight) instead of showing
  // the wrong prompt.
  private invalidatePreview(): void {
    this.clearErrors();
    this.state.preview = null;
    this.state.previewReq = null;
    const pre = this.body?.querySelector<HTMLElement>("#builder-composed");
    if (pre) {
      pre.textContent = "";
      pre.hidden = true;
    }
  }

  private preview(): void {
    this.clearErrors();
    const req = newReqId();
    this.state.previewReq = req;
    if (!this.callbacks.onCompose(wireDraft(this.state.draft), req)) {
      this.state.previewReq = null;
      this.state.error = "Not connected";
      this.renderErrors();
    }
  }

  private send(): void {
    this.clearErrors();
    const req = newReqId();
    this.state.sendReq = req;
    if (!this.callbacks.onSend(wireDraft(this.state.draft), req)) {
      this.state.sendReq = null;
      this.state.error = "Not connected";
      this.renderErrors();
    }
  }

  private clearErrors(): void {
    this.state.error = null;
    this.state.presetError = null;
    this.state.skillsError = null;
    this.state.projectError = null;
    this.renderErrors();
  }

  private renderErrors(): void {
    this.setError("builder-preset-error", this.state.presetError);
    this.setError("builder-skills-error", this.state.skillsError);
    this.setError("builder-project-error", this.state.projectError);
    this.setError("builder-error", this.state.error);
  }

  private setError(id: string, message: string | null): void {
    const el = this.body?.querySelector<HTMLElement>(`#${id}`);
    if (!el) {
      return;
    }
    el.textContent = message ?? "";
    el.hidden = message === null || message === "";
  }
}
