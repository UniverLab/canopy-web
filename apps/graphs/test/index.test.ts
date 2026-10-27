// SPDX-License-Identifier: Apache-2.0
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { createWorker, type DataPoint, type Env } from "../src/index.js";
import { createGitHub } from "../src/github.js";
import { runIndexer } from "../src/indexer.js";
import { INDEXING_BODY } from "../src/pages/copy.js";
import { resetIndexMemo } from "../src/store.js";
import { blockedDocKey, blockedRepoKey, type BlockedEntry } from "../src/blocked.js";
import { FakeCache, FakeKV, fakeFetch, fileBody, type Stub } from "./fakes.js";
import { VALID_GRAPH_TEXT, VALID_NODE_TEXT, INVALID_GRAPH_TEXT } from "./documents-fixture.js";
import { SLUG_PATTERN, SLUG_RE } from "../src/lib.js";
import { officialStubs, searchStubs } from "./stubs.js";

const ORIGIN = "https://graphs.univerlab.org";

const official = (kind: string, slug: string, ref = "HEAD"): string =>
  `https://raw.githubusercontent.com/UniverLab/canopy-graphs/${ref}/${kind}s/${slug}/${kind}.json`;

const community = (owner: string, repo: string, kind: string, slug: string, ref = "HEAD"): string =>
  `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${kind}s/${slug}/${kind}.json`;

interface Options {
  ua?: string | null;
  country?: string;
  env?: Env;
}

/** Seed a fresh KV with the official repository and one community graph. */
async function seeded(): Promise<FakeKV> {
  resetIndexMemo();
  const fake = fakeFetch(searchStubs());
  const kv = new FakeKV();
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
  await runIndexer({ github, index: kv, authenticated: true });
  return kv;
}

function request(path: string, options: Options = {}): Request {
  const headers = new Headers();
  if (options.ua !== null) {
    headers.set("user-agent", options.ua ?? "curl/8.5.0");
  }
  const req = new Request(new URL(path, ORIGIN), { headers });
  if (options.country) {
    Object.defineProperty(req, "cf", { value: { country: options.country }, configurable: true });
  }
  return req;
}

async function call(path: string, options: Options = {}): Promise<Response> {
  // The memo belongs to the previous case's KV; each call starts unmemoised.
  if (options.env?.INDEX === undefined) {
    resetIndexMemo();
  }
  return worker.fetch(request(path, options), options.env ?? {});
}

/** An env whose Analytics Engine binding records what the Worker sends it. */
async function counting(points: DataPoint[]): Promise<Env> {
  return {
    INDEX: await seeded(),
    INSTALLS: {
      writeDataPoint: (point: DataPoint): void => {
        points.push(point);
      },
    },
  };
}

describe("redirects", () => {
  it("sends an official graph to the community layout in the official repository", async () => {
    const response = await call("/i/graph/hello-graph", { env: { INDEX: await seeded() } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph"));
  });

  it("sends an official node to the community layout in the official repository", async () => {
    const response = await call("/i/node/hello-node", { env: { INDEX: await seeded() } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("node", "hello-node"));
  });

  it("answers installs with a 503 through the deployed Worker before the first run", async () => {
    // The isolate memo is shared with the deployed Worker under test.
    resetIndexMemo();
    const response = await SELF.fetch(`${ORIGIN}/i/graph/hello-graph`, { redirect: "manual" });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain(INDEXING_BODY);
  });

  it("sends a community node to its own repository with the same layout", async () => {
    const kv = new FakeKV();
    resetIndexMemo();
    const fake = fakeFetch([
      ...officialStubs(),
      {
        url: "search/repositories",
        status: 200,
        body: {
          total_count: 1,
          items: [{ name: "things", owner: { login: "acme" }, default_branch: "main", stargazers_count: 2 }],
        },
      },
      {
        url: "repos/acme/things/git/trees/main",
        status: 200,
        body: { tree: [{ path: "nodes/cool-node/node.json", type: "blob" }] },
      },
      { url: "repos/acme/things/contents/nodes/cool-node/node.json", status: 200, body: fileBody("nodes/cool-node/node.json", VALID_NODE_TEXT) },
      { url: "repos/acme/things/contents/nodes/cool-node/README.md", status: 404, body: {} },
    ]);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    await runIndexer({ github, index: kv, authenticated: true });
    const response = await call("/i/acme/things/node/cool-node", { env: { INDEX: kv } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(community("acme", "things", "node", "cool-node"));
  });

  it("sends a community graph to its own repository with the same layout", async () => {
    const response = await call("/i/acme/things/graph/flow", { env: { INDEX: await seeded() } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(community("acme", "things", "graph", "flow"));
  });

  it("answers an install for a document the index never listed with a 404", async () => {
    const response = await call("/i/graph/no-such-graph", { env: { INDEX: await seeded() } });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no graph named no-such-graph");
  });

  it("answers installs with a 503 before the first scheduled run", async () => {
    const response = await call("/i/graph/hello-graph", { env: {} });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(await response.text()).toContain(INDEXING_BODY);
  });

  it("tolerates a trailing slash", async () => {
    const response = await call("/i/graph/hello-graph/", { env: { INDEX: await seeded() } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph"));
  });

  it("never returns the document itself", async () => {
    const response = await call("/i/graph/hello-graph", { env: { INDEX: await seeded() } });
    expect(response.body).toBeNull();
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("answers a blocked document's install with 410 JSON, the reason and the issue", async () => {
    const kv = await seeded();
    const block: BlockedEntry = {
      kind: "graph",
      repo: "UniverLab/canopy-graphs",
      slug: "hello-graph",
      reason: "Malicious or dangerous command",
      issue: "https://github.com/UniverLab/canopy-graphs/issues/12",
      blocked_at: "2026-10-27",
    };
    await kv.put(blockedDocKey("graph", "UniverLab", "canopy-graphs", "hello-graph"), JSON.stringify(block));
    const response = await call("/i/graph/hello-graph", { env: { INDEX: kv } });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: "blocked",
      reason: block.reason,
      issue: block.issue,
    });
  });

  it("answers an install from a blocked repository with 410 JSON", async () => {
    const kv = await seeded();
    const block: BlockedEntry = {
      repo: "acme/things",
      reason: "Prompt that steers the agent to do harm",
      issue: "https://github.com/UniverLab/canopy-graphs/issues/13",
      blocked_at: "2026-10-27",
    };
    await kv.put(blockedRepoKey("acme", "things"), JSON.stringify(block));
    const response = await call("/i/acme/things/graph/flow", { env: { INDEX: kv } });
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: string }).error).toBe("blocked");
  });

  it("answers a pinned-ref install of a blocked document with 410, never fetching the ref", async () => {
    const kv = await seeded();
    const block: BlockedEntry = {
      kind: "graph",
      repo: "UniverLab/canopy-graphs",
      slug: "hello-graph",
      reason: "Broken or invalid",
      issue: "https://github.com/UniverLab/canopy-graphs/issues/14",
      blocked_at: "2026-10-27",
    };
    await kv.put(blockedDocKey("graph", "UniverLab", "canopy-graphs", "hello-graph"), JSON.stringify(block));
    // A block outranks a pinned ref: the 410 arrives before any live fetch,
    // so pinning a tag cannot install what the catalogue removed.
    const response = await call("/i/graph/hello-graph?ref=v1.2.0", { env: { INDEX: kv } });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: "blocked",
      reason: block.reason,
      issue: block.issue,
    });
  });
});

describe("explicit refs go live", () => {
  /** A Worker whose upstream is the stub table; the index stays empty. */
  function liveWorker(stubs: Stub[]) {
    const fake = fakeFetch(stubs);
    return {
      worker: createWorker({ fetchImpl: fake.fetchImpl, cache: new FakeCache() }),
      fetch: fake,
    };
  }

  it("honours ?ref= for a tag", async () => {
    const { worker: live } = liveWorker(officialStubs());
    const response = await live.fetch(
      new Request(`${ORIGIN}/i/graph/hello-graph?ref=v1.2.0`),
      {},
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph", "v1.2.0"));
  });

  it("honours ?ref= for a branch containing a slash", async () => {
    const { worker: live } = liveWorker([
      { url: "repos/acme/things/contents/nodes/cool-node/node.json", status: 200, body: fileBody("nodes/cool-node/node.json", VALID_NODE_TEXT) },
      { url: "repos/acme/things/contents/nodes/cool-node/README.md", status: 404, body: {} },
    ]);
    const response = await live.fetch(
      new Request(`${ORIGIN}/i/acme/things/node/cool-node?ref=release/1.x`),
      {},
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      community("acme", "things", "node", "cool-node", "release/1.x"),
    );
  });

  it("answers a 404 when the pinned ref has no such document", async () => {
    const { worker: live } = liveWorker([
      { url: "repos/acme/things/contents/graphs/flow/graph.json", status: 404, body: {} },
    ]);
    const response = await live.fetch(
      new Request(`${ORIGIN}/i/acme/things/graph/flow?ref=v9.9.9`),
      {},
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no graph named flow");
  });

  it("answers a 404 when the pinned ref holds an invalid document", async () => {
    const { worker: live } = liveWorker([
      { url: "repos/acme/things/contents/graphs/flow/graph.json", status: 200, body: fileBody("graphs/flow/graph.json", INVALID_GRAPH_TEXT) },
    ]);
    const response = await live.fetch(
      new Request(`${ORIGIN}/i/acme/things/graph/flow?ref=main`),
      {},
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("no graph named flow");
  });

  it("fetches the pinned ref live even during the cold start", async () => {
    const { worker: live, fetch } = liveWorker([
      { url: "repos/acme/things/contents/graphs/flow/graph.json", status: 200, body: fileBody("graphs/flow/graph.json", VALID_GRAPH_TEXT) },
      { url: "repos/acme/things/contents/graphs/flow/README.md", status: 404, body: {} },
    ]);
    // No INDEX binding at all: the cold start does not touch ?ref= installs.
    const response = await live.fetch(
      new Request(`${ORIGIN}/i/acme/things/graph/flow?ref=main`),
      {},
    );
    expect(response.status).toBe(302);
    expect(fetch.calls.length).toBeGreaterThan(0);
  });
});

describe("bad requests", () => {
  const cases: Array<{ path: string; reason: string }> = [
    { path: "/i/preset/hello-graph", reason: "kind must be graph or node" },
    { path: "/i/graph/Hello", reason: "slug must be 1-48 characters of a-z, 0-9 or -" },
    { path: "/i/graph/hello_node", reason: "slug must be 1-48 characters of a-z, 0-9 or -" },
    { path: `/i/graph/${"a".repeat(49)}`, reason: "slug must be 1-48 characters of a-z, 0-9 or -" },
    { path: "/i/graph", reason: "unknown route" },
    { path: "/i/a/b/c", reason: "unknown route" },
    { path: "/i/graph/hello-graph/extra/route/more", reason: "unknown route" },
    { path: "/i/-acme/things/graph/flow", reason: "owner must follow GitHub rules" },
    { path: "/i/acme/re@po/graph/flow", reason: "repo must follow GitHub rules" },
    { path: "/i/acme/things/preset/flow", reason: "kind must be graph or node" },
    { path: "/i/acme/things/graph/Flow", reason: "slug must be 1-48 characters of a-z, 0-9 or -" },
    { path: "/i/graph/hello-graph?ref=", reason: "ref must be a branch, tag or commit sha" },
    { path: "/i/graph/hello-graph?ref=-main", reason: "ref must be a branch, tag or commit sha" },
    {
      path: `/i/graph/hello-graph?ref=${"x".repeat(129)}`,
      reason: "ref must be a branch, tag or commit sha",
    },
  ];

  it("rejects every invalid shape with a 400 and a one-line reason", async () => {
    for (const { path, reason } of cases) {
      const response = await call(path);
      expect(response.status, path).toBe(400);
      expect(response.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
      const text = await response.text();
      expect(text, path).toContain(reason);
      expect(text.trimEnd().split("\n"), path).toHaveLength(1);
    }
  });

  it("rejects through the deployed Worker too", async () => {
    const response = await SELF.fetch(`${ORIGIN}/i/preset/hello-graph`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("kind must be graph or node");
  });
});

describe("unknown paths", () => {
  it.each(["/health", "/.well-known/security.txt"])("answers %s with a 404 and the one-line usage reason", async (path) => {
    const response = await call(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("unknown route");
    expect(text.trimEnd().split("\n")).toHaveLength(1);
  });

  it("answers an unknown path with a 404 through the deployed Worker too", async () => {
    const response = await SELF.fetch(`${ORIGIN}/health`, { redirect: "manual" });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("unknown route");
  });
});

describe("bare install path", () => {
  it.each(["/i/", "/i"])("answers %s with a 404 and the usage text", async (path) => {
    const response = await call(path);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain("/i/<kind>/<slug>");
    expect(text).toContain("/i/<owner>/<repo>/<kind>/<slug>");
    expect(text).toContain("graph or node");
  });
});

describe("counting", () => {
  it("writes one point for a redirect", async () => {
    const points: DataPoint[] = [];
    const response = await call("/i/graph/hello-graph", { ua: "curl/8.5.0", env: await counting(points) });
    expect(response.status).toBe(302);
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({
      indexes: ["UniverLab/canopy-graphs/graph/hello-graph"],
      blobs: ["graph", "UniverLab/canopy-graphs/hello-graph", "curl", "", "", "redirect"],
      doubles: [1],
    });
  });

  it("records the Canopy version and country without the raw user-agent", async () => {
    const points: DataPoint[] = [];
    await call("/i/node/hello-node", {
      ua: `canopy/1.7.2 ${"x".repeat(200)}`,
      country: "CO",
      env: await counting(points),
    });
    expect(points).toHaveLength(1);
    const blobs = points[0]?.blobs ?? [];
    expect(blobs[2]).toBe("canopy");
    expect(blobs[3]).toBe("1.7.2");
    expect(blobs[4]).toBe("CO");
    expect(blobs.join(" ")).not.toContain("x".repeat(10));
  });

  it("tells browsers and unknown clients from scripts", async () => {
    const cases: Array<[string | null, string]> = [
      ["Mozilla/5.0 (Macintosh) Safari/605", "browser"],
      ["wget/1.21", "other"],
      [null, "other"],
    ];
    for (const [ua, client] of cases) {
      const points: DataPoint[] = [];
      await call("/i/graph/hello-graph", { ua, env: await counting(points) });
      expect(points[0]?.blobs?.[2], String(ua)).toBe(client);
      expect(points[0]?.blobs?.[3], String(ua)).toBe("");
    }
  });

  it("writes a bad-request point with the parts it could read", async () => {
    const points: DataPoint[] = [];
    const response = await call("/i/graph/Not_A_Slug", { env: await counting(points) });
    expect(response.status).toBe(400);
    expect(points).toEqual([
      {
        indexes: ["UniverLab/canopy-graphs/graph/?"],
        blobs: ["graph", "UniverLab/canopy-graphs/?", "curl", "", "", "bad-request"],
        doubles: [1],
      },
    ]);
  });

  it("writes a bad-request point for the bare /i/", async () => {
    const points: DataPoint[] = [];
    const response = await call("/i/", { env: await counting(points) });
    expect(response.status).toBe(404);
    expect(points).toEqual([
      { indexes: ["?/?/?/?"], blobs: ["?", "?/?/?", "curl", "", "", "bad-request"], doubles: [1] },
    ]);
  });

  it("writes one point per request, never two", async () => {
    const points: DataPoint[] = [];
    const env = await counting(points);
    for (const path of ["/i/graph/hello-graph", "/i/graph/no-such-graph", "/health"]) {
      await call(path, { env });
    }
    expect(points).toHaveLength(3);
  });
});

describe("analytics never changes the answer", () => {
  it("still redirects when the binding throws", async () => {
    const env: Env = {
      INDEX: await seeded(),
      INSTALLS: {
        writeDataPoint: (): void => {
          throw new Error("analytics engine is down");
        },
      },
    };
    const response = await call("/i/graph/hello-graph", { env });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph"));
  });

  it("still answers bad requests when the binding throws", async () => {
    const env: Env = {
      INSTALLS: {
        writeDataPoint: (): void => {
          throw new Error("analytics engine is down");
        },
      },
    };
    const response = await call("/i/preset/hello-graph", { env });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("kind must be graph or node");
  });
});

describe("the scheduled run", () => {
  it("fills the index from the scheduled handler, authenticated with the token", async () => {
    const fake = fakeFetch(officialStubs());
    const kv = new FakeKV();
    const scheduled = createWorker({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    let waited = 0;
    await scheduled.scheduled(
      { scheduledTime: Date.now(), cron: "*/15 * * * *" },
      { INDEX: kv, GITHUB_TOKEN: "tok" },
      { waitUntil: (promise: Promise<unknown>) => { void promise; waited += 1; } },
    );
    expect(waited).toBe(1);
    const index = JSON.parse((await kv.get("index:v1")) as string) as { entries: unknown[] };
    expect(index.entries.length).toBe(2);
    const meta = JSON.parse((await kv.get("index:meta")) as string) as { authenticated: boolean };
    expect(meta.authenticated).toBe(true);
  });

  it("runs unauthenticated without a token", async () => {
    const fake = fakeFetch(officialStubs());
    const kv = new FakeKV();
    const scheduled = createWorker({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    await scheduled.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *" }, { INDEX: kv });
    const meta = JSON.parse((await kv.get("index:meta")) as string) as { authenticated: boolean; calls: number };
    expect(meta.authenticated).toBe(false);
    expect(meta.calls).toBeLessThanOrEqual(50);
  });

  it("does nothing without the index binding", async () => {
    await expect(
      worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *" }, {}),
    ).resolves.toBeUndefined();
  });
});

describe("slug rule", () => {
  it("matches the literal pattern copied from src/slug.ts", () => {
    expect(SLUG_RE.source).toBe(SLUG_PATTERN);
    expect(SLUG_RE.test("hello-graph")).toBe(true);
    expect(SLUG_RE.test("hello_graph")).toBe(false);
    expect(SLUG_RE.test("Hello")).toBe(false);
  });
});
