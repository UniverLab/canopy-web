// SPDX-License-Identifier: Apache-2.0
// Directory browsing for the New dialog: dir_list{req,path?} asks the host
// for one folder's children, and dir_list{req,path,parent,dirs,truncated}
// answers. Kept out of protocol.ts, which sits at the file-size gate.

export interface DirEntry {
  name: string;
}

export interface DirList {
  req: string;
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  truncated: boolean;
}

function isRecord(frame: unknown): frame is Record<string, unknown> {
  return typeof frame === "object" && frame !== null;
}

export function buildDirList(req: string, path?: string): string {
  const frame: Record<string, unknown> = { t: "dir_list", req };
  if (path !== undefined) {
    frame.path = path;
  }
  return JSON.stringify(frame);
}

// The reply is strict about the folder it names: req and path must be
// non-empty, parent is null at the root or a non-empty path, and dirs is an
// array whose malformed entries are dropped like a catalog frame's.
export function parseDirList(frame: unknown): DirList | null {
  if (!isRecord(frame) || frame.t !== "dir_list") {
    return null;
  }
  if (typeof frame.req !== "string" || frame.req === "") {
    return null;
  }
  if (typeof frame.path !== "string" || frame.path === "") {
    return null;
  }
  if (frame.parent !== null && (typeof frame.parent !== "string" || frame.parent === "")) {
    return null;
  }
  if (!Array.isArray(frame.dirs)) {
    return null;
  }
  const dirs: DirEntry[] = [];
  for (const item of frame.dirs) {
    if (isRecord(item) && typeof item.name === "string" && item.name !== "") {
      dirs.push({ name: item.name });
    }
  }
  return {
    req: frame.req,
    path: frame.path,
    parent: frame.parent,
    dirs,
    truncated: frame.truncated === true,
  };
}
