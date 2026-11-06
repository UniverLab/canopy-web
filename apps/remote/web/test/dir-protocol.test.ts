// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { buildDirList, parseDirList } from "../src/dir-protocol.js";

describe("dir_list frames", () => {
  it("builds the request with path only when given", () => {
    expect(JSON.parse(buildDirList("r1"))).toEqual({ t: "dir_list", req: "r1" });
    expect(JSON.parse(buildDirList("r2", "/home/u"))).toEqual({
      t: "dir_list",
      req: "r2",
      path: "/home/u",
    });
    expect(JSON.parse(buildDirList("r3", ""))).toEqual({ t: "dir_list", req: "r3", path: "" });
  });

  it("parses a full reply and keeps only named dirs", () => {
    expect(
      parseDirList({
        t: "dir_list",
        req: "r1",
        path: "/home/u",
        parent: "/home",
        dirs: [
          { name: "demo" },
          { name: ".config" },
          { name: "" },
          { name: 7 },
          { nope: true },
          "docs",
        ],
        truncated: true,
      }),
    ).toEqual({
      req: "r1",
      path: "/home/u",
      parent: "/home",
      dirs: [{ name: "demo" }, { name: ".config" }],
      truncated: true,
    });
  });

  it("accepts a root reply with parent null and truncated false", () => {
    expect(
      parseDirList({
        t: "dir_list",
        req: "r1",
        path: "/",
        parent: null,
        dirs: [{ name: "home" }],
        truncated: false,
      }),
    ).toEqual({ req: "r1", path: "/", parent: null, dirs: [{ name: "home" }], truncated: false });
  });

  it("rejects malformed replies", () => {
    const good = {
      t: "dir_list",
      req: "r1",
      path: "/home/u",
      parent: "/home",
      dirs: [],
      truncated: false,
    };
    for (const bad of [
      { ...good, t: "shelf" },
      { ...good, req: "" },
      { ...good, req: 7 },
      { ...good, path: "" },
      { ...good, path: null },
      { ...good, parent: undefined },
      { ...good, parent: "" },
      { ...good, parent: 7 },
      { ...good, dirs: {} },
      null,
      "dir_list",
    ]) {
      expect(parseDirList(bad)).toBeNull();
    }
  });

  it("reads truncated only when it is exactly true", () => {
    const base = {
      t: "dir_list",
      req: "r1",
      path: "/home/u",
      parent: "/home",
      dirs: [],
    };
    expect(parseDirList({ ...base, truncated: true })?.truncated).toBe(true);
    expect(parseDirList({ ...base, truncated: "yes" })?.truncated).toBe(false);
    expect(parseDirList({ ...base })?.truncated).toBe(false);
  });
});
