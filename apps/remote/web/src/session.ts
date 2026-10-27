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
  buildPrompt,
  decodeSnapshotData,
  decodeUtf8,
} from "./protocol.js";
import type { OutFrame } from "./protocol.js";

export interface SessionTerminal {
  write: (text: string) => void;
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

  sendPrompt(text: string, req: string): boolean {
    if (this.openId === null) {
      return false;
    }
    return this.callbacks.send(buildPrompt(req, this.openId, text));
  }

  handleSnapshot(snapshot: JoinedSnapshot): void {
    if (this.openId === null || snapshot.id !== this.openId) {
      return;
    }
    const terminal = this.callbacks.terminal();
    if (!terminal) {
      return;
    }
    const bytes = decodeSnapshotData(snapshot.data);
    if (!bytes) {
      return;
    }
    terminal.clear();
    this.lastSeq = snapshot.seq;
    this.snapshotSeen = true;
    terminal.write(decodeUtf8(bytes));
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
    this.callbacks.terminal()?.write(decodeUtf8(frame.data));
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
      terminal.write(decodeUtf8(frame.data));
      this.lastSeq = frame.seq;
    }
  }
}
