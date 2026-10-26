// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { searchCommunity, type SearchOutcome } from "../src/search.js";
import { createGitHub } from "../src/github.js";
import { FakeCache, dirBody, fakeFetch, fileBody, type Stub } from "./fakes.js";
import { BROKEN_NODE_TEXT, INVALID_GRAPH_TEXT, VALID_GRAPH_TEXT, VALID_NODE_TEXT } from "./documents-fixture.js";

const SEARCH = "search/repositories";

interface Repo {
  name: string;
  graphText: string;
  stars: number;
}

/** Stubs for a search of these repositories, each with one graph folder. */
function repoStubs(repos: Repo[]): Stub[] {
  const stubs: Stub[] = [
    {
      url: SEARCH,
      status: 200,
      body: {
        total_count: repos.length + 3,
        items: repos.map((repo) => ({
          name: repo.name,
          owner: { login: "acme" },
          default_branch: "main",
          stargazers_count: repo.stars,
        })),
      },
    },
  ];
  for (const repo of repos) {
    stubs.push({
      url: `repos/acme/${repo.name}/git/trees/main`,
      status: 200,
      body: {
        tree: [
          { path: "README.md", type: "blob" },
          { path: `graphs/flow/graph.json`, type: "blob" },
          { path: `graphs/flow/README.md`, type: "blob" },
        ],
      },
    });
    stubs.push({
      url: `repos/acme/${repo.name}/contents/graphs/flow/graph.json`,
      status: 200,
      body: fileBody("graphs/flow/graph.json", repo.graphText),
    });
    stubs.push({
      url: `repos/acme/${repo.name}/contents/graphs/flow/README.md`,
      status: 200,
      body: fileBody("graphs/flow/README.md", `# ${repo.name}\n`),
    });
  }
  return stubs;
}

async function searched(stubs: Stub[], input: { q: string; sort: string; page: number }): Promise<SearchOutcome> {
  const fake = fakeFetch(stubs);
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
  const notes: string[] = [];
  const outcome = (await searchCommunity(
    github,
    { q: input.q, sort: input.sort === "new" ? "new" : "top", page: input.page },
    (message) => notes.push(message),
  )) as SearchOutcome;
  void fake;
  return outcome;
}

describe("community search", () => {
  it("adds the free text to the topic filter and echoes the query", async () => {
    const outcome = await searched(repoStubs([{ name: "things", graphText: VALID_GRAPH_TEXT, stars: 5 }]), {
      q: "scheduled agents",
      sort: "top",
      page: 1,
    });
    expect(outcome.q).toBe("scheduled agents");
    expect(outcome.items.length).toBe(1);
    expect(outcome.total).toBe(4);
  });

  it("maps sort=new to GitHub's updated ordering", async () => {
    const fake = fakeFetch(repoStubs([]));
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    await searchCommunity(github, { q: "", sort: "new", page: 2 }, () => undefined);
    expect(fake.calls[0]).toContain("sort=updated");
    expect(fake.calls[0]).toContain("page=2");
  });

  it("maps sort=top to GitHub's star ordering", async () => {
    const fake = fakeFetch(repoStubs([{ name: "things", graphText: VALID_GRAPH_TEXT, stars: 5 }]));
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    await searchCommunity(github, { q: "", sort: "top", page: 1 }, () => undefined);
    expect(fake.calls[0]).toContain("sort=stars");
    expect(fake.calls[0]).toContain("topic%3Acanopy-graph");
  });

  it("preserves GitHub's ordering verbatim, stars or not", async () => {
    const outcome = await searched(
      repoStubs([
        { name: "b", graphText: VALID_GRAPH_TEXT, stars: 1 },
        { name: "a", graphText: VALID_GRAPH_TEXT, stars: 20 },
      ]),
      { q: "", sort: "top", page: 1 },
    );
    expect(outcome.items[0].repo).toBe("acme/b");
    expect(outcome.items[1].repo).toBe("acme/a");
    expect(outcome.items[0].stars).toBe(1);
    expect(outcome.items[1].stars).toBe(20);
  });

  it("finds graphs and nodes in one repo and drops invalid documents", async () => {
    const fake = fakeFetch([
      {
        url: SEARCH,
        status: 200,
        body: {
          total_count: 1,
          items: [{ name: "things", owner: { login: "acme" }, default_branch: "main", stargazers_count: 9 }],
        },
      },
      {
        url: "repos/acme/things/git/trees/main",
        status: 200,
        body: {
          tree: [
            { path: "graphs/flow/graph.json", type: "blob" },
            { path: "graphs/broken/graph.json", type: "blob" },
            { path: "nodes/hello-node/node.json", type: "blob" },
            { path: "nodes/void/node.json", type: "blob" },
          ],
        },
      },
      { url: "repos/acme/things/contents/graphs/flow/graph.json", status: 200, body: fileBody("graphs/flow/graph.json", INVALID_GRAPH_TEXT) },
      { url: "repos/acme/things/contents/graphs/broken/graph.json", status: 200, body: fileBody("graphs/broken/graph.json", BROKEN_NODE_TEXT) },
      { url: "repos/acme/things/contents/nodes/hello-node/node.json", status: 200, body: fileBody("nodes/hello-node/node.json", VALID_NODE_TEXT) },
      { url: "repos/acme/things/contents/nodes/void/node.json", status: 404, body: {} },
    ]);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const outcome = (await searchCommunity(github, { q: "", sort: "top", page: 1 }, () => undefined)) as SearchOutcome;
    expect(outcome.items.length).toBe(1);
    expect(outcome.items[0].kind).toBe("node");
    expect(outcome.items[0].slug).toBe("hello-node");
    expect(outcome.items[0].stars).toBe(9);
  });

  it("falls back to two directory listings when a tree is truncated", async () => {
    const fake = fakeFetch([
      {
        url: SEARCH,
        status: 200,
        body: {
          total_count: 1,
          items: [{ name: "things", owner: { login: "acme" }, default_branch: "main", stargazers_count: 3 }],
        },
      },
      {
        url: "repos/acme/things/git/trees/main",
        status: 200,
        body: { truncated: true, tree: [{ path: ".github/workflows/ci.yml", type: "blob" }] },
      },
      { url: "repos/acme/things/contents/graphs", status: 200, body: dirBody([{ name: "flow", type: "dir" }]) },
      { url: "repos/acme/things/contents/nodes", status: 200, body: [] },
      { url: "repos/acme/things/contents/graphs/flow/graph.json", status: 200, body: fileBody("graphs/flow/graph.json", VALID_GRAPH_TEXT) },
      { url: "repos/acme/things/contents/graphs/flow/README.md", status: 404, body: {} },
    ]);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const outcome = (await searchCommunity(github, { q: "", sort: "top", page: 1 }, () => undefined)) as SearchOutcome;
    expect(outcome.items.length).toBe(1);
    expect(outcome.items[0].slug).toBe("flow");
    expect(outcome.items[0].readme).toBe("");
  });

  it("surfaces a rate limit from the search call as a typed error", async () => {
    const fake = fakeFetch([
      { url: SEARCH, status: 429, headers: { "x-ratelimit-remaining": "0" } },
    ]);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const outcome = await searchCommunity(github, { q: "", sort: "top", page: 1 }, () => undefined);
    expect("kind" in outcome ? outcome.kind : "").toBe("rate-limit");
  });
});
