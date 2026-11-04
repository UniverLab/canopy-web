// SPDX-License-Identifier: Apache-2.0
/**
 * The scheduled indexer's incremental visit, against the fake GitHub the
 * worker tests share: sixty community repositories with a budget for forty
 * are split across two runs and resumed in order, a third run with nothing
 * pushed spends the official read plus discovery and writes only its meta,
 * a moved `pushed_at` revisits exactly that repository, a moved star count
 * refreshes the entry without a visit, a foreign ledger version rereads
 * everything, an unavailable repository stays pending with its entries,
 * a repository a completed discovery drops loses its entries and its state,
 * an unreadable ledger rereads everything, changed repositories visit oldest
 * visit first, and a failed discovery keeps every visit and entry.
 */
import { describe, expect, it } from "vitest";
import { createGitHub } from "../src/github.js";
import { INDEXER_VERSION, runIndexer } from "../src/indexer.js";
import { REPOS_KEY } from "../src/repo-state.js";
import { docKey, resetIndexMemo } from "../src/store.js";
import { FakeKV, fakeFetch, type FakeFetch, type Stub } from "./fakes.js";
import { VALID_GRAPH_TEXT } from "./documents-fixture.js";
import {
  graphqlStub,
  officialSnapshotStub,
  snapshotBody,
} from "./graphql-fixture.js";

/** The `pushed_at` every settled repository carries. */
const PUSHED = "2026-10-20T10:00:00Z";

/** A push the tests move one repository to. */
const PUSHED_NEW = "2026-10-28T08:00:00Z";

/** Fixed run clocks; a visit is stamped with its run's `built_at`. */
const T1 = 1_791_022_400_000;
const T2 = 1_791_022_460_000;
const T3 = 1_791_022_520_000;
const ISO1 = new Date(T1).toISOString();
const ISO2 = new Date(T2).toISOString();
const ISO3 = new Date(T3).toISOString();

/** Zero-padded names, so one GraphQL stub never matches another repository. */
function repoNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `r-${String(i + 1).padStart(3, "0")}`);
}

/** One discovery page listing these names, short enough to be complete. */
function searchStub(
  names: string[],
  overrides: { pushedAt?: (name: string) => string; stars?: (name: string) => number } = {},
): Stub {
  const pushedAt = overrides.pushedAt ?? (() => PUSHED);
  const stars = overrides.stars ?? (() => 5);
  return {
    url: "search/repositories",
    status: 200,
    body: {
      total_count: names.length,
      items: names.map((name) => ({
        name,
        owner: { login: "acme" },
        default_branch: "main",
        stargazers_count: stars(name),
        updated_at: "2026-10-20T10:00:00Z",
        pushed_at: pushedAt(name),
      })),
    },
  };
}

/** One community repository holding a graph called flow, five stars. */
function repoSnapshot(name: string): Stub {
  return graphqlStub(name, snapshotBody({
    stars: 5,
    updated: "2026-10-20T10:00:00Z",
    branch: "main",
    graphs: [{ slug: "flow", text: VALID_GRAPH_TEXT, readme: `# ${name}\n` }],
  }));
}

async function run(
  stubs: Stub[],
  options: { kv?: FakeKV; budget?: number; now?: () => number } = {},
) {
  resetIndexMemo();
  const fake = fakeFetch(stubs);
  const kv = options.kv ?? new FakeKV();
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: null });
  const meta = await runIndexer({
    github,
    index: kv,
    authenticated: true,
    budget: options.budget,
    now: options.now,
  });
  return { meta, kv, fake };
}

/** The community repositories one run read, in the order it read them. */
function visitedCommunityRepos(fake: FakeFetch): string[] {
  const visited: string[] = [];
  fake.calls.forEach((url, call) => {
    if (!url.includes("graphql")) {
      return;
    }
    const name = /"name":"([^"]+)"/.exec(fake.bodies[call] ?? "")?.[1];
    if (name !== undefined && name !== "canopy-graphs") {
      visited.push(name);
    }
  });
  return visited;
}

/** The visit ledger as the run left it. */
async function storedRepos(kv: FakeKV): Promise<{
  version: number;
  repos: Record<string, { pushed_at: string | null; visited_at: string }>;
}> {
  const text = await kv.get(REPOS_KEY);
  expect(text).not.toBeNull();
  return JSON.parse(text as string) as {
    version: number;
    repos: Record<string, { pushed_at: string | null; visited_at: string }>;
  };
}

async function storedEntries(kv: FakeKV): Promise<
  Array<{ repo: string; slug: string; stars: number | null; name: string }>
> {
  const text = await kv.get("index:v1");
  expect(text).not.toBeNull();
  return (JSON.parse(text as string) as {
    entries: Array<{ repo: string; slug: string; stars: number | null; name: string }>;
  }).entries;
}

/** Sixty repositories read end to end in one run: the settled catalogue. */
async function settled(): Promise<{ kv: FakeKV; names: string[]; table: Stub[] }> {
  const kv = new FakeKV();
  const names = repoNames(60);
  const table = [officialSnapshotStub(), searchStub(names), ...names.map(repoSnapshot)];
  await run(table, { kv, budget: 2000, now: () => T1 });
  return { kv, names, table };
}

describe("the incremental visit", () => {
  it("visits forty of sixty repositories, then resumes with the rest", async () => {
    const kv = new FakeKV();
    const names = repoNames(60);
    const table = [officialSnapshotStub(), searchStub(names), ...names.map(repoSnapshot)];

    // Official (1) + discovery (1) + 40 repositories: the 41st repository's
    // call is the one the budget of 42 refuses.
    const first = await run(table, { kv, budget: 42, now: () => T1 });

    expect(first.meta.repos_visited).toBe(40);
    expect(first.meta.repos_pending).toBe(20);
    expect(first.meta.repos_unchanged).toBe(0);
    expect(first.meta.truncated).toBe(true);
    expect(first.meta.stopped).toBe("budget of 42 subrequests reached");
    expect(first.meta.subrequests).toBe(42);
    expect(visitedCommunityRepos(first.fake)).toEqual(names.slice(0, 40));
    const afterFirst = await storedRepos(kv);
    expect(afterFirst.version).toBe(INDEXER_VERSION);
    expect(Object.keys(afterFirst.repos).sort()).toEqual(
      names.slice(0, 40).map((name) => `acme/${name}`),
    );
    for (const visit of Object.values(afterFirst.repos)) {
      expect(visit).toEqual({ pushed_at: PUSHED, visited_at: ISO1 });
    }

    const second = await run(table, { kv, now: () => T2 });

    expect(second.meta.repos_visited).toBe(20);
    expect(second.meta.repos_pending).toBe(0);
    expect(second.meta.repos_unchanged).toBe(40);
    expect(second.meta.truncated).toBe(false);
    expect(second.meta.stopped).toBeNull();
    expect(second.meta.documents).toBe(72);
    // The resume order: the never-visited remainder, in discovery order.
    expect(visitedCommunityRepos(second.fake)).toEqual(names.slice(40));
    const afterSecond = await storedRepos(kv);
    expect(Object.keys(afterSecond.repos)).toHaveLength(60);
    for (const name of names.slice(0, 40)) {
      expect(afterSecond.repos[`acme/${name}`]?.visited_at).toBe(ISO1);
    }
    for (const name of names.slice(40)) {
      expect(afterSecond.repos[`acme/${name}`]).toEqual({
        pushed_at: PUSHED,
        visited_at: ISO2,
      });
    }
  });

  it("spends the official read plus discovery and writes only its meta when nothing moved", async () => {
    const { kv, table } = await settled();
    const before = await kv.get("index:v1");
    const beforeRepos = await kv.get(REPOS_KEY);

    kv.putOptions.length = 0;
    const third = await run(table, { kv, now: () => T3 });

    expect(third.meta.repos_visited).toBe(0);
    expect(third.meta.repos_pending).toBe(0);
    expect(third.meta.repos_unchanged).toBe(60);
    expect(third.meta.truncated).toBe(false);
    expect(third.meta.subrequests).toBe(2);
    expect(visitedCommunityRepos(third.fake)).toEqual([]);
    // The only key an unchanged run touches is its own accounting, and the
    // listing keeps the `built_at` of the run that last changed it.
    expect(kv.putOptions.map((option) => option.key)).toEqual(["index:meta"]);
    expect(await kv.get("index:v1")).toBe(before);
    expect(await kv.get(REPOS_KEY)).toBe(beforeRepos);
  });

  it("visits exactly the repository whose pushed_at moved", async () => {
    const { kv, names } = await settled();
    const table = [
      officialSnapshotStub(),
      searchStub(names, { pushedAt: (name) => (name === "r-007" ? PUSHED_NEW : PUSHED) }),
      ...names.map(repoSnapshot),
    ];

    const next = await run(table, { kv, now: () => T3 });

    expect(next.meta.repos_visited).toBe(1);
    expect(next.meta.repos_pending).toBe(0);
    expect(next.meta.repos_unchanged).toBe(59);
    expect(next.meta.truncated).toBe(false);
    expect(visitedCommunityRepos(next.fake)).toEqual(["r-007"]);
    const repos = await storedRepos(kv);
    expect(repos.repos["acme/r-007"]).toEqual({ pushed_at: PUSHED_NEW, visited_at: ISO3 });
    expect(repos.repos["acme/r-008"]).toEqual({ pushed_at: PUSHED, visited_at: ISO1 });
  });

  it("refreshes a moved star count without a visit", async () => {
    const { kv, names } = await settled();
    const table = [
      officialSnapshotStub(),
      searchStub(names, { stars: (name) => (name === "r-007" ? 99 : 5) }),
      ...names.map(repoSnapshot),
    ];

    const next = await run(table, { kv, now: () => T3 });

    expect(next.meta.repos_visited).toBe(0);
    expect(next.meta.repos_pending).toBe(0);
    expect(next.meta.repos_unchanged).toBe(60);
    expect(visitedCommunityRepos(next.fake)).toEqual([]);
    const entries = await storedEntries(kv);
    expect(entries.find((entry) => entry.repo === "r-007")?.stars).toBe(99);
    expect(entries.find((entry) => entry.repo === "r-008")?.stars).toBe(5);
  });

  it("rereads every repository when the stored version differs", async () => {
    const { kv, table, names } = await settled();
    const stored = await storedRepos(kv);
    await kv.put(REPOS_KEY, JSON.stringify({ version: INDEXER_VERSION + 1, repos: stored.repos }));

    const next = await run(table, { kv, budget: 42, now: () => T3 });

    expect(next.meta.repos_visited).toBe(40);
    expect(next.meta.repos_pending).toBe(20);
    expect(next.meta.repos_unchanged).toBe(0);
    expect(next.meta.truncated).toBe(true);
    expect(visitedCommunityRepos(next.fake)).toEqual(names.slice(0, 40));
    const repos = await storedRepos(kv);
    expect(repos.version).toBe(INDEXER_VERSION);
    expect(repos.repos["acme/r-001"]).toEqual({ pushed_at: PUSHED, visited_at: ISO3 });
  });

  it("keeps an unavailable repository pending with its previous entries", async () => {
    const { kv, names } = await settled();
    const table = [
      officialSnapshotStub(),
      searchStub(names, { pushedAt: (name) => (name === "r-007" ? PUSHED_NEW : PUSHED) }),
      ...names.map((name) =>
        name === "r-007" ? graphqlStub(name, { data: { repository: null } }) : repoSnapshot(name)
      ),
    ];

    const next = await run(table, { kv, now: () => T3 });

    // Pushed, but unread: it stays pending, and the run is truncated.
    expect(next.meta.repos_visited).toBe(0);
    expect(next.meta.repos_pending).toBe(1);
    expect(next.meta.repos_unchanged).toBe(59);
    expect(next.meta.truncated).toBe(true);
    const entries = await storedEntries(kv);
    expect(entries.find((entry) => entry.repo === "r-007")?.name).toBe("hello-graph");
    // No successful visit, no new state: the old push and visit stand.
    const repos = await storedRepos(kv);
    expect(repos.repos["acme/r-007"]).toEqual({ pushed_at: PUSHED, visited_at: ISO1 });
  });

  it("drops a repository a completed discovery no longer lists", async () => {
    const { kv, names } = await settled();
    const kept = names.filter((name) => name !== "r-007");
    const table = [officialSnapshotStub(), searchStub(kept), ...names.map(repoSnapshot)];

    const next = await run(table, { kv, now: () => T3 });

    expect(next.meta.repos_visited).toBe(0);
    expect(next.meta.repos_pending).toBe(0);
    expect(next.meta.repos_unchanged).toBe(59);
    const entries = await storedEntries(kv);
    expect(entries.some((entry) => entry.repo === "r-007")).toBe(false);
    const repos = await storedRepos(kv);
    expect(repos.repos["acme/r-007"]).toBeUndefined();
    expect(Object.keys(repos.repos)).toHaveLength(59);
    expect(await kv.get(docKey("graph", "acme", "r-007", "flow"))).toBeNull();
  });

  it("records a blocked repository as visited without a contents call", async () => {
    const names = ["r-001", "r-002"];
    const table = [
      officialSnapshotStub({
        blocked: JSON.stringify([{
          repo: "acme/r-002",
          reason: "Broken or invalid",
          issue: "https://github.com/UniverLab/canopy-graphs/issues/9",
          blocked_at: "2026-10-27",
        }]),
      }),
      searchStub(names),
      ...names.map(repoSnapshot),
    ];
    const kv = new FakeKV();

    const first = await run(table, { kv, now: () => T1 });

    expect(first.meta.repos_visited).toBe(2);
    expect(first.meta.repos_pending).toBe(0);
    expect(visitedCommunityRepos(first.fake)).toEqual(["r-001"]);
    const repos = await storedRepos(kv);
    expect(repos.repos["acme/r-002"]).toEqual({ pushed_at: PUSHED, visited_at: ISO1 });
    const entries = await storedEntries(kv);
    expect(entries.some((entry) => entry.repo === "r-002")).toBe(false);

    // The recorded visit stands: the next run skips it as unchanged.
    const second = await run(table, { kv, now: () => T3 });
    expect(second.meta.repos_visited).toBe(0);
    expect(second.meta.repos_unchanged).toBe(2);
    expect((await storedRepos(kv)).repos["acme/r-002"]).toEqual({
      pushed_at: PUSHED,
      visited_at: ISO1,
    });
  });

  it("rereads every repository when the ledger does not parse", async () => {
    const { kv, table, names } = await settled();
    await kv.put(REPOS_KEY, "not json{");

    const next = await run(table, { kv, budget: 42, now: () => T3 });

    expect(next.meta.repos_visited).toBe(40);
    expect(next.meta.repos_pending).toBe(20);
    expect(next.meta.repos_unchanged).toBe(0);
    expect(next.meta.truncated).toBe(true);
    expect(visitedCommunityRepos(next.fake)).toEqual(names.slice(0, 40));
    const repos = await storedRepos(kv);
    expect(repos.version).toBe(INDEXER_VERSION);
    expect(repos.repos["acme/r-001"]).toEqual({ pushed_at: PUSHED, visited_at: ISO3 });
  });

  it("visits the oldest visit first when several repositories changed", async () => {
    const kv = new FakeKV();
    const names = repoNames(60);
    const table = [officialSnapshotStub(), searchStub(names), ...names.map(repoSnapshot)];
    await run(table, { kv, budget: 42, now: () => T1 });
    await run(table, { kv, now: () => T2 });

    // r-001 was visited at T1, r-050 at T2, but discovery now lists r-050
    // first: the resume order follows the oldest visit, not the listing.
    const reordered = names.filter((name) => name !== "r-001" && name !== "r-050");
    reordered.unshift("r-050", "r-001");
    const bumped = new Set(["r-001", "r-050"]);
    const third = await run(
      [
        officialSnapshotStub(),
        searchStub(reordered, { pushedAt: (name) => (bumped.has(name) ? PUSHED_NEW : PUSHED) }),
        ...names.map(repoSnapshot),
      ],
      { kv, budget: 3, now: () => T3 },
    );

    expect(third.meta.repos_visited).toBe(1);
    expect(third.meta.repos_pending).toBe(1);
    expect(third.meta.repos_unchanged).toBe(58);
    expect(third.meta.truncated).toBe(true);
    expect(third.meta.stopped).toBe("budget of 3 subrequests reached");
    expect(visitedCommunityRepos(third.fake)).toEqual(["r-001"]);
    const repos = await storedRepos(kv);
    expect(repos.repos["acme/r-001"]).toEqual({ pushed_at: PUSHED_NEW, visited_at: ISO3 });
    expect(repos.repos["acme/r-050"]).toEqual({ pushed_at: PUSHED, visited_at: ISO2 });
  });

  it("keeps the visits and entries of a discovery it could not read", async () => {
    const { kv } = await settled();
    const beforeRepos = await kv.get(REPOS_KEY);
    const beforeIndex = await kv.get("index:v1");

    kv.putOptions.length = 0;
    const next = await run(
      [officialSnapshotStub(), { url: "search/repositories", status: 500, body: {} }],
      { kv, now: () => T3 },
    );

    // A failed page proves nothing gone: no visit, no prune, no deletion.
    expect(next.meta.repos_visited).toBe(0);
    expect(next.meta.repos_pending).toBe(0);
    expect(next.meta.repos_unchanged).toBe(0);
    expect(next.meta.truncated).toBe(false);
    expect(next.meta.documents).toBe(72);
    expect(kv.putOptions.map((option) => option.key)).toEqual(["index:meta"]);
    expect(await kv.get(REPOS_KEY)).toBe(beforeRepos);
    expect(await kv.get("index:v1")).toBe(beforeIndex);
    expect(Object.keys((await storedRepos(kv)).repos)).toHaveLength(60);
  });
});
