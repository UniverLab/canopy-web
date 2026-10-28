// SPDX-License-Identifier: Apache-2.0
/**
 * The `index:v1` payload, in the two halves the write phase needs.
 *
 * `content` is the part the fingerprint covers — the entries alone — and
 * `value` is the string handed to `put`: the same entries plus `built_at`.
 * Splitting them is what lets an unchanged catalogue keep its previous
 * `built_at` (and cost no write) while the fingerprint still follows every
 * entry field: a value digest would move on every run, because the clock
 * does. Pure, so the tests pin the trim without building a 5 MiB fixture.
 */
import type { IndexEntry } from "./store.js";

/**
 * `index:v1` stays far under KV's 25 MiB value limit: past 5 MiB every
 * description is cut to 280 characters first.
 */
export const INDEX_MAX_BYTES = 5 * 1024 * 1024;

/** Descriptions are cut to this length when the index would overshoot. */
export const DESCRIPTION_TRIM = 280;

/** One index payload: its digestible content, and the value written. */
export interface IndexPayload {
  /** JSON of the entries alone, never `built_at`: what the digest covers. */
  content: string;
  /** The value written: the same entries plus `built_at`. */
  value: string;
}

/** Build both halves, cutting descriptions when the value would overshoot. */
export function buildIndexValue(
  entries: IndexEntry[],
  builtAt: string,
  maxBytes: number = INDEX_MAX_BYTES,
): IndexPayload {
  const full = JSON.stringify({ built_at: builtAt, entries });
  if (new TextEncoder().encode(full).length <= maxBytes) {
    return { content: JSON.stringify({ entries }), value: full };
  }
  const trimmed = entries.map((entry) =>
    entry.description.length > DESCRIPTION_TRIM
      ? { ...entry, description: entry.description.slice(0, DESCRIPTION_TRIM) }
      : entry
  );
  return {
    content: JSON.stringify({ entries: trimmed }),
    value: JSON.stringify({ built_at: builtAt, entries: trimmed }),
  };
}

/** The `index:v1` value alone; the write phase uses `buildIndexValue`. */
export function buildIndexPayload(
  entries: IndexEntry[],
  builtAt: string,
  maxBytes: number = INDEX_MAX_BYTES,
): string {
  return buildIndexValue(entries, builtAt, maxBytes).value;
}
