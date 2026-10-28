// SPDX-License-Identifier: Apache-2.0
/**
 * The agent discovery files: robots, sitemap, API catalogue and OpenAPI
 * description, served from a seeded index with an empty upstream — no
 * file may reach GitHub. Plus the Link header every HTML page carries.
 */
import { describe, expect, it } from "vitest";
import worker, { createWorker } from "../src/index.js";
import { AGENT_LINK_HEADER } from "../src/agent-files.js";
import { createGitHub } from "../src/github.js";
import { runIndexer } from "../src/indexer.js";
import { resetIndexMemo } from "../src/store.js";
import { FakeCache, FakeKV, fakeFetch, type Stub } from "./fakes.js";
import { REPO_DIR, officialStubs, searchStubs } from "./stubs.js";

const ORIGIN = "https://graphs.univerlab.org";

/** Seed a fresh KV by running the indexer over the stub table. */
async function seeded(stubsToSeed: Stub[]): Promise<FakeKV> {
  resetIndexMemo();
  const fake = fakeFetch(stubsToSeed);
  const kv = new FakeKV();
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
  await runIndexer({ github, index: kv, authenticated: true });
  return kv;
}

/** The official stubs with the repo's updated date, for sitemap lastmod. */
function datedStubs(): Stub[] {
  return officialStubs().map((stub) =>
    stub.url === REPO_DIR
      ? { ...stub, body: { stargazers_count: 7, updated_at: "2026-10-27T08:00:00Z", default_branch: "main" } }
      : stub,
  );
}

async function call(path: string, kv?: FakeKV): Promise<Response> {
  if (kv === undefined) {
    resetIndexMemo();
  }
  return worker.fetch(new Request(new URL(path, ORIGIN)), kv === undefined ? {} : { INDEX: kv });
}

describe("robots.txt", () => {
  it("welcomes crawlers to the catalogue but not to the install redirects", async () => {
    const response = await call("/robots.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await response.text();
    for (const line of [
      "User-agent: *",
      "Allow: /",
      "Disallow: /i/",
      "Content-Signal: search=yes, ai-input=yes, ai-train=no",
      "Sitemap: https://graphs.univerlab.org/sitemap.xml",
    ]) {
      expect(body).toContain(line);
    }
    // Training is not granted because third parties authored the documents.
    expect(body).toMatch(/#.*third part/i);
  });
});

describe("sitemap.xml", () => {
  it("lists the fixed pages and every indexed document, with lastmod", async () => {
    const response = await call("/sitemap.xml", await seeded(datedStubs()));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    const body = await response.text();
    expect(body).toContain(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`);
    for (const path of ["/", "/search", "/publish", "/llms.txt", "/g/hello-graph", "/n/hello-node"]) {
      expect(body).toContain(`<loc>https://graphs.univerlab.org${path}</loc>`);
    }
    expect(body).toContain("<lastmod>2026-10-27</lastmod>");
  });

  it("lists community documents under their owner/repo/slug path", async () => {
    const body = await (await call("/sitemap.xml", await seeded(searchStubs()))).text();
    expect(body).toContain("<loc>https://graphs.univerlab.org/g/acme/things/flow</loc>");
  });

  it("lists only the four fixed URLs with an empty or missing index", async () => {
    const empty = new FakeKV();
    resetIndexMemo();
    await empty.put("index:v1", JSON.stringify({ built_at: "2026-10-27T00:00:00Z", entries: [] }));
    for (const kv of [empty, undefined]) {
      const body = await (await call("/sitemap.xml", kv)).text();
      expect(body.match(/<loc>/g)).toHaveLength(4);
      for (const path of ["/", "/search", "/publish", "/llms.txt"]) {
        expect(body).toContain(`<loc>https://graphs.univerlab.org${path}</loc>`);
      }
      expect(body).not.toContain("<lastmod>");
    }
  });

  it("never calls GitHub", async () => {
    const kv = await seeded(searchStubs());
    const live = createWorker({
      fetchImpl: (async () => {
        throw new Error("the sitemap must not call GitHub");
      }) as unknown as typeof fetch,
    });
    const response = await live.fetch(new Request(`${ORIGIN}/sitemap.xml`), { INDEX: kv });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<urlset");
  });
});

describe("the API catalogue", () => {
  it("answers /.well-known/api-catalog with an RFC 9727 linkset", async () => {
    const response = await call("/.well-known/api-catalog");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/linkset+json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as {
      linkset: Array<{
        anchor: string;
        "service-desc": Array<{ href: string }>;
        "service-doc": Array<{ href: string }>;
        status: Array<{ href: string }>;
      }>;
    };
    expect(body.linkset).toHaveLength(1);
    const entry = body.linkset[0];
    expect(entry.anchor).toBe("https://graphs.univerlab.org/api/");
    expect(entry["service-desc"][0].href).toBe("https://graphs.univerlab.org/api/openapi.json");
    expect(entry["service-doc"][0].href).toBe("https://graphs.univerlab.org/publish");
    expect(entry.status[0].href).toBe("https://graphs.univerlab.org/api/index-status");
  });

  it("answers every other well-known path with a 404", async () => {
    const response = await call("/.well-known/security.txt");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});

describe("the OpenAPI description", () => {
  it("answers /api/openapi.json with an OpenAPI 3.1 document for the seven routes", async () => {
    const response = await call("/api/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await response.json()) as {
      openapi: string;
      paths: Record<string, { get: { parameters?: Array<{ name: string; schema?: { enum?: string[] } }>; responses: Record<string, unknown> } }>;
      components: { schemas: Record<string, unknown> };
    };
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths).sort()).toEqual([
      "/api/drafts",
      "/api/drafts/{id}",
      "/api/g/{owner}/{repo}/{slug}",
      "/api/index-status",
      "/api/n/{owner}/{repo}/{slug}",
      "/api/official",
      "/api/search",
    ]);
    // Search documents q, sort=top|new and page.
    const searchParams = body.paths["/api/search"].get.parameters ?? [];
    expect(searchParams.map((param) => param.name).sort()).toEqual(["page", "q", "sort"]);
    expect(searchParams.find((param) => param.name === "sort")?.schema?.enum).toEqual(["top", "new"]);
    // Single-document routes document their three path segments.
    for (const path of ["/api/g/{owner}/{repo}/{slug}", "/api/n/{owner}/{repo}/{slug}"]) {
      const params = body.paths[path].get.parameters ?? [];
      expect(params.map((param) => param.name)).toEqual(["owner", "repo", "slug"]);
      expect(body.paths[path].get.responses["400"]).toBeDefined();
      expect(body.paths[path].get.responses["404"]).toBeDefined();
    }
    // The 400/404 error shape is pinned once, as a component.
    expect(body.components.schemas["Error"]).toBeDefined();
    // POST /api/drafts answers 400 both for a malformed body (Error) and
    // for a document that did not validate (DraftInvalid with problems).
    const draftPosts = body.paths as unknown as Record<
      string,
      { post: { responses: Record<string, { content: { "application/json": { schema: { anyOf?: Array<{ $ref: string }> } } } }> } }
    >;
    const draft400 = draftPosts["/api/drafts"].post.responses["400"].content["application/json"].schema;
    expect(draft400.anyOf?.map((entry) => entry.$ref).sort()).toEqual([
      "#/components/schemas/DraftInvalid",
      "#/components/schemas/Error",
    ]);
  });

  it("never reaches the API router, which would 400 it as unknown", async () => {
    const response = await call("/api/openapi.json");
    expect(response.status).toBe(200);
    const other = await call("/api/what");
    expect(other.status).toBe(400);
  });
});

describe("the Link header", () => {
  it("rides on every HTML page response", async () => {
    const kv = await seeded(searchStubs());
    for (const path of ["/", "/search?q=flow", "/g/hello-graph", "/publish"]) {
      const response = await call(path, kv);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("link"), path).toBe(AGENT_LINK_HEADER);
    }
  });

  it("stays off the markdown twin", async () => {
    resetIndexMemo();
    const kv = await seeded(searchStubs());
    const response = await worker.fetch(
      new Request(`${ORIGIN}/g/hello-graph`, { headers: { accept: "text/markdown" } }),
      { INDEX: kv },
    );
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("link")).toBeNull();
  });
});
