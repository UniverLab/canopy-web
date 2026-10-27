// SPDX-License-Identifier: Apache-2.0
// The New dialog: start an agent session on the host. Harness, optional
// model, required project, and an optional name and first prompt, all
// picked from the host catalog. Create sends spawn{req,kind:"agent",...};
// a matching spawned{req,id} closes the dialog and the shell opens the
// session. An error keeps the form exactly as it was.

import { CatalogStore } from "./catalog.js";
import { classifyDraftError } from "./draft.js";
import { newReqId } from "./protocol.js";
import type { SpawnRequest } from "./protocol.js";
import { Sheet, esc } from "./sheet.js";

export interface NewDialogCallbacks {
  /** Returns false when the frame could not be sent (no connection). */
  onSpawn: (spawn: SpawnRequest, req: string) => boolean;
}

interface NewForm {
  cli: string;
  model: string;
  project: string;
  name: string;
  prompt: string;
}

const EMPTY_FORM: NewForm = { cli: "", model: "", project: "", name: "", prompt: "" };

export class NewDialog {
  private readonly catalog: CatalogStore;
  private readonly callbacks: NewDialogCallbacks;
  private readonly sheet: Sheet;
  private form: NewForm = { ...EMPTY_FORM };
  private pending: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private body: HTMLElement | null = null;
  private error: string | null = null;
  private projectError: string | null = null;

  constructor(catalog: CatalogStore, callbacks: NewDialogCallbacks) {
    this.catalog = catalog;
    this.callbacks = callbacks;
    this.sheet = new Sheet({ kind: "new", title: "New session" }, () => this.close());
  }

  get isOpen(): boolean {
    return this.sheet.isOpen;
  }

  open(parent: HTMLElement): void {
    if (this.sheet.isOpen) {
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.body = this.sheet.mount(parent);
    this.error = null;
    this.projectError = null;
    this.pending = null;
    this.defaultsFromCatalog();
    this.render();
    this.unsubscribe = this.catalog.subscribe(() => {
      if (!this.sheet.isOpen) {
        return;
      }
      this.defaultsFromCatalog();
      this.render();
    });
  }

  close(): void {
    this.pending = null;
    this.error = null;
    this.projectError = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.body = null;
    this.sheet.close();
  }

  handleSpawned(req: string): boolean {
    if (this.pending === null || this.pending !== req) {
      return false;
    }
    this.pending = null;
    this.form = { ...EMPTY_FORM };
    this.close();
    return true;
  }

  handleError(message: string, req: string | null, code: string): boolean {
    if (this.pending === null) {
      return false;
    }
    if (req !== null && req !== this.pending) {
      return false;
    }
    this.pending = null;
    const classified = classifyDraftError(code, message);
    if (classified.field === "project") {
      this.showProjectError(classified.message);
    } else {
      this.showError(classified.message);
    }
    return true;
  }

  // Keep the picks that still exist, default the rest: the first harness,
  // and the only project when the host offers exactly one.
  private defaultsFromCatalog(): void {
    const clis = this.catalog.clis;
    const cli = clis.find((item) => item.cli === this.form.cli) ?? clis[0] ?? null;
    this.form.cli = cli?.cli ?? "";
    const models = cli?.models ?? [];
    if (this.form.model !== "" && !models.includes(this.form.model)) {
      this.form.model = "";
    }
    const projects = this.catalog.projects;
    const project =
      projects.find((item) => item.name === this.form.project) ??
      (projects.length === 1 ? projects[0] : null);
    this.form.project = project?.name ?? "";
  }

  private render(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    const clis = this.catalog.clis;
    const projects = this.catalog.projects;
    body.innerHTML = `
      <form id="new-form" class="new-form">
        <label>Harness
          <select id="new-cli" name="cli"${clis.length === 0 ? " disabled" : ""}>${this.cliOptions()}</select>
        </label>
        <label>Model
          <select id="new-model" name="model"${clis.length === 0 ? " disabled" : ""}>${this.modelOptions()}</select>
        </label>
        <label>Project
          <select id="new-project" name="project"${projects.length === 0 ? " disabled" : ""}>${this.projectOptions()}</select>
        </label>
        <p class="field-error" id="new-project-error" role="alert"${this.projectError === null ? " hidden" : ""}>${esc(this.projectError ?? "")}</p>
        <label>Name (optional)
          <input id="new-name" name="name" autocomplete="off" value="${esc(this.form.name)}">
        </label>
        <label>First prompt (optional)
          <textarea id="new-prompt" name="prompt" rows="3">${esc(this.form.prompt)}</textarea>
        </label>
        <p class="sheet-error" id="new-error" role="alert">${esc(this.error ?? "")}</p>
        <div class="sheet-actions">
          <button type="button" id="new-cancel">Cancel</button>
          <button type="submit" class="primary" id="new-create">Create</button>
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
    const cli = body.querySelector<HTMLSelectElement>("#new-cli");
    const model = body.querySelector<HTMLSelectElement>("#new-model");
    const project = body.querySelector<HTMLSelectElement>("#new-project");
    if (cli) {
      cli.value = this.form.cli;
    }
    if (model) {
      model.value = this.form.model;
    }
    if (project) {
      project.value = this.form.project;
    }
  }

  private cliOptions(): string {
    const clis = this.catalog.clis;
    if (clis.length === 0) {
      return `<option value="" selected>No harnesses</option>`;
    }
    return clis
      .map(
        (item) =>
          `<option value="${esc(item.cli)}"${item.cli === this.form.cli ? " selected" : ""}>${esc(item.label)}</option>`,
      )
      .join("");
  }

  private modelOptions(): string {
    const models = this.catalog.findCli(this.form.cli)?.models ?? [];
    const head = `<option value=""${this.form.model === "" ? " selected" : ""}>Default</option>`;
    return (
      head +
      models
        .map(
          (model) =>
            `<option value="${esc(model)}"${model === this.form.model ? " selected" : ""}>${esc(model)}</option>`,
        )
        .join("")
    );
  }

  private projectOptions(): string {
    const projects = this.catalog.projects;
    if (projects.length === 0) {
      return `<option value="" selected>No projects</option>`;
    }
    const head = `<option value=""${this.form.project === "" ? " selected" : ""}>Choose a project…</option>`;
    return (
      head +
      projects
        .map(
          (project) =>
            `<option value="${esc(project.name)}"${project.name === this.form.project ? " selected" : ""}>${esc(project.name)}</option>`,
        )
        .join("")
    );
  }

  private wire(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    body.querySelector("#new-form")?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.submit();
    });
    body.querySelector("#new-cancel")?.addEventListener("click", () => this.close());
    body.querySelector<HTMLSelectElement>("#new-cli")?.addEventListener("change", (ev) => {
      this.form.cli = (ev.target as HTMLSelectElement).value;
      this.form.model = "";
      this.renderModelOptions();
    });
    body.querySelector<HTMLSelectElement>("#new-model")?.addEventListener("change", (ev) => {
      this.form.model = (ev.target as HTMLSelectElement).value;
    });
    body.querySelector<HTMLSelectElement>("#new-project")?.addEventListener("change", (ev) => {
      this.form.project = (ev.target as HTMLSelectElement).value;
      this.showProjectError(null);
    });
    body.querySelector<HTMLInputElement>("#new-name")?.addEventListener("input", (ev) => {
      this.form.name = (ev.target as HTMLInputElement).value;
    });
    body.querySelector<HTMLTextAreaElement>("#new-prompt")?.addEventListener("input", (ev) => {
      this.form.prompt = (ev.target as HTMLTextAreaElement).value;
    });
  }

  private renderModelOptions(): void {
    const select = this.body?.querySelector<HTMLSelectElement>("#new-model");
    if (select) {
      select.innerHTML = this.modelOptions();
      select.value = this.form.model;
    }
  }

  // The DOM is the truth at submit time: reads fields the way the pair form
  // does, so a programmatic value with no input event still counts.
  private syncFields(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    const cli = body.querySelector<HTMLSelectElement>("#new-cli");
    const model = body.querySelector<HTMLSelectElement>("#new-model");
    const project = body.querySelector<HTMLSelectElement>("#new-project");
    const name = body.querySelector<HTMLInputElement>("#new-name");
    const prompt = body.querySelector<HTMLTextAreaElement>("#new-prompt");
    if (cli) {
      this.form.cli = cli.value;
    }
    if (model) {
      this.form.model = model.value;
    }
    if (project) {
      this.form.project = project.value;
    }
    if (name) {
      this.form.name = name.value;
    }
    if (prompt) {
      this.form.prompt = prompt.value;
    }
  }

  private submit(): void {
    this.syncFields();
    this.showError("");
    this.showProjectError(null);
    if (this.form.cli === "") {
      this.showError("No harness selected");
      return;
    }
    const project = this.catalog.findProject(this.form.project);
    if (project === null) {
      this.showProjectError("Choose a project");
      return;
    }
    const spawn: SpawnRequest = { cli: this.form.cli, workdir: project.path };
    if (this.form.model !== "") {
      spawn.model = this.form.model;
    }
    const name = this.form.name.trim();
    if (name !== "") {
      spawn.name = name;
    }
    const prompt = this.form.prompt.trim();
    if (prompt !== "") {
      spawn.prompt = prompt;
    }
    const req = newReqId();
    this.pending = req;
    if (!this.callbacks.onSpawn(spawn, req)) {
      this.pending = null;
      this.showError("Not connected");
    }
  }

  private showError(message: string): void {
    this.error = message === "" ? null : message;
    const el = this.body?.querySelector<HTMLElement>("#new-error");
    if (el) {
      el.textContent = message;
    }
  }

  private showProjectError(message: string | null): void {
    this.projectError = message;
    const el = this.body?.querySelector<HTMLElement>("#new-project-error");
    if (el) {
      el.textContent = message ?? "";
      el.hidden = message === null;
    }
  }
}
