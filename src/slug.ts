// SPDX-License-Identifier: Apache-2.0
import path from "node:path";

/** Slug rule shared by the graph and node schemas: `^[a-z0-9-]{1,48}$`. */
export const SLUG_PATTERN = "^[a-z0-9-]{1,48}$";

export const SLUG_RE = /^[a-z0-9-]{1,48}$/;

/** True when `value` is a string matching the shared slug rule. */
export function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}

/**
 * True when a document folder's basename equals the document's slug-safe
 * name (the publish rule: `graphs/<slug>/` holds the document named
 * `<slug>`).
 */
export function folderMatchesName(folderPath: string, name: string): boolean {
  return path.basename(path.resolve(folderPath)) === name;
}
