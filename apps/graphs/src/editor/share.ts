// SPDX-License-Identifier: Apache-2.0
/**
 * The share block: what `Copy link` shows once the Worker has stored the
 * draft — the install command with a Copy button (the same delegated
 * morph every catalogue button uses), the draft page link, and a
 * countdown to `expires_at` that turns into "expired" when it passes.
 *
 * The countdown is the only timer in the editor; `stop` clears it before
 * a new draft replaces the old, so two shares never tick at once.
 */
import { copyButton } from "../pages/look.js";
import {
  DRAFT_EXPIRED,
  EDITOR_SHARE_BUSY,
  EDITOR_SHARE_PAGE,
  draftExpiresIn,
} from "../pages/copy.js";
import { escapeHtml } from "../pages/md.js";
import type { DraftCreated } from "./api.js";

/** The kit's bundle, as the inline shell script also reaches it. */
interface IconKit {
  mountCopyButtons?: (doc: Document) => void;
}

export class Share {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly section: HTMLElement,
    private readonly body: HTMLElement,
  ) {}

  /** The waiting state: the block opens with the busy line. */
  busy(): void {
    this.stop();
    this.body.textContent = EDITOR_SHARE_BUSY;
    this.section.hidden = false;
  }

  /** The stored draft: command, copy, page link, countdown. */
  show(draft: DraftCreated): void {
    this.stop();
    this.body.innerHTML =
      `<span class="row-install"><code>${escapeHtml(draft.install)}</code>${copyButton(draft.install)}</span>` +
      `<p class="editor-share-links">` +
      `<a href="${escapeHtml(draft.page_url)}">${escapeHtml(EDITOR_SHARE_PAGE)}</a> ` +
      `<span class="editor-countdown" id="editor-countdown"></span></p>`;
    // The shell's inline script wires copy buttons on DOMContentLoaded;
    // doing it here too is idempotent (the kit guards per document) and
    // covers an answer that lands before that event.
    const kit = (globalThis as unknown as { CanopyIcons?: IconKit }).CanopyIcons;
    try {
      kit?.mountCopyButtons?.(globalThis.document);
    } catch {
      // Without the kit the button stays a plain element; nothing throws.
    }
    this.tick(draft.expires_at);
    this.timer = setInterval(() => this.tick(draft.expires_at), 1000);
    this.section.hidden = false;
  }

  private tick(expiresAt: string): void {
    const label = this.body.querySelector("#editor-countdown");
    if (label === null) {
      this.stop();
      return;
    }
    const left = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(left) || left <= 0) {
      label.textContent = DRAFT_EXPIRED;
      this.stop();
      return;
    }
    const seconds = Math.ceil(left / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    label.textContent = draftExpiresIn(`${minutes}:${rest}`);
  }

  private stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
