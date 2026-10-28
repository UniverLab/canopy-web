// SPDX-License-Identifier: Apache-2.0
/**
 * The JSON API, served from a seeded index: every test runs the indexer
 * over a stub table into a fresh in-memory KV, then calls the API with
 * an empty upstream — no request-path call may reach GitHub. Shapes,
 * paging and errors stay exactly the live search's.
 */
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import { createGitHub } from "../src/github.js";
import { runIndexer } from "../src/indexer.js";
import { resetIndexMemo } from "../src/store.js";
import { blockedDocKey, type BlockedEntry } from "../src/blocked.js";
import { FakeCache, FakeKV, fakeFetch, fileBody, dirBody, type FakeFetch, type Stub } from "./fakes.js";
import { INVALID_GRAPH_TEXT, VALID_GRAPH_TEXT, VALID_NODE_TEXT } from "./documents-fixture.js";

const SEARCH = "search/repositories";
const REPO_DIR = "repos/UniverLab/canopy-graphs";

/** Everything one official graph plus one node need to answer an API call. */
function stubs(): Stub[] {
  return [
    { url: `${REPO_DIR}/contents/graphs`, status: 200, body: dirBody([{ name: "hello-graph", type: "dir" }]) },
    { url: `${REPO_DIR}/contents/nodes`, status: 200, body: dirBody([{ name: "hello-node", type: "dir" }]) },
    { url: `${REPO_DIR}/contents/graphs/hello-graph/graph.json`, status: 200, body: fileBody("graphs/hello-graph/graph.json", VALID_GRAPH_TEXT) },
    { url: `${REPO_DIR}/contents/graphs/hello-graph/README.md`, status: 200, body: fileBody("graphs/hello-graph/README.md", "# hello-graph\n") },
    { url: `${REPO_DIR}/contents/nodes/hello-node/node.json`, status: 200, body: fileBody("nodes/hello-node/node.json", VALID_NODE_TEXT) },
    { url: `${REPO_DIR}/contents/nodes/hello-node/README.md`, status: 404, body: {} },
    { url: "repos/UniverLab/canopy-graphs", status: 200, body: { stargazers_count: 7 } },
  ];
}

/** One community repository holding a graph called flow. */
function flowStubs(): Stub[] {
  return [{
    url: SEARCH,
    status: 200,
    body: {
      total_count: 5,
      items: [{ name: "things", owner: { login: "acme" }, default_branch: "main", stargazers_count: 2 }],
    },
  }, {
    url: "repos/acme/things/git/trees/main",
    status: 200,
    body: { tree: [{ path: "graphs/flow/graph.json", type: "blob" }] },
  }, {
    url: "repos/acme/things/contents/graphs/flow/graph.json",
    status: 200,
    body: fileBody("graphs/flow/graph.json", VALID_GRAPH_TEXT),
  }, {
    url: "repos/acme/things/contents/graphs/flow/README.md",
    status: 404,
    body: {},
  }];
}

/** Seed a fresh KV by running the indexer over the stub table. */
async function seeded(stubsToSeed: Stub[], budget?: number): Promise<FakeKV> {
  const fake = fakeFetch(stubsToSeed);
  const kv = new FakeKV();
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
  await runIndexer({ github, index: kv, authenticated: false, budget });
  return kv;
}

interface Options {
  stubs?: Stub[];
  env?: Record<string, string>;
  /** Upstream answers for the request itself (analytics SQL, never GitHub). */
  requestStubs?: Stub[];
  /** Skip seeding: the cold start, before the first scheduled run. */
  cold?: boolean;
  /** Budget override for a fixture larger than one cron run may read. */
  budget?: number;
}

async function call(path: string, options: Options = {}): Promise<{ response: Response; fetch: FakeFetch }> {
  resetIndexMemo();
  const kv = options.cold === true ? new FakeKV() : await seeded(options.stubs ?? stubs(), options.budget);
  const fake = fakeFetch(options.requestStubs ?? []);
  const req = new Request(`https://graphs.univerlab.org${path}`);
  const answer = await handleApi(req, { ...options.env, INDEX: kv }, {
    fetchImpl: fake.fetchImpl,
    cache: new FakeCache(),
  });
  expect(answer).not.toBe(true);
  return { response: answer as unknown as Response, fetch: fake };
}

describe("the JSON API", () => {
  it("answers /api/official with graphs and nodes", async () => {
    const { response, fetch } = await call("/api/official");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { graphs: unknown[]; nodes: unknown[] };
    expect(body.graphs.length).toBe(1);
    expect(body.nodes.length).toBe(1);
    expect(fetch.calls).toEqual([]);
  });

  it("answers /api/official with empty lists when the official folders do not exist", async () => {
    const { response } = await call("/api/official", {
      stubs: [{ url: `${REPO_DIR}/contents/graphs`, status: 404, body: {} }],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { graphs: unknown[]; nodes: unknown[] };
    expect(body.graphs).toEqual([]);
    expect(body.nodes).toEqual([]);
  });

  it("answers /api/search with items and echoed filters", async () => {
    const { response } = await call("/api/search?q=flow&sort=new&page=1", {
      stubs: [...stubs(), ...flowStubs()],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: unknown[];
      q: string;
      sort: string;
      page: number;
      total: number;
      truncated: boolean;
    };
    expect(body.items.length).toBe(1);
    expect(body.q).toBe("flow");
    expect(body.sort).toBe("new");
    expect(body.page).toBe(1);
    expect(body.total).toBe(1);
    expect(body.truncated).toBe(false);
  });

  it("filters case-insensitively over name, slug, description and repo", async () => {
    const table = [...stubs(), ...flowStubs()];
    // The slug alone names the community graph, whatever the case.
    const bySlug = (await (await call("/api/search?q=FLOW", { stubs: table })).response.json()) as {
      items: Array<{ slug: string; repo: string }>;
    };
    expect(bySlug.items.map((item) => item.slug)).toEqual(["flow"]);
    // The repository pair matches too.
    const byRepo = (await (await call("/api/search?q=acme/things", { stubs: table })).response.json()) as {
      items: Array<{ slug: string }>;
    };
    expect(byRepo.items.map((item) => item.slug)).toEqual(["flow"]);
    // The name matches both documents carrying it, official and community.
    const byName = (await (await call("/api/search?q=hello-graph", { stubs: table })).response.json()) as {
      items: Array<{ slug: string }>;
    };
    expect(byName.items.length).toBe(2);
    // The description matches the same two.
    const byDescription = (await (await call("/api/search?q=Minimal example graph", { stubs: table })).response.json()) as {
      items: Array<{ slug: string }>;
    };
    expect(byDescription.items.length).toBe(2);
    // An empty query lists everything indexed.
    const all = (await (await call("/api/search", { stubs: table })).response.json()) as {
      items: unknown[];
      total: number;
    };
    expect(all.total).toBe(3);
  });

  it("sorts top by stars and new by updated", async () => {
    const table = stubs().map((stub) =>
      stub.url === "repos/UniverLab/canopy-graphs"
        ? { ...stub, body: { stargazers_count: 7, updated_at: "2026-10-27T08:00:00Z", default_branch: "main" } }
        : stub,
    );
    const flow = flowStubs().map((stub) =>
      stub.url === SEARCH
        ? {
          ...stub,
          body: {
            total_count: 1,
            items: [{
              name: "things",
              owner: { login: "acme" },
              default_branch: "main",
              stargazers_count: 20,
              updated_at: "2026-10-20T08:00:00Z",
            }],
          },
        }
        : stub,
    );
    const both = [...table, ...flow];
    const top = (await (await call("/api/search?sort=top", { stubs: both })).response.json()) as {
      items: Array<{ slug: string; stars: number }>;
    };
    expect(top.items.map((item) => item.slug)).toEqual(["flow", "hello-graph", "hello-node"]);
    const fresh = (await (await call("/api/search?sort=new", { stubs: both })).response.json()) as {
      items: Array<{ slug: string; updated: string }>;
    };
    expect(fresh.items.map((item) => item.slug)).toEqual(["hello-graph", "hello-node", "flow"]);
  });

  it("pages through index matches 20 at a time", async () => {
    const names = Array.from({ length: 21 }, (_, i) => `p-${String(i + 1).padStart(2, "0")}`);
    const table: Stub[] = [
      { url: `${REPO_DIR}/contents/graphs`, status: 404, body: {} },
      { url: `${REPO_DIR}/contents/nodes`, status: 404, body: {} },
      { url: "repos/UniverLab/canopy-graphs", status: 200, body: { stargazers_count: 1 } },
      {
        url: SEARCH,
        status: 200,
        body: {
          total_count: 21,
          items: names.map((name) => ({
            name,
            owner: { login: "acme" },
            default_branch: "main",
            stargazers_count: 1,
          })),
        },
      },
      ...names.flatMap((name) => {
        const base = `repos/acme/${name}`;
        return [
          { url: `${base}/git/trees/main`, status: 200, body: { tree: [{ path: "graphs/flow/graph.json", type: "blob" }] } },
          { url: `${base}/contents/graphs/flow/graph.json`, status: 200, body: fileBody("graphs/flow/graph.json", VALID_GRAPH_TEXT) },
          { url: `${base}/contents/graphs/flow/README.md`, status: 404, body: {} },
        ] as Stub[];
      }),
    ];
    const first = (await (await call("/api/search?page=1", { stubs: table, budget: 2000 })).response.json()) as {
      items: unknown[];
      total: number;
      truncated: boolean;
    };
    expect(first.items.length).toBe(20);
    expect(first.total).toBe(21);
    expect(first.truncated).toBe(true);
    const second = (await (await call("/api/search?page=2", { stubs: table, budget: 2000 })).response.json()) as {
      items: unknown[];
      total: number;
      truncated: boolean;
    };
    expect(second.items.length).toBe(1);
    expect(second.total).toBe(21);
    expect(second.truncated).toBe(false);
  });

  it("rejects a bad sort and a bad page with typed 400s", async () => {
    const badSort = await call("/api/search?sort=hottest");
    expect(badSort.response.status).toBe(400);
    const badPage = await call("/api/search?page=zero");
    expect(badPage.response.status).toBe(400);
    const body = (await badPage.response.json()) as { kind: string };
    expect(body.kind).toBe("invalid-query");
  });

  it("answers /api/g/<official> with the validated document attached", async () => {
    const { response } = await call("/api/g/UniverLab/canopy-graphs/hello-graph");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      doc: { kind: string; slug: string; repo: string; readme: string };
      document: { format_version: number; nodes: unknown[] };
    };
    expect(body.doc.kind).toBe("graph");
    expect(body.doc.slug).toBe("hello-graph");
    expect(body.doc.readme).toBe("# hello-graph\n");
    expect(body.document.format_version).toBe(6);
    expect(Array.isArray(body.document.nodes)).toBe(true);
  });

  it("answers /api/n/<community> for a node document", async () => {
    const { response } = await call("/api/n/acme/things/hello-node", {
      stubs: [
        ...stubs(),
        {
          url: SEARCH,
          status: 200,
          body: {
            total_count: 1,
            items: [{ name: "things", owner: { login: "acme" }, default_branch: "main", stargazers_count: 2 }],
          },
        },
        {
          url: "repos/acme/things/git/trees/main",
          status: 200,
          body: { tree: [{ path: "nodes/hello-node/node.json", type: "blob" }] },
        },
        { url: "repos/acme/things/contents/nodes/hello-node/node.json", status: 200, body: fileBody("nodes/hello-node/node.json", VALID_NODE_TEXT) },
        { url: "repos/acme/things/contents/nodes/hello-node/README.md", status: 404, body: {} },
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { doc: { kind: string; repo: string } };
    expect(body.doc.kind).toBe("node");
    expect(body.doc.repo).toBe("acme/things");
  });

  it("answers the kind the route names, never the other one", async () => {
    resetIndexMemo();
    const kv = await seeded(stubs());
    const fake = fakeFetch([]);
    const answer = await handleApi(
      new Request("https://graphs.univerlab.org/api/n/UniverLab/canopy-graphs/hello-graph"),
      { INDEX: kv },
      { fetchImpl: fake.fetchImpl, cache: new FakeCache() },
    );
    const response = answer as unknown as Response;
    expect(response.status).toBe(404);
    const body = (await response.json()) as { kind: string; message: string };
    expect(body.kind).toBe("invalid-document");
    expect(body.message).toContain("no node named");
    // A node request never fetches at all: the index already said no.
    expect(fake.calls).toEqual([]);
  });

  it("leaves unreadable documents out of the index instead of throwing", async () => {
    const html = { "content-type": "text/html" };
    const table = stubs().map((stub) =>
      stub.url.endsWith("hello-graph/graph.json")
        ? { ...stub, text: "<html>portal</html>", headers: html, body: undefined }
        : stub,
    );
    const listing = await call("/api/official", { stubs: table });
    expect(listing.response.status).toBe(200);
    const graphs = (await listing.response.json()) as { graphs: unknown[] };
    expect(graphs.graphs).toEqual([]);

    const document = await call("/api/g/UniverLab/canopy-graphs/hello-graph", { stubs: table });
    expect(document.response.status).toBe(404);
    expect(((await document.response.json()) as { kind: string }).kind).toBe("invalid-document");
  });

  it("answers a blocked document with a 410 JSON body naming the reason and issue", async () => {
    resetIndexMemo();
    const kv = await seeded(stubs());
    const block: BlockedEntry = {
      kind: "graph",
      repo: "UniverLab/canopy-graphs",
      slug: "hello-graph",
      reason: "Broken or invalid",
      issue: "https://github.com/UniverLab/canopy-graphs/issues/12",
      blocked_at: "2026-10-27",
    };
    await kv.put(
      blockedDocKey("graph", "UniverLab", "canopy-graphs", "hello-graph"),
      JSON.stringify(block),
    );
    const answer = await handleApi(
      new Request("https://graphs.univerlab.org/api/g/UniverLab/canopy-graphs/hello-graph"),
      { INDEX: kv },
      { fetchImpl: fakeFetch([]).fetchImpl, cache: new FakeCache() },
    );
    const response = answer as unknown as Response;
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: "blocked",
      reason: block.reason,
      issue: block.issue,
    });
    // It never reaches the index, so a stale entry cannot answer instead.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers a missing document with a typed 404, never a 500", async () => {
    const { response } = await call("/api/g/UniverLab/canopy-graphs/missing");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { kind: string; message: string };
    expect(body.kind).toBe("invalid-document");
    expect(body.message).toContain("missing");
  });

  it("answers /api/index-status with the run's accounting", async () => {
    const { response } = await call("/api/index-status");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      built_at: string;
      duration_ms: number;
      calls: number;
      subrequests: number;
      repos_seen: number;
      documents: number;
      invalid: unknown[];
      truncated: boolean;
      stopped: string | null;
      authenticated: boolean;
    };
    expect(typeof body.built_at).toBe("string");
    expect(body.calls).toBeGreaterThan(0);
    expect(body.subrequests).toBe(body.calls);
    expect(body.repos_seen).toBe(1);
    expect(body.documents).toBe(2);
    expect(body.invalid).toEqual([]);
    expect(body.truncated).toBe(false);
    expect(body.stopped).toBeNull();
    expect(body.authenticated).toBe(false);
  });

  it("trims /api/index-status invalid details past the first 20", async () => {
    const slugs = Array.from({ length: 25 }, (_, i) => `bad-${String(i + 1).padStart(2, "0")}`);
    const base = "repos/acme/things";
    const table: Stub[] = [
      ...stubs(),
      {
        url: SEARCH,
        status: 200,
        body: {
          total_count: 1,
          items: [{ name: "things", owner: { login: "acme" }, default_branch: "main", stargazers_count: 1 }],
        },
      },
      {
        url: `${base}/git/trees/main`,
        status: 200,
        body: { tree: slugs.map((slug) => ({ path: `graphs/${slug}/graph.json`, type: "blob" })) },
      },
      ...slugs.map((slug): Stub => ({
        url: `${base}/contents/graphs/${slug}/graph.json`,
        status: 200,
        body: fileBody(`graphs/${slug}/graph.json`, INVALID_GRAPH_TEXT),
      })),
    ];
    const { response } = await call("/api/index-status", { stubs: table });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { invalid: Array<{ slug: string; reason: string }> };
    expect(body.invalid.length).toBe(20);
    expect(body.invalid[0]).toEqual({ repo: "acme/things", slug: "bad-01", reason: "schema validation failed" });
  });

  it("answers every data route with a 503 before the first scheduled run", async () => {
    for (const path of [
      "/api/official",
      "/api/search?q=flow",
      "/api/g/UniverLab/canopy-graphs/hello-graph",
      "/api/index-status",
    ]) {
      const { response } = await call(path, { cold: true });
      expect(response.status, path).toBe(503);
      expect(await response.json(), path).toEqual({ error: "indexing" });
    }
  });

  it("is CORS-open for GET and answers OPTIONS with 204", async () => {
    const { response } = await call("/api/official");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await handleApi(
      new Request("https://graphs.univerlab.org/api/official", { method: "OPTIONS" }),
      {},
      { cache: new FakeCache(), fetchImpl: fakeFetch([]).fetchImpl },
    );
    expect((preflight as unknown as Response).status).toBe(204);
  });

  it("answers unknown API routes with a typed 400", async () => {
    const { response } = await call("/api/what");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { kind: string };
    expect(body.kind).toBe("invalid-path");
  });

  it("keeps out of /api paths that are not its own routes", async () => {
    const answer = await handleApi(
      new Request("https://graphs.univerlab.org/i/graph/hello-graph"),
      {},
      { cache: new FakeCache(), fetchImpl: fakeFetch([]).fetchImpl },
    );
    expect(answer).toBe(true);
  });

  it("attaches install counts when analytics is configured and leaves them out otherwise", async () => {
    const enriched = await call("/api/official", {
      env: { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" },
      requestStubs: [
        {
          url: "analytics_engine/sql",
          status: 200,
          body: { data: [{ index: "UniverLab/canopy-graphs/graph/hello-graph", count: 5 }] },
        },
      ],
    });
    const withCounts = (await enriched.response.json()) as { graphs: Array<{ downloads?: number }> };
    expect(withCounts.graphs[0].downloads).toBe(5);

    const plain = (await (await call("/api/official")).response.json()) as { graphs: Array<{ downloads?: number }> };
    expect(plain.graphs[0].downloads).toBeUndefined();
  });

  it("does not list official stars as zero when the repo call fails", async () => {
    const withoutStars = stubs().filter((stub) => stub.url !== "repos/UniverLab/canopy-graphs");
    withoutStars.push({ url: "repos/UniverLab/canopy-graphs", status: 404, body: {}, });
    const { response } = await call("/api/official", { stubs: withoutStars });
    const body = (await response.json()) as { graphs: Array<{ stars: unknown }> };
    expect(response.status).toBe(200);
    expect(body.graphs[0].stars).toBeNull();
  });
});
