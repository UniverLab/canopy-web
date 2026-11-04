// SPDX-License-Identifier: Apache-2.0
/**
 * The write phase's fingerprint: what the last run actually wrote.
 *
 * Workers KV on the Free plan allows 1,000 writes a day per account, and the
 * cron wakes the indexer 96 times a day. Writing every key on every run would
 * spend that budget on a catalogue that had not moved since the previous run
 * and leave the index stale for the rest of the UTC day once it ran out, so a
 * run compares before it writes: one SHA-256 hex digest per written key lives
 * in `index:hashes:v1`, and a key whose digest is unchanged is not put at all.
 *
 * An unchanged catalogue then costs one put, `index:meta`, which is not
 * fingerprinted — it carries the run's own clock and accounting and moves
 * every time. The bookkeeping put of `index:hashes:v1` itself is not a content
 * write either: it happens only when the map changed.
 *
 * Everything here is total, like the rest of the data layer: a missing or
 * unparsable map is simply empty, which writes every key, exactly as a run
 * without a fingerprint always did.
 */
import { isRecord, isString, parseJson } from "./json.js";
import type { KV } from "./store.js";

/** The one key holding every content fingerprint the last run wrote. */
export const HASHES_KEY = "index:hashes:v1";

/** Key name to the SHA-256 hex digest of the string last written there. */
export type KeyHashes = Record<string, string>;

/** One run's write phase: puts issued, puts skipped as unchanged. */
export interface WriteStats {
  writes: number;
  skipped: number;
}

/** The SHA-256 hex digest of a text, over its UTF-8 bytes. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Parse `index:hashes:v1`. A missing or unparsable value is empty — every key
 * is written — and so is any entry whose value is not a string.
 */
export function parseHashes(text: string | null): KeyHashes {
  if (text === null) {
    return {};
  }
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return {};
  }
  const hashes: KeyHashes = {};
  for (const [key, value] of Object.entries(parsed.value)) {
    if (isString(value)) {
      hashes[key] = value;
    }
  }
  return hashes;
}

/** Serialize the map with sorted keys, so two equal maps are equal bytes. */
export function serializeHashes(hashes: KeyHashes): string {
  const sorted: KeyHashes = {};
  for (const key of Object.keys(hashes).sort()) {
    sorted[key] = hashes[key];
  }
  return JSON.stringify(sorted);
}

/**
 * The write phase's one gate: every content put goes through it, and it puts
 * only when the digest of what would be written differs from the last one.
 *
 * It records the digest for every key it was asked to write, written or
 * skipped, and drops it for every key it removed, so `index:hashes:v1` ends
 * the run describing exactly the keys the run left in KV. Deletes never count
 * as writes: KV charges for them, the meta's `kv_writes` does not.
 */
export class KvWriter {
  private readonly kv: KV;
  /** The map the previous run left: what a digest is compared against. */
  private readonly before: KeyHashes;
  /** What this run leaves behind. */
  private readonly next: KeyHashes;
  private readonly beforeText: string;
  private puts = 0;
  private skips = 0;

  constructor(kv: KV, previous: KeyHashes) {
    this.kv = kv;
    this.before = previous;
    this.next = { ...previous };
    this.beforeText = serializeHashes(previous);
  }

  /** This run's counts, before the caller's own `index:meta` put. */
  get stats(): WriteStats {
    return { writes: this.puts, skipped: this.skips };
  }

  /** Put `value` under `key` unless KV already holds exactly that value. */
  async put(key: string, value: string): Promise<void> {
    await this.write(key, value, value);
  }

  /**
   * Put a `built_at`-bearing value by its content: the digest is taken over
   * `content` (the same payload without `built_at`), so an unchanged catalogue
   * keeps its previous `built_at` and costs no write.
   */
  async putByContent(key: string, content: string, value: string): Promise<void> {
    await this.write(key, value, content);
  }

  /** Delete a key and forget its fingerprint. */
  async remove(key: string): Promise<void> {
    await this.kv.delete(key);
    delete this.next[key];
  }

  /** Write the fingerprint map, and only when this run changed it. */
  async flush(): Promise<boolean> {
    const text = serializeHashes(this.next);
    if (text === this.beforeText) {
      return false;
    }
    await this.kv.put(HASHES_KEY, text);
    return true;
  }

  private async write(key: string, value: string, source: string): Promise<void> {
    const hash = await sha256(source);
    this.next[key] = hash;
    if (this.before[key] === hash) {
      this.skips += 1;
      return;
    }
    await this.kv.put(key, value);
    this.puts += 1;
  }
}
