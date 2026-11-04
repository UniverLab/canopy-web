// SPDX-License-Identifier: Apache-2.0
// The Prompt Builder sheet, opened from the session's controls row. Ordered
// sections with add / remove / move, an optional preset with its preview,
// skills, and an optional project — all from the host catalog. Preview
// asks the host to compose (compose/composed) and shows the text
// read-only; Send ships prompt{id,draft} to the open session. The host
// owns the prompt rules; the browser only sends the draft.
//
// Each section picks one of the host's six kinds (draft.ts) instead of a
// free title, so every section lands in a group the host can place.

import { CatalogStore } from "./catalog.js";
import {
  SECTION_KINDS,
  addSection,
  classifyDraftError,
  clearDraft,
  emptyDraft,
  kindFromTitle,
  loadDraft,
  moveSection,
  parseStoredDraft,
  readRawDraft,
  removeSection,
  saveDraft,
  sectionLabel,
  setPreset,
  setProject,
  setSkill,
  updateSection,
  wireDraft,
} from "./draft.js";
import type { DraftStorage, SectionKind } from "./draft.js";
import { newReqId } from "./protocol.js";
import type { PromptDraft, ScheduledItem } from "./protocol.js";
import { Sheet, esc } from "./sheet.js";

export interface BuilderCallbacks {
  /** Returns false when the frame could not be sent (no connection). */
  onCompose: (draft: PromptDraft, req: string) => boolean;
  onSend: (draft: PromptDraft, req: string) => boolean;
  /** Schedule the draft for fireAt (RFC 3339 UTC) on the open session. */
  onSchedule: (draft: PromptDraft, fireAt: string, req: string) => boolean;
  /** List the open session's pending schedules; the shell knows the id. */
  onScheduledList: (req: string) => boolean;
  onScheduledCancel: (scheduleId: string, req: string) => boolean;
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
  scheduleRow: boolean;
  scheduleReq: string | null;
  listReq: string | null;
  cancelReq: { req: string; scheduleId: string } | null;
  /** The session's pending schedules; null until the first list lands. */
  scheduled: ScheduledItem[] | null;
  scheduleStatus: string | null;
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
    scheduleRow: false,
    scheduleReq: null,
    listReq: null,
    cancelReq: null,
    scheduled: null,
    scheduleStatus: null,
  };
}

// A datetime-local value in the device's own time zone: YYYY-MM-DDTHH:MM.
function toLocalInputValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function formatFireAt(fireAt: string): string {
  return new Date(fireAt).toLocaleString();
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
    if (!this.initialized) {
      const raw = readRawDraft(this.storage);
      if (raw !== null && parseStoredDraft(raw) === null) {
        this.state.error = "Saved draft was unreadable; started fresh.";
      }
    }
    this.initialized = true;
    // A new draft starts with one Instruction section, the TUI's default.
    if (this.state.draft.sections.length === 0) {
      this.state.draft = addSection(this.state.draft, "instruction");
    }
    this.body = this.sheet.mount(parent);
    this.render();
    this.unsubscribe = this.catalog.subscribe(() => {
      if (this.sheet.isOpen) {
        this.render();
      }
    });
    this.requestScheduledList();
  }

  // Closing keeps the draft: memory and sessionStorage both still hold it.
  close(): void {
    this.state.previewReq = null;
    this.state.sendReq = null;
    this.state.scheduleReq = null;
    this.state.listReq = null;
    this.state.cancelReq = null;
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
    if (this.state.sendReq !== null && this.state.sendReq === req) {
      this.state.sendReq = null;
      this.state.draft = emptyDraft();
      clearDraft(this.storage);
      this.state.preview = null;
      this.close();
      return true;
    }
    // A cancel answers the same ok: drop the row, then refresh the list.
    if (this.state.cancelReq !== null && this.state.cancelReq.req === req) {
      const scheduleId = this.state.cancelReq.scheduleId;
      this.state.cancelReq = null;
      if (this.state.scheduled !== null) {
        this.state.scheduled = this.state.scheduled.filter((item) => item.id !== scheduleId);
      }
      this.render();
      this.requestScheduledList();
      return true;
    }
    return false;
  }

  // The host accepted the schedule: clear the draft like a Send, keep the
  // sheet open with a fresh default section, and refresh the list.
  handleScheduled(req: string, item: ScheduledItem): boolean {
    if (this.state.scheduleReq === null || this.state.scheduleReq !== req) {
      return false;
    }
    this.state.scheduleReq = null;
    this.state.draft = addSection(emptyDraft(), "instruction");
    clearDraft(this.storage);
    this.state.preview = null;
    this.state.scheduleRow = false;
    this.state.scheduleStatus = `Scheduled for ${formatFireAt(item.fireAt)}`;
    this.render();
    this.requestScheduledList();
    return true;
  }

  handleScheduledList(req: string, items: ScheduledItem[]): boolean {
    if (this.state.listReq === null || this.state.listReq !== req) {
      return false;
    }
    this.state.listReq = null;
    this.state.scheduled = [...items].sort(
      (a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt),
    );
    this.render();
    return true;
  }

  handleError(message: string, req: string | null, code: string): boolean {
    const previewMatch = this.state.previewReq !== null && (req === null || this.state.previewReq === req);
    const sendMatch = this.state.sendReq !== null && (req === null || this.state.sendReq === req);
    const scheduleMatch =
      this.state.scheduleReq !== null && (req === null || this.state.scheduleReq === req);
    const listMatch = this.state.listReq !== null && (req === null || this.state.listReq === req);
    const cancelMatch =
      this.state.cancelReq !== null && (req === null || this.state.cancelReq.req === req);
    if (!previewMatch && !sendMatch && !scheduleMatch && !listMatch && !cancelMatch) {
      return false;
    }
    if (previewMatch) {
      this.state.previewReq = null;
    }
    if (sendMatch) {
      this.state.sendReq = null;
    }
    // A schedule, list or cancel failure keeps the draft and the rows: the
    // message lands on the sheet's own error line, even from an old host
    // that answers every new frame with unknown-frame.
    if (scheduleMatch || listMatch || cancelMatch) {
      this.state.scheduleReq = scheduleMatch ? null : this.state.scheduleReq;
      this.state.listReq = listMatch ? null : this.state.listReq;
      this.state.cancelReq = cancelMatch ? null : this.state.cancelReq;
      this.state.error = message;
      this.renderErrors();
      return true;
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
          <label>Add section
            <select id="builder-add-section">
              <option value="" selected>Choose kind…</option>
              ${this.kindOptions()}
            </select>
          </label>
        </section>
        ${this.scheduledHtml()}
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
          <button type="button" class="secondary" id="builder-preview">Preview</button>
          <button type="button" class="secondary" id="builder-schedule">Schedule</button>
          <button type="button" class="primary" id="builder-send">Send</button>
        </div>
        ${this.scheduleRowHtml()}
        <p class="builder-status" id="builder-schedule-status" role="status"${this.state.scheduleStatus === null ? " hidden" : ""}>${esc(this.state.scheduleStatus ?? "")}</p>
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

  private kindOptions(): string {
    return SECTION_KINDS.map(
      (kind) => `<option value="${kind}">${sectionLabel(kind)}</option>`,
    ).join("");
  }

  private sectionsHtml(): string {
    const sections = this.state.draft.sections;
    return sections
      .map((section, index) => {
        const last = index === sections.length - 1;
        return `
          <li class="builder-section" data-index="${index}">
            <label>Kind
              <select class="section-kind" data-index="${index}">${this.kindOptions()}</select>
            </label>
            <label>Content
              <textarea class="section-content" data-index="${index}" rows="3">${esc(section.content)}</textarea>
            </label>
            <div class="section-actions">
              <button type="button" class="secondary section-up" data-index="${index}"${index === 0 ? " disabled" : ""}>Up</button>
              <button type="button" class="secondary section-down" data-index="${index}"${last ? " disabled" : ""}>Down</button>
              <button type="button" class="secondary section-remove" data-index="${index}">Remove</button>
            </div>
          </li>`;
      })
      .join("");
  }

  // The session's pending schedules, once the list has loaded with
  // items. Previews are user text: always escaped, never innerHTML raw.
  private scheduledHtml(): string {
    const scheduled = this.state.scheduled;
    if (scheduled === null || scheduled.length === 0) {
      return "";
    }
    const rows = scheduled
      .map(
        (item) => `
          <li class="scheduled-item">
            <span class="scheduled-when">${esc(formatFireAt(item.fireAt))}</span>
            <span class="scheduled-preview">${esc(item.preview)}</span>
            <button type="button" class="secondary" data-schedule-id="${esc(item.id)}">Cancel</button>
          </li>`,
      )
      .join("");
    return `
        <section class="builder-scheduled" id="builder-scheduled">
          <h3>Scheduled for this session</h3>
          <ul class="builder-scheduled-list">${rows}</ul>
        </section>`;
  }

  // The inline scheduling row: preset to one hour from now, never earlier
  // than the current minute.
  private scheduleRowHtml(): string {
    const now = new Date();
    const preset = toLocalInputValue(new Date(now.getTime() + 60 * 60 * 1000));
    return `
        <div class="builder-schedule-row" id="builder-schedule-row"${this.state.scheduleRow ? "" : " hidden"}>
          <label>When
            <input type="datetime-local" id="builder-schedule-at" value="${preset}" min="${toLocalInputValue(now)}">
          </label>
          <div class="builder-schedule-actions">
            <button type="button" class="primary" id="builder-schedule-confirm">Confirm schedule</button>
            <button type="button" class="secondary" id="builder-schedule-dismiss">Cancel</button>
          </div>
        </div>`;
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
    // The Add menu is a picker like the preset's: choosing a kind appends
    // a section titled with that kind, and the re-render resets the menu.
    // The menu's options constrain the value, so only "" needs a guard.
    body.querySelector<HTMLSelectElement>("#builder-add-section")?.addEventListener("change", (ev) => {
      const kind = (ev.target as HTMLSelectElement).value;
      if (kind === "") {
        return;
      }
      this.state.draft = addSection(this.state.draft, kind as SectionKind);
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
    // The kind selects carry no `selected` marker: happy-dom only honors
    // it on the first options, so each select takes its kind — derived
    // from the section's title — by assignment (in document order, the
    // sections' order) and reports changes back through the same index.
    body.querySelectorAll<HTMLSelectElement>(".section-kind").forEach((select, index) => {
      select.value = kindFromTitle(this.state.draft.sections[index].title);
      select.addEventListener("change", () => {
        this.state.draft = updateSection(this.state.draft, index, { title: select.value });
        this.save();
        this.invalidatePreview();
      });
    });
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
    body.querySelector("#builder-schedule")?.addEventListener("click", () => {
      this.state.scheduleRow = true;
      this.render();
      body.querySelector<HTMLInputElement>("#builder-schedule-at")?.focus();
    });
    body.querySelector("#builder-schedule-dismiss")?.addEventListener("click", () => {
      this.state.scheduleRow = false;
      this.render();
    });
    body.querySelector("#builder-schedule-confirm")?.addEventListener("click", () => this.confirmSchedule());
    for (const button of body.querySelectorAll<HTMLButtonElement>("button[data-schedule-id]")) {
      button.addEventListener("click", () => this.cancelScheduled(button.dataset.scheduleId ?? ""));
    }
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

  // Confirm schedules the wire draft for the row's local time, sent as
  // UTC. An empty, unreadable or past value is the sheet's plain error
  // and sends nothing.
  private confirmSchedule(): void {
    this.clearErrors();
    const input = this.body?.querySelector<HTMLInputElement>("#builder-schedule-at");
    const value = input?.value ?? "";
    const at = value === "" ? Number.NaN : new Date(value).getTime();
    if (value === "") {
      this.state.error = "Choose a date and time first.";
      this.renderErrors();
      return;
    }
    if (Number.isNaN(at) || at <= Date.now()) {
      this.state.error = "Pick a time in the future.";
      this.renderErrors();
      return;
    }
    const req = newReqId();
    this.state.scheduleReq = req;
    if (!this.callbacks.onSchedule(wireDraft(this.state.draft), new Date(value).toISOString(), req)) {
      this.state.scheduleReq = null;
      this.state.error = "Not connected";
      this.renderErrors();
    }
  }

  private cancelScheduled(scheduleId: string): void {
    if (scheduleId === "") {
      return;
    }
    this.clearErrors();
    const req = newReqId();
    this.state.cancelReq = { req, scheduleId };
    if (!this.callbacks.onScheduledCancel(scheduleId, req)) {
      this.state.cancelReq = null;
      this.state.error = "Not connected";
      this.renderErrors();
    }
  }

  // No polling: the list loads on open and after each schedule or cancel.
  private requestScheduledList(): void {
    const req = newReqId();
    this.state.listReq = req;
    if (!this.callbacks.onScheduledList(req)) {
      this.state.listReq = null;
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
