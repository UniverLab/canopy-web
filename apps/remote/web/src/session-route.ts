// SPDX-License-Identifier: Apache-2.0
// The session route: the terminal view, the key bar with its one-shot
// Ctrl/Shift latches, the copy float, the terminal controls, the uploads
// tray and the Files badge. The shell owns render() and the route; this
// module owns everything else the open session needs, through hooks the
// shell provides. Split out of app.ts to keep the shell a readable size.

import { REMOTE_FOOTER } from "./footer.js";
import { icon, mountMorphSlot, type RemoteIconName, type MorphSlot } from "./icons-dom.js";
import { renderKeyBar, updateKeyBarLatches } from "./keys.js";
import {
  isTerminalReport,
  keyBytesWithModifiers,
  ModifierLatches,
  textBytesWithModifiers,
} from "./modifiers.js";
import { newReqId } from "./protocol.js";
import { convergeOpenSessionName, type SessionStore } from "./sessions.js";
import type { ShelfHandle } from "./shelf-controller.js";
import { esc } from "./sheet.js";
import { dropIdleFocus, followKeyboard, openPhoneKeyboard } from "./phone-keyboard.js";
import { TerminalView } from "./terminal.js";
import type { TerminalFactory } from "./terminal.js";
import {
  latestHidden,
  termControlsHtml,
  termLatestHtml,
  termSizeHtml,
  wireTermControls,
} from "./term-controls.js";

// Temporary kill-switch: the web resize misbehaves on phones (the terminal
// can end up small with no way back, and a resize pauses the graph), so the
// size row is not offered until the resize is fixed properly. One flag to
// flip back: the wiring underneath stays intact and tested.
const RESIZE_ENABLED = false;
import type { TermControls } from "./term-controls.js";
import { pointerIsFine } from "./terminal-prefs.js";
import { termCopyFloatHtml, wireCopyFloat } from "./term-copy.js";
import { mountUploads } from "./upload-view.js";
import type { UploadView } from "./upload-view.js";

export interface SessionRouteCallbacks {
  /** Key-bar bytes with the latches applied; the route owns the latches. */
  onKeyPress: (bytes: Uint8Array) => void;
  /** Phone-keyboard bytes with the latches applied. */
  onTerminalInput: (bytes: Uint8Array) => void;
  /**
   * The device asserts its PTY size for the open session (send
   * resize{id,cols,rows}): the cols × rows that fit this device's panel.
   * Fires when the control-size toggle turns on, on every terminal mount
   * while it is on, and (debounced) whenever the panel changes while on.
   */
  onControlSize: (cols: number, rows: number) => void;
  /** The control-size toggle turned off: give the size back to the host. */
  onReleaseSize: () => void;
  /**
   * The Close button's second tap: send kill{req,id} for the open
   * session. False when nothing went out — the route says "Not
   * connected" and re-arms the confirm.
   */
  onKill: (req: string) => boolean;
  onLeaveSession: () => void;
}

export interface SessionRouteHooks {
  header: () => string;
  banner: () => string;
  wireBanner: () => void;
  /** The shell's current route name ("sessions", "session", …). */
  route: () => string;
  /** Open the prompt builder sheet (shell-owned dialogs). */
  openBuilder: () => void;
  /** Open the copy sheet over the terminal's buffer text. */
  openCopy: (bufferText: (maxLines: number) => string) => void;
}

export interface SessionRouteDeps {
  terminalFactory: TerminalFactory;
  /** The session shelf; without it (or without the feature) no UI. */
  shelf: ShelfHandle | null;
}

export class SessionRoute {
  private readonly root: HTMLElement;
  private readonly terminalFactory: TerminalFactory;
  private readonly shelf: ShelfHandle | null;
  private readonly callbacks: SessionRouteCallbacks;
  private readonly hooks: SessionRouteHooks;
  // The one-shot Ctrl/Shift latches for the open session, released on
  // every consumed key and every session render.
  private readonly latches = new ModifierLatches();
  private sessionId: string | null = null;
  private sessionName = "";
  private sessionCols = 0;
  private sessionRows = 0;
  private terminalView: TerminalView | null = null;
  private latestButton: HTMLButtonElement | null = null;
  private copyFloatDispose: (() => void) | null = null;
  private dropFocusDispose: (() => void) | null = null;
  private keyboardDispose: (() => void) | null = null;
  private termControls: TermControls | null = null;
  private uploadView: UploadView | null = null;
  // The Files button's folder: open while the sheet is up.
  private shelfIcon: MorphSlot | null = null;
  // The one-shot spawn confirmation: set by sheetSpawned, consumed by the
  // session view's first render, so it shows exactly once.
  private spawnFlash: string | null = null;
  // The Close button's two-tap confirm: closeTimer runs the 4 s window,
  // killReq names the kill{req} in flight so its error can find it.
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private killReq: string | null = null;

  constructor(
    root: HTMLElement,
    deps: SessionRouteDeps,
    callbacks: SessionRouteCallbacks,
    hooks: SessionRouteHooks,
  ) {
    this.root = root;
    this.terminalFactory = deps.terminalFactory;
    this.shelf = deps.shelf;
    this.callbacks = callbacks;
    this.hooks = hooks;
  }

  /** The open session's id, if the route holds one. */
  get openId(): string | null {
    return this.sessionId;
  }

  /** The open session's display name. */
  get openName(): string {
    return this.sessionName;
  }

  /** Enter the route for one session; the shell paints after. */
  open(id: string, name: string): void {
    this.sessionId = id;
    this.sessionName = name;
  }

  /** Leaving the route: the widgets go and no session stays open. */
  leave(): void {
    this.teardown();
    this.sessionId = null;
  }

  render(): void {
    this.teardown();
    this.latches.release();
    const flash = this.spawnFlash;
    this.spawnFlash = null;
    this.root.innerHTML = `
    ${this.hooks.header()}
    <main class="session-view">
      ${flash === null ? "" : `<p class="flash-ok" role="status">${icon("check")}<span>${esc(flash)}</span></p>`}
      ${this.hooks.banner()}
      <div class="session-bar">
        <button type="button" id="session-back" aria-label="Back to sessions">${icon("chevronLeft")}</button>
        <span class="session-title">${esc(this.sessionName)}</span>
        <span class="session-exit" id="session-exit" hidden></span>
        <button type="button" id="session-close" aria-label="Close session">${icon("x")}</button>
        <button type="button" id="session-files" hidden>
          <span class="icon-slot" id="session-files-icon" data-morph="shelf" aria-hidden="true">${icon("folder")}</span>
          <span>Files</span><span
          class="files-badge" id="session-files-badge" hidden
        ></span></button>
      </div>
      <div class="term-stage">
        <div class="term-pane" id="term-pane">
          <p class="term-placeholder">Attaching…</p>
        </div>${termLatestHtml()}${termCopyFloatHtml()}
      </div>
      ${termControlsHtml()}
      <div class="upload-tray" id="upload-tray" hidden></div>
      <div class="keybar" id="keybar"></div>
      ${RESIZE_ENABLED ? termSizeHtml(this.sessionId, this.terminalView?.ownedSize()?.cols ?? null) : ""}
    </main>
    ${REMOTE_FOOTER}`;
    this.hooks.wireBanner();
    // A tap on any control button is not typing either: it drops an idle
    // focus so the phone keyboard stays closed. One delegated listener
    // covers the whole session view and goes with teardown.
    const onControlClick = (ev: Event): void => {
      const target = ev.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest(".term-controls button, #term-latest, #term-copy-float") === null) {
        return;
      }
      const view = this.terminalView;
      if (view) {
        dropIdleFocus(view);
      }
    };
    this.root.addEventListener("click", onControlClick);
    this.dropFocusDispose = () => this.root.removeEventListener("click", onControlClick);
    const filesIcon = this.root.querySelector<HTMLElement>("#session-files-icon");
    if (filesIcon) {
      this.shelfIcon = mountMorphSlot(filesIcon, "folder");
    }
    this.root.querySelector("#session-back")?.addEventListener("click", () => this.callbacks.onLeaveSession());
    this.root.querySelector("#session-close")?.addEventListener("click", () => this.onCloseTap());
    // The Files sheet only exists behind hello.features "shelf"; the
    // button itself is rendered hidden and syncFilesBadge reveals it.
    this.root.querySelector("#session-files")?.addEventListener("click", () => {
      this.shelf?.open(this.root);
    });
    this.syncFilesBadge();
    const controls = wireTermControls({
      root: this.root,
      sessionId: () => this.sessionId,
      terminalView: () => this.terminalView,
      onControlSize: (cols, rows) => this.callbacks.onControlSize(cols, rows),
      onReleaseSize: () => this.callbacks.onReleaseSize(),
      onLocalSize: (cols, rows) => this.resizeLocalTerminal(cols, rows),
      onBuilder: () => this.openBuilder(),
      onCopy: () => this.openCopy(),
    });
    this.termControls = controls;
    this.latestButton = controls.latestButton;
    // In fullscreen the latest button follows the pane's own scroll (see
    // latestHidden); the pane outlives terminal remounts on this route.
    this.root.querySelector("#term-pane")?.addEventListener("scroll", () => this.syncLatest(), { passive: true });
    this.uploadView = this.shelf
      ? mountUploads({
          root: this.root,
          shelf: this.shelf,
          sessionId: () => this.sessionId,
          typeText: (text) => this.callbacks.onKeyPress(new TextEncoder().encode(text)),
        })
      : null;
    const bar = this.root.querySelector<HTMLElement>("#keybar");
    if (bar) {
      renderKeyBar(bar, (def) => {
        // A latch toggles and shows pressed; a second tap releases it
        // without sending. Arming also focuses the terminal, in the same
        // tap, so the phone keyboard opens. Any other key goes out with
        // the latch applied, then the latch releases.
        if (def.id === "ctrl") {
          const armed = this.latches.toggleCtrl();
          updateKeyBarLatches(bar, this.latches.snapshot());
          if (armed) {
            this.focusTerminalForLatch();
          }
          return;
        }
        if (def.id === "shift") {
          const armed = this.latches.toggleShift();
          updateKeyBarLatches(bar, this.latches.snapshot());
          if (armed) {
            this.focusTerminalForLatch();
          }
          return;
        }
        const bytes = keyBytesWithModifiers(def.id, this.latches.snapshot());
        this.latches.release();
        updateKeyBarLatches(bar, this.latches.snapshot());
        const view = this.terminalView;
        if (view) {
          dropIdleFocus(view);
        }
        this.callbacks.onKeyPress(bytes);
      });
    }
    // The phone keyboard pins the session view to the visual viewport:
    // the terminal and the key bar stay above it while it is open.
    const main = this.root.querySelector<HTMLElement>("main.session-view");
    const pane = this.root.querySelector<HTMLElement>("#term-pane");
    this.keyboardDispose = main !== null && pane !== null ? followKeyboard(main, pane) : null;
  }

  teardown(): void {
    if (this.closeTimer !== null) {
      globalThis.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.killReq = null;
    this.keyboardDispose?.();
    this.keyboardDispose = null;
    this.termControls?.dispose();
    this.termControls = null;
    this.dropFocusDispose?.();
    this.dropFocusDispose = null;
    this.copyFloatDispose?.();
    this.copyFloatDispose = null;
    this.terminalView?.dispose();
    this.terminalView = null;
    this.latestButton = null;
    this.uploadView = null;
    this.shelfIcon?.destroy();
    this.shelfIcon = null;
    this.sessionCols = 0;
    this.sessionRows = 0;
  }

  dispose(): void {
    this.teardown();
  }

  openBuilder(): void {
    if (this.hooks.route() !== "session") {
      return;
    }
    this.hooks.openBuilder();
  }

  ensureTerminal(id: string, cols: number, rows: number): void {
    if (this.hooks.route() !== "session" || id !== this.sessionId) {
      return;
    }
    if (this.terminalView && cols === this.sessionCols && rows === this.sessionRows) {
      return;
    }
    this.teardownTerminal();
    const pane = this.root.querySelector<HTMLElement>("#term-pane");
    if (!pane) {
      return;
    }
    pane.replaceChildren();
    this.sessionCols = cols;
    this.sessionRows = rows;
    const view = new TerminalView(this.terminalFactory, {
      // Phone-keyboard keys honour the latches too: Ctrl+c sends 0x03,
      // then the latch releases and the bar shows it. xterm's own
      // reports (focus, cursor position, device attributes, mouse)
      // are not typing: they go out unchanged, leaving the latch
      // armed and the bar untouched — otherwise the focus-in report
      // from tapping the terminal would spend the latch first.
      onUserInput: (text) => {
        if (isTerminalReport(text)) {
          this.callbacks.onTerminalInput(new TextEncoder().encode(text));
          return;
        }
        const bytes = textBytesWithModifiers(text, this.latches.snapshot());
        if (this.latches.hasLatch) {
          this.latches.release();
          const bar = this.root.querySelector<HTMLElement>("#keybar");
          if (bar) {
            updateKeyBarLatches(bar, this.latches.snapshot());
          }
        }
        this.callbacks.onTerminalInput(bytes);
      },
      onFollowChange: () => this.syncLatest(),
      // A zoom changes how many cells fit: the size owner re-asserts.
      onZoomChange: () => this.termControls?.schedule(),
    });
    this.terminalView = view;
    view.mount(pane, cols, rows);
    // The selection float follows this mount: a remount rewires it.
    this.copyFloatDispose?.();
    this.copyFloatDispose = null;
    const floatButton = this.root.querySelector<HTMLButtonElement>("#term-copy-float");
    if (floatButton) {
      this.copyFloatDispose = wireCopyFloat(floatButton, view);
    }
    // A fine pointer types straight into the session: focus once on
    // attach, after xterm is open. A touch device never auto-opens its
    // keyboard — the first tap on the pane focuses instead.
    if (pointerIsFine()) {
      void view.ready().then(() => {
        if (this.terminalView === view) {
          view.focus();
        }
      });
    }
    // A remembered control-size toggle re-asserts on every (re)mount —
    // the size that fits this panel, never the snapshot's — so a
    // reconnected session keeps the size this device asked for. Skipped
    // while the resize is disabled: without the row nothing may assert.
    if (RESIZE_ENABLED) {
      this.termControls?.reassert();
    }
  }

  sessionResized(id: string, cols: number, rows: number): void {
    if (this.hooks.route() !== "session" || id !== this.sessionId) {
      return;
    }
    // The controls decide: a follower resizes in place and refits, an
    // owner that was overridden lets go first.
    if (this.termControls) {
      this.termControls.handleResized(cols, rows);
    } else {
      this.resizeLocalTerminal(cols, rows);
    }
  }

  writeTerminal(data: Uint8Array): void {
    this.terminalView?.write(data);
  }

  clearTerminal(): void {
    this.terminalView?.clear();
  }

  showSessionExited(code: number): void {
    this.exitText(`exited (${code})`);
  }

  // The Close button's two taps: the first arms the "Close?" confirm for
  // four seconds, the second sends kill{req,id} and holds the button
  // disabled until the host answers or the session leaves. A send that
  // never left re-arms with "Not connected".
  private onCloseTap(): void {
    const button = this.root.querySelector<HTMLButtonElement>("#session-close");
    if (button === null || button.disabled) {
      return;
    }
    if (this.closeTimer === null) {
      this.armClose();
      return;
    }
    globalThis.clearTimeout(this.closeTimer);
    this.closeTimer = null;
    button.disabled = true;
    const req = newReqId();
    // Set before the send: a fast host answers ok/exited/session_removed
    // or the error synchronously, and the reply must find its req.
    this.killReq = req;
    if (this.callbacks.onKill(req)) {
      return;
    }
    this.killReq = null;
    this.exitText("Not connected");
    this.armClose();
  }

  private armClose(): void {
    const button = this.root.querySelector<HTMLButtonElement>("#session-close");
    if (button === null) {
      return;
    }
    button.disabled = false;
    button.classList.add("confirm");
    button.innerHTML = `${icon("x")}<span>Close?</span>`;
    this.closeTimer = globalThis.setTimeout(() => this.disarmClose(), 4000);
  }

  private disarmClose(): void {
    if (this.closeTimer !== null) {
      globalThis.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const button = this.root.querySelector<HTMLButtonElement>("#session-close");
    if (button === null) {
      return;
    }
    button.classList.remove("confirm");
    button.innerHTML = icon("x");
    button.disabled = false;
  }

  /**
   * An error frame matching the pending kill's req: the button re-arms
   * and the host's message lands on the exit badge. True when consumed.
   */
  killError(req: string | null, message: string): boolean {
    if (this.killReq === null || req !== this.killReq) {
      return false;
    }
    this.killReq = null;
    this.disarmClose();
    this.exitText(message);
    return true;
  }

  /** This device sent the kill whose session_removed just arrived. */
  wasKillPending(): boolean {
    const pending = this.killReq !== null;
    this.killReq = null;
    return pending;
  }

  private exitText(text: string): void {
    const badge = this.root.querySelector<HTMLElement>("#session-exit");
    if (badge) {
      badge.textContent = text;
      badge.hidden = false;
    }
  }

  /** The one-shot spawn confirmation for the next render. */
  setSpawnFlash(text: string): void {
    this.spawnFlash = text;
  }

  /** The store changed while the session shows: converge its name. */
  storeUpdated(store: SessionStore): void {
    if (this.sessionId !== null) {
      this.sessionName = convergeOpenSessionName(this.root, store, this.sessionId, this.sessionName);
    }
  }

  /** The shelf changed while the session shows: badge and tray repaint. */
  shelfUpdated(): void {
    this.syncFilesBadge();
    this.uploadView?.render();
  }

  private openCopy(): void {
    if (this.hooks.route() !== "session") {
      return;
    }
    this.hooks.openCopy((maxLines) => this.terminalView?.bufferText(maxLines) ?? "");
  }

  // The Files badge lives in the session bar; every shelf change either
  // patches it (session route) or repaints the list (sessions route). The
  // folder icon opens while the sheet is up and closes when it goes.
  private syncFilesBadge(): void {
    const button = this.root.querySelector<HTMLElement>("#session-files");
    if (!button) {
      return;
    }
    const enabled = this.shelf?.enabled() ?? false;
    button.hidden = !enabled;
    // A morph says the meaning changed; a repaint that leaves the sheet as
    // it was must not restart it.
    const next: RemoteIconName = (this.shelf?.isOpen() ?? false) ? "folderOpen" : "folder";
    if (this.shelfIcon !== null && this.shelfIcon.name !== next) {
      this.shelfIcon.to(next);
    }
    const badge = button.querySelector<HTMLElement>("#session-files-badge");
    if (!badge) {
      return;
    }
    const unseen = !enabled ? 0 : (this.shelf?.unseenTotal() ?? 0);
    badge.hidden = unseen === 0;
    badge.textContent = unseen === 0 ? "" : String(unseen);
  }

  // The local terminal takes a new grid in place (no remount, the
  // scrollback stays), and the route remembers it so a snapshot at that
  // size later does not remount either.
  private resizeLocalTerminal(cols: number, rows: number): void {
    if (!this.terminalView) {
      return;
    }
    if (this.terminalView.resize(cols, rows)) {
      this.sessionCols = cols;
      this.sessionRows = rows;
    }
  }

  // Arming a latch focuses the terminal in the same tap: a phone only
  // opens its keyboard inside the user gesture. A terminal still behind
  // the font gate focuses once it opens, as a pane tap does; releasing a
  // latch never touches focus. Harmless with a mouse too.
  private focusTerminalForLatch(): void {
    const view = this.terminalView;
    if (!view) {
      return;
    }
    if (view.fitted) {
      openPhoneKeyboard(view);
      return;
    }
    void view.ready().then(() => {
      if (this.terminalView === view) {
        openPhoneKeyboard(view);
      }
    });
  }

  private syncLatest(): void {
    if (!this.latestButton) {
      return;
    }
    const pane = this.root.querySelector<HTMLElement>("#term-pane");
    this.latestButton.hidden = latestHidden(
      this.terminalView?.isFollowing ?? true,
      this.terminalView?.isAlternate ?? false,
      pane?.scrollTop ?? 0,
    );
  }

  // Remounting the terminal (a changed host size) drops the view only;
  // the rest of the session route stays painted around it.
  private teardownTerminal(): void {
    this.terminalView?.dispose();
    this.terminalView = null;
    this.sessionCols = 0;
    this.sessionRows = 0;
    if (this.latestButton) {
      this.latestButton.hidden = true;
    }
  }
}
