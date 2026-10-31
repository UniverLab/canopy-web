// SPDX-License-Identifier: Apache-2.0
/**
 * The index-time model review: the provider interface against a mock,
 * `off` disabling the pass, the hash gate, the per-run cap, failure
 * degrading to `unreviewed`, every verdict label including the
 * placeholder case, stored pattern relations on the patterns pages, and
 * the bundled prompt plus the pre-rendered diagram. Tests seed a fresh
 * in-memory KV with an index and documents directly — no GitHub — then
 * run the review and render pages from the same KV.
 */
import { describe, expect, it } from "vitest";
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import { sha256 } from "../src/hashes.js";
import { handlePage, NOT_PAGE } from "../src/pages/routes.js";
import {
  TRANSPARENCY_NO_VERDICTS,
  TRANSPARENCY_TITLE,
  PATTERN_MISSING_REF,
} from "../src/pages/copy.js";
import {
  INDEXING_MMD,
  INDEXING_SVG,
  REVIEW_PROMPT_V1,
  REVIEW_PROMPT_VERSION,
} from "../src/review-assets.generated.js";
import {
  REVIEWS_KEY,
  REVIEW_PATTERNS_KEY,
  REVIEW_DEFAULT_CAP,
  parseReviewPatterns,
  parseReviewsAggregate,
  parseStoredReview,
  reviewKey,
  runReview,
  type ReviewDocument,
  type ReviewProvider,
  type ReviewResult,
} from "../src/review.js";
import { buildReviewPrompt, createClaudeProvider, parseModelAnswer } from "../src/review-claude.js";
import { createStore, docKey, resetIndexMemo } from "../src/store.js";
import { FakeCache, FakeKV, fakeFetch } from "./fakes.js";

const ORIGIN = "https://graphs.univerlab.org";
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const MODEL = "mock-model";
const SLUGS = ["deterministic-gates", "adversarial-review"];

/** One index entry, official only for UniverLab/canopy-graphs. */
function entry(
  kind: DocumentKind,
  owner: string,
  repo: string,
  slug: string,
  updated: string | null = null,
): Record<string, unknown> {
  return {
    kind,
    owner,
    repo,
    slug,
    name: slug,
    description: `${slug} description`,
    official: owner === "UniverLab" && repo === "canopy-graphs",
    stars: null,
    updated,
    ref: "main",
  };
}

/** One graph document running a single check command. */
function graphDoc(slug: string, command: string): Record<string, unknown> {
  return {
    format_version: 6,
    name: slug,
    description: `${slug} description`,
    nodes: [{ name: "gate", kind: "check", position: 1, config: { command } }],
    edges: [],
  };
}

/** Seed the index plus one doc key per entry. */
async function seed(
  kv: FakeKV,
  entries: Array<Record<string, unknown>>,
  documents: Record<string, Record<string, unknown>>,
): Promise<void> {
  await kv.put("index:v1", JSON.stringify({ built_at: "2026-10-30T00:00:00.000Z", entries }));
  for (const [key, document] of Object.entries(documents)) {
    await kv.put(key, JSON.stringify({ document, readme: "" }));
  }
  kv.putOptions.length = 0;
}

/** A mock provider answering per document, recording every call. */
function mockProvider(
  answer: (document: ReviewDocument) => ReviewResult,
  model: string = MODEL,
): ReviewProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    model,
    calls,
    review(document: ReviewDocument): Promise<ReviewResult> {
      calls.push(`${document.owner}/${document.repo}/${document.slug}`);
      return Promise.resolve(answer(document));
    },
  };
}

/** Render one page from this KV; no request may reach upstream. */
async function call(path: string, kv: FakeKV, accept?: string): Promise<Response> {
  resetIndexMemo();
  const fake = fakeFetch([]);
  const headers = new Headers();
  if (accept !== undefined) {
    headers.set("accept", accept);
  }
  const answer = await handlePage(new Request(`${ORIGIN}${path}`, { headers }), { INDEX: kv }, {
    fetchImpl: fake.fetchImpl,
    cache: new FakeCache(),
  });
  expect(answer).not.toBe(NOT_PAGE);
  expect(fake.calls, "no page may reach upstream").toEqual([]);
  return answer as unknown as Response;
}

describe("the provider interface", () => {
  it("reviews through a mock and stores verdict, patterns, hash, model and date", async () => {
    const kv = new FakeKV();
    const entries = [entry("graph", "acme", "things", "flow", "2026-10-29")];
    const document = graphDoc("flow", "echo hi");
    await seed(kv, entries, { [docKey("graph", "acme", "things", "flow")]: document });
    const provider = mockProvider(() => ({
      verdict: "looks-safe",
      reasons: "",
      patterns: ["deterministic-gates", "no-such-pattern"],
    }));
    const stats = await runReview({
      index: kv,
      provider,
      patternSlugs: SLUGS,
      now: () => NOW,
    });
    expect(stats).toEqual({ candidates: 1, reviewed: 1, failed: 0, pruned: 0 });
    expect(provider.calls).toEqual(["acme/things/flow"]);
    const raw = await kv.get(docKey("graph", "acme", "things", "flow"));
    const hash = await sha256(raw as string);
    const stored = parseStoredReview((await kv.get(reviewKey("graph", "acme", "things", "flow"))) as string);
    // Unknown slugs are dropped; the scanned hash, model and date are kept.
    expect(stored).toEqual({
      verdict: "looks-safe",
      reasons: "",
      patterns: ["deterministic-gates"],
      hash,
      model: MODEL,
      reviewed_at: "2026-10-30T12:00:00.000Z",
    });
    const aggregate = parseReviewsAggregate((await kv.get(REVIEWS_KEY)) as string);
    expect(aggregate?.reviews).toEqual([{
      kind: "graph",
      owner: "acme",
      repo: "things",
      slug: "flow",
      verdict: "looks-safe",
      reasons: "",
      patterns: ["deterministic-gates"],
      hash,
      model: MODEL,
      reviewed_at: "2026-10-30T12:00:00.000Z",
    }]);
    const patterns = parseReviewPatterns((await kv.get(REVIEW_PATTERNS_KEY)) as string);
    expect(patterns?.relations["deterministic-gates"]).toEqual([
      { kind: "graph", owner: "acme", repo: "things", slug: "flow" },
    ]);
    expect(patterns?.relations["adversarial-review"]).toEqual([]);
  });

  it("stores no patterns for nodes, whatever the model named", async () => {
    const kv = new FakeKV();
    const entries = [entry("node", "acme", "things", "cool-node", "2026-10-29")];
    const document = { format_version: 1, name: "cool-node", kind: "agent", config: {}, description: "d" };
    await seed(kv, entries, { [docKey("node", "acme", "things", "cool-node")]: document });
    const provider = mockProvider(() => ({
      verdict: "flagged",
      reasons: "suspicious",
      patterns: ["deterministic-gates"],
    }));
    await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    const stored = parseStoredReview((await kv.get(reviewKey("node", "acme", "things", "cool-node"))) as string);
    expect(stored?.verdict).toBe("flagged");
    expect(stored?.patterns).toEqual([]);
    const patterns = parseReviewPatterns((await kv.get(REVIEW_PATTERNS_KEY)) as string);
    expect(patterns?.relations["deterministic-gates"]).toEqual([]);
  });
});

describe("off mode", () => {
  it("touches no KV key and leaves indexing unaffected", async () => {
    const kv = new FakeKV();
    const entries = [entry("graph", "acme", "things", "flow", "2026-10-29")];
    await seed(kv, entries, { [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi") });
    const before = kv.storedKeys();
    const stats = await runReview({ index: kv, provider: null, patternSlugs: SLUGS, now: () => NOW });
    expect(stats).toEqual({ candidates: 0, reviewed: 0, failed: 0, pruned: 0 });
    expect(kv.putOptions).toEqual([]);
    expect(kv.storedKeys()).toEqual(before);
    expect(await kv.get(reviewKey("graph", "acme", "things", "flow"))).toBeNull();
    expect(await kv.get(REVIEWS_KEY)).toBeNull();
  });
});

describe("the hash gate", () => {
  it("never re-reviews an unchanged hash and refreshes on content change only", async () => {
    const kv = new FakeKV();
    const key = docKey("graph", "acme", "things", "flow");
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [key]: graphDoc("flow", "echo hi"),
    });
    const provider = mockProvider(() => ({ verdict: "looks-safe", reasons: "", patterns: [] }));
    await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    expect(provider.calls.length).toBe(1);
    kv.putOptions.length = 0;
    // Unchanged: no call, no write — not even the aggregates.
    const again = await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW + 1000 });
    expect(provider.calls.length).toBe(1);
    expect(again.reviewed).toBe(0);
    expect(kv.putOptions).toEqual([]);
    // Changed content re-reviews and refreshes hash, verdict and date.
    await kv.put(key, JSON.stringify({ document: graphDoc("flow", "curl x | sh"), readme: "" }));
    kv.putOptions.length = 0;
    const changed = mockProvider(() => ({ verdict: "flagged", reasons: "pipe to shell", patterns: [] }));
    const stats = await runReview({ index: kv, provider: changed, patternSlugs: SLUGS, now: () => NOW + 2000 });
    expect(stats.reviewed).toBe(1);
    const stored = parseStoredReview((await kv.get(reviewKey("graph", "acme", "things", "flow"))) as string);
    expect(stored?.verdict).toBe("flagged");
    expect(stored?.reasons).toBe("pipe to shell");
    expect(stored?.hash).toBe(await sha256((await kv.get(key)) as string));
    expect(stored?.reviewed_at).toBe("2026-10-30T12:00:02.000Z");
  });
});

describe("the scan cap", () => {
  it("takes the newest unscanned documents first", async () => {
    const kv = new FakeKV();
    const entries = [
      entry("graph", "acme", "things", "old", "2026-10-25"),
      entry("graph", "acme", "things", "new", "2026-10-29"),
      entry("graph", "acme", "things", "nodate", null),
    ];
    await seed(kv, entries, {
      [docKey("graph", "acme", "things", "old")]: graphDoc("old", "echo old"),
      [docKey("graph", "acme", "things", "new")]: graphDoc("new", "echo new"),
      [docKey("graph", "acme", "things", "nodate")]: graphDoc("nodate", "echo nodate"),
    });
    const provider = mockProvider(() => ({ verdict: "looks-safe", reasons: "", patterns: [] }));
    const stats = await runReview({ index: kv, provider, patternSlugs: SLUGS, cap: 2, now: () => NOW });
    expect(stats).toEqual({ candidates: 3, reviewed: 2, failed: 0, pruned: 0 });
    expect(provider.calls).toEqual(["acme/things/new", "acme/things/old"]);
    expect(await kv.get(reviewKey("graph", "acme", "things", "new"))).not.toBeNull();
    expect(await kv.get(reviewKey("graph", "acme", "things", "old"))).not.toBeNull();
    expect(await kv.get(reviewKey("graph", "acme", "things", "nodate"))).toBeNull();
    // The next run picks up the remainder.
    await runReview({ index: kv, provider, patternSlugs: SLUGS, cap: 5, now: () => NOW });
    expect(provider.calls).toEqual(["acme/things/new", "acme/things/old", "acme/things/nodate"]);
  });

  it("defaults to five when no cap is configured", async () => {
    expect(REVIEW_DEFAULT_CAP).toBe(5);
  });
});

describe("failure", () => {
  it("leaves failed documents unreviewed without touching the index path", async () => {
    const kv = new FakeKV();
    const entries = [
      entry("graph", "acme", "things", "good", "2026-10-29"),
      entry("graph", "acme", "things", "bad", "2026-10-28"),
    ];
    await seed(kv, entries, {
      [docKey("graph", "acme", "things", "good")]: graphDoc("good", "echo hi"),
      [docKey("graph", "acme", "things", "bad")]: graphDoc("bad", "echo hi"),
    });
    const indexBefore = await kv.get("index:v1");
    const provider: ReviewProvider = {
      model: MODEL,
      review(document: ReviewDocument): Promise<ReviewResult> {
        return document.slug === "bad"
          ? Promise.reject(new Error("credits exhausted"))
          : Promise.resolve({ verdict: "looks-safe", reasons: "", patterns: [] });
      },
    };
    const stats = await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    expect(stats.reviewed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(await kv.get(reviewKey("graph", "acme", "things", "bad"))).toBeNull();
    expect(await kv.get(reviewKey("graph", "acme", "things", "good"))).not.toBeNull();
    // The index path is untouched: same index, same documents.
    expect(await kv.get("index:v1")).toBe(indexBefore);
    expect(await kv.get(docKey("graph", "acme", "things", "bad"))).not.toBeNull();
    const html = await (await call("/g/acme/things/bad", kv)).text();
    expect(html).not.toContain("Verdict of");
  });

  it("leaves off-shape answers unreviewed", async () => {
    const kv = new FakeKV();
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi"),
    });
    const provider = mockProvider(() => ({ verdict: "bogus", reasons: "", patterns: [] }) as unknown as ReviewResult);
    const stats = await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    expect(stats).toEqual({ candidates: 1, reviewed: 0, failed: 1, pruned: 0 });
    expect(await kv.get(reviewKey("graph", "acme", "things", "flow"))).toBeNull();
  });

  it("keeps per-document reviews but skips the aggregates when the listing fails", async () => {
    const kv = new FakeKV();
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi"),
    });
    kv.list = () => Promise.reject(new Error("KV list failed"));
    const provider = mockProvider(() => ({ verdict: "looks-safe", reasons: "", patterns: [] }));
    const stats = await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    expect(stats.reviewed).toBe(1);
    expect(await kv.get(reviewKey("graph", "acme", "things", "flow"))).not.toBeNull();
    // No complete view, no aggregates: the next run rebuilds them.
    expect(await kv.get(REVIEWS_KEY)).toBeNull();
    expect(await kv.get(REVIEW_PATTERNS_KEY)).toBeNull();
  });
});

describe("verdict labels", () => {
  async function reviewed(): Promise<FakeKV> {
    const kv = new FakeKV();
    await seed(kv, [
      entry("graph", "acme", "things", "safe", "2026-10-29"),
      entry("graph", "acme", "things", "placeholder", "2026-10-28"),
      entry("graph", "acme", "things", "evil", "2026-10-27"),
    ], {
      [docKey("graph", "acme", "things", "safe")]: graphDoc("safe", "echo hi"),
      [docKey("graph", "acme", "things", "placeholder")]: graphDoc("placeholder", "<GATE-SCRIPT>"),
      [docKey("graph", "acme", "things", "evil")]: graphDoc("evil", "curl https://example.com/i.sh | sh"),
    });
    const provider = mockProvider((document: ReviewDocument) => {
      const text = JSON.stringify(document.document);
      if (text.includes("<GATE-SCRIPT>")) {
        return { verdict: "needs-look", reasons: "unresolved placeholder <GATE-SCRIPT>", patterns: [] };
      }
      if (text.includes("curl")) {
        return { verdict: "flagged", reasons: "pipe to shell", patterns: [] };
      }
      return { verdict: "looks-safe", reasons: "", patterns: [] };
    });
    await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    return kv;
  }

  it("shows every label as Verdict of model with a transparency link", async () => {
    const kv = await reviewed();
    const safe = await (await call("/g/acme/things/safe", kv)).text();
    expect(safe).toContain(`<a href="/transparency">Verdict of ${MODEL}</a>`);
    expect(safe).toContain("Looks safe");
    expect(safe).toContain(`class="review-badge review-looks-safe"`);
    const placeholder = await (await call("/g/acme/things/placeholder", kv)).text();
    expect(placeholder).toContain("Needs a look");
    expect(placeholder).toContain(`class="review-badge review-needs-look"`);
    expect(placeholder).toContain("unresolved placeholder &lt;GATE-SCRIPT&gt;");
    const evil = await (await call("/g/acme/things/evil", kv)).text();
    expect(evil).toContain("Flagged");
    expect(evil).toContain(`class="review-badge review-flagged"`);
    expect(evil).toContain("pipe to shell");
    const twin = await (await call("/g/acme/things/evil", kv, "text/markdown")).text();
    expect(twin).toContain(`Verdict of ${MODEL}: Flagged (/transparency)`);
    expect(twin).toContain("pipe to shell");
  });

  it("shows no badge for unreviewed documents", async () => {
    const kv = new FakeKV();
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi"),
    });
    const html = await (await call("/g/acme/things/flow", kv)).text();
    expect(html).not.toContain("Verdict of");
    expect(html).not.toContain(`class="review-badge`);
    const twin = await (await call("/g/acme/things/flow", kv, "text/markdown")).text();
    expect(twin).not.toContain("Verdict of");
  });
});

describe("stored pattern relations", () => {
  it("links graphs from stored relations, replacing the static graph links", async () => {
    const kv = new FakeKV();
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi"),
    });
    const provider = mockProvider(() => ({
      verdict: "looks-safe",
      reasons: "",
      patterns: ["deterministic-gates"],
    }));
    await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    const html = await (await call("/patterns/deterministic-gates", kv)).text();
    // The reviewed community graph renders as a catalogue row with its plate.
    expect(html).toContain(`<a class="row-name" href="/g/acme/things/flow">flow</a>`);
    expect(html).toContain(`<code>canopy graph install acme/things/flow</code>`);
    // The statically authored graph links are replaced: no static graph row.
    expect(html).not.toContain(`<a class="row-name" href="/g/canopy-builder">`);
    expect(html).not.toContain(`<a class="row-name" href="/g/adversarial-developer">`);
    expect(html).not.toContain(`<span class="row-name">graph:canopy-builder</span>`);
    // The static node refs stay: reviews carry none for nodes.
    expect(html).toContain(`<span class="row-name">node:full-gates-cargo</span>`);
    expect(html).toContain(PATTERN_MISSING_REF);
    // The document links back to its stored patterns.
    const doc = await (await call("/g/acme/things/flow", kv)).text();
    expect(doc).toContain(`<a href="/patterns/deterministic-gates">`);
    const twin = await (await call("/patterns/deterministic-gates", kv, "text/markdown")).text();
    expect(twin).toContain(`[flow](/g/acme/things/flow)`);
  });

  it("keeps the static links before the first review landed", async () => {
    const kv = new FakeKV();
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi"),
    });
    const html = await (await call("/patterns/deterministic-gates", kv)).text();
    expect(html).toContain(`<span class="row-name">graph:canopy-builder</span>`);
  });

  it("keeps the static graph links for a pattern the last review never saw", async () => {
    const kv = new FakeKV();
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi"),
    });
    // Reviewed when the bundled list held another slug only: the relations
    // aggregate exists but carries no key for deterministic-gates.
    const provider = mockProvider(() => ({
      verdict: "looks-safe",
      reasons: "",
      patterns: ["other-pattern"],
    }));
    await runReview({ index: kv, provider, patternSlugs: ["other-pattern"], now: () => NOW });
    const html = await (await call("/patterns/deterministic-gates", kv)).text();
    expect(html).toContain(`<span class="row-name">graph:canopy-builder</span>`);
  });
});

describe("the transparency page", () => {
  it("explains the index, shows the prompt and the diagram, and lists verdicts", async () => {
    const kv = new FakeKV();
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi"),
    });
    const provider = mockProvider(() => ({ verdict: "looks-safe", reasons: "", patterns: [] }));
    await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    const response = await call("/transparency", kv);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(TRANSPARENCY_TITLE);
    expect(html).toContain("every 15 minutes");
    expect(html).toContain("canopy-graph");
    expect(html).toContain("never blocks them");
    expect(html).toContain("<svg");
    expect(html).toContain("Cron */15");
    expect(html).toContain("review newest unscanned docs");
    // The exact prompt, verbatim.
    expect(html).toContain("&lt;review_prompt");
    expect(html).toContain("{{COMMANDS}}");
    expect(html).toContain(`Version ${REVIEW_PROMPT_VERSION}`);
    // Each verdict with its hash and date.
    const review = parseStoredReview((await kv.get(reviewKey("graph", "acme", "things", "flow"))) as string);
    expect(html).toContain(`<a class="row-name" href="/g/acme/things/flow">flow</a>`);
    expect(html).toContain(`Verdict of ${MODEL} · Looks safe`);
    expect(html).toContain(`hash: ${review?.hash}`);
    expect(html).toContain(`reviewed: ${review?.reviewed_at}`);
    const twin = await (await call("/transparency", kv, "text/markdown")).text();
    expect(twin).toContain("```mermaid");
    expect(twin).toContain("sequenceDiagram");
    expect(twin).toContain("```xml");
    expect(twin).toContain("<review_prompt");
    expect(twin).not.toContain("<svg");
  });

  it("answers 200 with an empty verdict list on a cold KV", async () => {
    resetIndexMemo();
    const response = await call("/transparency", new FakeKV());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(TRANSPARENCY_NO_VERDICTS);
  });

  it("is linked from the header nav and the colophon", async () => {
    resetIndexMemo();
    const html = await (await call("/transparency", new FakeKV())).text();
    const header = html.slice(html.indexOf(`<header class="site-header">`), html.indexOf(`</header>`));
    expect(header).toMatch(/<a href="\/transparency" aria-label="Transparency" title="Transparency"><svg[\s\S]*?<\/svg><span>Transparency<\/span><\/a>/);
    const footer = html.slice(html.indexOf(`<footer class="look-colophon">`), html.indexOf(`</footer>`));
    expect(footer).toContain(`<a href="/transparency">Transparency</a>`);
  });
});

describe("the bundled review assets", () => {
  it("versions the prompt in XML with the install-review facts", () => {
    expect(REVIEW_PROMPT_VERSION).toBe("v1");
    expect(REVIEW_PROMPT_V1).toContain(`<review_prompt version="v1">`);
    expect(REVIEW_PROMPT_V1).toContain("{{PATTERNS}}");
    expect(REVIEW_PROMPT_V1).toContain("{{COMMANDS}}");
    expect(REVIEW_PROMPT_V1).toContain("{{PROMPTS}}");
    expect(REVIEW_PROMPT_V1).toContain("{{ATTENTION}}");
    expect(REVIEW_PROMPT_V1).toContain("looks-safe");
    expect(REVIEW_PROMPT_V1).toContain("needs-look");
    expect(REVIEW_PROMPT_V1).toContain("flagged");
    expect(REVIEW_PROMPT_V1).toContain("&lt;GATE-SCRIPT&gt;");
    expect(REVIEW_PROMPT_V1).toContain("never");
  });

  it("pre-renders the sequence diagram to static SVG", () => {
    expect(INDEXING_MMD).toContain("sequenceDiagram");
    for (const participant of ["Cron", "Worker", "GitHub", "KV", "Muse", "Browser"]) {
      expect(INDEXING_MMD).toContain(participant);
    }
    for (const message of [
      "scheduled trigger",
      "discover topic",
      "validate graph and node JSON",
      "write index, docs, meta",
      "review newest unscanned docs",
      "write reviews and pattern links",
    ]) {
      expect(INDEXING_MMD).toContain(message);
    }
    expect(INDEXING_SVG).toContain("<svg");
    expect(INDEXING_SVG).toContain("Cron */15");
    expect(INDEXING_SVG).toContain("review newest unscanned docs");
    expect(INDEXING_SVG).not.toContain("mermaid");
  });
});

describe("the Muse provider", () => {
  const DOCUMENT: ReviewDocument = {
    kind: "graph",
    owner: "acme",
    repo: "things",
    slug: "flow",
    name: "flow",
    document: graphDoc("flow", "echo hi") as unknown as JsonValue,
  };

  function claudeStub(text: string, status = 200) {
    return fakeFetch([{
      url: "api.anthropic.com/v1/messages",
      status,
      body: { content: [{ type: "text", text }] },
    }]);
  }

  it("fills the prompt with facts and parses the verdict JSON", async () => {
    const fake = claudeStub(JSON.stringify({
      verdict: "looks-safe",
      reasons: "",
      patterns: ["deterministic-gates", "unknown-slug"],
    }));
    const provider = createClaudeProvider({
      apiKey: "secret",
      model: "claude-test",
      patternSlugs: SLUGS,
      fetchImpl: fake.fetchImpl,
    });
    expect(provider.model).toBe("claude-test");
    const result = await provider.review(DOCUMENT);
    expect(result).toEqual({ verdict: "looks-safe", reasons: "", patterns: ["deterministic-gates"] });
    expect(fake.calls).toHaveLength(1);
    const sent = JSON.parse(fake.bodies[0] ?? "{}") as { model: string; messages: Array<{ content: string }> };
    expect(sent.model).toBe("claude-test");
    expect(sent.messages[0]?.content).toContain("echo hi");
    expect(sent.messages[0]?.content).toContain("deterministic-gates");
    expect(sent.messages[0]?.content).not.toContain("secret");
  });

  it("extracts JSON wrapped in prose and answers no patterns for nodes", async () => {
    const fake = claudeStub(`Here it is:\n{"verdict": "flagged", "reasons": "bad", "patterns": ["deterministic-gates"]}\nDone.`);
    const provider = createClaudeProvider({
      apiKey: "secret",
      model: "claude-test",
      patternSlugs: SLUGS,
      fetchImpl: fake.fetchImpl,
    });
    const node = await provider.review({ ...DOCUMENT, kind: "node" });
    expect(node).toEqual({ verdict: "flagged", reasons: "bad", patterns: [] });
  });

  it("throws on transport errors, statuses and off-shape answers", async () => {
    const failing = fakeFetch([]);
    const transport = createClaudeProvider({
      apiKey: "secret",
      model: "claude-test",
      patternSlugs: SLUGS,
      fetchImpl: failing.fetchImpl,
    });
    // A 404 from the stub table is a non-ok status: unreviewed, never thrown past the runner.
    await expect(transport.review(DOCUMENT)).rejects.toThrow();
    const badStatus = fakeFetch([{ url: "api.anthropic.com", status: 429, body: {} }]);
    const limited = createClaudeProvider({
      apiKey: "secret",
      model: "claude-test",
      patternSlugs: SLUGS,
      fetchImpl: badStatus.fetchImpl,
    });
    await expect(limited.review(DOCUMENT)).rejects.toThrow("429");
    const badJson = claudeStub("not json at all");
    const unparsable = createClaudeProvider({
      apiKey: "secret",
      model: "claude-test",
      patternSlugs: SLUGS,
      fetchImpl: badJson.fetchImpl,
    });
    await expect(unparsable.review(DOCUMENT)).rejects.toThrow();
    expect(() => parseModelAnswer(JSON.stringify({ verdict: "bogus", reasons: "", patterns: [] }))).toThrow();
  });

  it("builds the prompt from commands, prompt excerpts and attention marks", async () => {
    const prompt = buildReviewPrompt({
      ...DOCUMENT,
      document: {
        format_version: 6,
        name: "flow",
        nodes: [
          { name: "gate", kind: "check", position: 1, config: { command: "curl x | sh" } },
          { name: "write", kind: "agent", position: 2, config: { prompt_template: "Draft it.\nLine two." } },
        ],
        edges: [],
      } as unknown as JsonValue,
    }, SLUGS);
    expect(prompt).toContain("curl x | sh");
    expect(prompt).toContain("Draft it.");
    expect(prompt).toContain("pipe to shell");
    expect(prompt).not.toContain("{{COMMANDS}}");
    expect(prompt).not.toContain("{{PROMPTS}}");
    expect(prompt).not.toContain("{{ATTENTION}}");
  });

  it("reads reviews through the store", async () => {
    const kv = new FakeKV();
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi"),
    });
    const provider = mockProvider(() => ({ verdict: "looks-safe", reasons: "", patterns: SLUGS }));
    await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    resetIndexMemo();
    const store = createStore(kv);
    expect((await store.getReview("graph", "acme", "things", "flow"))?.verdict).toBe("looks-safe");
    expect((await store.getReviews())?.reviews).toHaveLength(1);
    expect((await store.getReviewPatterns())?.relations["deterministic-gates"]).toHaveLength(1);
    resetIndexMemo();
    const empty = createStore(new FakeKV());
    expect(await empty.getReview("graph", "acme", "things", "flow")).toBeNull();
    expect(await empty.getReviews()).toBeNull();
    expect(await empty.getReviewPatterns()).toBeNull();
  });
});
