// SPDX-License-Identifier: Apache-2.0
/**
 * The toolbar: two actions and the draft they produce.
 *
 * Import opens the JSON box (a paste or a file, as the catalogue editor
 * takes it); Export stores the graph as a one-use draft and shows the
 * install command with a Copy button and the countdown to its 30-minute
 * expiry. The countdown is the only timer here; a new draft stops the
 * old one, so two shares never tick at once.
 */
import { ApiError, type DraftCreated } from "./api.js";

/** What the toolbar asks of its owner. */
export interface ToolbarHooks {
  /** Take the import text; answer an error, or null on success. */
  importText(text: string): string | null;
  /** Validate and store the draft; throws the API's own error. */
  exportDraft(): Promise<DraftCreated>;
  /** Show a transient notice line. */
  notify(message: string): void;
}

/** The API's own words for a failure, its problem paths included. */
function apiMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problems.length > 0
      ? `${error.message} — ${error.problems.join(" · ")}`
      : error.message;
  }
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "Something went wrong.";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class Toolbar {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busyFlight = false;
  private blocked = false;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly exportBtn: HTMLButtonElement;
  private readonly importEl: HTMLElement;
  private readonly importText: HTMLTextAreaElement;
  private readonly importFile: HTMLInputElement;
  private readonly importError: HTMLElement;
  private readonly shareEl: HTMLElement;
  private readonly shareBody: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: ToolbarHooks,
  ) {
    const need = <T extends Element>(selector: string): T => {
      const found = root.querySelector<T>(selector);
      if (found === null) {
        throw new Error(`editor shell is missing ${selector}`);
      }
      return found;
    };
    this.exportBtn = need('[data-action="export"]');
    this.importEl = need("#editor-import");
    this.importText = need("#editor-import-text");
    this.importFile = need("#editor-import-file");
    this.importError = need("#editor-import-error");
    this.shareEl = need("#editor-share");
    this.shareBody = need("#editor-share-body");
    root.addEventListener("click", (event) => void this.onClick(event));
    this.importFile.addEventListener("change", () => void this.readImportFile());
  }

  /** Enable or disable Export; a flight in progress stays disabled. */
  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    this.exportBtn.disabled = blocked || this.busyFlight;
  }

  /** Hide the share block (a new import, a cleared canvas). */
  hideShare(): void {
    this.stop();
    this.shareEl.hidden = true;
  }

  private async onClick(event: Event): Promise<void> {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    const action = target?.getAttribute("data-action") ?? "";
    switch (action) {
      case "import":
        this.toggleImport();
        break;
      case "import-apply":
        this.applyImport();
        break;
      case "import-cancel":
        this.hideImport();
        break;
      case "export":
        await this.runExport();
        break;
      case "copy-draft": {
        const command = target?.getAttribute("data-copy") ?? "";
        await this.copyCommand(target as HTMLElement | null, command);
        break;
      }
      default:
        break;
    }
  }

  private toggleImport(): void {
    this.importEl.hidden = !this.importEl.hidden;
    this.importError.hidden = true;
    if (!this.importEl.hidden) {
      this.importText.focus();
    }
  }

  private hideImport(): void {
    this.importEl.hidden = true;
    this.importError.hidden = true;
    this.importText.value = "";
  }

  private applyImport(): void {
    const error = this.hooks.importText(this.importText.value);
    if (error !== null) {
      this.importError.textContent = error;
      this.importError.hidden = false;
      return;
    }
    this.hideShare();
    this.hideImport();
  }

  private async readImportFile(): Promise<void> {
    const file = this.importFile.files?.[0] ?? null;
    this.importFile.value = "";
    if (file === null) {
      return;
    }
    try {
      this.importText.value = await file.text();
    } catch {
      this.importError.textContent = "That file could not be read.";
      this.importError.hidden = false;
      return;
    }
    this.importError.hidden = true;
    this.importText.focus();
  }

  private async runExport(): Promise<void> {
    if (this.blocked || this.busyFlight) {
      return;
    }
    this.busyFlight = true;
    this.exportBtn.disabled = true;
    this.shareBody.textContent = "Creating a draft…";
    this.shareEl.hidden = false;
    try {
      const draft = await this.hooks.exportDraft();
      this.show(draft);
    } catch (error) {
      this.shareEl.hidden = true;
      this.hooks.notify(apiMessage(error));
    } finally {
      this.busyFlight = false;
      this.exportBtn.disabled = this.blocked;
    }
  }

  /** The stored draft: the command, its Copy button, the expiry countdown. */
  private show(draft: DraftCreated): void {
    this.stop();
    this.shareBody.innerHTML =
      `<span class="row-install"><code>${escapeHtml(draft.install)}</code>` +
      `<button type="button" class="button" data-action="copy-draft" data-copy="${escapeHtml(draft.install)}">` +
      `<span>Copy</span></button></span>` +
      `<p class="editor-share-note">One use · <span class="editor-countdown" id="editor-countdown"></span></p>`;
    this.tick(draft.expires_at);
    this.timer = setInterval(() => this.tick(draft.expires_at), 1000);
    this.shareEl.hidden = false;
  }

  private tick(expiresAt: string): void {
    const label = this.shareBody.querySelector("#editor-countdown");
    if (label === null) {
      this.stop();
      return;
    }
    const left = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(left) || left <= 0) {
      label.textContent = "expired";
      this.stop();
      return;
    }
    const seconds = Math.ceil(left / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    label.textContent = `expires in ${minutes}:${rest}`;
  }

  private async copyCommand(button: HTMLElement | null, command: string): Promise<void> {
    if (command === "") {
      return;
    }
    try {
      await globalThis.navigator.clipboard.writeText(command);
    } catch {
      // A clipboard without permission still copies through a selection.
      const area = document.createElement("textarea");
      area.value = command;
      document.body.append(area);
      area.select();
      try {
        document.execCommand("copy");
      } catch {
        // The command stays visible; the user copies it by hand.
      }
      area.remove();
    }
    const label = button?.querySelector("span") ?? null;
    if (label === null) {
      return;
    }
    label.textContent = "Copied";
    if (this.copyTimer !== null) {
      clearTimeout(this.copyTimer);
    }
    this.copyTimer = setTimeout(() => {
      label.textContent = "Copy";
    }, 2000);
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
