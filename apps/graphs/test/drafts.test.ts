// SPDX-License-Identifier: Apache-2.0
/**
 * Drafts: the 30-minute, one-use sharing path.
 *
 * The API and the pages are served through the production Worker over fresh
 * in-memory KV namespaces (test/fakes.ts), so every test exercises the same
 * route table the deploy ships: create → read → install → gone, the TTL on
 * the KV write, the validation paths, the limiter, the page banner and the
 * promise that a draft is never listed anywhere.
 */
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { createGitHub } from "../src/github.js";
import { runIndexer } from "../src/indexer.js";
import { resetIndexMemo } from "../src/store.js";
import { DRAFT_MAX_BYTES, DRAFT_TTL_SECONDS, DRAFT_ID_RE, draftKey } from "../src/drafts.js";
import {
  DRAFT_BANNER_LEAD,
  DRAFT_BANNER_TAIL,
  DRAFT_MISSING_BODY,
  DRAFT_MISSING_HEADING,
  draftTime,
} from "../src/pages/copy.js";
import { FakeCache, FakeKV, FakeRateLimit, fakeFetch, type Stub } from "./fakes.js";
import { searchStubs } from "./stubs.js";
import { VALID_GRAPH_TEXT } from "./documents-fixture.js";

const ORIGIN = "https://graphs.univerlab.org";

/** The Worker's own Env, so the helpers speak the deploy's types. */
type WorkerEnv = Parameters<typeof worker.fetch>[1];

/** One fresh copy of the valid fixture graph. */
function graph(): Record<string, unknown> {
  return JSON.parse(VALID_GRAPH_TEXT) as Record<string, unknown>;
}

/** One valid node document, small enough to read in an assertion. */
function node(): Record<string, unknown> {
  return {
    format_version: 1,
    name: "plan-node",
    kind: "agent",
    description: "Drafts a plan.",
    config: { prompt_template: "Draft a plan for {{spec_name}}." },
  };
}

/** Seed a fresh index by running the indexer over the stub table. */
async function seeded(stubsToSeed: Stub[]): Promise<FakeKV> {
  resetIndexMemo();
  const fake = fakeFetch(stubsToSeed);
  const kv = new FakeKV();
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
  await runIndexer({ github, index: kv, authenticated: true });
  return kv;
}

function get(path: string, env: WorkerEnv, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env);
}

function post(
  body: unknown,
  env: WorkerEnv,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`${ORIGIN}/api/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );
}

interface Created {
  id: string;
  kind: string;
  name: string;
  expires_at: string;
  page_url: string;
  install: string;
}

/** Create one draft and hand back its 201 body. */
async function create(
  env: WorkerEnv,
  body: unknown = { kind: "graph", document: graph() },
): Promise<Created> {
  const response = await post(body, env);
  expect(response.status).toBe(201);
  return (await response.json()) as Created;
}

describe("the draft lifecycle", () => {
  it("creates, reads, installs, and is gone after the first install", async () => {
    const kv = new FakeKV();
    const env: WorkerEnv = { DRAFTS: kv };
    const draft = await create(env);

    expect(draft.id).toMatch(DRAFT_ID_RE);
    expect(draft.id).toHaveLength(26);
    expect(draft.kind).toBe("graph");
    expect(draft.name).toBe("hello-graph");
    expect(draft.page_url).toBe(`${ORIGIN}/d/${draft.id}`);
    expect(draft.install).toBe(`canopy graph install draft:${draft.id}`);
    expect(Number.isNaN(Date.parse(draft.expires_at))).toBe(false);

    // GET /api/drafts/<id> answers the stored shape and consumes nothing.
    const read = await get(`/api/drafts/${draft.id}`, env);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    const stored = (await read.json()) as {
      kind: string;
      document: { name: string };
      expires_at: string;
    };
    expect(stored.kind).toBe("graph");
    expect(stored.expires_at).toBe(draft.expires_at);
    expect(stored.document.name).toBe("hello-graph");
    expect(kv.has(draftKey(draft.id))).toBe(true);

    // The install answers the document itself, `no-store`.
    const install = await get(`/i/draft/${draft.id}`, env);
    expect(install.status).toBe(200);
    expect(install.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(install.headers.get("cache-control")).toBe("no-store");
    const document = (await install.json()) as { name: string; nodes: unknown[] };
    expect(document.name).toBe("hello-graph");
    expect(Array.isArray(document.nodes)).toBe(true);
    expect(kv.has(draftKey(draft.id))).toBe(false);

    // Second install: missing, and the read route agrees.
    expect((await get(`/i/draft/${draft.id}`, env)).status).toBe(404);
    expect((await get(`/api/drafts/${draft.id}`, env)).status).toBe(404);
  });

  it("mints ids from 128 random bits, never repeating one", async () => {
    const env: WorkerEnv = { DRAFTS: new FakeKV() };
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      ids.add((await create(env, { kind: "node", document: node() })).id);
    }
    expect(ids.size).toBe(5);
    for (const id of ids) {
      expect(id).toMatch(DRAFT_ID_RE);
    }
  });

  it("stores under draft:v1:<id> with expirationTtl 1800", async () => {
    const kv = new FakeKV();
    const before = Date.now();
    const draft = await create({ DRAFTS: kv });

    expect(DRAFT_TTL_SECONDS).toBe(1800);
    expect(kv.putOptions).toEqual([
      { key: draftKey(draft.id), expirationTtl: 1800 },
    ]);
    const lifetime = Date.parse(draft.expires_at) - before;
    expect(lifetime).toBeGreaterThanOrEqual(1790_000);
    expect(lifetime).toBeLessThanOrEqual(1801_000);
  });

  it("counts an install in the existing analytics as kind draft", async () => {
    const points: Array<{ indexes?: string[]; blobs?: string[] }> = [];
    const env: WorkerEnv = {
      DRAFTS: new FakeKV(),
      INSTALLS: { writeDataPoint: (point) => points.push(point) },
    };
    const draft = await create(env);
    await get(`/i/draft/${draft.id}`, env);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[0]).toBe("draft");
    expect(points[0]?.indexes?.[0]).toBe(`?/?/draft/${draft.id}`);
  });
});

describe("draft validation", () => {
  it("refuses an invalid document with each problem's path", async () => {
    const kv = new FakeKV();
    const broken = graph();
    delete broken["nodes"];
    delete broken["edges"];
    const response = await post({ kind: "graph", document: broken }, { DRAFTS: kv });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      kind: string;
      problems: Array<{ path: string; message: string }>;
      total: number;
    };
    expect(body.kind).toBe("invalid-document");
    expect(body.total).toBeGreaterThan(0);
    expect(body.problems.length).toBe(body.total);
    expect(body.problems.map((problem) => problem.path)).toContain("#");
    for (const problem of body.problems) {
      expect(typeof problem.path).toBe("string");
      expect(problem.message.length).toBeGreaterThan(0);
    }
    expect(kv.storedKeys()).toEqual([]);
  });

  it("refuses harness bindings in a node config, a graph node and an ensemble member", async () => {
    const kv = new FakeKV();
    const env: WorkerEnv = { DRAFTS: kv };

    const withNodeConfig = await post(
      { kind: "node", document: { ...node(), config: { platform: "claude" } } },
      env,
    );
    expect(withNodeConfig.status).toBe(400);
    const nodeProblems = (await withNodeConfig.json()) as {
      problems: Array<{ path: string; message: string }>;
    };
    expect(nodeProblems.problems[0]?.path).toBe("#/config/platform");
    expect(nodeProblems.problems[0]?.message).toContain("platform, model or cli");

    const graphWithNode = graph();
    const nodes = graphWithNode["nodes"] as Array<{ config: Record<string, unknown> }>;
    nodes[0]!.config = { model: "opus" };
    const nodeInGraph = await post({ kind: "graph", document: graphWithNode }, env);
    expect(nodeInGraph.status).toBe(400);
    expect(((await nodeInGraph.json()) as { problems: Array<{ path: string }> }).problems[0]?.path)
      .toBe("#/nodes/0/config/model");

    const graphWithMember = graph();
    const ensembles = graphWithMember["ensembles"] as Array<{
      members: Array<Record<string, unknown>>;
    }>;
    ensembles[0]!.members[0] = { ...ensembles[0]!.members[0], platform: "claude" };
    const member = await post({ kind: "graph", document: graphWithMember }, env);
    expect(member.status).toBe(400);
    expect(((await member.json()) as { problems: Array<{ path: string }> }).problems[0]?.path)
      .toBe("#/ensembles/0/members/0/platform");

    expect(kv.storedKeys()).toEqual([]);
  });

  it("refuses a body over 256 KiB with 413", async () => {
    const kv = new FakeKV();
    const huge = JSON.stringify({
      kind: "graph",
      document: { ...graph(), padding: "a".repeat(DRAFT_MAX_BYTES) },
    });
    expect(huge.length).toBeGreaterThan(DRAFT_MAX_BYTES);
    const response = await post(huge, { DRAFTS: kv });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { kind: string }).kind).toBe("too-large");
    expect(kv.storedKeys()).toEqual([]);
  });

  it("refuses a body that is not { kind, document }", async () => {
    for (const body of [{ kind: "tool", document: node() }, { kind: "node" }, { kind: "node", document: [] }]) {
      const response = await post(body, { DRAFTS: new FakeKV() });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { kind: string }).kind).toBe("invalid-body");
    }
  });
});

describe("the draft limiter", () => {
  it("keys on the client IP and answers 429 with Retry-After when it refuses", async () => {
    const kv = new FakeKV();
    const limiter = new FakeRateLimit(0);
    const response = await post(
      { kind: "node", document: node() },
      { DRAFTS: kv, DRAFT_LIMIT: limiter },
      { "cf-connecting-ip": "203.0.113.7" },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(((await response.json()) as { kind: string }).kind).toBe("rate-limited");
    expect(limiter.keys).toEqual(["draft:203.0.113.7"]);
    expect(kv.storedKeys()).toEqual([]);
  });

  it("allows drafts while the binding allows them, and is unlimited without it", async () => {
    const limited: WorkerEnv = { DRAFTS: new FakeKV(), DRAFT_LIMIT: new FakeRateLimit(1) };
    expect((await post({ kind: "node", document: node() }, limited)).status).toBe(201);
    expect((await post({ kind: "node", document: node() }, limited)).status).toBe(429);

    const unlimited: WorkerEnv = { DRAFTS: new FakeKV() };
    for (let i = 0; i < 3; i += 1) {
      expect((await post({ kind: "node", document: node() }, unlimited)).status).toBe(201);
    }
  });
});

describe("the draft page", () => {
  it("renders the same document page as /g, with the install command and Copy", async () => {
    const kv = new FakeKV();
    const env: WorkerEnv = { DRAFTS: kv };
    const draft = await create(env);
    const response = await get(`/d/${draft.id}`, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();

    // The plate, the datasheet and the transparency section, like /g.
    expect(html).toContain(`<figure class="plate">`);
    expect(html).toContain(`<dt>Kind</dt><dd>`);
    expect(html).toContain(`<dt>Install</dt>`);
    expect(html).toContain(`<section class="runs" id="what-this-runs">`);
    expect(html).toContain(`canopy graph install draft:${draft.id}`);
    expect(html).toContain(`data-copy="canopy graph install draft:${draft.id}"`);
    expect(html).toContain(`<span class="copy-text">Copy</span></button>`);

    // A draft has no repository, so the GitHub furniture is absent.
    expect(html).not.toContain("Star on GitHub");
    expect(html).not.toContain(`<dt>Source</dt>`);
    expect(html).not.toContain(`<dt>Report</dt>`);
    expect(html).not.toContain(`Community document.`);
  });

  it("banners the draft as unreviewed, expiring at a time, gone after one install", async () => {
    const env: WorkerEnv = { DRAFTS: new FakeKV() };
    const draft = await create(env);
    const html = await (await get(`/d/${draft.id}`, env)).text();
    const when = draftTime(draft.expires_at);
    expect(html).toContain(DRAFT_BANNER_LEAD);
    expect(html).toContain(DRAFT_BANNER_TAIL);
    expect(html).toContain(`<time datetime="${draft.expires_at}">${when}</time>`);
    // The banner opens the content, above the title.
    expect(html.indexOf(`role="note"`)).toBeLessThan(html.indexOf(`<h1 class="doc-title">`));
  });

  it("carries noindex and never consumes the draft", async () => {
    const kv = new FakeKV();
    const env: WorkerEnv = { DRAFTS: kv };
    const draft = await create(env);
    const html = await (await get(`/d/${draft.id}`, env)).text();
    expect(html).toContain(`<meta name="robots" content="noindex">`);
    // Two views, and the draft is still installable afterwards.
    expect((await get(`/d/${draft.id}`, env)).status).toBe(200);
    expect(kv.has(draftKey(draft.id))).toBe(true);
    expect((await get(`/i/draft/${draft.id}`, env)).status).toBe(200);
  });

  it("answers an unknown or expired draft with 404 and the 30-minute rule", async () => {
    const kv = new FakeKV();
    const env: WorkerEnv = { DRAFTS: kv };
    const unknown = await get(`/d/${"a".repeat(26)}`, env);
    expect(unknown.status).toBe(404);
    const html = await unknown.text();
    expect(html).toContain(DRAFT_MISSING_HEADING);
    expect(html).toContain(DRAFT_MISSING_BODY);
    expect(html).toContain("30 minutes or one install");

    // A record whose expiry has passed reads as gone, even before KV collects it.
    const id = "b".repeat(26);
    await kv.put(
      draftKey(id),
      JSON.stringify({ kind: "graph", document: graph(), expires_at: "2000-01-01T00:00:00.000Z" }),
    );
    expect((await get(`/d/${id}`, env)).status).toBe(404);
    expect((await get(`/i/draft/${id}`, env)).status).toBe(404);
  });

  it("answers 503 when draft storage is not configured", async () => {
    expect((await post({ kind: "node", document: node() }, {})).status).toBe(503);
    expect((await get(`/i/draft/${"c".repeat(26)}`, {})).status).toBe(503);
  });
});

describe("visibility", () => {
  it("never appears in search, llms.txt or the sitemap", async () => {
    const kv = await seeded(searchStubs());
    const env: WorkerEnv = { INDEX: kv, DRAFTS: kv };
    const draft = await create(env);
    // A search for the id finds nothing: the echo of `q` names it, the
    // catalogue does not.
    const search = (await (await get(`/api/search?q=${draft.id}`, env)).json()) as {
      items: unknown[];
      total: number;
    };
    expect(search.total).toBe(0);
    expect(search.items).toEqual([]);
    for (const path of ["/api/search?q=hello-graph", "/llms.txt", "/sitemap.xml", "/"]) {
      const text = await (await get(path, env)).text();
      expect(text, path).not.toContain(draft.id);
      expect(text, path).not.toContain("/d/");
    }
  });
});
