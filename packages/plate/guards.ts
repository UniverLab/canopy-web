// SPDX-License-Identifier: Apache-2.0
/**
 * JSON value shape predicates, shared by the plate and its callers. They
 * moved here with the plate so the drawing has no dependency on the
 * catalogue's data layer; apps/graphs/src/json.ts re-exports them under
 * the same names, so every existing import keeps working.
 *
 * Everything here is total: a predicate only answers true or false, never
 * throws, so a malformed document degrades into "draws nothing" instead of
 * an exception.
 */
import type { JsonValue } from "../../src/schema.js";

/** True when the value is a JSON object (and not null, not an array). */
export function isRecord(
  value: unknown,
): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the value is a JSON string. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** True when the value is a JSON array. */
export function isArray(value: unknown): value is JsonValue[] {
  return Array.isArray(value);
}

/** True when the value is a JSON number. */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}
