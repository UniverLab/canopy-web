// SPDX-License-Identifier: Apache-2.0
/**
 * The scheduled indexer, against the fake GitHub the worker tests share:
 * discovery over two search pages, invalid documents recorded and
 * skipped, the budget cut-off carrying over unvisited repositories,
 * deletion of vanished document keys, official entries flagged, and the
 * single subrequest budget — authenticated runs over a GraphQL fixture the
 * size of the real official repository, REST runs when there is no token.
 * The fake transport refuses the free plan's 51st subrequest. The read
 * side's memo is pinned here too.
 */
import { describe, expect, it } from "vitest";
import { createGitHub, type CacheLike } from "../src/github.js";
import {
  SUBREQUEST_BUDGET,
  buildIndexPayload,
  discoveryUrl,
  runIndexer,
} from "../src/indexer.js";
import { createStore, docKey, patternKey, resetIndexMemo, type IndexEntry } from "../src/store.js";
import { blockedDocKey, blockedRepoKey, type BlockedEntry } from "../src/blocked.js";
import {
  FakeCache,
  FakeKV,
  SUBREQUEST_LIMIT,
  SubrequestMeter,
  fakeFetch,
  fileBody,
  meteredFetch,
  type Stub,
} from "./fakes.js";
import { officialStubs } from "./stubs.js";
import {
  BROKEN_NODE_TEXT,
  INVALID_GRAPH_TEXT,
  VALID_GRAPH_TEXT,
} from "./documents-fixture.js";
import {
  OFFICIAL_GRAPH_SLUGS,
  OFFICIAL_NODE_SLUGS,
  PATTERN_SLUGS,
  communitySnapshotStub,
  emptySearchStub,
  graphqlStub,
  officialSnapshotStub,
  patternPage,
  snapshotBody,
} from "./graphql-fixture.js";

const OFFICIAL_GRAPHS = "repos/UniverLab/canopy-graphs/contents/graphs";
const OFFICIAL_NODES = "repos/UniverLab/canopy-graphs/contents/nodes";
const OFFICIAL_BLOCKED = "repos/UniverLab/canopy-graphs/contents/blocked.json";
const OFFICIAL_REPO = "repos/UniverLab/canopy-graphs";

/** A budget no test reaches by accident: the REST fixtures are not the point. */
const TEST_BUDGET = 2000;

/** The issue every blocked fixture names. */
const BLOCK_ISSUE = "https://github.com/UniverLab/canopy-graphs/issues/9";

/** An empty official repository: both directories missing, the repo known. */
function emptyOfficialStubs(): Stub[] {
  return [
    { url: OFFICIAL_BLOCKED, status: 404, body: {} },
    { url: OFFICIAL_GRAPHS, status: 404, body: {} },
    { url: OFFICIAL_NODES, status: 404, body: {} },
    { url: OFFICIAL_REPO, status: 200, body: { stargazers_count: 3, default_branch: "main" } },
  ];
}

/** The removal list as the contents API serves it: base64 JSON in a file body. */
function blockedStubs(entries: unknown[]): Stub[] {
  return [
    {
      url: OFFICIAL_BLOCKED,
      status: 200,
      body: fileBody("blocked.json", JSON.stringify(entries)),
    },
  ];
}

/** The empty official stubs with the removal list replaced by these entries. */
function withBlocks(entries: unknown[]): Stub[] {
  return [
    ...emptyOfficialStubs().filter((stub) => stub.url !== OFFICIAL_BLOCKED),
    ...blockedStubs(entries),
  ];
}

function searchHit(name: string, stars: number): Record<string, unknown> {
  return {
    name,
    owner: { login: "acme" },
    default_branch: "main",
    stargazers_count: stars,
    updated_at: "2026-10-20T10:00:00Z",
  };
}

/** One community repository holding a graph called flow, README included. */
function repoStubs(name: string, stars: number, graphText: string = VALID_GRAPH_TEXT): Stub[] {
  const base = `repos/acme/${name}`;
  return [
    {
      url: `${base}/git/trees/main`,
      status: 200,
      body: { tree: [{ path: "graphs/flow/graph.json", type: "blob" }] },
    },
    {
      url: `${base}/contents/graphs/flow/graph.json`,
      status: 200,
      body: fileBody("graphs/flow/graph.json", graphText),
    },
    {
      url: `${base}/contents/graphs/flow/README.md`,
      status: 200,
      body: fileBody("graphs/flow/README.md", `# ${name}\n`),
    },
  ];
}

interface RunOptions {
  authenticated?: boolean;
  budget?: number;
  kv?: FakeKV;
  now?: () => number;
  /** The cache wired into the transport; the cron path passes none. */
  cache?: CacheLike | null;
  /** The free-plan meter every outbound call is counted against. */
  meter?: SubrequestMeter;
}

async function run(stubs: Stub[], options: RunOptions = {}) {
  resetIndexMemo();
  const fake = fakeFetch(stubs);
  const kv = options.kv ?? new FakeKV();
  const github = createGitHub({
    fetchImpl: options.meter === undefined ? fake.fetchImpl : meteredFetch(fake, options.meter),
    cache: options.cache ?? null,
  });
  const meta = await runIndexer({
    github,
    index: kv,
    authenticated: options.authenticated ?? true,
    budget: options.budget,
    now: options.now,
  });
  return { meta, kv, fake };
}

async function storedIndex(kv: FakeKV): Promise<{
  built_at: string;
  entries: Array<Record<string, unknown>>;
}> {
  const text = await kv.get("index:v1");
  expect(text).not.toBeNull();
  return JSON.parse(text as string) as { built_at: string; entries: Array<Record<string, unknown>> };
}

describe("the scheduled indexer", () => {
  it("discovers repositories over two search pages and indexes every document", async () => {
    const names = Array.from({ length: 100 }, (_, i) => `r-${String(i + 1).padStart(3, "0")}`);
    const stubs: Stub[] = [
      ...emptyOfficialStubs(),
      { url: discoveryUrl(1), status: 200, body: { total_count: 101, items: names.map((name, i) => searchHit(name, i + 1)) } },
      {
        url: discoveryUrl(2),
        status: 200,
        body: {
          total_count: 101,
          items: [
            searchHit("r-101", 101),
            // The official repository carries the catalogue topic too and
            // is already indexed as official; it must not appear twice.
            { name: "canopy-graphs", owner: { login: "UniverLab" }, default_branch: "main", stargazers_count: 9 },
          ],
        },
      },
      ...names.flatMap((name, i) => repoStubs(name, i + 1)),
      ...repoStubs("r-101", 101),
    ];
    const { meta, kv, fake } = await run(stubs, { authenticated: false, budget: TEST_BUDGET });

    expect(meta.documents).toBe(101);
    expect(meta.repos_seen).toBe(102);
    expect(meta.truncated).toBe(false);
    expect(meta.authenticated).toBe(false);
    expect(meta.stopped).toBeNull();
    expect(meta.invalid).toEqual([]);
    // Removal list (1) + official (4: graphs, nodes, repo, patterns) + two
    // search pages (2) + one tree, document and README per repository
    // (101 x 3): every call counted.
    expect(meta.calls).toBe(5 + 2 + 101 * 3);
    expect(fake.calls.length).toBe(meta.calls);
    const searches = fake.calls.filter((url) => url.includes("search/repositories"));
    expect(searches.length).toBe(2);
    for (const url of searches) {
      expect(url).toContain("per_page=100");
      expect(url).toContain("sort=stars");
      expect(url).toContain("topic%3Acanopy-graph");
    }

    const index = await storedIndex(kv);
    expect(index.entries.length).toBe(101);
    const first = index.entries[0] as Record<string, unknown>;
    expect(first["slug"]).toBe("flow");
    expect(first["repo"]).toBe("r-001");
    expect(first["official"]).toBe(false);
    expect(first["stars"]).toBe(1);
    expect(first["updated"]).toBe("2026-10-20");
    expect(first["ref"]).toBe("main");
    expect(first["name"]).toBe("hello-graph");
    const docText = await kv.get(docKey("graph", "acme", "r-001", "flow"));
    expect(docText).not.toBeNull();
    const stored = JSON.parse(docText as string) as { document: { name: string }; readme: string };
    expect(stored.document.name).toBe("hello-graph");
    expect(stored.readme).toBe("# r-001\n");
  });

  it("records invalid documents in the meta and leaves them out", async () => {
    const base = "repos/acme/things";
    const { meta, kv } = await run([
      ...emptyOfficialStubs(),
      {
        url: "search/repositories",
        status: 200,
        body: { total_count: 1, items: [searchHit("things", 5)] },
      },
      {
        url: `${base}/git/trees/main`,
        status: 200,
        body: {
          tree: [
            { path: "graphs/flow/graph.json", type: "blob" },
            { path: "graphs/broken/graph.json", type: "blob" },
            { path: "nodes/void/node.json", type: "blob" },
            { path: "graphs/garbled/graph.json", type: "blob" },
            { path: "graphs/gone/graph.json", type: "blob" },
          ],
        },
      },
      { url: `${base}/contents/graphs/flow/graph.json`, status: 200, body: fileBody("graphs/flow/graph.json", VALID_GRAPH_TEXT) },
      { url: `${base}/contents/graphs/flow/README.md`, status: 404, body: {} },
      { url: `${base}/contents/graphs/broken/graph.json`, status: 200, body: fileBody("graphs/broken/graph.json", INVALID_GRAPH_TEXT) },
      { url: `${base}/contents/nodes/void/node.json`, status: 200, body: fileBody("nodes/void/node.json", BROKEN_NODE_TEXT) },
      { url: `${base}/contents/graphs/garbled/graph.json`, status: 200, body: fileBody("graphs/garbled/graph.json", "this is not json") },
      { url: `${base}/contents/graphs/gone/graph.json`, status: 404, body: {} },
    ], { authenticated: false });

    const index = await storedIndex(kv);
    expect(index.entries.map((entry) => entry["slug"])).toEqual(["flow"]);
    expect(meta.documents).toBe(1);
    // The schema failures and the unparseable file are recorded with
    // their reasons; the missing file is an ordinary miss, not invalid.
    expect(meta.invalid).toEqual([
      { repo: "acme/things", slug: "broken", reason: "schema validation failed" },
      { repo: "acme/things", slug: "void", reason: "schema validation failed" },
      { repo: "acme/things", slug: "garbled", reason: "unparseable JSON" },
    ]);
    expect(await kv.get(docKey("graph", "acme", "things", "broken"))).toBeNull();
  });

  it("carries over unvisited repositories when the REST budget cuts the run", async () => {
    const kv = new FakeKV();
    const previousEntry = (repo: string, slug: string, name: string): Record<string, unknown> => ({
      kind: "graph",
      owner: "acme",
      repo,
      slug,
      name,
      description: `${name} description`,
      official: false,
      stars: 1,
      updated: null,
      ref: "main",
    });
    await kv.put("index:v1", JSON.stringify({
      built_at: "2026-10-26T00:00:00.000Z",
      entries: [previousEntry("one", "flow", "Old one"), previousEntry("two", "old", "Old two")],
    }));
    await kv.put(
      docKey("graph", "acme", "one", "flow"),
      JSON.stringify({ document: { name: "Old one" }, readme: "old one readme" }),
    );
    await kv.put(
      docKey("graph", "acme", "two", "old"),
      JSON.stringify({ document: { name: "Old two" }, readme: "old two readme" }),
    );

    // Removal list (1) + official (4: graphs, nodes, repo, patterns) +
    // search (1) + one full repository (tree, document, README): the ninth
    // call spends the budget of 9, and the second repository is never
    // visited.
    const { meta, fake } = await run(
      [
        ...emptyOfficialStubs(),
        {
          url: "search/repositories",
          status: 200,
          body: { total_count: 2, items: [searchHit("one", 4), searchHit("two", 6)] },
        },
        ...repoStubs("one", 4),
        ...repoStubs("two", 6),
      ],
      { kv, budget: 9, authenticated: false },
    );

    expect(meta.calls).toBe(9);
    expect(meta.subrequests).toBe(9);
    expect(fake.calls.length).toBe(9);
    expect(meta.truncated).toBe(true);
    expect(meta.stopped).toBe("budget of 9 subrequests reached");
    const index = await storedIndex(kv);
    expect(index.entries.map((entry) => `${entry["repo"]}/${entry["slug"]}`).sort()).toEqual([
      "one/flow",
      "two/old",
    ]);
    // The visited repository is re-indexed; the unvisited one keeps its
    // previous entry and its untouched document key.
    const one = index.entries.find((entry) => entry["repo"] === "one") as Record<string, unknown>;
    expect(one["name"]).toBe("hello-graph");
    const two = index.entries.find((entry) => entry["repo"] === "two") as Record<string, unknown>;
    expect(two["name"]).toBe("Old two");
    expect(JSON.parse((await kv.get(docKey("graph", "acme", "two", "old"))) as string)).toEqual({
      document: { name: "Old two" },
      readme: "old two readme",
    });
    const oneDoc = JSON.parse((await kv.get(docKey("graph", "acme", "one", "flow"))) as string) as {
      document: { name: string };
    };
    expect(oneDoc.document.name).toBe("hello-graph");
  });

  it("carries over repositories beyond GitHub's 1,000-result cap", async () => {
    const kv = new FakeKV();
    const previous = (repo: string, slug: string): Record<string, unknown> => ({
      kind: "graph",
      owner: "acme",
      repo,
      slug,
      name: slug,
      description: "",
      official: false,
      stars: null,
      updated: null,
      ref: "main",
    });
    await kv.put("index:v1", JSON.stringify({
      built_at: "2026-10-26T00:00:00.000Z",
      entries: [previous("r-001", "flow"), previous("beyond", "x")],
    }));
    for (const [repo, slug] of [["r-001", "flow"], ["beyond", "x"]] as const) {
      await kv.put(docKey("graph", "acme", repo, slug), JSON.stringify({ document: { name: slug }, readme: "" }));
    }

    // Ten full pages: GitHub's cap, every repository with an empty tree
    // (one call each, no documents). The run spends 1,015 of the override's
    // 2,000 calls here: this case is about the discovery cap, not the budget.
    const stubs: Stub[] = [...emptyOfficialStubs()];
    for (let page = 1; page <= 10; page += 1) {
      const names = Array.from({ length: 100 }, (_, i) => `r-${String((page - 1) * 100 + i + 1).padStart(3, "0")}`);
      stubs.push({
        url: discoveryUrl(page),
        status: 200,
        body: { total_count: 1001, items: names.map((name, i) => searchHit(name, i + 1)) },
      });
      for (const name of names) {
        stubs.push({
          url: `repos/acme/${name}/git/trees/main`,
          status: 200,
          body: { tree: [] },
        });
      }
    }
    const { meta } = await run(stubs, { kv, authenticated: false, budget: TEST_BUDGET });

    expect(meta.truncated).toBe(true);
    expect(meta.calls).toBe(5 + 10 + 1000);
    const index = await storedIndex(kv);
    // The visited repository had no documents, so its previous entry is
    // gone; the repository beyond the cap was never proven gone, so its
    // previous entry — and its document key — carry over.
    expect(index.entries.map((e) => `${e["repo"]}/${e["slug"]}`)).toEqual(["beyond/x"]);
    expect(await kv.get(docKey("graph", "acme", "r-001", "flow"))).toBeNull();
    expect(await kv.get(docKey("graph", "acme", "beyond", "x"))).not.toBeNull();
  });

  it("deletes the keys of documents that disappeared", async () => {
    const kv = new FakeKV();
    const entry = (repo: string, slug: string): Record<string, unknown> => ({
      kind: "graph",
      owner: "acme",
      repo,
      slug,
      name: slug,
      description: "",
      official: false,
      stars: null,
      updated: null,
      ref: "main",
    });
    await kv.put("index:v1", JSON.stringify({
      built_at: "2026-10-26T00:00:00.000Z",
      entries: [entry("one", "flow"), entry("one", "gone"), entry("vanished", "x")],
    }));
    for (const [repo, slug] of [["one", "flow"], ["one", "gone"], ["vanished", "x"]] as const) {
      await kv.put(docKey("graph", "acme", repo, slug), JSON.stringify({ document: { name: slug }, readme: "" }));
    }

    await run(
      [
        ...emptyOfficialStubs(),
        {
          url: "search/repositories",
          status: 200,
          body: { total_count: 1, items: [searchHit("one", 4)] },
        },
        ...repoStubs("one", 4),
      ],
      { kv, authenticated: false },
    );

    const index = await storedIndex(kv);
    expect(index.entries.map((e) => `${e["repo"]}/${e["slug"]}`)).toEqual(["one/flow"]);
    // The dropped folder in a visited repository and the repository a
    // completed discovery no longer lists both lose their keys.
    expect(await kv.get(docKey("graph", "acme", "one", "gone"))).toBeNull();
    expect(await kv.get(docKey("graph", "acme", "vanished", "x"))).toBeNull();
    expect(await kv.get(docKey("graph", "acme", "one", "flow"))).not.toBeNull();
  });

  it("skips a blocked document, records its key and deletes a stale one", async () => {
    const kv = new FakeKV();
    const staleKey = blockedRepoKey("acme", "gone");
    const stale: BlockedEntry = {
      repo: "acme/gone",
      reason: "Broken or invalid",
      issue: BLOCK_ISSUE,
      blocked_at: "2026-10-01",
    };
    await kv.put(staleKey, JSON.stringify(stale));
    const block: BlockedEntry = {
      kind: "graph",
      repo: "acme/things",
      slug: "toxic",
      reason: "Malicious or dangerous command",
      issue: BLOCK_ISSUE,
      blocked_at: "2026-10-27",
    };
    const base = "repos/acme/things";
    const { meta, fake } = await run([
      ...withBlocks([block]),
      {
        url: "search/repositories",
        status: 200,
        body: { total_count: 1, items: [searchHit("things", 5)] },
      },
      {
        url: `${base}/git/trees/main`,
        status: 200,
        body: {
          tree: [
            { path: "graphs/flow/graph.json", type: "blob" },
            { path: "graphs/toxic/graph.json", type: "blob" },
          ],
        },
      },
      { url: `${base}/contents/graphs/flow/graph.json`, status: 200, body: fileBody("graphs/flow/graph.json", VALID_GRAPH_TEXT) },
      { url: `${base}/contents/graphs/flow/README.md`, status: 404, body: {} },
      // Stubbed valid on purpose: the skip, not a missing file, drops it.
      { url: `${base}/contents/graphs/toxic/graph.json`, status: 200, body: fileBody("graphs/toxic/graph.json", VALID_GRAPH_TEXT) },
    ], { kv, authenticated: false });

    const index = await storedIndex(kv);
    expect(index.entries.map((entry) => entry["slug"])).toEqual(["flow"]);
    expect(fake.calls.some((url) => url.includes("graphs/toxic"))).toBe(false);
    expect(meta.documents).toBe(1);
    expect(meta.blocked).toBe(1);
    expect(JSON.parse((await kv.get(blockedDocKey("graph", "acme", "things", "toxic"))) as string))
      .toEqual(block);
    expect(await kv.get(docKey("graph", "acme", "things", "toxic"))).toBeNull();
    // The list was read and no longer names acme/gone: its key goes.
    expect(kv.has(staleKey)).toBe(false);
  });

  it("skips a blocked repository before its tree call", async () => {
    const block: BlockedEntry = {
      repo: "acme/evil",
      reason: "Prompt that steers the agent to do harm",
      issue: BLOCK_ISSUE,
      blocked_at: "2026-10-27",
    };
    const { meta, kv, fake } = await run([
      ...withBlocks([block]),
      {
        url: "search/repositories",
        status: 200,
        body: {
          total_count: 2,
          items: [searchHit("evil", 9), searchHit("things", 5)],
        },
      },
      ...repoStubs("things", 5),
    ], { authenticated: false });

    const index = await storedIndex(kv);
    expect(index.entries.map((entry) => `${entry["repo"]}/${entry["slug"]}`)).toEqual([
      "things/flow",
    ]);
    expect(fake.calls.some((url) => url.includes("repos/acme/evil"))).toBe(false);
    expect(meta.blocked).toBe(1);
    expect(JSON.parse((await kv.get(blockedRepoKey("acme", "evil"))) as string)).toEqual(block);
  });

  it("drops a blocked document from the carried-over entries", async () => {
    const kv = new FakeKV();
    await kv.put("index:v1", JSON.stringify({
      built_at: "2026-10-26T00:00:00.000Z",
      entries: [{
        kind: "graph",
        owner: "acme",
        repo: "old",
        slug: "x",
        name: "x",
        description: "",
        official: false,
        stars: null,
        updated: null,
        ref: "main",
      }],
    }));
    await kv.put(
      docKey("graph", "acme", "old", "x"),
      JSON.stringify({ document: { name: "x" }, readme: "" }),
    );
    const block: BlockedEntry = {
      kind: "graph",
      repo: "acme/old",
      slug: "x",
      reason: "Misleading description",
      issue: BLOCK_ISSUE,
      blocked_at: "2026-10-27",
    };

    // Discovery fails, so the previous entry would normally carry over.
    const { meta } = await run(
      [...withBlocks([block]), { url: "search/repositories", status: 500, body: {} }],
      { kv, authenticated: false },
    );

    const index = await storedIndex(kv);
    expect(index.entries).toEqual([]);
    expect(meta.documents).toBe(0);
    expect(await kv.get(docKey("graph", "acme", "old", "x"))).toBeNull();
  });

  it("keeps the previous block keys when the list cannot be read", async () => {
    const kv = new FakeKV();
    const key = blockedDocKey("graph", "UniverLab", "canopy-graphs", "hello-graph");
    const block: BlockedEntry = {
      kind: "graph",
      repo: "UniverLab/canopy-graphs",
      slug: "hello-graph",
      reason: "Copyright or licence",
      issue: BLOCK_ISSUE,
      blocked_at: "2026-10-27",
    };
    await kv.put(key, JSON.stringify(block));

    // officialStubs() answers 404 for blocked.json.
    const { meta } = await run(officialStubs(), { kv, authenticated: false });

    expect(meta.blocked).toBe(0);
    expect(kv.has(key)).toBe(true);
  });

  it("flags official entries and indexes the official repository in the same run", async () => {
    const { meta, kv } = await run(officialStubs(), { authenticated: false });
    const index = await storedIndex(kv);
    expect(index.entries.length).toBe(2);
    for (const entry of index.entries) {
      expect(entry["official"]).toBe(true);
      expect(entry["owner"]).toBe("UniverLab");
      expect(entry["stars"]).toBe(7);
    }
    expect(index.entries.map((entry) => `${entry["kind"]}/${entry["slug"]}`).sort()).toEqual([
      "graph/hello-graph",
      "node/hello-node",
    ]);
    expect(meta.documents).toBe(2);
    expect(meta.repos_seen).toBe(1);
    expect(meta.truncated).toBe(false);
    expect(await kv.get(docKey("graph", "UniverLab", "canopy-graphs", "hello-graph"))).not.toBeNull();
  });

  it("indexes the official repository once even when discovery returns it", async () => {
    // canopy-graphs carries the catalogue topic, so the topic search finds
    // it as a community repo: the run must not list its documents twice.
    const { meta, kv, fake } = await run([
      ...officialStubs(),
      {
        url: "search/repositories",
        status: 200,
        body: {
          total_count: 1,
          items: [
            { name: "canopy-graphs", owner: { login: "UniverLab" }, default_branch: "main", stargazers_count: 9 },
          ],
        },
      },
      // Would-be community answers for the same documents, never fetched:
      // the queued set already holds the official repository.
      { url: "repos/UniverLab/canopy-graphs/git/trees/main", status: 200, body: { tree: [{ path: "graphs/hello-graph/graph.json", type: "blob" }] } },
    ], { authenticated: false });

    const index = await storedIndex(kv);
    expect(index.entries.map((entry) => `${entry["kind"]}/${entry["slug"]}`).sort()).toEqual([
      "graph/hello-graph",
      "node/hello-node",
    ]);
    for (const entry of index.entries) {
      expect(entry["official"]).toBe(true);
    }
    expect(meta.documents).toBe(2);
    expect(fake.calls.some((url) => url.includes("git/trees"))).toBe(false);
  });

  it("keeps the previous entries when discovery fails", async () => {
    const kv = new FakeKV();
    await kv.put("index:v1", JSON.stringify({
      built_at: "2026-10-26T00:00:00.000Z",
      entries: [{
        kind: "graph",
        owner: "acme",
        repo: "things",
        slug: "flow",
        name: "flow",
        description: "",
        official: false,
        stars: 2,
        updated: null,
        ref: "main",
      }],
    }));
    await kv.put(
      docKey("graph", "acme", "things", "flow"),
      JSON.stringify({ document: { name: "flow" }, readme: "" }),
    );

    const { meta } = await run(
      [...emptyOfficialStubs(), { url: "search/repositories", status: 500, body: {} }],
      { kv, authenticated: false },
    );
    const index = await storedIndex(kv);
    // The failed discovery proves nothing gone: the entry stays, with
    // its key, and the run still writes fresh meta.
    expect(index.entries.length).toBe(1);
    expect(index.entries[0]["slug"]).toBe("flow");
    expect(await kv.get(docKey("graph", "acme", "things", "flow"))).not.toBeNull();
    expect(meta.documents).toBe(1);
    expect(meta.truncated).toBe(false);
  });

  it("stops at the single subrequest budget and says why in the meta", async () => {
    expect(SUBREQUEST_BUDGET).toBe(45);
    const names = Array.from({ length: 25 }, (_, i) => `r-${String(i + 1).padStart(2, "0")}`);
    const { meta, fake } = await run(
      [
        ...emptyOfficialStubs(),
        {
          url: "search/repositories",
          status: 200,
          body: { total_count: 25, items: names.map((name, i) => searchHit(name, i + 1)) },
        },
        ...names.flatMap((name, i) => repoStubs(name, i + 1)),
      ],
      { authenticated: false },
    );
    expect(meta.authenticated).toBe(false);
    expect(meta.subrequests).toBe(45);
    expect(meta.calls).toBe(45);
    expect(fake.calls.length).toBe(45);
    expect(meta.truncated).toBe(true);
    expect(meta.stopped).toBe("budget of 45 subrequests reached");
    // Official (5, patterns listed) + search + thirteen full repositories
    // (3 calls each) spend exactly 45; the fourteenth repository's tree is
    // the call the budget refuses, so it is never visited and nothing of
    // it is written.
    expect(meta.documents).toBe(13);
    expect(meta.repos_seen).toBe(14);
  });

  it("stamps the meta with the run's clock and duration", async () => {
    let tick = 1_791_000_000_000;
    const { meta } = await run(officialStubs(), {
      now: () => (tick += 500),
      authenticated: false,
    });
    expect(meta.built_at).toBe(new Date(1_791_000_000_500).toISOString());
    expect(meta.duration_ms).toBe(500);
  });
});

describe("the GraphQL snapshot run", () => {
  it("indexes the whole official repository in two subrequests", async () => {
    // The transport refuses the free plan's 51st subrequest, cache operations
    // included: this run may spend two, one GraphQL answer and one search.
    const meter = new SubrequestMeter(SUBREQUEST_LIMIT);
    const { meta, kv, fake } = await run(
      [officialSnapshotStub(), emptySearchStub()],
      { authenticated: true, meter },
    );

    expect(meta.subrequests).toBe(2);
    expect(meta.calls).toBe(2);
    expect(meta.stopped).toBeNull();
    expect(meta.truncated).toBe(false);
    expect(meta.authenticated).toBe(true);
    expect(meta.invalid).toEqual([]);
    expect(meta.repos_seen).toBe(1);
    expect(meter.total).toBe(2);
    // The cron transport has no cache at all, so no cache operation is spent.
    expect(meter.cacheOps).toBe(0);
    expect(fake.missing).toEqual([]);
    expect(fake.calls.filter((url) => url.includes("graphql"))).toHaveLength(1);
    expect(fake.calls.filter((url) => url.includes("search/repositories"))).toHaveLength(1);

    // Every document: 3 graphs and 9 nodes, each with its README.
    expect(meta.documents).toBe(12);
    const index = await storedIndex(kv);
    expect(index.entries.map((entry) => entry["slug"]).sort()).toEqual(
      [...OFFICIAL_GRAPH_SLUGS, ...OFFICIAL_NODE_SLUGS].sort(),
    );
    for (const entry of index.entries) {
      expect(entry["official"]).toBe(true);
      expect(entry["owner"]).toBe("UniverLab");
      expect(entry["stars"]).toBe(7);
      expect(entry["updated"]).toBe("2026-10-27");
      expect(entry["ref"]).toBe("main");
    }
    const graph = JSON.parse(
      (await kv.get(docKey("graph", "UniverLab", "canopy-graphs", "graph-alpha"))) as string,
    ) as { document: { name: string }; readme: string };
    expect(graph.document.name).toBe("hello-graph");
    expect(graph.readme).toBe("# graph-alpha\n");
    const node = JSON.parse(
      (await kv.get(docKey("node", "UniverLab", "canopy-graphs", "node-india"))) as string,
    ) as { document: { name: string } };
    expect(node.document.name).toBe("hello-node");

    // Every pattern page, figures included, again from the same answer.
    const patterns = JSON.parse((await kv.get("patterns:v1")) as string) as {
      entries: Array<{ slug: string; title: string }>;
    };
    expect(patterns.entries.map((entry) => entry.slug).sort()).toEqual([...PATTERN_SLUGS].sort());
    const page = JSON.parse(
      (await kv.get(patternKey("pattern-alpha"))) as string,
    ) as { title: string; body: string; sources: unknown[]; figure: { name: string } };
    expect(page.title).toBe("Page pattern-alpha");
    expect(page.body.trim()).toBe("The pattern-alpha page.");
    expect(page.sources).toHaveLength(1);
    expect(page.figure.name).toBe("hello-graph");
  });

  it("reads each community repository in one GraphQL request", async () => {
    const { meta, kv, fake } = await run(
      [
        officialSnapshotStub(),
        {
          url: "search/repositories",
          status: 200,
          body: { total_count: 1, items: [searchHit("things", 2)] },
        },
        communitySnapshotStub(),
      ],
      { authenticated: true },
    );

    // Official answer (1) + discovery (1) + the community repository (1).
    expect(meta.subrequests).toBe(3);
    expect(meta.stopped).toBeNull();
    expect(fake.calls.filter((url) => url.includes("graphql"))).toHaveLength(2);
    expect(fake.calls.some((url) => url.includes("contents") || url.includes("git/trees")))
      .toBe(false);
    const index = await storedIndex(kv);
    const community = index.entries.filter((entry) => entry["official"] === false);
    expect(community.map((entry) => `${entry["repo"]}/${entry["slug"]}`)).toEqual(["things/flow"]);
    expect(community[0]["stars"]).toBe(2);
    expect(community[0]["ref"]).toBe("main");
  });

  it("names why a document could not be read and keeps the rest", async () => {
    const partial = graphqlStub("canopy-graphs", snapshotBody({
      blocked: "[]",
      errors: ["the blob service timed out"],
      graphs: [
        { slug: "graph-alpha", text: VALID_GRAPH_TEXT, readme: "# graph-alpha\n" },
        { slug: "graph-binary", text: null },
        { slug: "graph-dropped", text: null, document: false },
      ],
      nodes: [{ slug: "node-dropped", text: null, document: false }],
    }));
    const { meta } = await run([partial, emptySearchStub()], { authenticated: true });

    expect(meta.documents).toBe(1);
    expect(meta.invalid).toEqual([
      { repo: "UniverLab/canopy-graphs", slug: "graph-binary", reason: "blob not text" },
      { repo: "UniverLab/canopy-graphs", slug: "graph-dropped", reason: "graphql error" },
      { repo: "UniverLab/canopy-graphs", slug: "node-dropped", reason: "graphql error" },
    ]);
  });

  it("reports the same pattern reasons from a snapshot as from REST", async () => {
    const body = snapshotBody({
      blocked: "[]",
      patterns: [
        { slug: "pattern-alpha", page: patternPage("pattern-alpha"), figure: VALID_GRAPH_TEXT },
        { slug: "pattern-bravo", page: "no front matter here", figure: VALID_GRAPH_TEXT },
        {
          slug: "pattern-charlie",
          page: patternPage("pattern-charlie"),
          figure: VALID_GRAPH_TEXT,
          figureName: "somewhere-else.figure.json",
        },
        { slug: "pattern-delta", page: patternPage("pattern-delta"), figure: "{not json" },
        {
          slug: "pattern-echo",
          page: patternPage("pattern-echo"),
          figure: JSON.stringify({ not: "a document" }),
        },
      ],
    });
    const { meta, kv } = await run(
      [graphqlStub("canopy-graphs", body), emptySearchStub()],
      { authenticated: true },
    );

    expect(meta.invalid).toEqual([
      { repo: "UniverLab/canopy-graphs", slug: "pattern-bravo", reason: "malformed front matter" },
      { repo: "UniverLab/canopy-graphs", slug: "pattern-charlie", reason: "missing figure" },
      { repo: "UniverLab/canopy-graphs", slug: "pattern-delta", reason: "unparseable figure JSON" },
      { repo: "UniverLab/canopy-graphs", slug: "pattern-echo", reason: "figure failed the graph schema" },
    ]);
    const patterns = JSON.parse((await kv.get("patterns:v1")) as string) as {
      entries: Array<{ slug: string }>;
    };
    expect(patterns.entries.map((entry) => entry.slug)).toEqual(["pattern-alpha"]);
    expect(await kv.get(patternKey("pattern-bravo"))).toBeNull();
  });

  it("calls an entry that vanished without an errors array a missing file", async () => {
    const { meta } = await run(
      [
        graphqlStub("canopy-graphs", snapshotBody({
          blocked: "[]",
          graphs: [{ slug: "graph-alpha", text: null, document: false }],
        })),
        emptySearchStub(),
      ],
      { authenticated: true },
    );

    expect(meta.documents).toBe(0);
    expect(meta.invalid).toEqual([
      { repo: "UniverLab/canopy-graphs", slug: "graph-alpha", reason: "missing file" },
    ]);
  });

  it("keeps the previous official entries when the answer carries no tree", async () => {
    const kv = new FakeKV();
    await kv.put("index:v1", JSON.stringify({
      built_at: "2026-10-26T00:00:00.000Z",
      entries: [{
        kind: "graph",
        owner: "UniverLab",
        repo: "canopy-graphs",
        slug: "graph-alpha",
        name: "Old alpha",
        description: "",
        official: true,
        stars: 7,
        updated: null,
        ref: "main",
      }],
    }));
    await kv.put(
      docKey("graph", "UniverLab", "canopy-graphs", "graph-alpha"),
      JSON.stringify({ document: { name: "Old alpha" }, readme: "old" }),
    );

    const { meta } = await run(
      [
        graphqlStub("canopy-graphs", {
          data: { repository: null },
          errors: [{ message: "Could not resolve to a Repository with the name 'UniverLab/canopy-graphs'." }],
        }),
        emptySearchStub(),
      ],
      { authenticated: true, kv },
    );

    expect(meta.stopped).toBe("official repository unavailable");
    expect(meta.truncated).toBe(true);
    expect(meta.repos_seen).toBe(0);
    expect(meta.subrequests).toBe(1);
    const index = await storedIndex(kv);
    expect(index.entries.map((entry) => entry["slug"])).toEqual(["graph-alpha"]);
    expect(index.entries[0]["name"]).toBe("Old alpha");
    expect(await kv.get(docKey("graph", "UniverLab", "canopy-graphs", "graph-alpha"))).not.toBeNull();
  });

  it("counts every outbound call, cache operations included, and refuses the 51st", async () => {
    const meter = new SubrequestMeter(SUBREQUEST_LIMIT);
    const cache: CacheLike = new FakeCache(meter);
    const fake = fakeFetch([{ url: "repos/acme/things", status: 200, body: { stargazers_count: 1 } }]);
    const github = createGitHub({ fetchImpl: meteredFetch(fake, meter), cache });
    await github.get("https://api.github.com/repos/acme/things", "contents");
    expect(meter.fetches).toBe(1);
    // One match before the fetch, one store after it.
    expect(meter.cacheOps).toBe(2);
    expect(meter.total).toBe(3);

    const full = new SubrequestMeter(SUBREQUEST_LIMIT);
    for (let index = 0; index < SUBREQUEST_LIMIT; index += 1) {
      full.spend(index % 2 === 0 ? "fetch" : "cache");
    }
    expect(full.total).toBe(50);
    expect(() => full.spend("cache")).toThrow("Too many subrequests");
  });
});

describe("the index payload", () => {
  const entry = (description: string): IndexEntry => ({
    kind: "graph",
    owner: "acme",
    repo: "things",
    slug: "flow",
    name: "flow",
    description,
    official: false,
    stars: 1,
    updated: null,
    ref: "main",
  });

  it("trims descriptions past 280 characters when the value would overshoot", () => {
    const payload = buildIndexPayload(
      [entry("x".repeat(500))],
      "2026-10-27T00:00:00.000Z",
      500,
    );
    const parsed = JSON.parse(payload) as { entries: Array<{ description: string }> };
    expect(parsed.entries[0].description.length).toBe(280);
  });

  it("leaves descriptions alone under the cap", () => {
    const payload = buildIndexPayload(
      [entry("short")],
      "2026-10-27T00:00:00.000Z",
      500,
    );
    const parsed = JSON.parse(payload) as { entries: Array<{ description: string }> };
    expect(parsed.entries[0].description).toBe("short");
  });
});

describe("the read side", () => {
  it("memoises the index in the isolate for 60 seconds", async () => {
    resetIndexMemo();
    const kv = new FakeKV();
    await kv.put("index:v1", JSON.stringify({ built_at: "t0", entries: [] }));
    const store = createStore(kv);
    expect((await store.getIndex())?.built_at).toBe("t0");
    await kv.put("index:v1", JSON.stringify({ built_at: "t1", entries: [] }));
    expect((await store.getIndex())?.built_at).toBe("t0");
    resetIndexMemo();
    expect((await store.getIndex())?.built_at).toBe("t1");
  });

  it("reads documents case-insensitively and meta straight through", async () => {
    resetIndexMemo();
    const kv = new FakeKV();
    await kv.put(
      docKey("graph", "acme", "things", "flow"),
      JSON.stringify({ document: { name: "flow" }, readme: "hi" }),
    );
    await kv.put(
      "index:meta",
      JSON.stringify({
        built_at: "t",
        duration_ms: 1,
        calls: 2,
        repos_seen: 1,
        documents: 1,
        invalid: [],
        truncated: false,
        authenticated: true,
      }),
    );
    const store = createStore(kv);
    expect((await store.getDoc("graph", "ACME", "Things", "flow"))?.readme).toBe("hi");
    expect((await store.getMeta())?.calls).toBe(2);
    // An older meta wrote neither field: the count falls back to `calls` and
    // the stop reason is null, so /api/index-status keeps answering.
    expect((await store.getMeta())?.subrequests).toBe(2);
    expect((await store.getMeta())?.stopped).toBeNull();
  });

  it("reads the stop reason a truncated run wrote", async () => {
    resetIndexMemo();
    const kv = new FakeKV();
    await kv.put(
      "index:meta",
      JSON.stringify({
        built_at: "t",
        duration_ms: 1,
        calls: 45,
        subrequests: 45,
        repos_seen: 14,
        documents: 13,
        blocked: 0,
        invalid: [],
        truncated: true,
        stopped: "budget of 45 subrequests reached",
        authenticated: false,
      }),
    );
    const meta = await createStore(kv).getMeta();
    expect(meta?.subrequests).toBe(45);
    expect(meta?.stopped).toBe("budget of 45 subrequests reached");
  });

  it("answers null for a missing binding, a missing key and a corrupt value", async () => {
    resetIndexMemo();
    const missing = createStore(undefined);
    expect(await missing.getIndex()).toBeNull();
    expect(await missing.getDoc("graph", "a", "b", "c")).toBeNull();
    expect(await missing.getMeta()).toBeNull();

    resetIndexMemo();
    const kv = new FakeKV();
    await kv.put("index:v1", "not json");
    await kv.put(docKey("graph", "a", "b", "c"), JSON.stringify({ nope: true }));
    await kv.put("index:meta", JSON.stringify({ built_at: "t" }));
    const store = createStore(kv);
    expect(await store.getIndex()).toBeNull();
    expect(await store.getDoc("graph", "a", "b", "c")).toBeNull();
    expect(await store.getMeta()).toBeNull();
  });
});
