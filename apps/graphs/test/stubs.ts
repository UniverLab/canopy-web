// SPDX-License-Identifier: Apache-2.0
/**
 * The stub tables the page tests read, kept in one module so the visual e2e
 * fixture (test/e2e/worker.ts) serves exactly the data the unit tests assert
 * on: one five-node graph and one node in the official registry, and one
 * community repository holding a graph called flow. No live GitHub.
 */
import { dirBody, fileBody, type Stub } from "./fakes.js";
import { FIVE_NODE_GRAPH_TEXT, PAGES_README_TEXT } from "./pages-fixture.js";
import { VALID_GRAPH_TEXT, VALID_NODE_TEXT } from "./documents-fixture.js";

/** The repository the catalogue reads: UniverLab/canopy-web. */
export const REPO_DIR = "repos/UniverLab/canopy-web";

/** Everything the official listing needs: one five-node graph, one node. */
export function officialStubs(): Stub[] {
  return [
    // The removal list: absent until a maintainer merges one.
    { url: `${REPO_DIR}/contents/registry/blocked.json`, status: 404, body: {} },
    { url: `${REPO_DIR}/contents/registry/graphs`, status: 200, body: dirBody([{ name: "hello-graph", type: "dir" }]) },
    { url: `${REPO_DIR}/contents/registry/nodes`, status: 200, body: dirBody([{ name: "hello-node", type: "dir" }]) },
    { url: `${REPO_DIR}/contents/registry/graphs/hello-graph/graph.json`, status: 200, body: fileBody("graphs/hello-graph/graph.json", FIVE_NODE_GRAPH_TEXT) },
    { url: `${REPO_DIR}/contents/registry/graphs/hello-graph/README.md`, status: 200, body: fileBody("graphs/hello-graph/README.md", PAGES_README_TEXT) },
    { url: `${REPO_DIR}/contents/registry/nodes/hello-node/node.json`, status: 200, body: fileBody("nodes/hello-node/node.json", VALID_NODE_TEXT) },
    { url: `${REPO_DIR}/contents/registry/nodes/hello-node/README.md`, status: 404, body: {} },
    { url: REPO_DIR, status: 200, body: { stargazers_count: 7 } },
  ];
}

/** One community repository holding a graph called flow. */
export function communityStubs(): Stub[] {
  return [
    { url: "repos/acme/things/contents/graphs/flow/graph.json", status: 200, body: fileBody("graphs/flow/graph.json", VALID_GRAPH_TEXT) },
    { url: "repos/acme/things/contents/graphs/flow/README.md", status: 404, body: {} },
  ];
}

/** The discovery answer: one repository holding flow, plus its tree. */
export function flowSearchStubs(): Stub[] {
  return [
    {
      url: "search/repositories",
      status: 200,
      body: {
        total_count: 1,
        items: [{ name: "things", owner: { login: "acme" }, default_branch: "main", stargazers_count: 2 }],
      },
    },
    { url: "repos/acme/things/git/trees/main", status: 200, body: { tree: [{ path: "graphs/flow/graph.json", type: "blob" }] } },
  ];
}

/** The search answer the /search tests read: one repository holding flow. */
export function searchStubs(): Stub[] {
  return [
    ...officialStubs(),
    ...communityStubs(),
    ...flowSearchStubs(),
  ];
}
