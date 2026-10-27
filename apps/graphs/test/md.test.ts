// SPDX-License-Identifier: Apache-2.0
/**
 * The README markdown renderer's lists: ordered and unordered markers, one
 * nested level by two-space indent, the inline pieces an item carries, the
 * sanitizer's reach inside a list, and the quality-bubble README — a real
 * document with both kinds of list — as a snapshot.
 */
import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "../src/pages/md.js";
import { QUALITY_BUBBLE_README } from "./md-fixture.js";

describe("lists", () => {
  it("renders an ordered list, one li per item", () => {
    expect(renderMarkdown("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
  });

  it("renders an unordered list with either marker", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("* a\n* b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("nests a list one level by two-space indent, inside the parent li", () => {
    expect(renderMarkdown("- outer\n  - inner")).toBe(
      "<ul><li>outer<ul><li>inner</li></ul></li></ul>",
    );
    expect(renderMarkdown("1. one\n  - sub")).toBe(
      "<ol><li>one<ul><li>sub</li></ul></li></ol>",
    );
  });

  it("closes the list when the marker changes", () => {
    expect(renderMarkdown("- a\n1. b")).toBe("<ul><li>a</li></ul>\n<ol><li>b</li></ol>");
  });

  it("keeps inline code and links working inside an item", () => {
    expect(
      renderMarkdown("1. run `npm test`\n2. read the [docs](https://example.com/docs)"),
    ).toBe(
      '<ol><li>run <code>npm test</code></li>' +
        '<li>read the <a href="https://example.com/docs" rel="nofollow">docs</a></li></ol>',
    );
  });

  it("starts a new list after the paragraph in front of it", () => {
    expect(renderMarkdown("Intro text.\n\n- after the blank")).toBe(
      "<p>Intro text.</p>\n<ul><li>after the blank</li></ul>",
    );
  });
});

describe("lists among the other blocks", () => {
  it("joins a heading, a paragraph, a list and a fence in order", () => {
    const markdown = [
      "## Install",
      "",
      "Run `npm test` and read the [docs](https://example.com/docs).",
      "",
      "1. first step",
      "2. second step",
      "",
      "```sh",
      "canopy graph install quality-bubble",
      "```",
      "",
    ].join("\n");
    expect(renderMarkdown(markdown)).toBe(
      [
        "<h2>Install</h2>",
        '<p>Run <code>npm test</code> and read the <a href="https://example.com/docs" rel="nofollow">docs</a>.</p>',
        "<ol><li>first step</li><li>second step</li></ol>",
        "<pre><code>canopy graph install quality-bubble</code></pre>",
      ].join("\n"),
    );
  });

  it("lets a fence interrupt an open list", () => {
    expect(renderMarkdown("1. one\n```\ncode\n```")).toBe(
      "<ol><li>one</li></ol>\n<pre><code>code</code></pre>",
    );
  });

  it("keeps a marker with no text after it a plain paragraph", () => {
    expect(renderMarkdown("- ")).toBe("<p>- </p>");
  });
});

describe("the sanitizer inside a list", () => {
  it("escapes raw HTML in an item", () => {
    expect(renderMarkdown("- <b>x</b>")).toBe("<ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul>");
  });

  it("degrades an unsafe link target to its label text", () => {
    expect(renderMarkdown("- [bad](javascript:doEvil)")).toBe("<ul><li>bad</li></ul>");
  });

  it("escapes the HTML metacharacters", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("a real README", () => {
  const html = renderMarkdown(QUALITY_BUBBLE_README);

  it("carries both kinds of list and the fenced install block", () => {
    expect(html).toContain("<ol><li><code>implementer</code> (agent)");
    expect(html).toContain("<ul><li>Harness:");
    expect(html).toContain("<pre><code>canopy graph install quality-bubble</code></pre>");
    expect(html).not.toContain("<p>1. ");
    expect(html).not.toContain("<p>- ");
  });

  it("renders the quality-bubble README as it reads on the site", () => {
    expect(html).toMatchSnapshot();
  });
});
