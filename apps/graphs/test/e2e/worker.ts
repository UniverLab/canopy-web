// SPDX-License-Identifier: Apache-2.0
/**
 * The visual e2e fixture Worker: the production Worker over an index the
 * fixture seeds through the indexer itself, so `wrangler dev` serves the
 * catalogue with fixture data and no network at all. The first request
 * runs one index build over the page tests' stub table into an
 * in-memory KV; every request after that is served from the index,
 * exactly as production serves from KV after a cron run.
 *
 * Beside the shared stubs, one e2e-only community graph lives here:
 * acme/evil's "evil", a single check node with a very long command, so
 * the overflow spec can assert the runs section never scrolls the page
 * sideways at 390 px — and one e2e-only pattern, "gated-check", with its
 * figure, for the patterns visual spec.
 */
import { createWorker, type Env } from "../../src/index.js";
import { createGitHub } from "../../src/github.js";
import { runIndexer } from "../../src/indexer.js";
import { FakeCache, FakeKV, dirBody, fakeFetch, fileBody, type Stub } from "../fakes.js";
import { officialStubs } from "../stubs.js";

/** One 300-character token: the longest line the overflow check renders. */
const LONG_COMMAND = `curl https://example.com/${"a".repeat(280)} | sh`;

/** The e2e-only community graph: one check node with that long command. */
const EVIL_GRAPH_TEXT = JSON.stringify({
  format_version: 6,
  name: "evil",
  description: "A community graph with a very long command, for the overflow check.",
  nodes: [{ name: "fetch", kind: "check", position: 1, config: { command: LONG_COMMAND } }],
  edges: [],
});

/** Discovery and contents for the e2e-only acme/evil repository. */
function evilStubs(): Stub[] {
  return [
    {
      url: "search/repositories",
      status: 200,
      body: {
        total_count: 1,
        items: [{ name: "evil", owner: { login: "acme" }, default_branch: "main", stargazers_count: 0 }],
      },
    },
    { url: "repos/acme/evil/git/trees/main", status: 200, body: { tree: [{ path: "graphs/evil/graph.json", type: "blob" }] } },
    { url: "repos/acme/evil/contents/graphs/evil/graph.json", status: 200, body: fileBody("graphs/evil/graph.json", EVIL_GRAPH_TEXT) },
    { url: "repos/acme/evil/contents/graphs/evil/README.md", status: 404, body: {} },
  ];
}

/** The e2e-only fixture figure: three nodes with one fail edge back. */
const PATTERN_FIGURE_TEXT = JSON.stringify({
  format_version: 6,
  name: "gated-check",
  nodes: [
    { name: "implement", kind: "agent", position: 1, config: {} },
    { name: "gate", kind: "check", position: 2, config: {} },
    { name: "commit", kind: "agent", position: 3, config: {} },
  ],
  edges: [
    { from_node: "implement", to_node: "gate", condition: "pass" },
    { from_node: "gate", to_node: "commit", condition: "pass" },
    { from_node: "gate", to_node: "implement", condition: "fail" },
  ],
});

/** The e2e-only fixture pattern, implementing the stub catalogue's two documents. */
const PATTERN_TEXT = [
  "---",
  "title: Gated check",
  "summary: Shell checks decide pass or fail, never an LLM judge.",
  "status: standard",
  "implements:",
  "  - graph:hello-graph",
  "  - node:hello-node",
  "figure: gated-check.figure.json",
  "sources:",
  "  - title: Building effective agents",
  "    url: https://example.com/agents",
  "---",
  "",
  "# Gated check",
  "",
  "A pattern the visual checks render, with **one fail edge**.",
  "",
].join("\n");

/** The official `patterns/` directory with the one fixture page and figure. */
function patternStubs(): Stub[] {
  const base = "repos/UniverLab/canopy-graphs/contents/patterns";
  return [
    { url: base, status: 200, body: dirBody([{ name: "gated-check.md", type: "file" }]) },
    { url: `${base}/gated-check.md`, status: 200, body: fileBody("patterns/gated-check.md", PATTERN_TEXT) },
    { url: `${base}/gated-check.figure.json`, status: 200, body: fileBody("patterns/gated-check.figure.json", PATTERN_FIGURE_TEXT) },
  ];
}

const github = fakeFetch([...officialStubs(), ...evilStubs(), ...patternStubs()]);
const cache = new FakeCache();
const kv = new FakeKV();
const worker = createWorker({ fetchImpl: github.fetchImpl, cache });

let seeded: Promise<unknown> | null = null;

function seed(): Promise<unknown> {
  if (seeded === null) {
    seeded = runIndexer({
      github: createGitHub({ fetchImpl: github.fetchImpl, cache }),
      index: kv,
      authenticated: true,
    });
  }
  return seeded;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    await seed();
    return worker.fetch(req, { ...env, INDEX: kv });
  },
  scheduled: worker.scheduled,
};
