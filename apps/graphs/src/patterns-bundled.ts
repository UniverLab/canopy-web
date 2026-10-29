// SPDX-License-Identifier: Apache-2.0
/**
 * The bundled pattern pages, parsed for the request path.
 *
 * `patterns-data.generated.ts` carries the raw texts the build validated;
 * this module parses them once per isolate with the site's own
 * `patternFromTexts` rules into the cards and the stored pages. The build
 * rejects a malformed page before it can ship, so a parse failure here
 * throws instead of dropping a page silently.
 */
import type { Log } from "./github.js";
import {
  type PatternEntry,
  type StoredPattern,
  patternFromTexts,
} from "./patterns.js";
import { BUNDLED_PATTERNS, PATTERNS_BUILT_AT } from "./patterns-data.generated.js";

/** The whole bundled set, parsed: the cards and one page per slug. */
export interface BundledPatterns {
  /** When the bundled payload last changed, from the generated module. */
  builtAt: string;
  entries: PatternEntry[];
  documents: Map<string, StoredPattern>;
}

let parsed: Promise<BundledPatterns> | null = null;

/** Parse the bundled texts. Throws on a page the build should have rejected. */
async function parseBundled(log: Log): Promise<BundledPatterns> {
  const entries: PatternEntry[] = [];
  const documents = new Map<string, StoredPattern>();
  const figures = new Map(BUNDLED_PATTERNS.map((bundled) => [bundled.figureName, bundled.figure]));
  for (const bundled of BUNDLED_PATTERNS) {
    const loaded = await patternFromTexts(
      bundled.slug,
      bundled.page,
      (name) => {
        const text = figures.get(name);
        return Promise.resolve(
          text === undefined ? { kind: "absent" } : { kind: "text", text },
        );
      },
      log,
    );
    if (loaded.kind === "invalid") {
      throw new Error(`patterns: bundled ${bundled.slug}: ${loaded.reason}`);
    }
    entries.push(loaded.entry);
    documents.set(bundled.slug, loaded.stored);
  }
  return { builtAt: PATTERNS_BUILT_AT, entries, documents };
}

/**
 * The bundled set, parsed once per isolate. The build validated these
 * texts, so this resolves on every request; a throw means the bundle and
 * the validator disagree, and the page must fail loudly.
 */
export function bundledPatterns(log: Log = () => undefined): Promise<BundledPatterns> {
  if (parsed === null) {
    parsed = parseBundled(log);
  }
  return parsed;
}
