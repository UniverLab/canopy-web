// SPDX-License-Identifier: Apache-2.0
// Test-only shelf_delete responder behind fake.html (served by vite dev,
// never built): the daemon's delete half — ok plus the removed broadcast
// to every connection including the requester, not_found for unknown ids,
// internal on failure. ?delete=internal makes every delete fail, the way
// ?upload=denied refuses every upload. Split out of fake-host.ts, which
// sits at the gate's size limit.

import type { ShelfItem } from "./protocol.js";

export interface FakeShelfFile {
  item: ShelfItem;
  bytes: Uint8Array;
}

interface FakeDeleterDeps {
  deliver: (frame: unknown) => void;
  files: FakeShelfFile[];
}

interface DeleteFrame {
  t: string;
  req?: string;
  file_id?: string;
}

export function createFakeShelfDeleter(deps: FakeDeleterDeps): {
  handle: (frame: DeleteFrame) => boolean;
} {
  const failAll =
    new URLSearchParams(globalThis.location.search).get("delete") === "internal";
  return {
    handle(frame: DeleteFrame): boolean {
      if (frame.t !== "shelf_delete") {
        return false;
      }
      const req = frame.req;
      const fileId = frame.file_id;
      if (typeof req !== "string" || typeof fileId !== "string" || fileId === "") {
        deps.deliver({ t: "error", req, code: "bad_request", message: "bad delete" });
        return true;
      }
      const index = deps.files.findIndex((row) => row.item.file_id === fileId);
      if (index < 0) {
        deps.deliver({ t: "error", req, code: "not_found", message: `no shelf file '${fileId}'` });
        return true;
      }
      if (failAll) {
        deps.deliver({ t: "error", req, code: "internal", message: "delete failed" });
        return true;
      }
      deps.files.splice(index, 1);
      deps.deliver({ t: "ok", req });
      deps.deliver({ t: "shelf_removed", file_id: fileId });
      return true;
    },
  };
}
