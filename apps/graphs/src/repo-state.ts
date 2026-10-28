// SPDX-License-Identifier: Apache-2.0
/**
 * The scheduled index's per-repository ledger: which repositories the runs
 * already read, and when their code last moved.
 *
 * A run may spend 45 subrequests, so rereading every discovered repository
 * every 15 minutes caps the catalogue at the first ~42 of them: a new,
 * low-starred repository past that cut would never be visited. Instead each
 * run visits only the repositories that changed or were never read — a
 * repository is pending when the stored ledger has no visit for it, or its
 * discovery hit's `pushed_at` differs from the stored one — and resumes
 * where a short run stopped: pending repositories go oldest `visited_at`
 * first, never visited before anything else, so no repository starves while
 * an unchanged catalogue costs the official read plus discovery.
 *
 * The ledger lives in one KV key, `index:repos:v1`, as JSON
 * `{ "version": <INDEXER_VERSION>, "repos": { "<owner>/<repo>": ... } }`,
 * written through the write phase's fingerprint helper like every content
 * key. A stored visit is updated only after a successful visit; an
 * unavailable or stopped repository keeps its previous state and stays
 * pending. Like the rest of the data layer everything here is total: a
 * missing or unparsable ledger, or a stored version that differs from the
 * indexer's, reads as empty — every repository counts as never visited, so
 * a deploy that changes parsing or validation rereads everything over the
 * next runs.
 */
import { isNumber, isRecord, isString, parseJson, stringField } from "./json.js";

/** The one KV key holding every repository's last visit. */
export const REPOS_KEY = "index:repos:v1";

/** One repository as the discovery search describes it. */
export interface RepoHit {
  owner: string;
  repo: string;
  branch: string;
  stars: number | null;
  updated: string | null;
  /** `pushed_at` from the search hit, or null when the hit carries none. */
  pushedAt: string | null;
}

export function hitOf(value: unknown): RepoHit | null {
  if (!isRecord(value)) {
    return null;
  }
  const owner = isRecord(value["owner"]) ? stringField(value["owner"], "login") : "";
  const repo = stringField(value, "name");
  if (owner === "" || repo === "") {
    return null;
  }
  const stars = value["stargazers_count"];
  const updated = value["updated_at"];
  const pushed = value["pushed_at"];
  return {
    owner,
    repo,
    branch: stringField(value, "default_branch").trim() || "HEAD",
    stars: isNumber(stars) ? stars : null,
    updated: typeof updated === "string" && /^\d{4}-\d{2}-\d{2}/.test(updated)
      ? updated.slice(0, 10)
      : null,
    pushedAt: typeof pushed === "string" && pushed !== "" ? pushed : null,
  };
}

/** The repository key the ledger and the carry-over compare: lowercase `owner/repo`. */
export function repoKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** One stored visit: what the repository's code looked like, and when. */
export interface RepoVisit {
  /** The hit's `pushed_at` at the last successful visit. */
  pushed_at: string | null;
  /** The visiting run's `built_at`. */
  visited_at: string;
}

/** The ledger's repositories by key, exactly as stored under `repos`. */
export type RepoStateMap = Record<string, RepoVisit>;

/**
 * Parse `index:repos:v1`. A missing or unparsable value reads as empty, and
 * so does a stored version that differs from the indexer's — every key is
 * then pending, exactly as a run without a ledger always did. Entries that
 * are not visits are dropped, never fatal.
 */
export function parseRepoState(text: string | null, version: number): RepoStateMap {
  if (text === null) {
    return {};
  }
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return {};
  }
  if (parsed.value["version"] !== version) {
    return {};
  }
  const repos = parsed.value["repos"];
  if (!isRecord(repos)) {
    return {};
  }
  const state: RepoStateMap = {};
  for (const [key, value] of Object.entries(repos)) {
    if (!isRecord(value)) {
      continue;
    }
    const pushed = value["pushed_at"];
    const visited = value["visited_at"];
    if ((pushed !== null && !isString(pushed)) || !isString(visited)) {
      continue;
    }
    state[key] = { pushed_at: pushed, visited_at: visited };
  }
  return state;
}

/** Serialize the ledger with sorted keys, so two equal ledgers are equal bytes. */
export function serializeRepoState(version: number, repos: RepoStateMap): string {
  const sorted: RepoStateMap = {};
  for (const key of Object.keys(repos).sort()) {
    sorted[key] = repos[key];
  }
  return JSON.stringify({ version, repos: sorted });
}

/** What one run decided about its discovered community repositories. */
export interface VisitPlan {
  /** Pending hits in visit order: never visited first, then oldest visit first. */
  pending: RepoHit[];
  /** Unchanged hits by repository key, for the entry carry-over. */
  unchanged: Map<string, RepoHit>;
}

/**
 * Split the discovered hits into pending and unchanged. A repository is
 * pending when the ledger holds no visit for it, when its hit carries no
 * `pushed_at` (nothing to compare is always worth a visit), or when the
 * hit's `pushed_at` differs from the stored one. Pending repositories are
 * ordered for resume: never visited first in discovery order, then oldest
 * `visited_at` first, so a run cut short by the budget is picked up by the
 * next one and no repository starves.
 */
export function planVisits(hits: RepoHit[], stored: RepoStateMap): VisitPlan {
  const pending: Array<{ hit: RepoHit; index: number; visitedAt: string | null }> = [];
  const unchanged = new Map<string, RepoHit>();
  hits.forEach((hit, index) => {
    const key = repoKey(hit.owner, hit.repo);
    const visit = stored[key];
    if (visit === undefined || hit.pushedAt === null || visit.pushed_at !== hit.pushedAt) {
      pending.push({ hit, index, visitedAt: visit?.visited_at ?? null });
    } else {
      unchanged.set(key, hit);
    }
  });
  pending.sort((a, b) => {
    if (a.visitedAt === null && b.visitedAt !== null) {
      return -1;
    }
    if (a.visitedAt !== null && b.visitedAt === null) {
      return 1;
    }
    if (a.visitedAt !== null && b.visitedAt !== null && a.visitedAt !== b.visitedAt) {
      return a.visitedAt < b.visitedAt ? -1 : 1;
    }
    return a.index - b.index;
  });
  return { pending: pending.map((candidate) => candidate.hit), unchanged };
}

/**
 * Drop the stored visits a completed discovery no longer lists. A truncated
 * discovery — the page cap or a failed page — never calls this: repositories
 * it did not see were not proven gone, so their visits stay.
 */
export function pruneRepoState(stored: RepoStateMap, discovered: Set<string>): void {
  for (const key of Object.keys(stored)) {
    if (!discovered.has(key)) {
      delete stored[key];
    }
  }
}
