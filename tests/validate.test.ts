// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateDocument, validateDocumentFile, validateFolder, validateTarget } from "../src/validate.js";

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

  it("accepts a real Rust route condition {route}", () => {
    const doc = {
      format_version: 6,
      name: "g",
      nodes: [],
      edges: [{ from_node: "a", to_node: "b", condition: { route: "proceed" } }],
    };
    expect(validateDocument("g/graph.json", "graph", doc)).toEqual([]);
  });

  it("rejects the {condition, route} shape Rust never wrote", () => {
    const doc = {
      format_version: 6,
      name: "g",
      nodes: [],
      edges: [{ from_node: "a", to_node: "b", condition: { condition: "route", route: "proceed" } }],
    };
    expect(validateDocument("g/graph.json", "graph", doc).length).toBeGreaterThan(0);
  });

  it("accepts unknown hook fields, like Rust import does", () => {
    const doc = {
      format_version: 6,
      name: "g",
      nodes: [],
      edges: [],
      hooks: { on_completed: [{ command: "echo done", future_hook_field: 1 }] },
    };
    expect(validateDocument("g/graph.json", "graph", doc)).toEqual([]);
  });

  it("enforces folder rules when given a single file", () => {
    const missing = validateTarget(path.join(folder("missing-readme-graph"), "graph.json"));
    expect(missing.some((failure) => failure.message.includes("README"))).toBe(true);
    const mismatch = validateTarget(path.join(folder("name-mismatch-node"), "node.json"));
    expect(mismatch.some((failure) => failure.message.includes("folder name"))).toBe(true);
  });
});
