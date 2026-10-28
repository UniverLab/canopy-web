// SPDX-License-Identifier: Apache-2.0
/**
 * The lab's pattern pages: front-matter parsing, figure validation and the
 * indexer's skip-and-record rule, the patterns index build, card ordering,
 * the plates on cards and pages, the experiment notice, the Implemented-by
 * rows, the document back-link, the body sanitizer, and llms.txt plus the
 * markdown twin. Page tests seed a fresh KV through the indexer, like the
 * catalogue page tests, with an empty upstream — no page may reach GitHub.
 */
import { describe, expect, it } from "vitest";
import { NOT_PAGE, handlePage } from "../src/pages/routes.js";
import {
  EXPERIMENT_NOTICE,
  IMPLEMENTED_BY_HEADING,
  INDEXING_HEADING,
  PATTERNS_EMPTY,
  PATTERNS_NO_IMPLEMENTS,
  PATTERN_MISSING_REF,
  PATTERN_SOURCES_HEADING,
} from "../src/pages/copy.js";
import { parsePatternFile, type StoredPattern } from "../src/patterns.js";
import { patternPage } from "../src/pages/patterns.js";
import { createGitHub } from "../src/github.js";
import { runIndexer } from "../src/indexer.js";
import { patternKey, resetIndexMemo } from "../src/store.js";
import { FakeCache, FakeKV, dirBody, fakeFetch, fileBody, type Stub } from "./fakes.js";
import { INVALID_GRAPH_TEXT } from "./documents-fixture.js";
import { FIVE_NODE_GRAPH_TEXT } from "./pages-fixture.js";
import { REPO_DIR, officialStubs } from "./stubs.js";

const ORIGIN = "https://graphs.univerlab.org";
const PATTERNS_DIR = `${REPO_DIR}/contents/patterns`;

/** A three-node figure with one fail edge back: the plate tests' subject. */
const FIGURE_TEXT = JSON.stringify({
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

interface PatternPage {
  slug: string;
  title?: string;
  summary?: string;
  status?: string;
  implements?: string[];
  figure?: string;
  sources?: Array<{ title: string; url: string }>;
  body?: string;
}

/** One `patterns/<slug>.md` file, valid unless an override breaks it. */
function patternText(page: PatternPage): string {
  const front = [
    `title: ${page.title ?? `${page.slug} title`}`,
    `summary: ${page.summary ?? `${page.slug} summary`}`,
    `status: ${page.status ?? "standard"}`,
    ...(page.implements === undefined || page.implements.length === 0
      ? ["implements: []"]
      : ["implements:", ...page.implements.map((ref) => `  - ${ref}`)]),
    ...(page.figure === undefined ? [] : [`figure: ${page.figure}`]),
    ...(page.sources === undefined
      ? ["sources:", "  - title: A source", "    url: https://example.com/source"]
      : ["sources:", ...page.sources.flatMap((source) => [`  - title: ${source.title}`, `    url: ${source.url}`])]),
  ];
  return ["---", ...front, "---", "", page.body ?? `# ${page.slug}`, ``].join("\n");
}

/** The listing plus the page and figure files for these slugs. */
function patternStubs(
  pages: PatternPage[],
  figures: Record<string, string> = {},
): Stub[] {
  const files = [
    { name: "README.md", type: "file" },
    ...pages.map((page) => ({ name: `${page.slug}.md`, type: "file" })),
  ];
  const stubs: Stub[] = [
    { url: PATTERNS_DIR, status: 200, body: dirBody(files) },
  ];
  for (const page of pages) {
    const figure = page.figure ?? `${page.slug}.figure.json`;
    stubs.push({
      url: `${PATTERNS_DIR}/${page.slug}.md`,
      status: 200,
      body: fileBody(`patterns/${page.slug}.md`, patternText({ ...page, figure })),
    });
    stubs.push({
      url: `${PATTERNS_DIR}/${figure}`,
      status: 200,
      body: fileBody(`patterns/${figure}`, figures[figure] ?? FIGURE_TEXT),
    });
  }
  return stubs;
}

/** Seed a fresh KV by running the indexer over the stub table. */
async function seeded(stubsToSeed: Stub[]): Promise<{ kv: FakeKV; meta: { invalid: unknown[] } }> {
  const fake = fakeFetch(stubsToSeed);
  const kv = new FakeKV();
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
  const meta = await runIndexer({ github, index: kv, authenticated: false });
  return { kv, meta };
}

async function call(
  path: string,
  options: { stubs?: Stub[]; accept?: string } = {},
): Promise<Response> {
  resetIndexMemo();
  const { kv } = await seeded(options.stubs ?? officialStubs());
  const fake = fakeFetch([]);
  const headers = new Headers();
  if (options.accept !== undefined) {
    headers.set("accept", options.accept);
  }
  const req = new Request(`${ORIGIN}${path}`, { headers });
  const answer = await handlePage(req, { INDEX: kv }, {
    fetchImpl: fake.fetchImpl,
    cache: new FakeCache(),
  });
  expect(answer).not.toBe(NOT_PAGE);
  expect(fake.calls, "no page may reach upstream").toEqual([]);
  return answer as unknown as Response;
}

const GATED_PAGE: PatternPage = {
  slug: "gated-check",
  title: "Gated check",
  summary: "Shell checks decide pass or fail, never an LLM judge.",
  status: "standard",
  implements: ["graph:hello-graph", "node:hello-node", "graph:missing-thing"],
  figure: "gated-check.figure.json",
  sources: [{ title: "Building effective agents", url: "https://example.com/agents" }],
  body: "# Gated check\n\nA graph the pattern tests render, with **one fail edge**.\n",
};

function gatedStubs(): Stub[] {
  return [...officialStubs(), ...patternStubs([GATED_PAGE])];
}

describe("front matter parsing", () => {
  it("parses a valid page: all six keys plus the body", () => {
    const parsed = parsePatternFile(patternText(GATED_PAGE));
    expect(parsed).not.toBeNull();
    expect(parsed?.meta.title).toBe("Gated check");
    expect(parsed?.meta.summary).toBe("Shell checks decide pass or fail, never an LLM judge.");
    expect(parsed?.meta.status).toBe("standard");
    expect(parsed?.meta.implements).toEqual([
      { kind: "graph", slug: "hello-graph" },
      { kind: "node", slug: "hello-node" },
      { kind: "graph", slug: "missing-thing" },
    ]);
    expect(parsed?.meta.figure).toBe("gated-check.figure.json");
    expect(parsed?.meta.sources).toEqual([
      { title: "Building effective agents", url: "https://example.com/agents" },
    ]);
    expect(parsed?.body).toBe("\n# Gated check\n\nA graph the pattern tests render, with **one fail edge**.\n\n");
  });

  it("parses an empty implements list and several sources", () => {
    const parsed = parsePatternFile(patternText({
      slug: "quiet",
      figure: "quiet.figure.json",
      sources: [
        { title: "First", url: "https://example.com/first" },
        { title: "Second", url: "https://example.com/second" },
      ],
    }));
    expect(parsed?.meta.implements).toEqual([]);
    expect(parsed?.meta.sources).toEqual([
      { title: "First", url: "https://example.com/first" },
      { title: "Second", url: "https://example.com/second" },
    ]);
  });

  it("rejects malformed front matter", () => {
    const valid = patternText(GATED_PAGE);
    const cases: Array<[string, string]> = [
      ["no opening fence", valid.replace("---\n", "")],
      ["no closing fence", valid.replace("\n---\n\n# Gated", "\n\n# Gated")],
      ["unknown status", valid.replace("status: standard", "status: canon")],
      ["missing title", valid.replace("title: Gated check\n", "")],
      ["empty summary", valid.replace("Shell checks decide pass or fail, never an LLM judge.", "")],
      ["unknown key", valid.replace("figure: gated-check.figure.json", "figure: gated-check.figure.json\nformat: 7")],
      ["duplicate key", valid.replace("status: standard", "status: standard\ntitle: Twice")],
      ["bare implements", valid.replace("implements:\n  - graph:hello-graph\n  - node:hello-node\n  - graph:missing-thing", "implements:")],
      ["bad implements kind", valid.replace("  - graph:missing-thing", "  - worker:missing-thing")],
      ["bad implements slug", valid.replace("  - graph:missing-thing", "  - graph:Missing_Thing")],
      ["inline implements", valid.replace(/implements:\n( {2}- .*\n)+/, "implements: [graph:hello-graph]\n")],
      ["figure with a path", valid.replace("figure: gated-check.figure.json", "figure: ../graphs/x.json")],
      ["figure not json", valid.replace("figure: gated-check.figure.json", "figure: drawing.svg")],
      ["sources without items", valid.replace("sources:\n  - title: Building effective agents\n    url: https://example.com/agents", "sources:")],
      ["source without url", valid.replace("    url: https://example.com/agents", "")],
      ["source without title", valid.replace("  - title: Building effective agents\n", "")],
    ];
    for (const [label, text] of cases) {
      expect(parsePatternFile(text), label).toBeNull();
    }
  });

  it("rejects a page missing its figure key", () => {
    const text = patternText({ ...GATED_PAGE, figure: undefined });
    expect(text).not.toContain("figure:");
    expect(parsePatternFile(text)).toBeNull();
  });
});

describe("figure validation and the skip", () => {
  it("skips a page whose figure fails the graph schema, recording why", async () => {
    const { kv, meta } = await seeded([
      ...officialStubs(),
      ...patternStubs(
        [{ ...GATED_PAGE }, { slug: "broken-figure", figure: "broken-figure.figure.json" }],
        { "broken-figure.figure.json": INVALID_GRAPH_TEXT },
      ),
    ]);
    expect(meta.invalid).toEqual([
      { repo: "UniverLab/canopy-graphs", slug: "broken-figure", reason: "figure failed the graph schema" },
    ]);
    const patterns = JSON.parse((await kv.get("patterns:v1")) as string) as {
      entries: Array<{ slug: string }>;
    };
    expect(patterns.entries.map((entry) => entry.slug)).toEqual(["gated-check"]);
    expect(await kv.get(patternKey("broken-figure"))).toBeNull();
    expect(await kv.get(patternKey("gated-check"))).not.toBeNull();
  });

  it("skips malformed pages, unparseable figures and missing figure files", async () => {
    const { meta } = await seeded([
      ...officialStubs(),
      { url: PATTERNS_DIR, status: 200, body: dirBody([
        { name: "malformed.md", type: "file" },
        { name: "garbled.md", type: "file" },
        { name: "ghost.md", type: "file" },
      ]) },
      { url: `${PATTERNS_DIR}/malformed.md`, status: 200, body: fileBody("patterns/malformed.md", "no fences here\n") },
      { url: `${PATTERNS_DIR}/garbled.md`, status: 200, body: fileBody("patterns/garbled.md", patternText({ slug: "garbled", figure: "garbled.figure.json" })) },
      { url: `${PATTERNS_DIR}/garbled.figure.json`, status: 200, body: fileBody("patterns/garbled.figure.json", "this is not json") },
      { url: `${PATTERNS_DIR}/ghost.md`, status: 200, body: fileBody("patterns/ghost.md", patternText({ slug: "ghost", figure: "ghost.figure.json" })) },
      { url: `${PATTERNS_DIR}/ghost.figure.json`, status: 404, body: {} },
    ]);
    // The run still lands: three reasons recorded, nothing thrown.
    expect(meta.invalid).toEqual([
      { repo: "UniverLab/canopy-graphs", slug: "malformed", reason: "malformed front matter" },
      { repo: "UniverLab/canopy-graphs", slug: "garbled", reason: "unparseable figure JSON" },
      { repo: "UniverLab/canopy-graphs", slug: "ghost", reason: "missing figure" },
    ]);
  });
});

describe("the patterns index build", () => {
  it("writes the patterns index and one key per page, body and figure kept", async () => {
    const { kv } = await seeded(gatedStubs());
    const patterns = JSON.parse((await kv.get("patterns:v1")) as string) as {
      built_at: string;
      entries: Array<{ slug: string; title: string; status: string; figure: { name: string } }>;
    };
    expect(patterns.built_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(patterns.entries).toHaveLength(1);
    expect(patterns.entries[0]?.slug).toBe("gated-check");
    expect(patterns.entries[0]?.figure.name).toBe("gated-check");
    const stored = JSON.parse((await kv.get(patternKey("gated-check"))) as string) as {
      title: string;
      body: string;
      sources: Array<{ title: string }>;
      figure: { name: string };
    };
    expect(stored.title).toBe("Gated check");
    expect(stored.body).toContain("**one fail edge**");
    expect(stored.sources).toEqual([{ title: "Building effective agents", url: "https://example.com/agents" }]);
    expect(stored.figure.name).toBe("gated-check");
  });

  it("deletes the key of a pattern that disappeared", async () => {
    const kv = new FakeKV();
    await kv.put(patternKey("retired"), JSON.stringify({
      title: "Retired",
      summary: "",
      status: "standard",
      implements: [],
      sources: [],
      body: "",
      figure: {},
    }));
    const fake = fakeFetch(gatedStubs());
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    await runIndexer({ github, index: kv, authenticated: false });
    expect(await kv.get(patternKey("retired"))).toBeNull();
    expect(await kv.get(patternKey("gated-check"))).not.toBeNull();
  });

  it("reads only the official repository's patterns", async () => {
    const fake = fakeFetch([
      ...officialStubs(),
      ...patternStubs([GATED_PAGE]),
      {
        url: "search/repositories",
        status: 200,
        body: {
          total_count: 1,
          items: [{ name: "things", owner: { login: "acme" }, default_branch: "main", stargazers_count: 1 }],
        },
      },
      // A community repository carrying its own patterns directory: the run
      // indexes its documents and never looks at its patterns.
      { url: "repos/acme/things/git/trees/main", status: 200, body: { tree: [{ path: "graphs/flow/graph.json", type: "blob" }] } },
      { url: "repos/acme/things/contents/graphs/flow/graph.json", status: 200, body: fileBody("graphs/flow/graph.json", FIVE_NODE_GRAPH_TEXT) },
      { url: "repos/acme/things/contents/graphs/flow/README.md", status: 404, body: {} },
    ]);
    const kv = new FakeKV();
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    await runIndexer({ github, index: kv, authenticated: false });
    expect(fake.calls.some((url) => url.includes("repos/acme/things/contents/patterns"))).toBe(false);
    expect(fake.calls.filter((url) => url.includes("/contents/patterns"))).toHaveLength(3);
  });

  it("keeps the previous patterns when the directory cannot be read", async () => {
    const kv = new FakeKV();
    await kv.put("patterns:v1", JSON.stringify({ built_at: "t", entries: [] }));
    await kv.put(patternKey("kept"), JSON.stringify({
      title: "Kept",
      summary: "",
      status: "standard",
      implements: [],
      sources: [],
      body: "",
      figure: {},
    }));
    const stubs = [...officialStubs(), { url: PATTERNS_DIR, status: 500, body: {} }];
    const fake = fakeFetch(stubs);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    resetIndexMemo();
    await runIndexer({ github, index: kv, authenticated: false });
    expect(await kv.get(patternKey("kept"))).not.toBeNull();
    expect(JSON.parse((await kv.get("patterns:v1")) as string)).toEqual({ built_at: "t", entries: [] });
  });
});

describe("card ordering", () => {
  it("lists standard first, then in use, then experiment", async () => {
    const stubs = [
      ...officialStubs(),
      ...patternStubs([
        { slug: "z-experiment", title: "Z experiment", status: "experiment" },
        { slug: "a-use", title: "A use", status: "in use" },
        { slug: "m-standard", title: "M standard", status: "standard" },
        { slug: "b-standard", title: "B standard", status: "standard" },
      ]),
    ];
    const html = await (await call("/patterns", { stubs })).text();
    const order = ["B standard", "M standard", "A use", "Z experiment"].map((title) =>
      html.indexOf(`<span class="card-title">${title}</span>`)
    );
    for (const position of order) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("the plates", () => {
  it("draws every card's figure small and non-interactive", async () => {
    const html = await (await call("/patterns", { stubs: gatedStubs() })).text();
    expect(html).toContain(`<ol class="cards">`);
    expect(html).toContain(`<li class="card">`);
    expect(html).toContain(`<a class="card-link" href="/patterns/gated-check">`);
    expect(html).toContain(`<span class="card-title">Gated check</span>`);
    expect(html).toContain(`<span class="badge-status status-standard">standard</span>`);
    // The thumbnail: both orientations like a full plate, one shape per
    // figure node, the fail edge dashed, the token stilled, out of the
    // pointer's way.
    const thumbs = html.match(/<figure class="plate thumb" aria-hidden="true">/g) ?? [];
    expect(thumbs).toHaveLength(1);
    expect(html).toContain(`<g class="node shape-agent" data-name="implement"`);
    expect(html).toContain(`<g class="node shape-check" data-name="gate"`);
    expect(html).toContain(`<g class="node shape-agent" data-name="commit"`);
    expect(html).toContain(`class="edge fail"`);
    expect(html).toContain(`stroke-dasharray:1.4 1.1`);
    expect(html).toMatch(/figure\.thumb \{[^}]*pointer-events: none;/);
    expect(html).toMatch(/figure\.thumb \.token \{ display: none; \}/);
  });

  it("opens the page with the figure's full plate, both orientations", async () => {
    const html = await (await call("/patterns/gated-check", { stubs: gatedStubs() })).text();
    expect(html).toContain(`<figure class="plate">`);
    expect(html).toContain(`<svg class="plate-svg plate-h"`);
    expect(html).toContain(`<svg class="plate-svg plate-v"`);
    // One shape per figure node in each orientation, the fail edge dashed.
    for (const name of ["implement", "gate", "commit"]) {
      expect(html.match(new RegExp(`data-name="${name}"`, "g"))?.length).toBeGreaterThanOrEqual(2);
    }
    expect((html.match(/class="edge fail"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // The shape comes first: plate, then badge, body, sources, Implemented-by.
    const order = ["<figure", `<span class="badge-status`, `<div class="readme">`, "Sources</span>", `${IMPLEMENTED_BY_HEADING}</span>`]
      .map((part) => html.indexOf(part));
    expect(order.every((position) => position > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("answers an empty list with the empty line, and the header links it", async () => {
    const html = await (await call("/patterns", { stubs: officialStubs() })).text();
    expect(html).toContain(PATTERNS_EMPTY);
    expect(html).not.toContain(`<li class="card">`);
    const header = html.slice(html.indexOf(`<header class="site-header">`), html.indexOf(`</header>`));
    expect(header).toMatch(/<a href="\/patterns" aria-label="Patterns" title="Patterns"><svg[\s\S]*?<\/svg><span>Patterns<\/span><\/a>/);
  });

  it("links the list from the home page", async () => {
    const html = await (await call("/", { stubs: gatedStubs() })).text();
    expect(html).toContain(`<h2 class="kicker">Patterns</h2>`);
    expect(html).toContain(`<a href="/patterns">Patterns</a>`);
    const twin = await (await call("/", { stubs: gatedStubs(), accept: "text/markdown" })).text();
    expect(twin).toContain(`## Patterns`);
    expect(twin).toContain(`[Patterns](/patterns)`);
  });
});

describe("the experiment notice", () => {
  const tried: PatternPage = {
    slug: "tried",
    title: "Tried",
    status: "experiment",
    implements: [],
    figure: "tried.figure.json",
  };

  it("marks an experiment page as not yet proven in the lab", async () => {
    const stubs = [...officialStubs(), ...patternStubs([tried])];
    const html = await (await call("/patterns/tried", { stubs })).text();
    expect(html).toContain(`<span class="badge-status status-experiment">experiment</span>`);
    expect(html).toContain(EXPERIMENT_NOTICE);
    const carded = await (await call("/patterns", { stubs })).text();
    expect(carded).toContain(`<span class="badge-status status-experiment">experiment</span>`);
    const twin = await (await call("/patterns/tried", { stubs, accept: "text/markdown" })).text();
    expect(twin).toContain(`Status: experiment`);
    expect(twin).toContain(EXPERIMENT_NOTICE);
  });

  it("marks no notice on a standard page", async () => {
    const html = await (await call("/patterns/gated-check", { stubs: gatedStubs() })).text();
    expect(html).toContain(`<span class="badge-status status-standard">standard</span>`);
    expect(html).not.toContain(EXPERIMENT_NOTICE);
  });
});

describe("Implemented by", () => {
  it("renders a known graph and node as catalogue rows, with the graph's plate", async () => {
    const html = await (await call("/patterns/gated-check", { stubs: gatedStubs() })).text();
    expect(html).toContain(`${IMPLEMENTED_BY_HEADING}</span>`);
    // The catalogue's index rows: name linked, Official badge, install
    // command with Copy — for the graph and the node alike.
    expect(html).toContain(`<a class="row-name" href="/g/hello-graph">hello-graph</a>`);
    expect(html).toContain(`<a class="row-name" href="/n/hello-node">hello-node</a>`);
    expect(html).toContain(`<code>canopy graph install hello-graph</code>`);
    expect(html).toContain(`<code>canopy node install hello-node</code>`);
    expect(html).toContain(`data-copy="canopy graph install hello-graph"`);
    expect(html).toContain(`data-copy="canopy node install hello-node"`);
    // The graph's own small plate rides in its row; the node draws none.
    const rows = html.slice(html.indexOf(`${IMPLEMENTED_BY_HEADING}</span>`));
    expect(rows).toContain(`<figure class="plate thumb" aria-hidden="true">`);
    expect(rows).toContain(`>build</text>`);
  });

  it("lists a missing ref as text with the not-in-the-catalogue line", async () => {
    const html = await (await call("/patterns/gated-check", { stubs: gatedStubs() })).text();
    expect(html).toContain(`<span class="row-name">graph:missing-thing</span>`);
    expect(html).toContain(PATTERN_MISSING_REF);
    expect(html).not.toContain(`href="/g/missing-thing"`);
    const twin = await (await call("/patterns/gated-check", { stubs: gatedStubs(), accept: "text/markdown" })).text();
    expect(twin).toContain(`- graph:missing-thing — ${PATTERN_MISSING_REF}`);
    expect(twin).toContain(`[hello-graph](/g/hello-graph)`);
  });

  it("says so when nothing implements the pattern yet", async () => {
    const stubs = [...officialStubs(), ...patternStubs([{ slug: "quiet", figure: "quiet.figure.json" }])];
    const html = await (await call("/patterns/quiet", { stubs })).text();
    expect(html).toContain(PATTERNS_NO_IMPLEMENTS);
  });
});

describe("the back-link", () => {
  it("links an implemented document page back to its patterns", async () => {
    const html = await (await call("/g/hello-graph", { stubs: gatedStubs() })).text();
    expect(html).toContain(`<dt>Patterns</dt><dd><a href="/patterns/gated-check">Gated check</a></dd>`);
    const node = await (await call("/n/hello-node", { stubs: gatedStubs() })).text();
    expect(node).toContain(`<a href="/patterns/gated-check">Gated check</a>`);
    const twin = await (await call("/g/hello-graph", { stubs: gatedStubs(), accept: "text/markdown" })).text();
    expect(twin).toContain(`- Patterns: [Gated check](/patterns/gated-check)`);
  });

  it("adds no Patterns line where no pattern implements the document", async () => {
    const html = await (await call("/g/hello-graph", { stubs: officialStubs() })).text();
    expect(html).not.toContain(`<dt>Patterns</dt>`);
    const twin = await (await call("/g/hello-graph", { stubs: officialStubs(), accept: "text/markdown" })).text();
    expect(twin).not.toContain(`- Patterns:`);
  });
});

describe("the body sanitizer", () => {
  it("lets no raw HTML from the body through", async () => {
    const evil: PatternPage = {
      slug: "evil",
      figure: "evil.figure.json",
      body: "# evil\n\n<script>alert(1)</script>\n\n<img src=x onerror=\"alert(2)\">\n",
    };
    const html = await (await call("/patterns/evil", {
      stubs: [...officialStubs(), ...patternStubs([evil])],
    })).text();
    const body = html.slice(html.indexOf(`<div class="readme">`), html.indexOf(`</main>`));
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&lt;img src=x onerror=");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script>alert");
  });

  it("renders sources as links, and degrades an unsafe URL to text", async () => {
    const page: PatternPage = {
      slug: "linked",
      figure: "linked.figure.json",
      sources: [
        { title: "Good", url: "https://example.com/good" },
        { title: "Bad", url: "javascript:alert(1)" },
      ],
    };
    const html = await (await call("/patterns/linked", {
      stubs: [...officialStubs(), ...patternStubs([page])],
    })).text();
    expect(html).toContain(`${PATTERN_SOURCES_HEADING}</span>`);
    expect(html).toContain(
      `<a href="https://example.com/good" target="_blank" rel="nofollow noopener noreferrer">Good</a>`,
    );
    expect(html).not.toContain(`href="javascript:`);
    expect(html).toContain(`<li>Bad</li>`);
    // The twin degrades the same URL to text: it generates this link
    // itself, so it never hands agents a target the page would refuse.
    const twin = await (await call("/patterns/linked", {
      stubs: [...officialStubs(), ...patternStubs([page])],
      accept: "text/markdown",
    })).text();
    expect(twin).toContain(`- [Good](https://example.com/good)`);
    expect(twin).not.toContain(`javascript:`);
    expect(twin.split("\n")).toContain(`- Bad`);
  });
});

describe("the body's leading title", () => {
  const pattern: StoredPattern = {
    title: "Gated check",
    summary: "Shell checks decide pass or fail, never an LLM judge.",
    status: "standard",
    implements: [],
    sources: [],
    figure: JSON.parse(FIGURE_TEXT),
    body: "",
  };

  /** The rendered readme div of one body: the section under test. */
  function readme(body: string): string {
    const html = patternPage({ ...pattern, body }, []).html;
    return /<div class="readme">[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
  }

  it("drops a leading H1 that repeats the front-matter title", () => {
    const section = readme("# Gated check\n\nA graph the pattern tests render.\n");
    expect(section).not.toContain("<h1>");
    expect(section).toContain("<p>A graph the pattern tests render.</p>");
    // Case and a trailing space do not save a repeated title.
    expect(readme("# gated check \n\nBody.\n")).not.toContain("<h1>");
  });

  it("keeps a leading H1 that says something else", () => {
    const section = readme("# Another heading\n\nBody.\n");
    expect(section).toContain("<h1>Another heading</h1>");
    expect(section).toContain("<p>Body.</p>");
  });

  it("keeps a body that opens with no H1", () => {
    const section = readme("Straight into the prose.\n");
    expect(section).not.toContain("<h1>");
    expect(section).toContain("<p>Straight into the prose.</p>");
  });
});

describe("llms.txt and the twin", () => {
  it("lists patterns under a Patterns heading", async () => {
    const llms = await (await call("/llms.txt", { stubs: gatedStubs() })).text();
    expect(llms).toContain(`## Patterns`);
    expect(llms).toContain(`Gated check\tShell checks decide pass or fail, never an LLM judge.\t/patterns/gated-check`);
    // Documents keep their lines above the patterns section.
    expect(llms.indexOf("hello-graph")).toBeLessThan(llms.indexOf("## Patterns"));
  });

  it("carries the figure as a fenced JSON block in the twin, no HTML", async () => {
    const twin = await (await call("/patterns/gated-check", {
      stubs: gatedStubs(),
      accept: "text/markdown",
    })).text();
    expect(twin).toContain(`## Figure`);
    expect(twin).toContain("```json");
    expect(twin).toContain(`"name": "gated-check"`);
    expect(twin).toContain(`## ${PATTERN_SOURCES_HEADING}`);
    expect(twin).toContain(`- [Building effective agents](https://example.com/agents)`);
    expect(twin).toContain(`## ${IMPLEMENTED_BY_HEADING}`);
    expect(twin).not.toContain("<");
  });

  it("serves the list twin too", async () => {
    const twin = await (await call("/patterns", { stubs: gatedStubs(), accept: "text/markdown" })).text();
    expect(twin).toContain(`# Patterns`);
    expect(twin).toContain(`[Gated check](/patterns/gated-check)`);
    expect(twin).not.toContain("<");
  });
});

describe("routing", () => {
  it("answers the cold start with the indexing 503", async () => {
    resetIndexMemo();
    const kv = new FakeKV();
    const fake = fakeFetch([]);
    for (const path of ["/patterns", "/patterns/gated-check"]) {
      const answer = await handlePage(new Request(`${ORIGIN}${path}`), { INDEX: kv }, {
        fetchImpl: fake.fetchImpl,
        cache: new FakeCache(),
      });
      expect(answer).not.toBe(NOT_PAGE);
      const response = answer as unknown as Response;
      expect(response.status, path).toBe(503);
      expect(await response.text(), path).toContain(INDEXING_HEADING);
    }
  });

  it("answers a missing pattern and a bad slug with the calm 404", async () => {
    const missing = await call("/patterns/nope", { stubs: gatedStubs() });
    expect(missing.status).toBe(404);
    const bad = await call("/patterns/Not_A_Slug", { stubs: gatedStubs() });
    expect(bad.status).toBe(404);
    expect(await bad.text()).toContain("Not found");
  });
});
