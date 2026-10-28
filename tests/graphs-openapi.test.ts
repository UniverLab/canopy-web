// SPDX-License-Identifier: Apache-2.0
/**
 * The OpenAPI description cannot drift from the API contract: every `GET` and
 * `POST` route in `api.ts`'s header comment is a path in `openApiDocument()`,
 * and no other API path is. The router's own `switch` must be covered too, so
 * a new verb breaks this test until both its header line and its OpenAPI entry
 * land beside it. The drafts routes are handled before the read-only switch,
 * which is why the header — not the switch alone — is the list compared.
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

/**
 * The routes in `api.ts`'s header table: `GET /api/official`,
 * `POST /api/drafts`, `GET /api/drafts/<id>`, with `<param>` spelled
 * `{param}` the way OpenAPI does.
 */
function headerRoutes(): string[] {
  return [...API_SOURCE.matchAll(/^\s*\*\s+(?:GET|POST)\s+(\/api\/[^\s?]+)/gm)]
    .map((match) => (match[1] as string).replace(/<([^>]+)>/g, "{$1}"))
    .sort();
}

describe("the OpenAPI description", () => {
  it("documents every route api.ts parses, and no other", () => {
    const verbs = apiVerbs();
    expect(verbs.length).toBeGreaterThan(0);
    const header = headerRoutes();
    // Every switch verb is named in the header, so the two cannot drift.
    for (const verbPath of verbs.map(documentedPath)) {
      expect(header, verbPath).toContain(verbPath);
    }
    // And the OpenAPI paths are exactly the header's.
    const document = openApiDocument();
    const paths = Object.keys((document["paths"] ?? {}) as Record<string, unknown>).sort();
    expect(paths).toEqual(header);
  });
});
