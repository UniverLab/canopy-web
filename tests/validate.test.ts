// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateDocumentFile, validateFolder } from "../src/validate.js";

const fixtures = path.resolve(import.meta.dirname, "fixtures");

function folder(name: string): string {
  return path.join(fixtures, name);
}

describe("catalogue validator", () => {
  it("accepts a valid graph document folder", () => {
    expect(validateFolder(folder("valid-graph"))).toEqual([]);
  });

  it("accepts a valid node document folder", () => {
    expect(validateFolder(folder("valid-node"))).toEqual([]);
  });

  it("rejects an unknown field", () => {
    const failures = validateDocumentFile(path.join(folder("unknown-field-graph"), "graph.json"));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((failure) => failure.message.includes("additional properties"))).toBe(true);
  });

  it("rejects a bad slug", () => {
    const failures = validateDocumentFile(path.join(folder("bad-slug-node"), "node.json"));
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some(
        (failure) => failure.pointer === "#/name" && failure.message.includes("pattern"),
      ),
    ).toBe(true);
  });

  it("rejects platform inside a node config", () => {
    const failures = validateDocumentFile(path.join(folder("nested-platform-node"), "node.json"));
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some((failure) => failure.pointer.startsWith("#/config")),
    ).toBe(true);
  });

  it("rejects a missing README", () => {
    const failures = validateFolder(folder("missing-readme-graph"));
    expect(
      failures.some((failure) => failure.message.includes("README")),
    ).toBe(true);
  });

  it("rejects a folder/name mismatch", () => {
    const failures = validateFolder(folder("name-mismatch-node"));
    expect(
      failures.some(
        (failure) => failure.pointer === "#/name" && failure.message.includes("folder name"),
      ),
    ).toBe(true);
  });
});
