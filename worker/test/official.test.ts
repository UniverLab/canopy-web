// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { OfficialListing } from "../src/official.js";
import { listOfficial } from "../src/official.js";
import { createGitHub } from "../src/github.js";
import { FakeCache, dirBody, fakeFetch, fileBody } from "./fakes.js";
import { INVALID_GRAPH_TEXT, VALID_GRAPH_TEXT } from "./documents-fixture.js";

const REPO_DIR = "repos/UniverLab/graphs";

/** The GitHub-shaped stubs behind one and two official documents. */
const STUBS = (brokenToo: boolean) => [
  {
    url: `${REPO_DIR}/contents/registry/graphs`,
    status: 200,
    body: dirBody(
      brokenToo
        ? [{ name: "broken-graph", type: "dir" }, { name: "hello-graph", type: "dir" }]
        : [{ name: "hello-graph", type: "dir" }],
    ),
  },
  { url: `${REPO_DIR}/contents/registry/nodes`, status: 200, body: [] },
  { url: `${REPO_DIR}/contents/registry/graphs/hello-graph/graph.json`, status: 200, body: fileBody("graphs/hello-graph/graph.json", VALID_GRAPH_TEXT) },
  { url: `${REPO_DIR}/contents/registry/graphs/broken-graph/graph.json`, status: 200, body: fileBody("graphs/broken-graph/graph.json", INVALID_GRAPH_TEXT) },
  { url: `${REPO_DIR}/contents/registry/graphs/hello-graph/README.md`, status: 200, body: fileBody("graphs/hello-graph/README.md", "# hello-graph\n\nA tiny graph.\n") },
  { url: `${REPO_DIR}/contents/registry/graphs/broken-graph/README.md`, status: 404, body: {} },
  { url: "repos/UniverLab/graphs", status: 200, body: { stargazers_count: 7 } },
];

describe("the official listing", () => {
  it("lists a valid document with every field the pages render", async () => {
    const fake = fakeFetch(STUBS(false));
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const listing = (await listOfficial(github, () => undefined)) as OfficialListing;

    expect("kind" in listing).toBe(false);
    expect(listing.graphs.length).toBe(1);
    expect(listing.nodes.length).toBe(0);
    const doc = listing.graphs[0];
    expect(doc.kind).toBe("graph");
    expect(doc.slug).toBe("hello-graph");
    expect(doc.name).toBe("hello-graph");
    expect(doc.readme).toContain("A tiny graph");
    expect(doc.nodeCount).toBe(4);
    expect(doc.repo).toBe("UniverLab/graphs");
    expect(doc.stars).toBe(7);
    expect("downloads" in doc).toBe(false);
  });

  it("drops an invalid document and still lists the valid ones", async () => {
    const fake = fakeFetch(STUBS(true));
    const cache = new FakeCache();
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache });
    const notes: string[] = [];
    const listing = (await listOfficial(github, (message) => notes.push(message))) as OfficialListing;

    expect(listing.graphs.length).toBe(1);
    expect(listing.graphs[0].slug).toBe("hello-graph");
    expect(notes.some((message) => message.includes("broken-graph"))).toBe(true);
  });

  it("lists a document whose README is missing, with an empty readme", async () => {
    const withoutReadme = [
      STUBS(false)[0],
      STUBS(false)[1],
      STUBS(false)[2],
      STUBS(false)[6],
    ];
    const fake = fakeFetch(withoutReadme);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const listing = (await listOfficial(github, () => undefined)) as OfficialListing;
    expect(listing.graphs.length).toBe(1);
    expect(listing.graphs[0].readme).toBe("");
  });

  it("surfaces a rate limit from the directory listing as a typed error", async () => {
    const fake = fakeFetch([
      {
        url: `${REPO_DIR}/contents/registry/graphs`,
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      },
    ]);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const error = await listOfficial(github, () => undefined);
    expect("kind" in error ? error.kind : "").toBe("rate-limit");
  });
});
