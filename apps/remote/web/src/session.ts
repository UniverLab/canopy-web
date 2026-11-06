// SPDX-License-Identifier: Apache-2.0
// The open session: attach on open, detach on leave, and the terminal
// feed. The snapshot redraws the terminal and sets the sequence floor;
// only out frames with a greater seq are applied, so a reconnect's fresh
// snapshot never duplicates output. Out frames that arrive before the
// snapshot wait in a bounded buffer instead of racing it.

import type { JoinedSnapshot } from "./channel.js";
import {
  buildAttach,
  buildDetach,
  buildInput,
  buildInputText,
  buildKill,
  buildPromptDraft,
  buildPromptSchedule,
  buildResize,
  buildResizeRelease,
  buildScheduledCancel,
  buildScheduledList,
} from "./protocol.js";
import type { OutFrame, PromptDraft } from "./protocol.js";

export interface SessionTerminal {
  write: (data: Uint8Array) => void;
  clear: () => void;
}

export interface SessionCallbacks {
  send: (data: string) => boolean;
  terminal: () => SessionTerminal | null;
  onExited?: (id: string, code: number) => void;
}

const MAX_PENDING_OUT = 200;

export class SessionController {
  private readonly callbacks: SessionCallbacks;
  private openId: string | null = null;
  private lastSeq = -1;
  private snapshotSeen = false;
  private pending: OutFrame[] = [];

  constructor(callbacks: SessionCallbacks) {
    this.callbacks = callbacks;
  }

  get sessionId(): string | null {
    return this.openId;
  }

  open(id: string): void {
    if (this.openId !== null && this.openId !== id) {
      this.callbacks.send(buildDetach(this.openId));
    }
    this.openId = id;
    this.lastSeq = -1;
    this.snapshotSeen = false;
    this.pending = [];
    this.callbacks.send(buildAttach(id));
  }

  // After a reconnect the same attach runs again; the fresh snapshot
  // redraws the terminal and its seq drops every stale out frame.
  reattach(): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildAttach(this.openId));
  }

  close(): void {
    if (this.openId !== null) {
      this.callbacks.send(buildDetach(this.openId));
    }
    this.openId = null;
    this.lastSeq = -1;
    this.snapshotSeen = false;
    this.pending = [];
  }

  sendInputText(text: string): boolean {
    if (this.openId === null || text === "") {
      return false;
    }
    return this.callbacks.send(buildInputText(this.openId, text));
  }

  sendInputBytes(bytes: Uint8Array): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildInput(this.openId, bytes));
  }

  // The Prompt Builder path: the host composes the final text from the
  // draft, so the browser never reimplements canopy's prompt rules.
  sendPromptDraft(draft: PromptDraft, req: string): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildPromptDraft(req, this.openId, draft));
  }

  // The Builder's scheduling path: the same draft, delivered at fireAt.
  sendPromptSchedule(draft: PromptDraft, fireAt: string, req: string): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildPromptSchedule(req, this.openId, draft, fireAt));
  }

  sendScheduledList(req: string): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildScheduledList(req, this.openId));
  }

  sendScheduledCancel(scheduleId: string, req: string): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildScheduledCancel(req, this.openId, scheduleId));
  }

  // The control-size path: the device asserts its PTY size for the open
  // session. Only the toggle calls this, and only while it is on.
  sendResize(cols: number, rows: number): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildResize(this.openId, cols, rows));
  }

  // The session view's Close: the host ends the session itself, so every
  // attached device sees exited and session_removed. False with no open
  // session or no channel — the caller shows "Not connected".
  kill(req: string): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildKill(req, this.openId));
  }

  // The control-size toggle turning off: give the size back so the host's
  // own TUI re-asserts its size at once. Takeovers and teardown stay
  // silent: only the user's own toggle calls this.
  releaseSize(): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildResizeRelease(this.openId));
  }

  handleSnapshot(snapshot: JoinedSnapshot): void {
    if (this.openId === null || snapshot.id !== this.openId) {
      return;
    }
    const terminal = this.callbacks.terminal();
    if (!terminal) {
      return;
    }
    // The channel already decoded the parts: bytes written as they came.
    terminal.clear();
    this.lastSeq = snapshot.seq;
    this.snapshotSeen = true;
    terminal.write(snapshot.data);
    this.drainPending(terminal);
  }

  handleOut(frame: OutFrame): void {
    if (this.openId === null || frame.id !== this.openId) {
      return;
    }
    if (!this.snapshotSeen) {
      this.pending.push(frame);
      if (this.pending.length > MAX_PENDING_OUT) {
        this.pending.splice(0, this.pending.length - MAX_PENDING_OUT);
      }
      return;
    }
    if (frame.seq <= this.lastSeq) {
      return;
    }
    this.callbacks.terminal()?.write(frame.data);
    this.lastSeq = frame.seq;
  }

  handleExited(id: string, code: number): void {
    if (this.openId === null || id !== this.openId) {
      return;
    }
    this.callbacks.onExited?.(id, code);
  }

  private drainPending(terminal: SessionTerminal): void {
    const frames = this.pending
      .filter((frame) => frame.seq > this.lastSeq)
      .sort((a, b) => a.seq - b.seq);
    this.pending = [];
    for (const frame of frames) {
      terminal.write(frame.data);
      this.lastSeq = frame.seq;
    }
  }
}
