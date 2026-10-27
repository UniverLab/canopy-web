// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";
import { FakeCache, dirBody, fakeFetch, fileBody, type Stub } from "./fakes.js";
import { VALID_GRAPH_TEXT, VALID_NODE_TEXT } from "./documents-fixture.js";

const SEARCH = "search/repositories";
const REPO_DIR = "repos/UniverLab/canopy-web";

/** Everything one official graph plus one node need to answer an API call. */
function stubs(): Stub[] {
  return [
    { url: `${REPO_DIR}/contents/registry/graphs`, status: 200, body: dirBody([{ name: "hello-graph", type: "dir" }]) },
    { url: `${REPO_DIR}/contents/registry/nodes`, status: 200, body: dirBody([{ name: "hello-node", type: "dir" }]) },
    { url: `${REPO_DIR}/contents/registry/graphs/hello-graph/graph.json`, status: 200, body: fileBody("graphs/hello-graph/graph.json", VALID_GRAPH_TEXT) },
    { url: `${REPO_DIR}/contents/registry/graphs/hello-graph/README.md`, status: 200, body: fileBody("graphs/hello-graph/README.md", "# hello-graph\n") },
    { url: `${REPO_DIR}/contents/registry/nodes/hello-node/node.json`, status: 200, body: fileBody("nodes/hello-node/node.json", VALID_NODE_TEXT) },
    { url: `${REPO_DIR}/contents/registry/nodes/hello-node/README.md`, status: 404, body: {} },
    { url: "repos/UniverLab/canopy-web", status: 200, body: { stargazers_count: 7 } },
  ];
}

interface Options {
  stubs?: Stub[];
  env?: Record<string, string>;
}

async function call(path: string, options: Options = {}): Promise<Response> {
  const fake = fakeFetch(options.stubs ?? stubs());
  const cache = new FakeCache();
  const req = new Request(`https://graphs.univerlab.org${path}`);
  const answer = await handleApi(req, options.env ?? {}, {
    fetchImpl: fake.fetchImpl,
    cache,
  });
  expect(answer).not.toBe(true);
  return answer as unknown as Response;
}

describe("the JSON API", () => {
  it("answers /api/official with graphs and nodes", async () => {
    const response = await call("/api/official");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { graphs: unknown[]; nodes: unknown[] };
    expect(body.graphs.length).toBe(1);
    expect(body.nodes.length).toBe(1);
  });

  it("answers /api/official with empty lists when the registry folders do not exist", async () => {
    const response = await call("/api/official", {
      stubs: [{ url: `${REPO_DIR}/contents/registry/graphs`, status: 404, body: {} }],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { graphs: unknown[]; nodes: unknown[] };
    expect(body.graphs).toEqual([]);
    expect(body.nodes).toEqual([]);
  });

  it("answers /api/search with items and echoed filters", async () => {
    const listing = [...stubs(), {
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
    const response = await call("/api/search?q=flow&sort=new&page=2", { stubs: listing });
    const body = (await response.json()) as { items: unknown[]; q: string; sort: string; page: number; total: number };
    expect(body.items.length).toBe(1);
    expect(body.q).toBe("flow");
    expect(body.sort).toBe("new");
    expect(body.page).toBe(2);
    expect(body.total).toBe(5);
  });

  it("rejects a bad sort and a bad page with typed 400s", async () => {
    const badSort = await call("/api/search?sort=hottest");
    expect(badSort.status).toBe(400);
    const badPage = await call("/api/search?page=zero");
    expect(badPage.status).toBe(400);
    const body = (await badPage.json()) as { kind: string };
    expect(body.kind).toBe("invalid-query");
  });

  it("answers /api/g/<official> with the validated document attached", async () => {
    const response = await call("/api/g/UniverLab/canopy-web/hello-graph");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      doc: { kind: string; slug: string; repo: string };
      document: { format_version: number; nodes: unknown[] };
    };
    expect(body.doc.kind).toBe("graph");
    expect(body.doc.slug).toBe("hello-graph");
    expect(body.document.format_version).toBe(6);
    expect(Array.isArray(body.document.nodes)).toBe(true);
  });

  it("answers /api/n/<community> for a node document", async () => {
    const response = await call("/api/n/acme/things/hello-node", {
      stubs: [
        ...stubs(),
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
    const fake = fakeFetch([
      {
        url: `${REPO_DIR}/contents/registry/graphs/hello-graph/graph.json`,
        status: 200,
        body: fileBody("graphs/hello-graph/graph.json", VALID_GRAPH_TEXT),
      },
    ]);
    const answer = await handleApi(
      new Request("https://graphs.univerlab.org/api/n/UniverLab/canopy-web/hello-graph"),
      {},
      { fetchImpl: fake.fetchImpl, cache: new FakeCache() },
    );
    const response = answer as unknown as Response;
    expect(response.status).toBe(404);
    const body = (await response.json()) as { kind: string; message: string };
    expect(body.kind).toBe("invalid-document");
    expect(body.message).toContain("no node named");
    // A node request never reads the graph folder, so a miss stays one probe.
    expect(fake.calls.some((url) => url.includes("registry/graphs/hello-graph"))).toBe(false);
  });

  it("turns an unreadable upstream body into a typed error, never a throw", async () => {
    const html = { "content-type": "text/html" };
    const listing = await call("/api/official", {
      stubs: [{ url: `${REPO_DIR}/contents/registry/graphs`, status: 200, text: "<html>portal</html>", headers: html }],
    });
    expect(listing.status).toBe(502);
    expect(((await listing.json()) as { kind: string }).kind).toBe("upstream");

    const document = await call("/api/g/UniverLab/canopy-web/hello-graph", {
      stubs: [
        {
          url: `${REPO_DIR}/contents/registry/graphs/hello-graph/graph.json`,
          status: 200,
          text: "<html>portal</html>",
          headers: html,
        },
      ],
    });
    expect(document.status).toBe(404);
    expect(((await document.json()) as { kind: string }).kind).toBe("invalid-document");
  });

  it("answers a missing document with a typed 404, never a 500", async () => {
    const fake = fakeFetch([
      { url: "repos/UniverLab/canopy-web/contents/registry/graphs/missing/graph.json", status: 404, body: {} },
      { url: "repos/UniverLab/canopy-web/contents/registry/nodes/missing/node.json", status: 404, body: {} },
    ]);
    const cache = new FakeCache();
    const answer = await handleApi(
      new Request("https://graphs.univerlab.org/api/g/UniverLab/canopy-web/missing"),
      {},
      { fetchImpl: fake.fetchImpl, cache },
    );
    const response = answer as unknown as Response;
    expect(response.status).toBe(404);
    const body = (await response.json()) as { kind: string; message: string };
    expect(body.kind).toBe("invalid-document");
    expect(body.message).toContain("missing");
  });

  it("surfaces a rate limit as a typed 429 for agents to show", async () => {
    const response = await call("/api/official", {
      stubs: [
        {
          url: `${REPO_DIR}/contents/registry/graphs`,
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
        },
      ],
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { kind: string; retryAfter?: number };
    expect(body.kind).toBe("rate-limit");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it("is CORS-open for GET and answers OPTIONS with 204", async () => {
    const response = await call("/api/official");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const options = await call("/api/official", { stubs: [] });
    void options;
    const preflight = await handleApi(
      new Request("https://graphs.univerlab.org/api/official", { method: "OPTIONS" }),
      {},
      { cache: new FakeCache(), fetchImpl: fakeFetch([]).fetchImpl },
    );
    expect((preflight as unknown as Response).status).toBe(204);
  });

  it("answers unknown API routes with a typed 400", async () => {
    const response = await call("/api/what");
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
      stubs: [
        ...stubs(),
        {
          url: "analytics_engine/sql",
          status: 200,
          body: { data: [{ index: "UniverLab/canopy-web/graph/hello-graph", count: 5 }] },
        },
      ],
    });
    const withCounts = (await enriched.json()) as { graphs: Array<{ downloads?: number }> };
    expect(withCounts.graphs[0].downloads).toBe(5);

    const plain = (await (await call("/api/official")).json()) as { graphs: Array<{ downloads?: number }> };
    expect(plain.graphs[0].downloads).toBeUndefined();
  });

  it("does not list official stars as zero when the repo call fails", async () => {
    const withoutStars = stubs().filter((stub) => stub.url !== "repos/UniverLab/canopy-web");
    withoutStars.push({ url: "repos/UniverLab/canopy-web", status: 404, body: {}, });
    const response = await call("/api/official", { stubs: withoutStars });
    const body = (await response.json()) as { graphs: Array<{ stars: unknown }> };
    expect(response.status).toBe(200);
    expect(body.graphs[0].stars).toBeNull();
  });
});
