// SPDX-License-Identifier: Apache-2.0
// Test-only directory fixture behind fake.html (served by vite dev, never
// built): a small host tree for dir_list, including a hidden folder, a
// forbidden folder and a truncated listing. Split out of fake-host.ts,
// which sits at the gate's size limit.

interface FakeDirFrame {
  t: string;
  req?: unknown;
  path?: unknown;
}

interface FakeDirsDeps {
  deliver: (frame: unknown) => void;
}

const HOME = "/home/u";
const MANY_COUNT = 500;

const TREE: Record<string, string[]> = {
  "/": ["home"],
  "/home": ["u"],
  [HOME]: ["demo", "other", "locked", "many", ".config"],
  "/home/u/demo": ["src", "docs"],
  "/home/u/other": [],
};

const MANY_DIRS = Array.from({ length: MANY_COUNT }, (_, index) => `folder-${String(index).padStart(3, "0")}`);

function normalizePath(path: unknown): string | null {
  if (path === undefined) {
    return HOME;
  }
  if (typeof path !== "string" || path === "") {
    return null;
  }
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function parentOf(path: string): string | null {
  if (path === "/") {
    return null;
  }
  const slash = path.lastIndexOf("/");
  if (slash <= 0) {
    return "/";
  }
  return path.slice(0, slash);
}

export function createFakeDirs(deps: FakeDirsDeps): {
  handle: (frame: FakeDirFrame) => boolean;
} {
  return {
    handle(frame: FakeDirFrame): boolean {
      if (frame.t !== "dir_list") {
        return false;
      }
      const req = frame.req;
      if (typeof req !== "string" || req === "") {
        deps.deliver({ t: "error", code: "bad_request", message: "frame needs a req" });
        return true;
      }
      const path = normalizePath(frame.path);
      if (path === null) {
        deps.deliver({ t: "error", req, code: "bad_request", message: "path must be a string" });
        return true;
      }
      if (path === "/home/u/locked") {
        deps.deliver({ t: "error", req, code: "forbidden", message: "permission denied" });
        return true;
      }
      if (path === "/home/u/many") {
        deps.deliver({
          t: "dir_list",
          req,
          path,
          parent: parentOf(path),
          dirs: MANY_DIRS.map((name) => ({ name })),
          truncated: true,
        });
        return true;
      }
      const names = TREE[path];
      if (names === undefined) {
        deps.deliver({ t: "error", req, code: "not_found", message: "no such directory" });
        return true;
      }
      deps.deliver({
        t: "dir_list",
        req,
        path,
        parent: parentOf(path),
        dirs: names.map((name) => ({ name })),
        truncated: false,
      });
      return true;
    },
  };
}
