// SPDX-License-Identifier: Apache-2.0
/**
 * Drafts: the catalogue's one deliberate exception to "the Worker never serves
 * documents".
 *
 * A draft is a graph or node document somebody assembled in the editor (or an
 * agent produced) and wants to hand to a teammate — or to themselves on
 * another machine — without creating a repository first. It lives in its own
 * KV namespace for at most 30 minutes, and the first install deletes it.
 * Because a draft is unreviewed, labelled as such, and validated before it is
 * stored, it does not widen the trust surface the catalogue promises
 * (Intelligence 778242cb): the redirector still owns published documents.
 *
 * This module owns the ids, the storage record and the validation question;
 * `api.ts`, `index.ts` and `pages/routes.ts` wire it to HTTP. Every function
 * here is total: a missing binding, a malformed value or a KV failure is
 * `null`, never an exception.
 *
 * One KV caveat is documented in the README: deletes are eventually
 * consistent, so "one use" is best effort within about a minute.
 */
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import { isRecord, isString, parseJson, stringField } from "./json.js";
import { documentProblems, harnessProblems, type DocumentProblem } from "./validate.js";

/** The namespace prefix every draft key carries. */
export const DRAFT_PREFIX = "draft:v1:";

/** How long a draft lives: 30 minutes, in seconds, the KV TTL. */
export const DRAFT_TTL_SECONDS = 1800;

/** The largest body `POST /api/drafts` accepts: 256 KiB. */
export const DRAFT_MAX_BYTES = 256 * 1024;

/** The Crockford base32 alphabet, lowercase, minus i, l, o and u. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A draft id: 26 characters of that alphabet (128 random bits). */
export const DRAFT_ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** The smallest KV surface drafts need: no list, no metadata. */
export interface DraftKV {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/** One stored draft: the validated document and when it stops existing. */
export interface DraftRecord {
  kind: DocumentKind;
  document: JsonValue;
  /** ISO 8601, the moment the draft expires even if KV has not collected it. */
  expires_at: string;
}

/** The key one draft lives under. */
export function draftKey(id: string): string {
  return `${DRAFT_PREFIX}${id}`;
}

/**
 * A fresh draft id: 16 bytes from `crypto.getRandomValues` in Crockford
 * base32, lowercase and unpadded — 26 characters, URL-safe by construction.
 */
export function draftId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    id += ALPHABET[(value & ((1 << bits) - 1)) << (5 - bits)];
  }
  return id;
}

/** The public address a draft's page lives at. */
export function draftPagePath(id: string): string {
  return `/d/${id}`;
}

/**
 * Every problem that keeps a value from becoming a draft: the catalogue
 * schema first, then the harness-free rule a shared document must satisfy.
 */
export function draftProblems(kind: DocumentKind, document: unknown): DocumentProblem[] {
  return [...documentProblems(kind, document), ...harnessProblems(kind, document)];
}

/** Parse one stored value; a past `expires_at` reads as gone. */
export function parseDraft(text: string, now: number): DraftRecord | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const value = parsed.value;
  const kind = value["kind"];
  const document = value["document"];
  const expiresAt = value["expires_at"];
  if ((kind !== "graph" && kind !== "node") || !isRecord(document) || !isString(expiresAt)) {
    return null;
  }
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || expires <= now) {
    return null;
  }
  return { kind, document, expires_at: expiresAt };
}

/** Store a draft for 30 minutes and answer its id and expiry. */
export async function createDraft(
  kv: DraftKV,
  kind: DocumentKind,
  document: JsonValue,
  now: number = Date.now(),
): Promise<{ id: string; expires_at: string }> {
  const id = draftId();
  const expiresAt = new Date(now + DRAFT_TTL_SECONDS * 1000).toISOString();
  const record: DraftRecord = { kind, document, expires_at: expiresAt };
  await kv.put(draftKey(id), JSON.stringify(record), { expirationTtl: DRAFT_TTL_SECONDS });
  return { id, expires_at: expiresAt };
}

/** Read a draft without touching it; null when unknown, expired or malformed. */
export async function readDraft(
  kv: DraftKV,
  id: string,
  now: number = Date.now(),
): Promise<DraftRecord | null> {
  if (!DRAFT_ID_RE.test(id)) {
    return null;
  }
  let text: string | null;
  try {
    text = await kv.get(draftKey(id));
  } catch {
    return null;
  }
  return text === null ? null : parseDraft(text, now);
}

/**
 * The one-install read: return the draft and delete it. The delete is best
 * effort — KV deletes are eventually consistent, so a second install within
 * about a minute can still find the value — but it is awaited so a healthy
 * namespace is empty by the time the caller answers.
 */
export async function consumeDraft(
  kv: DraftKV,
  id: string,
  now: number = Date.now(),
): Promise<DraftRecord | null> {
  const record = await readDraft(kv, id, now);
  if (record === null) {
    return null;
  }
  try {
    await kv.delete(draftKey(id));
  } catch {
    // A failed delete still served the document: KV will expire it.
  }
  return record;
}

/** The document's own name, for the API's answer; `""` when it has none. */
export function draftName(document: JsonValue): string {
  return isRecord(document) ? stringField(document, "name") : "";
}
