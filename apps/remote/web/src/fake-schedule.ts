// SPDX-License-Identifier: Apache-2.0
// Test-only prompt scheduling behind fake.html (served by vite dev, never
// built): prompt_schedule stores a draft and answers scheduled{item},
// scheduled_list answers the session's pending rows fire_at ascending,
// and scheduled_cancel drops one or answers not_found. The preview is the
// composed text's first 120 chars, like the real host's. Split out of
// fake-host.ts, which sits at the gate's size limit.

import type { PromptDraft } from "./protocol.js";

interface FakeScheduleFrame {
  t: string;
  req?: string;
  id?: string;
  draft?: PromptDraft;
  fire_at?: string;
  schedule_id?: string;
}

interface FakeSchedulerDeps {
  deliver: (frame: unknown) => void;
  compose: (draft: PromptDraft) => string;
}

interface PendingSchedule {
  id: string;
  sessionId: string;
  fire_at: string;
  preview: string;
}

export function createFakeScheduler(deps: FakeSchedulerDeps): {
  handle: (frame: FakeScheduleFrame) => boolean;
} {
  const scheduled: PendingSchedule[] = [];
  let counter = 0;
  return {
    handle(frame: FakeScheduleFrame): boolean {
      if (
        frame.t === "prompt_schedule" &&
        typeof frame.req === "string" &&
        typeof frame.id === "string" &&
        typeof frame.fire_at === "string"
      ) {
        counter += 1;
        const item = {
          id: `ss-${counter}`,
          fire_at: frame.fire_at,
          preview: deps.compose(frame.draft ?? { sections: [], skills: [] }).slice(0, 120),
        };
        scheduled.push({ ...item, sessionId: frame.id });
        deps.deliver({ t: "scheduled", req: frame.req, item });
        return true;
      }
      if (frame.t === "scheduled_list" && typeof frame.req === "string" && typeof frame.id === "string") {
        const items = scheduled
          .filter((entry) => entry.sessionId === frame.id)
          .sort((a, b) => Date.parse(a.fire_at) - Date.parse(b.fire_at))
          .map((entry) => ({ id: entry.id, fire_at: entry.fire_at, preview: entry.preview }));
        deps.deliver({ t: "scheduled_list", req: frame.req, id: frame.id, items });
        return true;
      }
      if (
        frame.t === "scheduled_cancel" &&
        typeof frame.req === "string" &&
        typeof frame.id === "string" &&
        typeof frame.schedule_id === "string"
      ) {
        const index = scheduled.findIndex(
          (entry) => entry.sessionId === frame.id && entry.id === frame.schedule_id,
        );
        if (index < 0) {
          deps.deliver({ t: "error", req: frame.req, code: "not_found", message: "no such schedule" });
        } else {
          scheduled.splice(index, 1);
          deps.deliver({ t: "ok", req: frame.req });
        }
        return true;
      }
      return false;
    },
  };
}
