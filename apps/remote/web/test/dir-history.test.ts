// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDirectorySuggestions,
  pushRecentDir,
  readLastDir,
  readRecentDirs,
  writeLastDir,
} from "../src/dir-history.js";

describe("directory memory", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("remembers the last directory per host", () => {
    expect(readLastDir("h1")).toBeNull();
    writeLastDir("h1", "/home/u/demo");
    writeLastDir("h2", "/home/u/other");
    expect(readLastDir("h1")).toBe("/home/u/demo");
    expect(readLastDir("h2")).toBe("/home/u/other");
    expect(readLastDir("")).toBeNull();
    writeLastDir("", "/home/u/nowhere");
    writeLastDir("h1", "   ");
    expect(readLastDir("h1")).toBe("/home/u/demo");
  });

  it("trims what it stores", () => {
    writeLastDir("h1", "  /home/u/demo  ");
    expect(readLastDir("h1")).toBe("/home/u/demo");
  });

  it("keeps the last 8 directories newest first without duplicates", () => {
    expect(readRecentDirs()).toEqual([]);
    pushRecentDir("/a");
    pushRecentDir("/b");
    pushRecentDir("/a");
    expect(readRecentDirs()).toEqual(["/a", "/b"]);
    for (let i = 0; i < 10; i += 1) {
      pushRecentDir(`/d${i}`);
    }
    const recent = readRecentDirs();
    expect(recent).toHaveLength(8);
    expect(recent[0]).toBe("/d9");
    expect(recent).not.toContain("/d0");
    expect(recent).not.toContain("/d1");
    pushRecentDir("   ");
    expect(readRecentDirs()).toHaveLength(8);
  });

  it("ignores a broken recents entry", () => {
    localStorage.setItem("canopy.remote.dirs.recent.v1", "not json");
    expect(readRecentDirs()).toEqual([]);
    localStorage.setItem("canopy.remote.dirs.recent.v1", JSON.stringify({ nope: true }));
    expect(readRecentDirs()).toEqual([]);
  });

  it("builds suggestions catalog-first without duplicates or blanks", () => {
    expect(
      buildDirectorySuggestions({
        catalogPaths: ["/home/u/demo", "/home/u/other"],
        sessionWorkdirs: ["/home/u/other", "/home/u/live", ""],
        recent: ["/home/u/live", "~/scratch", "  "],
      }),
    ).toEqual(["/home/u/demo", "/home/u/other", "/home/u/live", "~/scratch"]);
  });
});
