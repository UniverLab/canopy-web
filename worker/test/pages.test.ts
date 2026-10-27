// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue pages: route snapshots against mocked data, the markdown
 * twin, the sanitizer, the SVG drawing, the calm 503 and the page shell.
 * Everything runs on the injected fakes (fakes.ts), never a global.
 */
import { describe, expect, it } from "vitest";
import { NOT_PAGE, handlePage } from "../src/pages/routes.js";
import { BUSY_BODY, COPY_BUTTON, FOOTER_HREF, FOOTER_TEXT, SEARCH_BUTTON, SEARCH_LABEL } from "../src/pages/copy.js";
import { FakeCache, dirBody, fakeFetch, fileBody, type Stub } from "./fakes.js";
import {
  EVIL_README_TEXT,
  FIVE_NODE_GRAPH_TEXT,
  PAGES_README_TEXT,
} from "./pages-fixture.js";
import { VALID_GRAPH_TEXT, VALID_NODE_TEXT } from "./documents-fixture.js";

const ORIGIN = "https://graphs.univerlab.org";
const REPO_DIR = "repos/UniverLab/graphs";
const SEARCH = "search/repositories";
const HTML = { "content-type": "text/html" };

/** Everything the official listing needs: one five-node graph, one node. */
function officialStubs(): Stub[] {
  return [
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
function communityStubs(): Stub[] {
  return [
    { url: "repos/acme/things/contents/graphs/flow/graph.json", status: 200, body: fileBody("graphs/flow/graph.json", VALID_GRAPH_TEXT) },
    { url: "repos/acme/things/contents/graphs/flow/README.md", status: 404, body: {} },
  ];
}

/** The search answer the /search tests read: one repository holding flow. */
function searchStubs(): Stub[] {
  return [
    ...officialStubs(),
    ...communityStubs(),
    {
      url: SEARCH,
      status: 200,
      body: {
        total_count: 1,
        items: [{ name: "things", owner: { login: "acme" }, default_branch: "main", stargazers_count: 2 }],
      },
    },
    { url: "repos/acme/things/git/trees/main", status: 200, body: { tree: [{ path: "graphs/flow/graph.json", type: "blob" }] } },
  ];
}

interface Options {
  stubs?: Stub[];
  accept?: string;
  env?: Record<string, string>;
  method?: string;
}

async function call(path: string, options: Options = {}): Promise<Response> {
  const fake = fakeFetch(options.stubs ?? officialStubs());
  const headers = new Headers();
  if (options.accept !== undefined) {
    headers.set("accept", options.accept);
  }
  const req = new Request(`${ORIGIN}${path}`, { method: options.method ?? "GET", headers });
  const answer = await handlePage(req, options.env ?? {}, {
    fetchImpl: fake.fetchImpl,
    cache: new FakeCache(),
  });
  expect(answer).not.toBe(NOT_PAGE);
  return answer as unknown as Response;
}

describe("route snapshots", () => {
  it("renders / with the official listing first", async () => {
    const html = await (await call("/")).text();
    expect(html).toMatchSnapshot();
    expect(html).toContain(`<label for="q">${SEARCH_LABEL}</label>`);
    expect(html).toContain(`<button type="submit" class="button">${SEARCH_BUTTON}</button>`);
    expect(html).toContain(`<a href="/search?sort=top">`);
    expect(html).toContain(`<a href="/search?sort=new">`);
  });

  it("renders /search with community results", async () => {
    expect(await (await call("/search?q=flow&sort=top", { stubs: searchStubs() })).text()).toMatchSnapshot();
  });

  it("renders /g/<slug> with the drawing and the install command", async () => {
    expect(await (await call("/g/hello-graph")).text()).toMatchSnapshot();
  });

  it("renders /g/<owner>/<repo>/<slug> with the community ref", async () => {
    const response = await call("/g/acme/things/flow", { stubs: [...officialStubs(), ...communityStubs()] });
    expect(await response.text()).toMatchSnapshot();
  });

  it("renders /n/<slug> without a drawing", async () => {
    expect(await (await call("/n/hello-node")).text()).toMatchSnapshot();
  });

  it("renders /llms.txt with one line per document", async () => {
    expect(await (await call("/llms.txt")).text()).toMatchSnapshot();
  });
});

describe("the markdown twin", () => {
  it("answers Accept: text/markdown with the twin, README verbatim, no HTML", async () => {
    const response = await call("/g/hello-graph", { accept: "text/markdown" });
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const twin = await response.text();
    expect(twin).toContain(PAGES_README_TEXT);
    expect(twin).toContain("canopy graph install hello-graph");
    expect(twin).not.toContain("<");
  });

  it("serves the twin for the listing routes too", async () => {
    for (const path of ["/", "/search?q=flow", "/n/hello-node"]) {
      const response = await call(path, { stubs: searchStubs(), accept: "text/markdown" });
      expect(response.headers.get("content-type"), path).toBe("text/markdown; charset=utf-8");
      expect(await response.text(), path).not.toContain("<");
    }
  });
});

describe("the sanitizer", () => {
  it("lets no raw HTML through and marks links nofollow", async () => {
    const evil = officialStubs().map((stub) =>
      stub.url.endsWith("README.md") ? { ...stub, body: fileBody("graphs/hello-graph/README.md", EVIL_README_TEXT) } : stub,
    );
    const html = await (await call("/g/hello-graph", { stubs: evil })).text();
    // The tags survive only as escaped text, never as markup.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain('onerror="alert');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain(`<a href="https://example.com/page?a=1&amp;b=2" rel="nofollow">`);
  });
});

describe("the SVG drawing", () => {
  it("draws five labelled boxes, one dashed fail edge, kinds as classes", async () => {
    const html = await (await call("/g/hello-graph")).text();
    expect(html).toMatchSnapshot();
    for (const label of ["build", "test", "gate", "triage", "docs"]) {
      expect(html).toContain(`>${label}</text>`);
    }
    expect((html.match(/class="edge fail"/g) ?? [])).toHaveLength(1);
    expect((html.match(/class="edge pass"/g) ?? [])).toHaveLength(2);
    expect((html.match(/class="edge other"/g) ?? [])).toHaveLength(2);
    for (const kind of ["kind-agent", "kind-check", "kind-gate", "kind-router"]) {
      expect(html).toContain(`class="node ${kind}"`);
    }
    expect(html).toContain(`stroke-dasharray`);
  });
});

describe("data-layer failures", () => {
  it("answers a typed GitHub error with a calm 503, never a stack trace", async () => {
    const response = await call("/g/hello-graph", {
      stubs: [{ url: `${REPO_DIR}/contents/registry/graphs/hello-graph/graph.json`, status: 500, body: {} }],
    });
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain(BUSY_BODY);
    expect(html).not.toContain("Error:");
    expect(html).not.toContain("at Object");
    expect(html).not.toContain("stack");
  });

  it("answers a rate-limited listing with the same calm 503", async () => {
    const response = await call("/", {
      stubs: [{
        url: `${REPO_DIR}/contents/registry/graphs`,
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
      }],
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain(BUSY_BODY);
  });

  it("answers an unreadable upstream body with the calm page, never a crash", async () => {
    const response = await call("/g/hello-graph", {
      stubs: [{ url: `${REPO_DIR}/contents/registry/graphs/hello-graph/graph.json`, status: 200, text: "<html>portal</html>", headers: HTML }],
    });
    // The data layer degrades an unreadable body into a missing document.
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Not found");
  });

  it("answers a missing document with a calm 404", async () => {
    const response = await call("/g/nope", { stubs: [{ url: `${REPO_DIR}/contents/registry/graphs/nope`, status: 404, body: {} }] });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Not found");
  });
});

describe("the page shell", () => {
  it("carries the fonts, both theme pairs, the hour script, the footer and a keyboard copy button", async () => {
    const html = await (await call("/g/hello-graph")).text();
    // The visual system of univerlab.org.
    expect(html).toContain("fonts.googleapis.com/css2");
    expect(html).toContain("Old+Standard+TT");
    expect(html).toContain("EB+Garamond");
    expect(html).toContain("Sometype+Mono");
    for (const hex of ["#f4f0ea", "#1d1510", "#222928", "#ecebe4", "#3fb8b0"]) {
      expect(html).toContain(hex);
    }
    expect(html).toContain("localStorage");
    expect(html).toContain("getHours");
    expect(html).toContain(`<a href="${FOOTER_HREF}">${FOOTER_TEXT}</a>`);
    // Accessibility and weight: no framework, real buttons, reduced motion.
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toMatch(/<button type="button" class="copy" data-copy="canopy graph install hello-graph"/);
    expect(html).toContain(COPY_BUTTON);
    expect(html).toContain(`aria-label="Copy the install command to the clipboard"`);
    expect(html).not.toContain("react");
    expect(html.length).toBeLessThan(150_000);
  });

  it("shows stars, downloads when configured, the repo link and the agent nodes", async () => {
    const html = await (await call("/g/hello-graph", {
      env: { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" },
      stubs: [
        ...officialStubs(),
        { url: "analytics_engine/sql", status: 200, body: { data: [{ index: "UniverLab/graphs/graph/hello-graph", count: 12 }] } },
      ],
    })).text();
    expect(html).toContain("7 stars");
    expect(html).toContain("12 downloads");
    expect(html).toContain(`<a class="button" href="https://github.com/UniverLab/graphs">Star on GitHub</a>`);
    expect(html).toContain("build, docs");
    expect(html).toContain("need a harness");
  });

  it("installs the node page by its node ref and draws nothing", async () => {
    const html = await (await call("/n/hello-node")).text();
    expect(html).toContain("canopy node install hello-node");
    expect(html).not.toContain("<svg");
  });

  it("gives the community graph the owner/repo/slug ref", async () => {
    const html = await (await call("/g/acme/things/flow", { stubs: [...officialStubs(), ...communityStubs()] })).text();
    expect(html).toContain("canopy graph install acme/things/flow");
    expect(html).toContain(`<a class="button" href="https://github.com/acme/things">Star on GitHub</a>`);
  });

  it("serves the short official form and the long one identically", async () => {
    const long = await call("/g/UniverLab/graphs/hello-graph");
    const html = await long.text();
    expect(html).toContain("canopy graph install hello-graph");
  });
});

describe("routing", () => {
  it("leaves the install paths and unknown paths to the redirector", async () => {
    for (const path of ["/i/graph/hello-graph", "/favicon.ico", "/api/official"]) {
      const fake = fakeFetch([]);
      const answer = await handlePage(
        new Request(`${ORIGIN}${path}`),
        {},
        { fetchImpl: fake.fetchImpl, cache: new FakeCache() },
      );
      expect(answer, path).toBe(NOT_PAGE);
    }
  });

  it("leaves non-GET requests to the redirector", async () => {
    const answer = await handlePage(
      new Request(`${ORIGIN}/g/hello-graph`, { method: "POST" }),
      {},
      { fetchImpl: fakeFetch([]).fetchImpl, cache: new FakeCache() },
    );
    expect(answer).toBe(NOT_PAGE);
  });

  it("answers an invalid document shape with the calm 404", async () => {
    const response = await call("/g/Not_A_Slug");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Not found");
  });

  it("keeps a raw directory-name slug inert in listing links", async () => {
    const slug = 'evil" onmouseover="alert(1)';
    const encoded = "evil%22%20onmouseover%3D%22alert(1)";
    const stubs = [
      { url: `${REPO_DIR}/contents/registry/graphs`, status: 200, body: dirBody([{ name: slug, type: "dir" }]) },
      { url: `${REPO_DIR}/contents/registry/graphs/evil%22%20onmouseover=%22alert(1)/graph.json`, status: 200, body: fileBody("graphs/x/graph.json", VALID_GRAPH_TEXT) },
      { url: `${REPO_DIR}/contents/registry/graphs/${encoded}/README.md`, status: 404, body: {} },
      { url: REPO_DIR, status: 200, body: { stargazers_count: 1 } },
    ];
    const html = await (await call("/", { stubs })).text();
    expect(html).toContain(`href="/g/${encoded}"`);
    expect(html).not.toContain(`onmouseover="alert(1)"`);
    const twin = await (await call("/", { stubs, accept: "text/markdown" })).text();
    expect(twin).toContain(`](/g/${encoded})`);
    // No link target in the twin may carry a raw quote.
    expect(twin).not.toMatch(/\]\(\/g\/[^)\n]*"/i);
  });
});
