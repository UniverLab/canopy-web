// SPDX-License-Identifier: Apache-2.0
/**
 * The verdict pages after the audit detail moved onto each document:
 * the transparency page keeps a summary and the 10 newest verdicts, and
 * every document's own page carries its hash and date. Tests seed a fresh
 * in-memory KV with an index, documents, per-document reviews and the
 * `reviews:v1` aggregate directly — no GitHub — then render the pages.
 */
import { describe, expect, it } from "vitest";
import type { DocumentKind } from "../../../src/schema.js";
import { handlePage, NOT_PAGE } from "../src/pages/routes.js";
import { TRANSPARENCY_NO_VERDICTS } from "../src/pages/copy.js";
import { REVIEWS_KEY, reviewKey, type Verdict } from "../src/review.js";
import { docKey, resetIndexMemo } from "../src/store.js";
import { FakeCache, FakeKV, fakeFetch } from "./fakes.js";

const ORIGIN = "https://graphs.univerlab.org";

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

interface Row {
  slug: string;
  verdict: Verdict;
  reviewed_at: string;
}

/** One stored review body, with its own short hash. */
function reviewBody(row: Row, n: number): Record<string, unknown> {
  return {
    verdict: row.verdict,
    reasons: "",
    patterns: [],
    hash: `h${n}`,
    prompt: "v2",
    model: "mock-model",
    reviewed_at: row.reviewed_at,
  };
}

/** Seed the index, documents, one `review:v1:*` per row and the aggregate. */
async function seedReviews(kv: FakeKV, rows: Row[]): Promise<void> {
  await seed(
    kv,
    rows.map((row) => entry("graph", "acme", "things", row.slug, "2026-10-29")),
    Object.fromEntries(
      rows.map((row) => [docKey("graph", "acme", "things", row.slug), graphDoc(row.slug, "echo hi")]),
    ),
  );
  for (const [index, row] of rows.entries()) {
    await kv.put(reviewKey("graph", "acme", "things", row.slug), JSON.stringify(reviewBody(row, index + 1)));
  }
  await kv.put(REVIEWS_KEY, JSON.stringify({
    built_at: "2026-10-30T00:00:00.000Z",
    reviews: rows.map((row, index) => ({
      kind: "graph",
      owner: "acme",
      repo: "things",
      slug: row.slug,
      ...reviewBody(row, index + 1),
    })),
  }));
}

/** 12 rows, one per day: 5 safe, 4 to look at, 3 flagged, oldest first. */
const TWELVE: Row[] = Array.from({ length: 12 }, (_, i) => {
  const day = i + 1;
  const verdict: Verdict = day <= 5 ? "looks-safe" : day <= 9 ? "needs-look" : "flagged";
  return {
    slug: `doc-${String(day).padStart(2, "0")}`,
    verdict,
    reviewed_at: `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`,
  };
});

/** The row-name links inside the verdict list, in render order. */
function listLinks(html: string): Array<{ href: string; name: string }> {
  const start = html.indexOf(`<ol class="verdict-list">`);
  const end = html.indexOf("</ol>", start);
  const list = start === -1 ? "" : html.slice(start, end);
  return [...list.matchAll(/<a class="row-name" href="([^"]+)">([^<]+)<\/a>/g)]
    .map((match) => ({ href: match[1] as string, name: match[2] as string }));
}

describe("the transparency verdict list", () => {
  it("caps the list at 10 newest rows while the summary counts every review", async () => {
    const kv = new FakeKV();
    await seedReviews(kv, TWELVE);
    const html = await (await call("/transparency", kv)).text();
    expect(html).toContain("12 documents reviewed — Looks safe 5, Needs a look 4, Flagged 3.");
    const links = listLinks(html);
    expect(links).toHaveLength(10);
    expect(links.map((link) => link.name)).toEqual([
      "doc-12", "doc-11", "doc-10", "doc-09", "doc-08",
      "doc-07", "doc-06", "doc-05", "doc-04", "doc-03",
    ]);
    expect(links[0]?.href).toBe("/g/acme/things/doc-12");
    expect(links[9]?.href).toBe("/g/acme/things/doc-03");
    const start = html.indexOf(`<ol class="verdict-list">`);
    const list = html.slice(start, html.indexOf("</ol>", start));
    expect(list).not.toContain("doc-01");
    expect(list).not.toContain("doc-02");
    expect(html).toContain(`<a href="/">browse the catalogue</a>`);
    expect(html).toContain("Every document's own page carries its verdict, with its hash and date");
    expect(html).not.toContain("every verdict");
  });

  it("mirrors the summary, the newest rows and the pointer in the twin", async () => {
    const kv = new FakeKV();
    await seedReviews(kv, TWELVE);
    const twin = await (await call("/transparency", kv, "text/markdown")).text();
    expect(twin).toContain("12 documents reviewed — Looks safe 5, Needs a look 4, Flagged 3.");
    const rows = twin.split("\n").filter((line) => line.startsWith("- [doc-"));
    expect(rows).toHaveLength(10);
    expect(rows[0]?.startsWith("- [doc-12](/g/acme/things/doc-12)")).toBe(true);
    expect(twin).not.toContain("doc-01");
    expect(twin).not.toContain("doc-02");
    expect(twin).toContain("Every document's own page carries its verdict, with its hash and date: [browse the catalogue](/)");
    expect(twin).not.toContain("every verdict");
  });

  it("renders every row of a short list, newest first", async () => {
    const kv = new FakeKV();
    await seedReviews(kv, [
      { slug: "safe", verdict: "looks-safe", reviewed_at: "2026-10-01T12:00:00.000Z" },
      { slug: "wary", verdict: "needs-look", reviewed_at: "2026-10-02T12:00:00.000Z" },
      { slug: "evil", verdict: "flagged", reviewed_at: "2026-10-03T12:00:00.000Z" },
    ]);
    const html = await (await call("/transparency", kv)).text();
    expect(html).toContain("3 documents reviewed — Looks safe 1, Needs a look 1, Flagged 1.");
    const links = listLinks(html);
    expect(links.map((link) => link.name)).toEqual(["evil", "wary", "safe"]);
    for (const link of links) {
      expect(link.href).toBe(`/g/acme/things/${link.name}`);
    }
    const twin = await (await call("/transparency", kv, "text/markdown")).text();
    expect(twin).toContain("3 documents reviewed — Looks safe 1, Needs a look 1, Flagged 1.");
    expect(twin.split("\n").filter((line) => line.startsWith("- [")).length).toBeGreaterThanOrEqual(3);
    expect(twin).toContain("- [evil](/g/acme/things/evil)");
  });

  it("keeps the empty line and shows no list when nothing is reviewed", async () => {
    const kv = new FakeKV();
    await seedReviews(kv, []);
    const html = await (await call("/transparency", kv)).text();
    expect(html).toContain(TRANSPARENCY_NO_VERDICTS);
    expect(html).not.toContain(`<ol class="verdict-list">`);
    expect(html).not.toContain("documents reviewed —");
    expect(html).not.toContain("browse the catalogue");
    const twin = await (await call("/transparency", kv, "text/markdown")).text();
    expect(twin).toContain(TRANSPARENCY_NO_VERDICTS);
    expect(twin).not.toContain("documents reviewed —");
    expect(twin).not.toContain("browse the catalogue");
  });
});

describe("the document datasheet verdict", () => {
  it("shows the reviewed hash and date in both the HTML and the twin", async () => {
    const kv = new FakeKV();
    await seedReviews(kv, TWELVE);
    const html = await (await call("/g/acme/things/doc-01", kv)).text();
    const reviewAt = html.indexOf("<dt>Review</dt>");
    expect(reviewAt).toBeGreaterThan(-1);
    const dd = html.slice(reviewAt, html.indexOf("</dd>", reviewAt));
    expect(dd).toContain("hash: h1 · reviewed: 2026-10-01T12:00:00.000Z");
    const twin = await (await call("/g/acme/things/doc-01", kv, "text/markdown")).text();
    const line = twin.split("\n").find((candidate) => candidate.startsWith("- Review:"));
    expect(line).toBeDefined();
    expect(line).toContain("— hash: h1 · reviewed: 2026-10-01T12:00:00.000Z");
  });

  it("shows neither hash nor date on an unreviewed document", async () => {
    const kv = new FakeKV();
    await seed(
      kv,
      [entry("graph", "acme", "things", "unreviewed", "2026-10-29")],
      { [docKey("graph", "acme", "things", "unreviewed")]: graphDoc("unreviewed", "echo hi") },
    );
    const html = await (await call("/g/acme/things/unreviewed", kv)).text();
    expect(html).not.toContain("<dt>Review</dt>");
    expect(html).not.toContain("hash:");
    const twin = await (await call("/g/acme/things/unreviewed", kv, "text/markdown")).text();
    expect(twin).not.toContain("- Review:");
    expect(twin).not.toContain("hash:");
  });
});
