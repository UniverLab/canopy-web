// SPDX-License-Identifier: Apache-2.0
// Test-only resume half behind fake.html (served by vite dev, never built):
// resumable_list answers three recorded conversations newest first — one of
// them the folder's latest without a transcript — and session_resume brings
// one back with spawned{req,id} then session_added{item}, the way the real
// host hands a session to every device. ?resume=empty and ?resume=error
// drive the two states the New dialog must show. Split out of fake-host.ts,
// which sits at the gate's size limit.

import type { ResumableSession, SessionItem } from "./protocol.js";

interface FakeResumeFrame {
  t: string;
  req?: string;
  id?: string;
}

interface FakeResumeDeps {
  deliver: (frame: unknown) => void;
  sessions: SessionItem[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The host sends started_at in unix seconds, like last_output_at.
function toWireRow(row: ResumableSession): unknown {
  return {
    id: row.id,
    name: row.name,
    cli: row.cli,
    workdir: row.workdir,
    started_at: row.started_at === null ? null : Math.floor(row.started_at / 1000),
    has_conversation: row.has_conversation,
  };
}

function toWireSession(item: SessionItem): unknown {
  return {
    id: item.id,
    name: item.name,
    cli: item.cli,
    model: item.model,
    workdir: item.workdir,
    status: item.status,
    kind: item.kind,
    last_output_at: item.lastOutputAt === null ? null : Math.floor(item.lastOutputAt / 1000),
  };
}

export function createFakeResume(deps: FakeResumeDeps): {
  handle: (frame: FakeResumeFrame) => boolean;
  rows: () => ResumableSession[];
} {
  const mode = new URLSearchParams(globalThis.location.search).get("resume");
  const now = Date.now();
  const fixtures: ResumableSession[] = [
    {
      id: "past-muse",
      name: "refactor the parser",
      cli: "muse",
      workdir: "/home/u/demo",
      started_at: now - 2 * HOUR,
      has_conversation: true,
    },
    {
      id: "past-claude",
      name: "docs pass",
      cli: "claude",
      workdir: "/home/u/other",
      started_at: now - 26 * HOUR,
      has_conversation: true,
    },
    {
      id: "past-shell",
      name: "nightly build",
      cli: "muse",
      workdir: "/home/u/demo",
      started_at: now - 3 * DAY,
      has_conversation: false,
    },
  ];
  return {
    rows: () => [...fixtures],
    handle(frame: FakeResumeFrame): boolean {
      if (frame.t === "resumable_list") {
        const req = frame.req;
        if (mode === "error") {
          deps.deliver({ t: "error", req, code: "internal", message: "could not read the host's history" });
        } else {
          const sessions = mode === "empty" ? [] : fixtures.map(toWireRow);
          deps.deliver({ t: "resumable", req, sessions });
        }
        return true;
      }
      if (frame.t !== "session_resume") {
        return false;
      }
      const req = frame.req;
      const id = frame.id;
      const fixture = fixtures.find((row) => row.id === id);
      if (typeof id !== "string" || fixture === undefined) {
        deps.deliver({ t: "error", req, code: "not_found", message: "no such conversation" });
        return true;
      }
      deps.deliver({ t: "spawned", req, id });
      if (!deps.sessions.some((item) => item.id === id)) {
        const item: SessionItem = {
          id,
          name: fixture.name,
          cli: fixture.cli,
          model: "",
          workdir: fixture.workdir,
          status: "running",
          kind: "agent",
          lastOutputAt: null,
        };
        deps.sessions.push(item);
        deps.deliver({ t: "session_added", item: toWireSession(item) });
      }
      return true;
    },
  };
}
