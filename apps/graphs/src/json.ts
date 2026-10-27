// SPDX-License-Identifier: Apache-2.0
/**
 * JSON value helpers for the catalogue data layer.
 *
 * Everything here is total: no function throws, no function touches the
 * network or a global. Parsing, base64 decoding and shape checks return
 * values the callers can branch on, so a malformed GitHub response degrades
 * into a typed error or a dropped document instead of an exception.
 */
import type { JsonValue } from "../../../src/schema.js";

export type { JsonValue };

/** A parsed document: true means the text was JSON and the shapes are usable. */
export type ParsedJson =
  | { ok: true; value: JsonValue }
  | { ok: false };

/** Parse JSON text. Never throws: invalid text simply is not ok. */
export function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false };
  }
}

/** A response body that parsed as JSON; `ok: false` means it never will. */
export type JsonRead = { ok: true; value: JsonValue } | { ok: false };

/**
 * Read a response body as JSON without ever throwing. GitHub answers JSON on
 * every success, but a proxy or a captive portal can hand back HTML with a
 * 200: that is an upstream problem the caller shapes into a typed error, not
 * an exception that reaches the user as a 500.
 */
export async function readJson(response: Response): Promise<JsonRead> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false };
  }
  return parseJson(text);
}

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

/** Read a string field from a JSON object, `""` when absent or not a string. */
export function stringField(
  record: { [key: string]: JsonValue },
  key: string,
): string {
  const value = record[key];
  return isString(value) ? value : "";
}

/**
 * Decode GitHub's base64 file content. Content arrives as standard base64
 * chunked with newlines; whitespace is stripped and characters outside the
 * alphabet make the result `null` (the caller falls back to the raw URL).
 */
export function decodeBase64(encoded: unknown): string | null {
  if (!isString(encoded)) {
    return null;
  }
  const compact = encoded.replace(/\s/g, "");
  try {
    const bytes = atob(compact);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      buffer[i] = bytes.charCodeAt(i);
    }
    return new TextDecoder().decode(buffer);
  } catch {
    return null;
  }
}
