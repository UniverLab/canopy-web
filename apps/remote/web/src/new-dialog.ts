// SPDX-License-Identifier: Apache-2.0
// The New dialog: start an agent or a terminal on the host. A segmented
// control picks the kind (Agent by default). Agents pick a harness, a
// directory, an optional yolo mode, name and first prompt; terminals pick
// a directory and a name, and the host runs the user's shell. There is no
// model field: the harness's own default applies. Create sends
// spawn{req,kind,...}; a matching spawned{req,id} closes the dialog and
// the shell opens the session. An error keeps the form exactly as it was.

import { CatalogStore } from "./catalog.js";
import {
  buildDirectorySuggestions,
  pushRecentDir,
  readLastDir,
  readRecentDirs,
  writeLastDir,
} from "./dir-history.js";
import { classifyDraftError } from "./draft.js";
import { newReqId } from "./protocol.js";
import type { SessionItem, SpawnKind, SpawnRequest } from "./protocol.js";
import { Sheet, esc } from "./sheet.js";
import { icon } from "./icons-dom.js";

export interface NewDialogCallbacks {
  /** Returns false when the frame could not be sent (no connection). */
  onSpawn: (spawn: SpawnRequest, req: string) => boolean;
}

export interface NewDialogSessions {
  list: () => SessionItem[];
}

export interface NewDialogEnv {
  sessions?: NewDialogSessions | SessionItem[];
  hostId?: string;
}

interface NewForm {
  kind: SpawnKind;
  cli: string;
  directory: string;
  yolo: boolean;
  name: string;
  prompt: string;
}

const EMPTY_FORM: NewForm = { kind: "agent", cli: "", directory: "", yolo: false, name: "", prompt: "" };

export const YOLO_HINT = "not supported by this harness";

export class NewDialog {
  private readonly catalog: CatalogStore;
  private readonly callbacks: NewDialogCallbacks;
  private readonly sheet: Sheet;
  private sessions: NewDialogSessions | SessionItem[] | null;
  private hostId: string;
  private form: NewForm = { ...EMPTY_FORM };
  private pending: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private body: HTMLElement | null = null;
  private error: string | null = null;
  private directoryError: string | null = null;

  constructor(catalog: CatalogStore, callbacks: NewDialogCallbacks, env?: NewDialogEnv) {
    this.catalog = catalog;
    this.callbacks = callbacks;
    this.sheet = new Sheet({ kind: "new", title: "Start a session on this host" }, () => this.close());
    this.sessions = env?.sessions ?? null;
    this.hostId = env?.hostId ?? "";
  }

  setHostId(hostId: string): void {
    // The directory draft belongs to the old host: drop it so the next
    // open prefills from the new host's memory instead.
    if (hostId !== this.hostId) {
      this.form.directory = "";
    }
    this.hostId = hostId;
  }

  setSessions(sessions: NewDialogSessions | SessionItem[]): void {
    this.sessions = sessions;
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
    this.directoryError = null;
    this.pending = null;
    // Every open starts an agent with yolo off; the directory keeps a
    // cancelled draft, or the last directory used on this host.
    this.form.kind = "agent";
    this.form.yolo = false;
    if (this.form.directory === "") {
      this.form.directory = readLastDir(this.hostId) ?? "";
    }
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
    this.directoryError = null;
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
    // The host validates the path: workdir complaints land beside the
    // directory field, everything else above the actions. Either way the
    // host's own message shows and the dialog stays open.
    const classified = classifyDraftError(code, message);
    if (classified.field === "project") {
      this.showDirectoryError(classified.message);
    } else {
      this.showError(classified.message);
    }
    return true;
  }

  // Keep the harness that still exists, default the rest to the first.
  private defaultsFromCatalog(): void {
    const clis = this.catalog.clis;
    const cli = clis.find((item) => item.cli === this.form.cli) ?? clis[0] ?? null;
    this.form.cli = cli?.cli ?? "";
    // A harness without yolo support cannot stay checked.
    if (!this.yoloSupported(this.form.cli)) {
      this.form.yolo = false;
    }
  }

  private yoloSupported(cli: string): boolean {
    return this.catalog.findCli(cli)?.yolo === true;
  }

  private sessionWorkdirs(): string[] {
    const sessions = this.sessions;
    if (!sessions) {
      return [];
    }
    const items = Array.isArray(sessions) ? sessions : sessions.list();
    return items.map((item) => item.workdir).filter((workdir) => workdir !== "");
  }

  private suggestions(): string[] {
    return buildDirectorySuggestions({
      catalogPaths: this.catalog.projects.map((project) => project.path),
      sessionWorkdirs: this.sessionWorkdirs(),
      recent: readRecentDirs(),
    });
  }

  private render(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    const agent = this.form.kind === "agent";
    body.innerHTML = `
      <form id="new-form" class="new-form">
        <div class="kind-segment" role="radiogroup" aria-label="Session kind">
          <label class="kind-option"><input type="radio" name="kind" id="new-kind-agent" value="agent"${agent ? " checked" : ""}> Agent</label>
          <label class="kind-option"><input type="radio" name="kind" id="new-kind-terminal" value="terminal"${agent ? "" : " checked"}> Terminal</label>
        </div>
        ${agent ? this.agentFields() : this.terminalFields()}
        <p class="sheet-error" id="new-error" role="alert">${esc(this.error ?? "")}</p>
        <div class="sheet-actions">
          <button type="button" id="new-cancel">Cancel</button>
          <button type="submit" class="primary" id="new-create">Create</button>
        </div>
      </form>`;
    this.wire();
    this.syncSelects();
  }

  private directoryField(): string {
    const options = this.suggestions()
      .map((dir) => `<option value="${esc(dir)}"></option>`)
      .join("");
    return `
        <label>${icon("folder")}Directory
          <input id="new-directory" name="directory" autocomplete="off" spellcheck="false"
            placeholder="/home/user/project" list="new-directory-list" value="${esc(this.form.directory)}">
        </label>
        <datalist id="new-directory-list">${options}</datalist>
        <p class="field-error" id="new-directory-error" role="alert"${this.directoryError === null ? " hidden" : ""}>${esc(this.directoryError ?? "")}</p>`;
  }

  private agentFields(): string {
    const clis = this.catalog.clis;
    const supported = this.yoloSupported(this.form.cli);
    return `
        <label>Harness
          <select id="new-cli" name="cli"${clis.length === 0 ? " disabled" : ""}>${this.cliOptions()}</select>
        </label>
        ${this.directoryField()}
        <label class="yolo-row"><input type="checkbox" id="new-yolo"${this.form.yolo ? " checked" : ""}${supported ? "" : " disabled"}> ${icon("zap")}Yolo (skip approval prompts)</label>
        <p class="yolo-hint" id="new-yolo-hint"${supported ? " hidden" : ""}>${esc(YOLO_HINT)}</p>
        <label>Name (optional)
          <input id="new-name" name="name" autocomplete="off" value="${esc(this.form.name)}">
        </label>
        <label>First prompt (optional)
          <textarea id="new-prompt" name="prompt" rows="3">${esc(this.form.prompt)}</textarea>
        </label>`;
  }

  private terminalFields(): string {
    return `
        ${this.directoryField()}
        <label>Name (optional)
          <input id="new-name" name="name" autocomplete="off" value="${esc(this.form.name)}">
        </label>`;
  }

  // happy-dom (and some browsers) pick the first non-empty option from
  // innerHTML; assign the current state explicitly so the UI is truthful.
  private syncSelects(): void {
    const body = this.body;
    if (!body) {
      return;
    }
    const cli = body.querySelector<HTMLSelectElement>("#new-cli");
    if (cli) {
      cli.value = this.form.cli;
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
    for (const input of body.querySelectorAll<HTMLInputElement>('input[name="kind"]')) {
      input.addEventListener("change", () => {
        this.syncFields();
        const picked = body.querySelector<HTMLInputElement>('input[name="kind"]:checked')?.value;
        this.form.kind = picked === "terminal" ? "terminal" : "agent";
        this.error = null;
        this.directoryError = null;
        this.render();
      });
    }
    body.querySelector<HTMLSelectElement>("#new-cli")?.addEventListener("change", (ev) => {
      this.form.cli = (ev.target as HTMLSelectElement).value;
      // Yolo follows the newly picked harness: unsupported unchecks and
      // disables, supported only enables (still off until checked).
      if (!this.yoloSupported(this.form.cli)) {
        this.form.yolo = false;
      }
      this.syncYoloRow();
    });
    body.querySelector<HTMLInputElement>("#new-yolo")?.addEventListener("change", (ev) => {
      this.form.yolo = (ev.target as HTMLInputElement).checked;
    });
    body.querySelector<HTMLInputElement>("#new-directory")?.addEventListener("input", (ev) => {
      this.form.directory = (ev.target as HTMLInputElement).value;
      this.showDirectoryError(null);
    });
    body.querySelector<HTMLInputElement>("#new-name")?.addEventListener("input", (ev) => {
      this.form.name = (ev.target as HTMLInputElement).value;
    });
    body.querySelector<HTMLTextAreaElement>("#new-prompt")?.addEventListener("input", (ev) => {
      this.form.prompt = (ev.target as HTMLTextAreaElement).value;
    });
  }

  private syncYoloRow(): void {
    const supported = this.yoloSupported(this.form.cli);
    const box = this.body?.querySelector<HTMLInputElement>("#new-yolo");
    if (box) {
      box.disabled = !supported;
      box.checked = supported && this.form.yolo;
    }
    const hint = this.body?.querySelector<HTMLElement>("#new-yolo-hint");
    if (hint) {
      hint.hidden = supported;
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
    const directory = body.querySelector<HTMLInputElement>("#new-directory");
    const yolo = body.querySelector<HTMLInputElement>("#new-yolo");
    const name = body.querySelector<HTMLInputElement>("#new-name");
    const prompt = body.querySelector<HTMLTextAreaElement>("#new-prompt");
    if (cli) {
      this.form.cli = cli.value;
    }
    if (directory) {
      this.form.directory = directory.value;
    }
    if (yolo) {
      this.form.yolo = yolo.checked;
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
    this.showDirectoryError(null);
    const workdir = this.form.directory.trim();
    if (workdir === "") {
      this.showDirectoryError("Enter a directory");
      return;
    }
    let spawn: SpawnRequest;
    if (this.form.kind === "terminal") {
      spawn = { kind: "terminal", workdir };
      const name = this.form.name.trim();
      if (name !== "") {
        spawn.name = name;
      }
    } else {
      if (this.form.cli === "") {
        this.showError("No harness selected");
        return;
      }
      spawn = { kind: "agent", cli: this.form.cli, workdir };
      if (this.form.yolo && this.yoloSupported(this.form.cli)) {
        spawn.yolo = true;
      }
      const name = this.form.name.trim();
      if (name !== "") {
        spawn.name = name;
      }
      const prompt = this.form.prompt.trim();
      if (prompt !== "") {
        spawn.prompt = prompt;
      }
    }
    // Remembered on use: the host's last directory and the browser recents.
    writeLastDir(this.hostId, workdir);
    pushRecentDir(workdir);
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

  private showDirectoryError(message: string | null): void {
    this.directoryError = message;
    const el = this.body?.querySelector<HTMLElement>("#new-directory-error");
    if (el) {
      el.textContent = message ?? "";
      el.hidden = message === null;
    }
  }
}
