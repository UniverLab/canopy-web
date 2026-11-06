// SPDX-License-Identifier: Apache-2.0
// Test-only kill{req,id} responder behind fake.html (served by vite dev,
// never built): the real host's kill — ok{req} or error{req,code,message},
// then exited and session_removed to every connection. A frame with no
// req is a bad_request, an unknown id is not_found, and failNext arms a
// one-shot error the way failNextPrompt does for prompt. Split out of
// fake-host.ts, which sits at the gate's size limit.

import type { SessionItem } from "./protocol.js";

interface FakeKillFrame {
  t: string;
  req?: string;
  id?: string;
}

interface FakeKillerDeps {
  deliver: (frame: unknown) => void;
  sessions: SessionItem[];
  ptySizes: Map<string, { cols: number; rows: number }>;
  prevSizes: Map<string, { cols: number; rows: number }>;
}

export function createFakeKiller(deps: FakeKillerDeps): {
  handle: (frame: FakeKillFrame) => boolean;
  failNext: (code: string, message: string) => void;
} {
  let failure: { code: string; message: string } | null = null;
  return {
    failNext(code: string, message: string): void {
      failure = { code, message };
    },
    handle(frame: FakeKillFrame): boolean {
      if (frame.t !== "kill") {
        return false;
      }
      const req = frame.req;
      if (typeof req !== "string" || req === "") {
        deps.deliver({ t: "error", code: "bad_request", message: "kill needs a req" });
        return true;
      }
      if (failure !== null) {
        const armed = failure;
        failure = null;
        deps.deliver({ t: "error", req, code: armed.code, message: armed.message });
        return true;
      }
      const id = frame.id;
      const index = typeof id === "string" ? deps.sessions.findIndex((item) => item.id === id) : -1;
      if (typeof id !== "string" || index < 0) {
        deps.deliver({ t: "error", req, code: "not_found", message: "no such session" });
        return true;
      }
      deps.sessions.splice(index, 1);
      deps.ptySizes.delete(id);
      deps.prevSizes.delete(id);
      deps.deliver({ t: "ok", req });
      deps.deliver({ t: "exited", id, code: 0 });
      deps.deliver({ t: "session_removed", id });
      return true;
    },
  };
}
