// SPDX-License-Identifier: Apache-2.0
// Protocol v1 data-channel frames. Snapshot bodies arrive split across one
// `snapshot` frame plus `snapshot_more` chunks; they are joined into a single
// snapshot before delivery to the session layer. Every other frame passes
// through untouched.

export interface JoinedSnapshot {
  id: string;
  cols: number;
  rows: number;
  seq: number;
  data: string;
}

export interface ChannelHandlers {
  onSnapshot: (snapshot: JoinedSnapshot) => void;
  onFrame?: (frame: unknown) => void;
}

interface SnapshotHead {
  id: string;
  cols: number;
  rows: number;
  seq: number;
  data: string;
}

function asSnapshotHead(frame: unknown): SnapshotHead | null {
  if (typeof frame !== "object" || frame === null) {
    return null;
  }
  const row = frame as Record<string, unknown>;
  if (row.t !== "snapshot") {
    return null;
  }
  if (
    typeof row.id !== "string" ||
    typeof row.cols !== "number" ||
    typeof row.rows !== "number" ||
    typeof row.seq !== "number" ||
    typeof row.data !== "string"
  ) {
    return null;
  }
  return { id: row.id, cols: row.cols, rows: row.rows, seq: row.seq, data: row.data };
}

interface SnapshotChunk {
  id: string;
  data: string;
  last: boolean;
}

function asSnapshotChunk(frame: unknown): SnapshotChunk | null {
  if (typeof frame !== "object" || frame === null) {
    return null;
  }
  const row = frame as Record<string, unknown>;
  if (row.t !== "snapshot_more") {
    return null;
  }
  if (typeof row.id !== "string" || typeof row.data !== "string" || typeof row.last !== "boolean") {
    return null;
  }
  return { id: row.id, data: row.data, last: row.last };
}

export interface ChannelAssembler {
  push: (raw: string) => void;
}

export function createChannelHandler(handlers: ChannelHandlers): ChannelAssembler {
  let pending: (SnapshotHead & { parts: string[] }) | null = null;

  const flush = () => {
    if (!pending) {
      return;
    }
    const done: JoinedSnapshot = {
      id: pending.id,
      cols: pending.cols,
      rows: pending.rows,
      seq: pending.seq,
      data: pending.parts.join(""),
    };
    pending = null;
    handlers.onSnapshot(done);
  };

  return {
    push(raw: string): void {
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      const head = asSnapshotHead(frame);
      if (head) {
        // A fresh snapshot supersedes any partial one.
        pending = { ...head, parts: [head.data] };
        return;
      }
      const chunk = asSnapshotChunk(frame);
      if (chunk) {
        if (pending && pending.id === chunk.id) {
          pending.parts.push(chunk.data);
          if (chunk.last) {
            flush();
          }
        }
        return;
      }
      handlers.onFrame?.(frame);
    },
  };
}
