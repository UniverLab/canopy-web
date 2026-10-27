// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_CACHE_URL,
  attachDownloads,
  createAnalytics,
  downloadKey,
  type Downloads,
} from "../src/analytics.js";
import type { Doc } from "../src/documents.js";
import { isOfficialRepo } from "../src/lib.js";
import { FakeCache, fakeFetch } from "./fakes.js";

const SQL_URL = "analytics_engine/sql";

function sampleDoc(slug: string, kind: "graph" | "node", repo: string): Doc {
  const [owner = "", name = ""] = repo.split("/");
  return {
    kind,
    slug,
    name: slug,
    description: "",
    readme: "",
    nodeCount: kind === "node" ? 1 : 3,
    repo,
    official: isOfficialRepo(owner, name),
    stars: null,
    updated: null,
    harnesses: [],
    sourceRef: null,
  };
}

describe("the analytics collector", () => {
  it("returns null and calls nothing when unconfigured", async () => {
    const fake = fakeFetch([]);
    const analytics = createAnalytics({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const volumes = await analytics.volume();
    expect(volumes).toBeNull();
    expect(fake.calls.length).toBe(0);
  });

  it("queries the Analytics Engine SQL API and maps index counts", async () => {
    const fake = fakeFetch([
      {
        url: SQL_URL,
        status: 200,
        body: {
          data: [
            { index: "UniverLab/canopy-graphs/graph/hello-graph", count: 12 },
            { index: "acme/things/node/cool-node", count: 4 },
          ],
        },
      },
    ]);
    const analytics = createAnalytics({
      fetchImpl: fake.fetchImpl,
      cache: new FakeCache(),
      accountId: "acct",
      token: "tok",
    });
    const volumes = (await analytics.volume()) as Downloads;
    expect(volumes.get("UniverLab/canopy-graphs/graph/hello-graph")).toBe(12);
    expect(volumes.get("acme/things/node/cool-node")).toBe(4);
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]).toContain("accounts/acct/analytics_engine/sql");
    // Pin the real Analytics Engine columns: the index lives in index1, so
    // the SQL must select and group by it, over the 90-day window.
    expect(fake.bodies[0]).toContain("SELECT index1 AS index");
    expect(fake.bodies[0]).toContain("SUM(_sample_interval) AS count");
    expect(fake.bodies[0]).toContain(`INTERVAL '90' DAY`);
    expect(fake.bodies[0]).toContain("GROUP BY index1");
  });

  it("serves the second call from the cache without a second SQL call", async () => {
    const fake = fakeFetch([
      { url: SQL_URL, status: 200, body: { data: [{ index: "UniverLab/canopy-graphs/graph/hello-graph", count: 12 }] } },
    ]);
    const cache = new FakeCache();
    const analytics = createAnalytics({
      fetchImpl: fake.fetchImpl,
      cache,
      accountId: "acct",
      token: "tok",
    });
    await analytics.volume();
    const again = await analytics.volume();
    expect(fake.calls.length).toBe(1);
    expect(cache.has(ANALYTICS_CACHE_URL)).toBe(true);
    expect((again as Downloads).get("UniverLab/canopy-graphs/graph/hello-graph")).toBe(12);
  });

  it("returns null when the SQL call fails, never a throw", async () => {
    const analytics = createAnalytics({
      fetchImpl: (async () => {
        throw new Error("sql down");
      }) as unknown as typeof fetch,
      cache: new FakeCache(),
      accountId: "acct",
      token: "tok",
    });
    expect(await analytics.volume()).toBeNull();
  });

  it("attaches 90-day counts where they match and nothing where they do not", () => {
    const docs = [
      sampleDoc("hello-graph", "graph", "UniverLab/canopy-graphs"),
      sampleDoc("quiet-graph", "graph", "UniverLab/canopy-graphs"),
    ];
    const volumes = new Map<string, number>([[downloadKey(docs[0]), 12]]);
    const attached = attachDownloads(docs, volumes);
    expect(attached[0].downloads).toBe(12);
    expect("downloads" in attached[1]).toBe(false);
    expect("downloads" in docs[0]).toBe(false);
  });

  it("leaves downloads absent altogether when analytics is unconfigured", () => {
    const attached = attachDownloads([sampleDoc("hello-graph", "graph", "UniverLab/canopy-graphs")], null);
    expect(attached[0].downloads).toBeUndefined();
  });
});
