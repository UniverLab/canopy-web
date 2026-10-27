// SPDX-License-Identifier: Apache-2.0
/**
 * The OpenAPI description cannot drift from the API router: every verb
 * the `switch` in `apps/graphs/src/api.ts` parses must appear as a path
 * in `openApiDocument()`, and no other API path may. A new route breaks
 * this test until its documentation lands beside it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "../apps/graphs/src/agent-files.js";

const API_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "../apps/graphs/src/api.ts"),
  "utf8",
);

/** Every verb the API router's switch parses. */
function apiVerbs(): string[] {
  const verbs = [...API_SOURCE.matchAll(/case "([^"]+)":/g)].map((match) => match[1] as string);
  return [...new Set(verbs)].sort();
}

/** The OpenAPI path a verb must be documented under. */
function documentedPath(verb: string): string {
  if (verb === "g" || verb === "n") {
    return `/api/${verb}/{owner}/{repo}/{slug}`;
  }
  return `/api/${verb}`;
}

describe("the OpenAPI description", () => {
  it("documents every route api.ts parses, and no other", () => {
    const verbs = apiVerbs();
    expect(verbs.length).toBeGreaterThan(0);
    const document = openApiDocument();
    const paths = Object.keys((document["paths"] ?? {}) as Record<string, unknown>).sort();
    expect(paths).toEqual(verbs.map(documentedPath).sort());
  });
});
