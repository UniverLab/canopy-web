// SPDX-License-Identifier: Apache-2.0
// The door check: what each pathname means, and that an unknown one is
// sent home by a single replaceState — same document, no navigation —
// while the app's own routes, the editor chunk and the guest links are
// left exactly as they came.

import { describe, expect, it } from "vitest";
import { classifyEntryPath, homeHref, redirectUnknownRoute } from "../src/entry-path.js";
import type { EntryPath } from "../src/entry-path.js";

/** Enough of a location for the door check, plus the navigations it must refuse. */
interface FakeLocation {
  pathname: string;
  search: string;
  hash: string;
  assign: () => never;
  replace: () => never;
}

interface Entry {
  location: FakeLocation;
  history: { replaceState: (data: unknown, unused: string, url?: string) => void };
  calls: Array<{ data: unknown; unused: string; url?: string | undefined }>;
}

function fakeEntry(pathname: string, search = "", hash = ""): Entry {
  const calls: Array<{ data: unknown; unused: string; url?: string | undefined }> = [];
  const refuse = (name: string): never => {
    throw new Error(`location.${name}: the redirect must not navigate`);
  };
  return {
    location: {
      pathname,
      search,
      hash,
      assign: () => refuse("assign"),
      replace: () => refuse("replace"),
    },
    history: {
      replaceState(data: unknown, unused: string, url?: string): void {
        calls.push({ data, unused, url });
      },
    },
    calls,
  };
}

describe("classifyEntryPath", () => {
  const table: Array<[string, EntryPath]> = [
    ["/", "app"],
    ["/pair", "app"],
    ["/pair/", "app"],
    ["/pair//", "app"],
    ["/editor", "editor"],
    ["/editorial", "editor"],
    ["/editor/draft/7", "editor"],
    ["/g/7/0123456789abcdef", "guest"],
    ["/g", "unknown"],
    ["/sessions", "unknown"],
    ["/index.html", "unknown"],
    ["/pair/x", "unknown"],
    ["/does/not/exist", "unknown"],
  ];

  it.each(table)("classifies %s as %s", (pathname, expected) => {
    expect(classifyEntryPath(pathname)).toBe(expected);
  });
});

describe("homeHref", () => {
  it("is a bare / without a query or a hash", () => {
    expect(homeHref({ search: "", hash: "" })).toBe("/");
  });

  it("keeps the query and the fragment", () => {
    expect(homeHref({ search: "?tab=hosts", hash: "#CODE" })).toBe("/?tab=hosts#CODE");
  });
});

describe("redirectUnknownRoute", () => {
  it("sends an unknown path home with one replaceState and no navigation", () => {
    const entry = fakeEntry("/does/not/exist");
    expect(redirectUnknownRoute(entry.location, entry.history)).toBe(true);
    expect(entry.calls).toHaveLength(1);
    expect(entry.calls[0]?.data).toBeNull();
    expect(entry.calls[0]?.url).toBe("/");
    // The pathname is rewritten through the URL argument alone; the
    // navigation methods on the location were never touched.
    expect(entry.location.pathname).toBe("/does/not/exist");
  });

  it("preserves the query and the fragment", () => {
    const entry = fakeEntry("/sessions", "?tab=hosts", "#open");
    expect(redirectUnknownRoute(entry.location, entry.history)).toBe(true);
    expect(entry.calls).toHaveLength(1);
    expect(entry.calls[0]?.url).toBe("/?tab=hosts#open");
  });

  it("leaves the app's own paths untouched", () => {
    const known = ["/", "/pair", "/pair/", "/editor", "/editorial", "/g/7/0123456789abcdef"];
    for (const pathname of known) {
      const entry = fakeEntry(pathname);
      expect(redirectUnknownRoute(entry.location, entry.history), pathname).toBe(false);
      expect(entry.calls, pathname).toHaveLength(0);
    }
  });
});
