// SPDX-License-Identifier: Apache-2.0
// Protocol v1 data-channel frames. Snapshot bodies arrive split across one
// `snapshot` frame plus `snapshot_more` chunks; each part carries its own
// base64 so its own `=` padding, so the parts are decoded one by one and
// joined as bytes before delivery to the session layer. Every other frame
// passes through untouched.

import { b64decode } from "./crypto.js";

export interface JoinedSnapshot {
  id: string;
  cols: number;
  rows: number;
  seq: number;
  data: Uint8Array;
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

  // The host base64-encodes each part on its own, so every part may end in
  // `=` padding; joining the strings would put that padding in the middle,
  // where `atob` throws. Decode one by one and concatenate the bytes, and
  // drop a part that cannot decode so one bad frame never blanks the view.
  const joinParts = (parts: string[]): Uint8Array => {
    const chunks: Uint8Array[] = [];
    for (const part of parts) {
      try {
        chunks.push(b64decode(part));
      } catch {
        // An undecodable part paints as absent; the rest still reaches
        // the terminal.
      }
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return joined;
  };

  const flush = () => {
    if (!pending) {
      return;
    }
    const done: JoinedSnapshot = {
      id: pending.id,
      cols: pending.cols,
      rows: pending.rows,
      seq: pending.seq,
      data: joinParts(pending.parts),
    };
    pending = null;
    // Always delivered, even when nothing survived decoding: the session
    // layer needs the snapshot beat so the live output after it flows.
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
      // Output for the pending snapshot's session means the host moved
      // on: a snapshot whose closing part never came is drawn as it stands
      // rather than leaving the view on "Attaching…".
      const row = typeof frame === "object" && frame !== null ? (frame as Record<string, unknown>) : null;
      if (pending && row?.t === "out" && row.id === pending.id) {
        flush();
      }
      handlers.onFrame?.(frame);
    },
  };
}
