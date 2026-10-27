// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createGitHub, TTL } from "../src/github.js";
import { listOfficial } from "../src/official.js";
import { FakeCache, dirBody, fakeFetch, fileBody, type Stub } from "./fakes.js";
import { VALID_GRAPH_TEXT } from "./documents-fixture.js";

const REPO_DIR = "repos/UniverLab/canopy-web";

const STUBS: Stub[] = [
  { url: `${REPO_DIR}/contents/registry/graphs`, status: 200, body: dirBody([{ name: "hello-graph", type: "dir" }]) },
  { url: `${REPO_DIR}/contents/registry/nodes`, status: 200, body: [] },
  { url: `${REPO_DIR}/contents/registry/graphs/hello-graph/graph.json`, status: 200, body: fileBody("graphs/hello-graph/graph.json", VALID_GRAPH_TEXT) },
  { url: `${REPO_DIR}/contents/registry/graphs/hello-graph/README.md`, status: 200, body: fileBody("graphs/hello-graph/README.md", "# hello-graph\n") },
  { url: "repos/UniverLab/canopy-web", status: 200, body: { stargazers_count: 7 } },
];

describe("the Cache API contract", () => {
  it("serves a repeated request from the shared cache without new fetches", async () => {
    const fake = fakeFetch(STUBS);
    const cache = new FakeCache();
    const first = createGitHub({ fetchImpl: fake.fetchImpl, cache });
    const listing = await listOfficial(first, () => undefined);

    expect(fake.calls.length).toBe(5);
    const listed = listing as { graphs: Array<{ slug: string }> };
    expect(listed.graphs.length).toBe(1);

    // A second transport over the same cache: warm, no network needed.
    const warmFake = fakeFetch([]);
    const warm = createGitHub({ fetchImpl: warmFake.fetchImpl, cache });
    const again = await listOfficial(warm, () => undefined);
    expect(warmFake.calls.length).toBe(0);
    expect(again).toEqual(listing);
  });

  it("caches analytics results for an hour", async () => {
    const analyticsBody = { data: [{ index: "UniverLab/canopy-web/graph/hello-graph", count: 3 }] };
    const fake = fakeFetch([
      { url: "analytics_engine/sql", status: 200, body: analyticsBody },
    ]);
    const cache = new FakeCache();
    const one = await createGitHub({
      fetchImpl: fake.fetchImpl,
      cache,
      // only used to exercise TTL through a github-shaped key
    }).get("https://canopy.ttl/analytics", "analytics");
    void one;
    expect(TTL.analytics).toBe(3600);
    expect(TTL.contents).toBe(1800);
    expect(TTL.raw).toBe(1800);
    expect(TTL.search).toBe(600);
  });
});
