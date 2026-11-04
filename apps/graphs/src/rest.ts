// SPDX-License-Identifier: Apache-2.0
/**
 * The REST reads the scheduled index needs when it has no token.
 *
 * GitHub's GraphQL API is the cheap way to a whole repository (`snapshot.ts`),
 * but it needs authentication. Without a token the run reads the same facts
 * over REST: the removal list, the two document directories and the
 * repository's accounting, one call per thing. It is the expensive path — two
 * or three calls per document folder, plus one raw fallback per missing file —
 * so the caller's subrequest budget usually stops it partway, which is exactly
 * why the authenticated path exists.
 *
 * Everything here is typed, never thrown: a rate limit comes back as
 * `halt`, so the indexer decides what a stop means; an unreadable file is
 * logged and contributes nothing.
 */
import type { DocumentKind } from "../../../src/schema.js";
import { type BlockedEntry, parseBlockedList } from "./blocked.js";
import {
  type DocumentSource,
  branchFromRepository,
  documentDirectory,
  starsFromRepository,
  updatedFromRepository,
} from "./documents.js";
import type { GitHub, Log } from "./github.js";
import { isApiError } from "./github.js";
import { decodeBase64, isRecord, readJson } from "./json.js";
import { OFFICIAL_OWNER, OFFICIAL_REPO, OFFICIAL_REPOSITORY } from "./lib.js";

/**
 * The removal list at the root of the official repository, through the
 * contents API: one call, and only when the run is unauthenticated.
 */
export const BLOCKED_FILE_URL =
  `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/contents/blocked.json?ref=main`;

/** What one REST read of the removal list proved. */
export type BlockedRead =
  /** The list was read; it replaces the previous blocks. */
  | { kind: "read"; entries: BlockedEntry[] }
  /** The file was missing or unreadable: keep the previous blocks and keys. */
  | { kind: "unread" }
  /** A rate limit: the run stops like any other stop. */
  | { kind: "halt"; reason: string };

/** Read the removal list over REST. */
export async function readBlocked(github: GitHub, log: Log): Promise<BlockedRead> {
  const response = await github.get(BLOCKED_FILE_URL, "contents");
  if (isApiError(response)) {
    if (response.kind === "rate-limit") {
      return { kind: "halt", reason: "rate-limited reading blocked.json" };
    }
    log(`indexer: blocked.json ${response.kind}; keeping the previous blocks`);
    return { kind: "unread" };
  }
  const body = await readJson(response);
  const content = body.ok && isRecord(body.value) ? body.value["content"] : undefined;
  const text = decodeBase64(content);
  const entries = text === null ? null : parseBlockedList(text);
  if (entries === null) {
    log("indexer: blocked.json did not parse as a JSON array; keeping the previous blocks");
    return { kind: "unread" };
  }
  return { kind: "read", entries };
}

/** The directory names in a contents listing; anything unreadable is none. */
function listedDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (isRecord(entry) && entry["type"] === "dir") {
      const name = entry["name"];
      return typeof name === "string" ? [name] : [];
    }
    return [];
  });
}

/** What one `/repos/...` call tells the index: stars, updated, branch. */
interface RepoInfo {
  stars: number | null;
  updated: string | null;
  branch: string;
}

/** Read the repository's accounting; blanks when GitHub stays silent. */
export async function repoInfo(github: GitHub, repository: string): Promise<RepoInfo> {
  const blank: RepoInfo = { stars: null, updated: null, branch: "" };
  const response = await github.get(`https://api.github.com/repos/${repository}`, "contents");
  if (isApiError(response)) {
    return blank;
  }
  const body = await readJson(response);
  if (!body.ok) {
    return blank;
  }
  return {
    stars: starsFromRepository(body.value),
    updated: updatedFromRepository(body.value),
    branch: branchFromRepository(body.value),
  };
}

/** What one REST pass over the official repository proved. */
export type OfficialSources =
  | { kind: "read"; sources: DocumentSource[] }
  | { kind: "halt"; reason: string };

/**
 * Every official document folder in REST order: `graphs/` then `nodes/`,
 * listing each directory and reading the repository's accounting once. A
 * missing directory is an empty kind, not an outage.
 */
export async function officialSources(github: GitHub, log: Log): Promise<OfficialSources> {
  const slugs: Record<DocumentKind, string[]> = { graph: [], node: [] };
  for (const kind of ["graph", "node"] as const) {
    const listing = await github.get(
      `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/contents/${kind}s`,
      "contents",
    );
    if (isApiError(listing)) {
      if (listing.kind === "rate-limit") {
        return { kind: "halt", reason: "rate-limited listing the official repository" };
      }
      if (listing.kind !== "not-found") {
        log(`indexer: official ${kind}s failed: ${listing.kind}`);
      }
      continue;
    }
    const body = await readJson(listing);
    if (!body.ok) {
      log(`indexer: official ${kind}s did not parse as JSON`);
      continue;
    }
    slugs[kind] = listedDirectories(body.value);
  }
  const info = await repoInfo(github, OFFICIAL_REPOSITORY);
  const sources: DocumentSource[] = [];
  for (const kind of ["graph", "node"] as const) {
    for (const slug of slugs[kind]) {
      sources.push({
        owner: OFFICIAL_OWNER,
        repo: OFFICIAL_REPO,
        directory: documentDirectory(kind, slug),
        kind,
        slug,
        stars: info.stars,
        updated: info.updated,
        ref: info.branch,
      });
    }
  }
  return { kind: "read", sources };
}
