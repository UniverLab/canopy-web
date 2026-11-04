// SPDX-License-Identifier: Apache-2.0
// Test-only upload responder behind fake.html (served by vite dev, never
// built): the daemon's shelf_put half — begin/part/end/abort over the
// session wire, stored on the target shelf with the mime the host sniffs.
// ?upload=off advertises no shelf_upload, ?upload=denied refuses every
// begin with forbidden. Split out of fake-host.ts, which sits at the
// gate's size limit.

import { b64decode, sha256Hex } from "./crypto.js";
import type { FakeShelfFile } from "./fake-delete.js";
import type { SessionItem, ShelfItem } from "./protocol.js";
import { MAX_UPLOAD_BYTES } from "./upload.js";

interface FakeUploadDeps {
  deliver: (frame: unknown) => void;
  files: FakeShelfFile[];
  sessions: SessionItem[];
}

interface UploadFrame {
  t: string;
  req?: string;
  name?: string;
  size?: number;
  sha256?: string;
  mime?: string;
  id?: string;
  part?: number;
  data?: string;
  file_id?: string;
}

interface FakeUpload {
  fileId: string;
  sessionId: string | null;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  parts: Map<number, Uint8Array>;
}

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
};

const sniffMime = (name: string, provided: string | undefined): string => {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? (provided !== undefined && provided !== "" ? provided : "application/octet-stream");
};

export function createFakeUploads(deps: FakeUploadDeps): {
  handle: (frame: UploadFrame) => boolean;
} {
  const uploadMode = new URLSearchParams(globalThis.location.search).get("upload");
  const uploads = new Map<string, FakeUpload>();
  let uploadCounter = 0;

  const finishUpload = async (upload: FakeUpload): Promise<void> => {
    const ordered = [...upload.parts.entries()].sort((a, b) => a[0] - b[0]);
    const total = ordered.reduce((sum, [, bytes]) => sum + bytes.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const [, part] of ordered) {
      bytes.set(part, offset);
      offset += part.length;
    }
    if ((await sha256Hex(bytes)) !== upload.sha256) {
      uploads.delete(upload.fileId);
      deps.deliver({ t: "error", code: "checksum_mismatch", message: "checksum mismatch", file_id: upload.fileId });
      return;
    }
    uploads.delete(upload.fileId);
    const workdir = deps.sessions.find((item) => item.id === upload.sessionId)?.workdir ?? "/home/u/demo";
    const item: ShelfItem = {
      file_id: upload.fileId,
      session_id: upload.sessionId,
      name: upload.name,
      mime: upload.mime,
      size: bytes.length,
      caption: null,
      from: "you",
      created_at: Date.now(),
      path: `${workdir}/${upload.name}`,
      origin: "device",
    };
    deps.files.push({ item, bytes });
    deps.deliver({ t: "shelf_added", item });
  };

  return {
    handle(frame: UploadFrame): boolean {
    if (frame.t === "shelf_put_begin" && typeof frame.req === "string") {
      if (uploadMode === "denied") {
        deps.deliver({ t: "error", req: frame.req, code: "forbidden", message: "upload not allowed" });
      } else if (
        typeof frame.name !== "string" ||
        frame.name === "" ||
        typeof frame.size !== "number" ||
        typeof frame.sha256 !== "string"
      ) {
        deps.deliver({ t: "error", req: frame.req, code: "bad_request", message: "bad upload" });
      } else if (frame.size > MAX_UPLOAD_BYTES) {
        deps.deliver({ t: "error", req: frame.req, code: "too_large", message: "file is larger than 20 MiB" });
      } else {
        uploadCounter += 1;
        const fileId = `u${uploadCounter}`;
        uploads.set(fileId, {
          fileId,
          sessionId: typeof frame.id === "string" && frame.id !== "" ? frame.id : null,
          name: frame.name,
          size: frame.size,
          mime: sniffMime(frame.name, frame.mime),
          sha256: frame.sha256,
          parts: new Map(),
        });
        deps.deliver({ t: "shelf_put_ready", req: frame.req, file_id: fileId });
      }
    } else if (frame.t === "shelf_put_part" && typeof frame.file_id === "string") {
      const upload = uploads.get(frame.file_id);
      if (!upload || typeof frame.part !== "number" || typeof frame.data !== "string") {
        deps.deliver({ t: "error", code: "bad_request", message: "bad part", file_id: frame.file_id });
      } else {
        upload.parts.set(frame.part, b64decode(frame.data));
        if ((frame.part + 1) % 8 === 0) {
          deps.deliver({ t: "shelf_put_ack", file_id: frame.file_id, part: frame.part });
        }
      }
    } else if (frame.t === "shelf_put_end" && typeof frame.file_id === "string") {
      const upload = uploads.get(frame.file_id);
      if (upload) {
        void finishUpload(upload);
      } else {
        deps.deliver({ t: "error", code: "not_found", message: "no such upload", file_id: frame.file_id });
      }
    } else if (frame.t === "shelf_put_abort" && typeof frame.file_id === "string") {
      uploads.delete(frame.file_id);
    } else {
        return false;
      }
      return true;
    },
  };
}
