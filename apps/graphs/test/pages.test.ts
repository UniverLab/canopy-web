// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue pages: route snapshots against mocked data, the markdown
 * twin, the sanitizer, the SVG drawing, the calm 503 and the page shell.
 * Everything runs on the injected fakes (fakes.ts), never a global.
 */
import { describe, expect, it } from "vitest";
import { NOT_PAGE, handlePage } from "../src/pages/routes.js";
import { BUSY_BODY, BUSY_HEADING, COPY_BUTTON, EMPTY_OFFICIAL_GRAPHS, EMPTY_OFFICIAL_NODES, SEARCH_BUTTON, SEARCH_LABEL } from "../src/pages/copy.js";
import { FakeCache, dirBody, fakeFetch, fileBody, type Stub } from "./fakes.js";
import { EVIL_README_TEXT, FIVE_NODE_GRAPH_TEXT, PAGES_README_TEXT } from "./pages-fixture.js";
import { VALID_GRAPH_TEXT } from "./documents-fixture.js";
import { communityStubs, officialStubs, REPO_DIR, searchStubs } from "./stubs.js";

const ORIGIN = "https://graphs.univerlab.org";
const HTML = { "content-type": "text/html" };

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
    expect(html).toContain(`<label class="sr-only" for="q">${SEARCH_LABEL}</label>`);
    expect(html).toContain(`<button type="submit">${SEARCH_BUTTON}</button>`);
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

  it("renders /n/<slug> with the one node", async () => {
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

  it("lists the sheet fields as a list, in title/list/install/README order", async () => {
    const twin = await (await call("/g/hello-graph", { accept: "text/markdown" })).text();
    for (const line of [
      "# hello-graph",
      "- Kind: graph",
      "- Name: hello-graph",
      "- Source: https://github.com/UniverLab/canopy-web",
      "- Stars: 7 stars",
      "- Nodes: agent 2 · check 1 · gate 1 · router 1",
      "- Edges: 5 edges · 1 fail",
      "- Agent nodes: build, docs",
      "## Install",
      "canopy graph install hello-graph",
      "## README",
    ]) {
      expect(twin).toContain(line);
    }
    // Title, then the list, then install, then the README — in that order.
    const order = ["# hello-graph", "- Kind:", "## Install", "## README"].map((part) => twin.indexOf(part));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(twin).not.toContain("<");
  });

  it("gives the node twin no graph sheet fields and no README when empty", async () => {
    const twin = await (await call("/n/hello-node", { accept: "text/markdown" })).text();
    expect(twin).toContain("- Kind: node");
    expect(twin).not.toContain("- Nodes:");
    expect(twin).not.toContain("- Edges:");
    expect(twin).not.toContain("## README");
  });
});

describe("the sanitizer", () => {
  it("lets no raw HTML through and marks links nofollow", async () => {
    const evil = officialStubs().map((stub) =>
      stub.url.endsWith("README.md") ? { ...stub, body: fileBody("graphs/hello-graph/README.md", EVIL_README_TEXT) } : stub,
    );
    const html = await (await call("/g/hello-graph", { stubs: evil })).text();
    // Scope to the rendered README: the colophon below carries real images.
    const readme = html.slice(html.indexOf(`<div class="readme">`), html.indexOf(`</main>`));
    // The tags survive only as escaped text, never as markup.
    expect(readme).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(readme).toContain("&lt;img src=x onerror=");
    expect(readme).not.toContain("<img");
    expect(readme).not.toContain("<b>");
    expect(readme).not.toContain('onerror="alert');
    expect(readme).not.toContain('href="javascript:');
    expect(readme).toContain(`<a href="https://example.com/page?a=1&amp;b=2" rel="nofollow">`);
  });
});

describe("the plate drawing", () => {
  it("draws the five nodes as Canopy shapes in a scrolling figure, both orientations", async () => {
    const html = await (await call("/g/hello-graph")).text();
    expect(html).toMatchSnapshot();
    // The figure holds both orientations; CSS shows the vertical one under
    // 640 px and the horizontal one above, with no JavaScript involved.
    expect(html).toContain(`<figure class="plate">`);
    expect(html).toContain(`<svg class="plate-svg plate-h"`);
    expect(html).toContain(`<svg class="plate-svg plate-v"`);
    expect(html).toMatch(/\.plate \.plate-v \{ display: none; \}/);
    expect(html).toMatch(/@media \(max-width: 639px\) \{[\s\S]*\.plate \.plate-v \{ display: block; \}/);
    // The figure scrolls horizontally inside itself; the page never overflows.
    expect(html).toMatch(/figure\.plate \{[^}]*max-width: 100%;[^}]*overflow-x: auto;/);
    // One labelled shape per node: agents are circles, checks rounded
    // squares, gates and routers diamonds — the router reads as a gate.
    for (const label of ["build", "test", "gate", "triage", "docs"]) {
      expect(html).toContain(`>${label}</text>`);
    }
    for (const shape of [
      `class="node shape-agent" data-name="build"`,
      `class="node shape-check" data-name="test"`,
      `class="node shape-gate" data-name="gate"`,
      `class="node shape-gate" data-name="triage"`,
      `class="node shape-agent" data-name="docs"`,
    ]) {
      expect(html).toContain(shape);
    }
    // Edges follow the conditions, in each orientation: one red fail arc
    // back, four teal passes (the always and the route read as pass), no
    // error, a labelled svg.
    expect((html.match(/class="edge fail"/g) ?? [])).toHaveLength(2);
    expect((html.match(/class="edge pass"/g) ?? [])).toHaveLength(8);
    expect(html).not.toContain(`class="edge error"`);
    expect(html).toContain(`role="img"`);
    expect(html).toContain(`<title>hello-graph</title>`);
    expect(html).toContain(`<desc>Nodes in order: build, test, gate, triage, docs.</desc>`);
    // The walking token rides the main pass chain and rests without motion.
    expect(html).toContain(`<circle class="token"`);
    expect(html).toContain(`prefers-reduced-motion`);
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

  it("answers a missing registry folder with the empty official home, not the busy page", async () => {
    const response = await call("/", {
      stubs: [{ url: `${REPO_DIR}/contents/registry/graphs`, status: 404, body: {} }],
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(EMPTY_OFFICIAL_GRAPHS);
    expect(html).toContain(EMPTY_OFFICIAL_NODES);
    expect(html).not.toContain(BUSY_HEADING);
    // The rest of the home keeps working: search box and the two tabs.
    expect(html).toContain(`<label class="sr-only" for="q">${SEARCH_LABEL}</label>`);
    expect(html).toContain(`<a href="/search?sort=top">`);
  });

  it("answers a 500 listing with the same calm 503", async () => {
    const response = await call("/", {
      stubs: [{ url: `${REPO_DIR}/contents/registry/graphs`, status: 500, body: {} }],
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
  it("dresses the page in the Canopy look kit: surface, faces, honeycomb and colophon", async () => {
    const html = await (await call("/g/hello-graph")).text();
    // The Canopy surface and the kit's three stylesheets, from their folders.
    expect(html).toContain(`<html lang="en" data-surface="tui">`);
    expect(html).toContain(`<link rel="stylesheet" href="/look/tokens.css">`);
    expect(html).toContain(`<link rel="stylesheet" href="/look/fonts/fonts.css">`);
    expect(html).toContain(`<link rel="stylesheet" href="/look/colophon/colophon.css">`);
    // The honeycomb: a hidden host and the kit's bundle behind the content.
    expect(html).toContain(`<div class="fondo" id="fondo" aria-hidden="true"></div>`);
    expect(html).toContain(`<script src="/look/fondo.js" defer></script>`);
    expect(html).toContain(`mountCanopyBackground`);
    expect(html).toContain(`/look/fondo/assets/`);
    expect(html).toContain(`<main class="look-col">`);
    // The kit's variables, and both of its faces, drive the page stylesheet.
    expect(html).toContain("background: var(--surface-bg)");
    expect(html).toContain("color: var(--surface-ink)");
    expect(html).toContain("font-family: var(--font-body)");
    expect(html).toContain("font-family: var(--font-mono)");
    expect(html).toContain("font-family: var(--font-display)");
    expect(html).toContain("var(--radius-card)");
    expect(html).toContain("var(--cta-gradient)");
    // The header wordmark and the UniverLab colophon as footer.
    expect(html).toContain(`<a class="wordmark" href="https://univerlab.org/canopy/">graphs</a>`);
    expect(html).toContain(`<footer class="look-colophon">`);
    expect(html).toContain("Part of UniverLab · EXP-001 Canopy graphs");
    expect(html).toContain(`/look/colophon/frieze-1920.avif`);
    // The day/night toggle is gone: the Canopy page is a dark surface.
    expect(html).not.toContain("theme-toggle");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("getHours");
    // Accessibility and weight: no framework, real buttons, reduced motion.
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain(":focus-visible { outline: 2px solid var(--teal)");
    expect(html).toMatch(/<button type="button" class="copy" data-copy="canopy graph install hello-graph"/);
    expect(html).toContain(COPY_BUTTON);
    expect(html).toContain(`aria-label="Copy the install command to the clipboard"`);
    expect(html).not.toContain("react");
    expect(html.length).toBeLessThan(150_000);
  });

  it("gives every listing page one h1 hero", async () => {
    const home = await (await call("/")).text();
    expect(home).toMatch(/<h1 class="index-title">A catalogue of Canopy graphs and nodes\.<\/h1>/);
    const search = await (await call("/search?q=flow&sort=top", { stubs: searchStubs() })).text();
    expect(search).toContain(`<h1 class="index-title">Results for “flow”</h1>`);
    expect(search).not.toMatch(/<h1>.*<\/h1>[\s\S]*<h1>/);
  });

  it("shows stars, the repo link and the agent nodes in the datasheet", async () => {
    const html = await (await call("/g/hello-graph", {
      env: { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" },
      stubs: [
        ...officialStubs(),
        { url: "analytics_engine/sql", status: 200, body: { data: [{ index: "UniverLab/canopy-web/graph/hello-graph", count: 12 }] } },
      ],
    })).text();
    expect(html).toContain("<dt>Stars</dt><dd>7 stars</dd>");
    expect(html).toContain(`<a class="button" href="https://github.com/UniverLab/canopy-web">Star on GitHub</a>`);
    expect(html).toContain("<dt>Agent nodes</dt><dd>build, docs</dd>");
    expect(html).toContain("<dt>Nodes</dt><dd>agent 2 · check 1 · gate 1 · router 1</dd>");
    expect(html).toContain("<dt>Edges</dt><dd>5 edges · 1 fail</dd>");
  });

  it("installs the node page by its node ref and draws the one node", async () => {
    const html = await (await call("/n/hello-node")).text();
    expect(html).toContain("canopy node install hello-node");
    expect(html).toContain(`<figure class="plate">`);
    expect(html).toContain(`<g class="node shape-agent" data-name="hello-node"`);
    expect(html).toContain(`<title>hello-node</title>`);
  });

  it("gives the community graph the owner/repo/slug ref", async () => {
    const html = await (await call("/g/acme/things/flow", { stubs: [...officialStubs(), ...communityStubs()] })).text();
    expect(html).toContain("canopy graph install acme/things/flow");
    expect(html).toContain(`<a class="button" href="https://github.com/acme/things">Star on GitHub</a>`);
  });

  it("serves the short official form and the long one identically", async () => {
    const long = await call("/g/UniverLab/canopy-web/hello-graph");
    const html = await long.text();
    expect(html).toContain("canopy graph install hello-graph");
  });
});

describe("the technical index", () => {
  it("renders rows, not cards, with kind, node count and the install box", async () => {
    const html = await (await call("/")).text();
    expect(html).toContain(`<ol class="index">`);
    expect(html).toContain(`<li class="row">`);
    expect(html).not.toContain(`doc-list`);
    expect(html).toContain(`<a class="row-name" href="/g/hello-graph">hello-graph</a>`);
    expect(html).toContain(`<span class="kind">graph</span>`);
    expect(html).toContain(`<span class="kind">node</span>`);
    expect(html).toContain(`<span class="row-meta">5 nodes</span>`);
    expect(html).toContain(`<span class="row-meta">7 stars</span>`);
    expect(html).toContain(`<code>canopy graph install hello-graph</code>`);
    expect(html).toContain(`<code>canopy node install hello-node</code>`);
    // Rows are separated by a rule, with no card background.
    expect(html).toMatch(/li\.row \{[^}]*border-bottom: 1px solid var\(--surface-line\);/);
    expect(html).not.toMatch(/li\.row \{[^}]*background:/);
  });

  it("keeps the Official heading as a mono uppercase kicker", async () => {
    const html = await (await call("/")).text();
    expect(html).toContain(`<h2 class="kicker">Official</h2>`);
    expect(html).toMatch(/\.kicker \{[^}]*text-transform: uppercase;/);
  });

  it("marks the active tab underlined, with aria-current", async () => {
    const html = await (await call("/search?q=flow&sort=new", { stubs: searchStubs() })).text();
    expect(html).toContain(`<a href="/search?q=flow&sort=new" aria-current="page">New</a>`);
    expect(html).toContain(`<a href="/search?q=flow&sort=top">Top</a>`);
  });

  it("shows last updated and the ref the page was read from", async () => {
    const stubs = officialStubs().map((stub) =>
      stub.url === REPO_DIR
        ? { ...stub, body: { stargazers_count: 7, updated_at: "2026-10-27T08:00:00Z", default_branch: "main" } }
        : stub,
    );
    const home = await (await call("/", { stubs })).text();
    expect(home).toContain(`<time class="row-meta" datetime="2026-10-27">2026-10-27</time>`);
    const doc = await (await call("/g/hello-graph", { stubs })).text();
    expect(doc).toContain(`<dt>Ref</dt><dd>main</dd>`);
    const twin = await (await call("/g/hello-graph", { stubs, accept: "text/markdown" })).text();
    expect(twin).toContain(`- Ref: main`);
  });

  it("dots the harnesses a document runs on, in rows and plates", async () => {
    const harnessed = JSON.stringify({
      ...JSON.parse(FIVE_NODE_GRAPH_TEXT),
      nodes: [
        { name: "build", kind: "agent", position: 1, config: { platform: "claude" } },
        { name: "test", kind: "check", position: 2, config: {} },
        { name: "gate", kind: "gate", position: 3, config: {} },
        { name: "triage", kind: "router", position: 4, config: {} },
        { name: "docs", kind: "agent", position: 5, config: { model: "codex-mini" } },
      ],
    });
    const stubs = officialStubs().map((stub) =>
      stub.url.endsWith("hello-graph/graph.json")
        ? { ...stub, body: fileBody("graphs/hello-graph/graph.json", harnessed) }
        : stub,
    );
    const home = await (await call("/", { stubs })).text();
    expect(home).toContain(`aria-label="harnesses: claude, codex"`);
    expect(home).toContain(`<span class="dot" style="--nc:#d97757" title="claude"></span>`);
    expect(home).toContain(`<span class="dot" style="--nc:#57c7c3" title="codex"></span>`);
    const doc = await (await call("/g/hello-graph", { stubs })).text();
    expect(doc).toContain(`style="--nc:#d97757"`);
    expect(doc).toContain(`>claude</text>`);
    expect(doc).toContain(`>codex</text>`);
  });
});

describe("the header band", () => {
  it("holds the wordmark, the search form and Publish/Source over the honeycomb", async () => {
    const html = await (await call("/")).text();
    const header = html.slice(html.indexOf(`<header class="site-header">`), html.indexOf(`</header>`));
    expect(header).toContain(`<a class="wordmark" href="https://univerlab.org/canopy/">graphs</a>`);
    expect(header).toContain(`<form class="search"`);
    expect(header).toContain(`<a href="/publish">Publish</a>`);
    expect(header).toContain(`<a href="https://github.com/UniverLab/canopy-web">Source</a>`);
    expect(header).toContain(`<div class="fondo" id="fondo" aria-hidden="true"></div>`);
    // The band is 160 px on desktop, 120 px on mobile, clipping the honeycomb.
    expect(html).toMatch(/\.site-header \{[^}]*height: 120px;[^}]*overflow: hidden;/);
    expect(html).toMatch(/@media \(min-width: 640px\) \{[\s\S]*\.site-header \{ height: 160px; \}/);
  });

  it("holds the current query in the search box", async () => {
    const html = await (await call("/search?q=flow&sort=top", { stubs: searchStubs() })).text();
    expect(html).toContain(`<input id="q" name="q" type="search" value="flow"`);
  });
});

describe("the README section", () => {
  it("renders inline emphasis from the README", async () => {
    const html = await (await call("/g/hello-graph")).text();
    expect(html).toContain(`<strong>one fail edge</strong>`);
  });

  it("omits the README section when the README is empty, in HTML and in the twin", async () => {
    const html = await (await call("/n/hello-node")).text();
    expect(html).not.toContain(`>README</h2>`);
    expect(html).not.toContain(`<div class="readme">`);
    const twin = await (await call("/n/hello-node", { accept: "text/markdown" })).text();
    expect(twin).not.toContain(`## README`);
  });

  it("omits the README section when the README is whitespace-only", async () => {
    const stubs = officialStubs().map((stub) =>
      stub.url.endsWith("hello-graph/README.md")
        ? { ...stub, body: fileBody("graphs/hello-graph/README.md", "   \n  \t\n") }
        : stub,
    );
    const html = await (await call("/g/hello-graph", { stubs })).text();
    expect(html).not.toContain(`>README</h2>`);
    expect(html).not.toContain(`<div class="readme">`);
    const twin = await (await call("/g/hello-graph", { stubs, accept: "text/markdown" })).text();
    expect(twin).not.toContain(`## README`);
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
