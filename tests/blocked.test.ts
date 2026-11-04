// SPDX-License-Identifier: Apache-2.0
/**
 * The removal list as a contract: `schema/blocked.schema.json` validates the
 * shape, and the validator adds the one rule JSON Schema cannot state across
 * sibling fields — a slug needs its kind. The live list lives in
 * UniverLab/canopy-graphs; the fixture here stays empty, exactly as a
 * fresh repository's does until a maintainer merges a decided report.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBlocked, validateBlockedFile } from "../src/validate.js";

const BLOCKED = path.resolve(import.meta.dirname, "fixtures/blocked.json");

const ISSUE = "https://github.com/UniverLab/canopy-web/issues/7";

function validEntries(): unknown[] {
  return [
    {
      kind: "graph",
      repo: "acme/things",
      slug: "flow",
      reason: "Malicious or dangerous command",
      issue: ISSUE,
      blocked_at: "2026-10-27",
    },
    {
      repo: "acme/eviltools",
      reason: "Prompt that steers the agent to do harm",
      issue: ISSUE,
      blocked_at: "2026-10-27",
    },
  ];
}

describe("the blocked list schema", () => {
  it("accepts a document block and a repository block", () => {
    expect(validateBlocked("blocked.json", validEntries())).toEqual([]);
    expect(validateBlocked("blocked.json", [])).toEqual([]);
  });

  it("rejects an entry without a reason", () => {
    const [entry] = validEntries() as Array<Record<string, unknown>>;
    const withoutReason = { ...entry };
    delete withoutReason["reason"];
    const failures = validateBlocked("blocked.json", [withoutReason]);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((failure) => failure.message.includes("required"))).toBe(true);
  });

  it("rejects a repo that is not owner/repo", () => {
    const [entry] = validEntries() as Array<Record<string, unknown>>;
    for (const repo of ["acme", "acme/", "/things", "acme/things/extra"]) {
      const failures = validateBlocked("blocked.json", [{ ...entry, repo }]);
      expect(failures.length, repo).toBeGreaterThan(0);
      expect(failures.some((failure) => failure.message.includes("pattern")), repo).toBe(true);
    }
  });

  it("requires kind when a slug is named", () => {
    const [entry] = validEntries() as Array<Record<string, unknown>>;
    const withoutKind = { ...entry };
    delete withoutKind["kind"];
    const failures = validateBlocked("blocked.json", [withoutKind]);
    expect(failures.some((failure) => failure.message.includes("slug requires kind"))).toBe(true);
    // Dropping the slug blocks the whole repository and needs no kind.
    delete withoutKind["slug"];
    expect(validateBlocked("blocked.json", [withoutKind])).toEqual([]);
  });

  it("keeps the fixture list empty and valid, as the official repo's does before its first merge", () => {
    expect(validateBlockedFile(BLOCKED)).toEqual([]);
    expect(JSON.parse(readFileSync(BLOCKED, "utf8"))).toEqual([]);
  });
});
