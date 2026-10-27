// SPDX-License-Identifier: Apache-2.0
/**
 * The scheduled indexer, against the fake GitHub the worker tests share:
 * discovery over two search pages, invalid documents recorded and
 * skipped, the budget cut-off carrying over unvisited repositories,
 * deletion of vanished document keys, official entries flagged, and
 * the unauthenticated budget. The read side's memo is pinned here too.
 */
import { describe, expect, it } from "vitest";
import { createGitHub } from "../src/github.js";
import {
  AUTHENTICATED_BUDGET,
  UNAUTHENTICATED_BUDGET,
  buildIndexPayload,
  discoveryUrl,
  runIndexer,
} from "../src/indexer.js";
import { createStore, docKey, resetIndexMemo, type IndexEntry } from "../src/store.js";
import { FakeCache, FakeKV, fakeFetch, fileBody, type Stub } from "./fakes.js";
import { officialStubs } from "./stubs.js";
import {
  BROKEN_NODE_TEXT,
  INVALID_GRAPH_TEXT,
  VALID_GRAPH_TEXT,
} from "./documents-fixture.js";

const OFFICIAL_GRAPHS = "repos/UniverLab/canopy-web/contents/registry/graphs";
const OFFICIAL_NODES = "repos/UniverLab/canopy-web/contents/registry/nodes";
const OFFICIAL_REPO = "repos/UniverLab/canopy-web";

/** An empty official registry: both directories missing, the repo known. */
function emptyOfficialStubs(): Stub[] {
  return [
    { url: OFFICIAL_GRAPHS, status: 404, body: {} },
    { url: OFFICIAL_NODES, status: 404, body: {} },
    { url: OFFICIAL_REPO, status: 200, body: { stargazers_count: 3, default_branch: "main" } },
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
}

async function run(stubs: Stub[], options: RunOptions = {}) {
  resetIndexMemo();
  const fake = fakeFetch(stubs);
  const kv = options.kv ?? new FakeKV();
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
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
            // The official repository in discovery results is already
            // indexed as official; it must not appear twice.
            { name: "canopy-web", owner: { login: "UniverLab" }, default_branch: "main", stargazers_count: 9 },
          ],
        },
      },
      ...names.flatMap((name, i) => repoStubs(name, i + 1)),
      ...repoStubs("r-101", 101),
    ];
    const { meta, kv, fake } = await run(stubs);

    expect(meta.documents).toBe(101);
    expect(meta.repos_seen).toBe(102);
    expect(meta.truncated).toBe(false);
    expect(meta.authenticated).toBe(true);
    expect(meta.invalid).toEqual([]);
    // Official (3) + two search pages (2) + one tree, document and README
    // per repository (101 x 3): every GitHub call counted.
    expect(meta.calls).toBe(3 + 2 + 101 * 3);
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
    ]);

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

  it("carries over unvisited repositories when the budget cuts the run", async () => {
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

    // Official (3) + search (1) + one full repository (tree, document,
    // README): the seventh call spends the budget of 7, and the second
    // repository is never visited.
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
      { kv, budget: 7 },
    );

    expect(meta.calls).toBe(7);
    expect(fake.calls.length).toBe(7);
    expect(meta.truncated).toBe(true);
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
    // (one call each, no documents). Official (3) + discovery (10) +
    // trees (1,000) stays under the 1,200 budget.
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
    const { meta } = await run(stubs, { kv });

    expect(meta.truncated).toBe(true);
    expect(meta.calls).toBe(3 + 10 + 1000);
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
      { kv },
    );

    const index = await storedIndex(kv);
    expect(index.entries.map((e) => `${e["repo"]}/${e["slug"]}`)).toEqual(["one/flow"]);
    // The dropped folder in a visited repository and the repository a
    // completed discovery no longer lists both lose their keys.
    expect(await kv.get(docKey("graph", "acme", "one", "gone"))).toBeNull();
    expect(await kv.get(docKey("graph", "acme", "vanished", "x"))).toBeNull();
    expect(await kv.get(docKey("graph", "acme", "one", "flow"))).not.toBeNull();
  });

  it("flags official entries and indexes the registry in the same run", async () => {
    const { meta, kv } = await run(officialStubs());
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
    expect(await kv.get(docKey("graph", "UniverLab", "canopy-web", "hello-graph"))).not.toBeNull();
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
      { kv },
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

  it("caps unauthenticated runs at 50 calls and says so in the meta", async () => {
    expect(UNAUTHENTICATED_BUDGET).toBe(50);
    expect(AUTHENTICATED_BUDGET).toBe(1200);
    const names = Array.from({ length: 25 }, (_, i) => `r-${String(i + 1).padStart(2, "0")}`);
    const { meta } = await run(
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
    expect(meta.calls).toBe(50);
    expect(meta.truncated).toBe(true);
    // Official + search + fifteen full repositories (3 calls each) spend
    // 49 calls; the sixteenth repository's tree is the 50th, and its
    // document is never fetched.
    expect(meta.documents).toBe(15);
    expect(meta.repos_seen).toBe(16);
  });

  it("stamps the meta with the run's clock and duration", async () => {
    let tick = 1_791_000_000_000;
    const { meta } = await run(officialStubs(), { now: () => (tick += 500) });
    expect(meta.built_at).toBe(new Date(1_791_000_000_500).toISOString());
    expect(meta.duration_ms).toBe(500);
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
