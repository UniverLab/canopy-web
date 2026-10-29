// SPDX-License-Identifier: Apache-2.0
/**
 * The lab's pattern pages, served from the bundled set: front-matter
 * parsing, the bundled build (every page parses, every figure validates),
 * card ordering, the plates on cards and pages, the experiment notice, the
 * Implemented-by rows, the document back-link, the body sanitizer, and
 * llms.txt plus the markdown twin. Route tests seed a fresh KV through the
 * indexer with the shared catalogue stubs, like the catalogue page tests —
 * the bundled patterns arrive with the Worker, and no page may reach
 * GitHub. Pattern-specific expectations are computed from the bundled set,
 * so the suite follows `apps/graphs/patterns/` without retyping it.
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
import {
  comparePatterns,
  implementingPatterns,
  parsePatternFile,
  patternFromTexts,
  type FigureText,
  type PatternMeta,
  type PatternRef,
  type StoredPattern,
} from "../src/patterns.js";
import { bundledPatterns } from "../src/patterns-bundled.js";
import { BUNDLED_PATTERNS, PATTERNS_BUILT_AT } from "../src/patterns-data.generated.js";
import { SLUG_RE } from "../src/lib.js";
import { isValidDocument } from "../src/validate.js";
import { escapeHtml } from "../src/pages/md.js";
import { patternsIndexPage, patternPage } from "../src/pages/patterns.js";
import { createGitHub } from "../src/github.js";
import { runIndexer } from "../src/indexer.js";
import { createStore, resetIndexMemo } from "../src/store.js";
import { FakeCache, FakeKV, fakeFetch, fileBody, type Stub } from "./fakes.js";
import { VALID_GRAPH_TEXT, VALID_NODE_TEXT } from "./documents-fixture.js";
import { REPO_DIR, officialStubs } from "./stubs.js";

const ORIGIN = "https://graphs.univerlab.org";

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

/** The front matter of every bundled page; throws when a page misparses. */
function bundledMetas(): Array<{ slug: string; meta: PatternMeta }> {
  return BUNDLED_PATTERNS.map((bundled) => {
    const parsed = parsePatternFile(bundled.page);
    if (parsed === null) {
      throw new Error(`bundled ${bundled.slug} does not parse`);
    }
    return { slug: bundled.slug, meta: parsed.meta };
  });
}

/** Every `implements` ref the bundled set names, deduplicated in first-seen order. */
function bundledRefs(): PatternRef[] {
  const refs: PatternRef[] = [];
  const seen = new Set<string>();
  for (const { meta } of bundledMetas()) {
    for (const ref of meta.implements) {
      const key = `${ref.kind}:${ref.slug}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(ref);
      }
    }
  }
  return refs;
}

/** One valid document text renamed to the slug it is seeded under. */
function docText(kind: "graph" | "node", slug: string): string {
  const parsed = JSON.parse(kind === "graph" ? VALID_GRAPH_TEXT : VALID_NODE_TEXT) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, name: slug });
}

/**
 * The official stubs with extra documents seeded, so bundled `implements`
 * refs resolve to catalogue rows: the listings grow the slugs, and each
 * slug answers its renamed document.
 */
function catalogueStubs(extra: PatternRef[]): Stub[] {
  const graphs = extra.filter((doc) => doc.kind === "graph").map((doc) => doc.slug);
  const nodes = extra.filter((doc) => doc.kind === "node").map((doc) => doc.slug);
  const extended = officialStubs().map((stub) => {
    if (stub.url.endsWith("/contents/graphs") && graphs.length > 0) {
      return {
        ...stub,
        body: [...(stub.body as unknown[]), ...graphs.map((slug) => ({ name: slug, path: slug, type: "dir", size: 0 }))],
      };
    }
    if (stub.url.endsWith("/contents/nodes") && nodes.length > 0) {
      return {
        ...stub,
        body: [...(stub.body as unknown[]), ...nodes.map((slug) => ({ name: slug, path: slug, type: "dir", size: 0 }))],
      };
    }
    return stub;
  });
  const files = extra.flatMap((doc): Stub[] => {
    const file = doc.kind === "graph" ? "graph.json" : "node.json";
    const base = `${REPO_DIR}/contents/${doc.kind}s/${doc.slug}`;
    return [
      { url: `${base}/${file}`, status: 200, body: fileBody(`${doc.kind}s/${doc.slug}/${file}`, docText(doc.kind, doc.slug)) },
      { url: `${base}/README.md`, status: 404, body: {} },
    ];
  });
  return [...extended, ...files];
}

/**
 * The catalogue stubs with every bundled `implements` ref seeded as an
 * official document but the last, so pages render known rows for the
 * seeded refs and the not-in-the-catalogue line for the missing one.
 */
function refsStubs(): { stubs: Stub[]; seeded: PatternRef[]; missing: PatternRef } {
  const refs = bundledRefs();
  if (refs.length === 0) {
    throw new Error("the bundled set names no implements refs");
  }
  const missing = refs[refs.length - 1];
  const seeded = refs.slice(0, -1);
  return { stubs: catalogueStubs(seeded), seeded, missing };
}

/** Seed a fresh KV by running the indexer over the stub table. */
async function seeded(stubsToSeed: Stub[]): Promise<FakeKV> {
  const fake = fakeFetch(stubsToSeed);
  const kv = new FakeKV();
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
  await runIndexer({ github, index: kv, authenticated: false });
  return kv;
}

async function call(
  path: string,
  options: { stubs?: Stub[]; accept?: string } = {},
): Promise<Response> {
  resetIndexMemo();
  const kv = await seeded(options.stubs ?? officialStubs());
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

describe("the bundled set", () => {
  it("holds every page the build validated: slugs unique, ordered, well-formed", async () => {
    const { entries, documents } = await bundledPatterns();
    expect(BUNDLED_PATTERNS.length).toBeGreaterThan(0);
    expect(entries.length).toBe(BUNDLED_PATTERNS.length);
    expect(documents.size).toBe(BUNDLED_PATTERNS.length);
    const slugs = BUNDLED_PATTERNS.map((bundled) => bundled.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual(slugs);
    for (const slug of slugs) {
      expect(SLUG_RE.test(slug), slug).toBe(true);
      expect(documents.has(slug), slug).toBe(true);
    }
    expect(PATTERNS_BUILT_AT).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("parses every bundled page with its bundled figure", async () => {
    const figures = new Map(BUNDLED_PATTERNS.map((bundled) => [bundled.figureName, bundled.figure]));
    for (const bundled of BUNDLED_PATTERNS) {
      const figure = (name: string): Promise<FigureText> => {
        const text = figures.get(name);
        return Promise.resolve(text === undefined ? { kind: "absent" } : { kind: "text", text });
      };
      const loaded = await patternFromTexts(bundled.slug, bundled.page, figure, () => undefined);
      expect(loaded.kind, bundled.slug).toBe("pattern");
    }
  });

  it("validates every bundled figure against the graph schema", async () => {
    const { entries } = await bundledPatterns();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(isValidDocument("graph", entry.figure), entry.slug).toBe(true);
    }
  });

  it("serves the bundled set through the store, with or without KV", async () => {
    const seededKv = await seeded(officialStubs());
    for (const kv of [seededKv, new FakeKV(), undefined]) {
      resetIndexMemo();
      const store = createStore(kv);
      const patterns = await store.getPatterns();
      expect(patterns?.entries.length).toBe(BUNDLED_PATTERNS.length);
      expect(patterns?.built_at).toBe(PATTERNS_BUILT_AT);
      const cards = new Map((patterns?.entries ?? []).map((entry) => [entry.slug, entry]));
      for (const bundled of BUNDLED_PATTERNS) {
        const stored = await store.getPattern(bundled.slug);
        expect(stored?.title, bundled.slug).toBe(cards.get(bundled.slug)?.title);
      }
      expect(await store.getPattern("no-such-pattern")).toBeNull();
    }
  });
});

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

describe("card ordering", () => {
  it("lists standard first, then in use, then experiment", async () => {
    const { entries } = await bundledPatterns();
    const ordered = [...entries].sort(comparePatterns);
    const html = await (await call("/patterns")).text();
    expect(html.match(/<li class="card">/g)).toHaveLength(ordered.length);
    const positions = ordered.map((entry) =>
      html.indexOf(`<span class="card-title">${escapeHtml(entry.title)}</span>`)
    );
    for (const position of positions) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("the plates", () => {
  it("draws every card's figure small and non-interactive", async () => {
    const { entries } = await bundledPatterns();
    const html = await (await call("/patterns")).text();
    expect(html).toContain(`<ol class="cards">`);
    // Every card: its link, title, badge and summary, and one thumbnail.
    for (const entry of entries) {
      expect(html).toContain(`<a class="card-link" href="/patterns/${entry.slug}">`);
      expect(html).toContain(`<span class="card-title">${escapeHtml(entry.title)}</span>`);
      expect(html).toContain(`<span class="card-summary">${escapeHtml(entry.summary)}</span>`);
      expect(html).toContain(
        `<span class="badge-status status-${entry.status.replace(" ", "-")}">${entry.status}</span>`,
      );
    }
    const thumbs = html.match(/<figure class="plate thumb" aria-hidden="true">/g) ?? [];
    expect(thumbs).toHaveLength(entries.length);
    // Every figure node drawn twice — both orientations like a full
    // plate — the token stilled, out of the pointer's way. Fail edges
    // render dashed; ensembles add their own, so only presence is pinned.
    let nodes = 0;
    let fails = 0;
    for (const entry of entries) {
      const figure = entry.figure as { nodes?: unknown[]; edges?: Array<{ condition?: string }> };
      nodes += figure.nodes?.length ?? 0;
      fails += figure.edges?.filter((edge) => edge.condition === "fail").length ?? 0;
    }
    expect(html.match(/<g class="node /g) ?? []).toHaveLength(nodes * 2);
    expect(fails).toBeGreaterThan(0);
    expect(html).toContain(`class="edge fail"`);
    expect(html).toContain(`stroke-dasharray:1.4 1.1`);
    expect(html).toMatch(/figure\.thumb \{[^}]*pointer-events: none;/);
    expect(html).toMatch(/figure\.thumb \.token \{ display: none; \}/);
  });

  it("opens the page with the figure's full plate, both orientations", async () => {
    const { entries } = await bundledPatterns();
    const ordered = [...entries].sort(comparePatterns);
    const withFail = ordered.find((one) => {
      const edges = (one.figure as { edges?: Array<{ condition?: string }> }).edges ?? [];
      return edges.some((edge) => edge.condition === "fail");
    });
    expect(withFail, "a bundled figure with a fail edge").toBeDefined();
    const entry = withFail ?? ordered[0];
    const figure = entry.figure as { nodes?: Array<{ name?: string }> };
    const html = await (await call(`/patterns/${entry.slug}`)).text();
    expect(html).toContain(`<figure class="plate">`);
    expect(html).toContain(`<svg class="plate-svg plate-h"`);
    expect(html).toContain(`<svg class="plate-svg plate-v"`);
    // One shape per figure node in each orientation, the fail edge dashed.
    for (const node of figure.nodes ?? []) {
      expect(html.match(new RegExp(`data-name="${node.name ?? ""}"`, "g"))?.length).toBeGreaterThanOrEqual(2);
    }
    expect(html).toContain(`class="edge fail"`);
    // The shape comes first: plate, then badge, body, sources, Implemented-by.
    const order = ["<figure", `<span class="badge-status`, `<div class="readme">`, "Sources</span>", `${IMPLEMENTED_BY_HEADING}</span>`]
      .map((part) => html.indexOf(part));
    expect(order.every((position) => position > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("answers an empty list with the empty line, and the header links it", async () => {
    const empty = patternsIndexPage([]);
    expect(empty.html).toContain(PATTERNS_EMPTY);
    expect(empty.html).not.toContain(`<li class="card">`);
    const html = await (await call("/patterns")).text();
    const header = html.slice(html.indexOf(`<header class="site-header">`), html.indexOf(`</header>`));
    expect(header).toMatch(/<a href="\/patterns" aria-label="Patterns" title="Patterns"><svg[\s\S]*?<\/svg><span>Patterns<\/span><\/a>/);
  });

  it("links the list from the home page", async () => {
    const html = await (await call("/")).text();
    expect(html).toContain(`<h2 class="kicker">Patterns</h2>`);
    expect(html).toContain(`<a href="/patterns">Patterns</a>`);
    const twin = await (await call("/", { accept: "text/markdown" })).text();
    expect(twin).toContain(`## Patterns`);
    expect(twin).toContain(`[Patterns](/patterns)`);
  });
});

describe("the experiment notice", () => {
  it("marks an experiment page as not yet proven in the lab", async () => {
    const { entries } = await bundledPatterns();
    const tried = entries.find((entry) => entry.status === "experiment");
    expect(tried, "the bundled set holds an experiment").toBeDefined();
    const slug = tried?.slug ?? "missing";
    const html = await (await call(`/patterns/${slug}`)).text();
    expect(html).toContain(`<span class="badge-status status-experiment">experiment</span>`);
    expect(html).toContain(EXPERIMENT_NOTICE);
    const carded = await (await call("/patterns")).text();
    expect(carded).toContain(`<span class="badge-status status-experiment">experiment</span>`);
    const twin = await (await call(`/patterns/${slug}`, { accept: "text/markdown" })).text();
    expect(twin).toContain(`Status: experiment`);
    expect(twin).toContain(EXPERIMENT_NOTICE);
  });

  it("marks no notice on a standard page", async () => {
    const { entries } = await bundledPatterns();
    const steady = entries.find((entry) => entry.status === "standard");
    expect(steady, "the bundled set holds a standard").toBeDefined();
    const html = await (await call(`/patterns/${steady?.slug ?? "missing"}`)).text();
    expect(html).toContain(`<span class="badge-status status-standard">standard</span>`);
    expect(html).not.toContain(EXPERIMENT_NOTICE);
  });
});

describe("Implemented by", () => {
  it("renders seeded graphs and nodes as catalogue rows, with the graphs' plates", async () => {
    const { stubs, seeded } = refsStubs();
    const { entries } = await bundledPatterns();
    const keys = new Set(seeded.map((ref) => `${ref.kind}:${ref.slug}`));
    const subject = entries.find((entry) =>
      entry.implements.some((ref) => ref.kind === "graph" && keys.has(`graph:${ref.slug}`)) &&
      entry.implements.some((ref) => ref.kind === "node" && keys.has(`node:${ref.slug}`))
    );
    expect(subject, "a bundled pattern implements a seeded graph and node").toBeDefined();
    if (subject === undefined) {
      return;
    }
    const html = await (await call(`/patterns/${subject.slug}`, { stubs })).text();
    expect(html).toContain(`${IMPLEMENTED_BY_HEADING}</span>`);
    // The catalogue's index rows: name linked, install command with Copy —
    // for every seeded ref of the page.
    for (const ref of subject.implements.filter((ref) => keys.has(`${ref.kind}:${ref.slug}`))) {
      const prefix = ref.kind === "graph" ? "/g" : "/n";
      const command = `canopy ${ref.kind} install ${ref.slug}`;
      expect(html).toContain(`<a class="row-name" href="${prefix}/${ref.slug}">${ref.slug}</a>`);
      expect(html).toContain(`<code>${command}</code>`);
      expect(html).toContain(`data-copy="${command}"`);
    }
    // Each seeded graph row carries the graph's own small plate; nodes
    // draw none.
    const rows = html.slice(html.indexOf(`${IMPLEMENTED_BY_HEADING}</span>`));
    const graphs = subject.implements.filter((ref) => ref.kind === "graph" && keys.has(`graph:${ref.slug}`));
    expect(rows.match(/<figure class="plate thumb" aria-hidden="true">/g) ?? []).toHaveLength(graphs.length);
    const names = (JSON.parse(VALID_GRAPH_TEXT) as { nodes: Array<{ name: string }> }).nodes;
    expect(rows).toContain(`>${names[0]?.name ?? ""}</text>`);
  });

  it("lists a missing ref as text with the not-in-the-catalogue line", async () => {
    const { stubs, seeded, missing } = refsStubs();
    const { entries } = await bundledPatterns();
    const subject = entries.find((entry) =>
      entry.implements.some((ref) => ref.kind === missing.kind && ref.slug === missing.slug)
    );
    expect(subject, "a bundled pattern implements the missing ref").toBeDefined();
    if (subject === undefined) {
      return;
    }
    const keys = new Set(seeded.map((ref) => `${ref.kind}:${ref.slug}`));
    const prefix = missing.kind === "graph" ? "/g" : "/n";
    const html = await (await call(`/patterns/${subject.slug}`, { stubs })).text();
    expect(html).toContain(`<span class="row-name">${missing.kind}:${missing.slug}</span>`);
    expect(html).toContain(PATTERN_MISSING_REF);
    expect(html).not.toContain(`href="${prefix}/${missing.slug}"`);
    // ... while the seeded refs beside it stay linked rows.
    for (const ref of subject.implements.filter((ref) => keys.has(`${ref.kind}:${ref.slug}`))) {
      const refPrefix = ref.kind === "graph" ? "/g" : "/n";
      expect(html).toContain(`<a class="row-name" href="${refPrefix}/${ref.slug}">`);
    }
    const twin = await (await call(`/patterns/${subject.slug}`, { stubs, accept: "text/markdown" })).text();
    expect(twin).toContain(`- ${missing.kind}:${missing.slug} — ${PATTERN_MISSING_REF}`);
  });

  it("says so when nothing implements the pattern yet", async () => {
    const { entries } = await bundledPatterns();
    const quiet = entries.find((entry) => entry.implements.length === 0);
    expect(quiet, "the bundled set holds a pattern nothing implements").toBeDefined();
    const html = await (await call(`/patterns/${quiet?.slug ?? "missing"}`)).text();
    expect(html).toContain(PATTERNS_NO_IMPLEMENTS);
  });
});

describe("the back-link", () => {
  it("links an implemented document page back to its patterns", async () => {
    const { stubs, seeded } = refsStubs();
    const { entries } = await bundledPatterns();
    const ref = seeded.find((one) => one.kind === "graph") ?? seeded.find((one) => one.kind === "node");
    if (ref === undefined) {
      throw new Error("the bundled set names no implements refs");
    }
    const prefix = ref.kind === "graph" ? "/g" : "/n";
    const backlinks = implementingPatterns(entries, ref.kind, ref.slug);
    expect(backlinks.length).toBeGreaterThan(0);
    const html = await (await call(`${prefix}/${ref.slug}`, { stubs })).text();
    expect(html).toContain(`<dt>Patterns</dt>`);
    for (const pattern of backlinks) {
      expect(html).toContain(`<a href="/patterns/${pattern.slug}">${escapeHtml(pattern.title)}</a>`);
    }
    const twin = await (await call(`${prefix}/${ref.slug}`, { stubs, accept: "text/markdown" })).text();
    expect(twin).toContain(
      `- Patterns: ${backlinks.map((pattern) => `[${pattern.title}](/patterns/${pattern.slug})`).join(", ")}`,
    );
  });

  it("adds no Patterns line where no pattern implements the document", async () => {
    const { entries } = await bundledPatterns();
    expect(implementingPatterns(entries, "graph", "hello-graph")).toEqual([]);
    const html = await (await call("/g/hello-graph")).text();
    expect(html).not.toContain(`<dt>Patterns</dt>`);
    const twin = await (await call("/g/hello-graph", { accept: "text/markdown" })).text();
    expect(twin).not.toContain(`- Patterns:`);
  });
});

describe("the body sanitizer", () => {
  it("lets no raw HTML from the body through", async () => {
    const { documents } = await bundledPatterns();
    expect(BUNDLED_PATTERNS.length).toBeGreaterThan(0);
    const first = BUNDLED_PATTERNS[0];
    const stored = documents.get(first.slug);
    if (stored === undefined) {
      throw new Error(`the bundled set holds no ${first.slug} page`);
    }
    const html = patternPage({
      ...stored,
      body: "# evil\n\n<script>alert(1)</script>\n\n<img src=x onerror=\"alert(2)\">\n",
    }, []).html;
    const body = html.slice(html.indexOf(`<div class="readme">`));
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&lt;img src=x onerror=");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script>alert");
  });

  it("renders sources as links, and degrades an unsafe URL to text", async () => {
    const { documents } = await bundledPatterns();
    expect(BUNDLED_PATTERNS.length).toBeGreaterThan(0);
    const first = BUNDLED_PATTERNS[0];
    const stored = documents.get(first.slug);
    if (stored === undefined) {
      throw new Error(`the bundled set holds no ${first.slug} page`);
    }
    const page = {
      ...stored,
      sources: [
        { title: "Good", url: "https://example.com/good" },
        { title: "Bad", url: "javascript:alert(1)" },
      ],
    };
    const html = patternPage(page, []).html;
    expect(html).toContain(`${PATTERN_SOURCES_HEADING}</span>`);
    expect(html).toContain(
      `<a href="https://example.com/good" target="_blank" rel="nofollow noopener noreferrer">Good</a>`,
    );
    expect(html).not.toContain(`href="javascript:`);
    expect(html).toContain(`<li>Bad</li>`);
    // The twin degrades the same URL to text: it generates this link
    // itself, so it never hands agents a target the page would refuse.
    const twin = patternPage(page, []).markdown;
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
    figure: {},
    body: "",
  };

  /** The rendered readme div of one body: the section under test. */
  function readme(body: string): string {
    expect(BUNDLED_PATTERNS.length).toBeGreaterThan(0);
    const figure = JSON.parse(BUNDLED_PATTERNS[0].figure) as StoredPattern["figure"];
    const html = patternPage({ ...pattern, figure, body }, []).html;
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
  it("lists every bundled pattern under a Patterns heading", async () => {
    const { entries } = await bundledPatterns();
    const llms = await (await call("/llms.txt")).text();
    expect(llms).toContain(`## Patterns`);
    for (const entry of entries) {
      expect(llms).toContain(`${entry.title}\t${entry.summary}\t/patterns/${entry.slug}`);
    }
    // Documents keep their lines above the patterns section.
    expect(llms.indexOf("hello-graph")).toBeLessThan(llms.indexOf("## Patterns"));
  });

  it("carries the figure as a fenced JSON block in the twin, no HTML", async () => {
    const { entries, documents } = await bundledPatterns();
    const entry = entries.find((one) => !(documents.get(one.slug)?.body.includes("<") ?? true));
    expect(entry, "a bundled body without angle brackets").toBeDefined();
    if (entry === undefined) {
      return;
    }
    const stored = documents.get(entry.slug);
    if (stored === undefined) {
      throw new Error(`the bundled set holds no ${entry.slug} page`);
    }
    const twin = await (await call(`/patterns/${entry.slug}`, { accept: "text/markdown" })).text();
    expect(twin).toContain(`## Figure`);
    expect(twin).toContain("```json");
    const name = (entry.figure as { name?: string }).name ?? "";
    expect(name).not.toBe("");
    expect(twin).toContain(`"name": "${name}"`);
    expect(twin).toContain(`## ${PATTERN_SOURCES_HEADING}`);
    for (const source of stored.sources) {
      expect(twin).toContain(`- [${source.title}](${source.url})`);
    }
    expect(twin).toContain(`## ${IMPLEMENTED_BY_HEADING}`);
    expect(twin).not.toContain("<");
  });

  it("serves the list twin too", async () => {
    const { entries } = await bundledPatterns();
    const twin = await (await call("/patterns", { accept: "text/markdown" })).text();
    expect(twin).toContain(`# Patterns`);
    for (const entry of entries) {
      expect(twin).toContain(`[${entry.title}](/patterns/${entry.slug})`);
    }
    expect(twin).not.toContain("<");
  });
});

describe("routing", () => {
  it("renders the list from the bundle on a cold KV", async () => {
    resetIndexMemo();
    const kv = new FakeKV();
    const fake = fakeFetch([]);
    const answer = await handlePage(new Request(`${ORIGIN}/patterns`), { INDEX: kv }, {
      fetchImpl: fake.fetchImpl,
      cache: new FakeCache(),
    });
    expect(answer).not.toBe(NOT_PAGE);
    const response = answer as unknown as Response;
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const bundled of BUNDLED_PATTERNS) {
      expect(html).toContain(`href="/patterns/${bundled.slug}"`);
    }
    expect(fake.calls, "no page may reach upstream").toEqual([]);
  });

  it("answers a pattern page on a cold KV with the indexing 503", async () => {
    resetIndexMemo();
    const kv = new FakeKV();
    const fake = fakeFetch([]);
    expect(BUNDLED_PATTERNS.length).toBeGreaterThan(0);
    const first = BUNDLED_PATTERNS[0];
    const answer = await handlePage(new Request(`${ORIGIN}/patterns/${first.slug}`), { INDEX: kv }, {
      fetchImpl: fake.fetchImpl,
      cache: new FakeCache(),
    });
    expect(answer).not.toBe(NOT_PAGE);
    const response = answer as unknown as Response;
    expect(response.status).toBe(503);
    expect(await response.text()).toContain(INDEXING_HEADING);
  });

  it("answers a missing pattern and a bad slug with the calm 404", async () => {
    expect(BUNDLED_PATTERNS.map((bundled) => bundled.slug)).not.toContain("no-such-pattern");
    const missing = await call("/patterns/no-such-pattern");
    expect(missing.status).toBe(404);
    const bad = await call("/patterns/Not_A_Slug");
    expect(bad.status).toBe(404);
    expect(await bad.text()).toContain("Not found");
  });
});
