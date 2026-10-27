// SPDX-License-Identifier: Apache-2.0
/**
 * A minimal markdown renderer for READMEs, safe by construction.
 *
 * Supported: headings, paragraphs, fenced code blocks, links and inline
 * code — nothing else. Everything the renderer does not recognise is
 * escaped, so HTML in a README never passes through as HTML; the only tags
 * in the output are the ones this file emits. Links carry `rel="nofollow"`
 * and only http(s), relative and anchor targets survive; anything else
 * renders as its text. No dependency: this is the whole sanitizer.
 */

/** Escape text for HTML content and attribute values alike. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Only these link targets become anchors; the rest degrade to text. */
const SAFE_URL = /^(?:https?:\/\/|\/|#|\.\.?\/)/i;

/** Inline pieces this renderer understands, scanned left to right. */
const INLINE_RE = /(`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;

function renderInline(raw: string): string {
  let html = "";
  let cursor = 0;
  for (const match of raw.matchAll(INLINE_RE)) {
    const piece = match[0];
    const start = match.index ?? 0;
    html += escapeHtml(raw.slice(cursor, start));
    cursor = start + piece.length;
    if (piece.startsWith("`")) {
      html += `<code>${escapeHtml(piece.slice(1, -1))}</code>`;
      continue;
    }
    const close = piece.indexOf("](");
    const label = piece.slice(1, close);
    const target = piece.slice(close + 2, -1);
    if (SAFE_URL.test(target)) {
      html += `<a href="${escapeHtml(target)}" rel="nofollow">${renderInline(label)}</a>`;
    } else {
      html += renderInline(label);
    }
  }
  return html + escapeHtml(raw.slice(cursor));
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```/;

/** Render markdown to escaped, sanitized HTML. Never throws. */
export function renderMarkdown(markdown: string): string {
  const blocks: string[] = [];
  const paragraphs: string[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let index = 0;

  const flushParagraph = (): void => {
    if (paragraphs.length > 0) {
      blocks.push(`<p>${renderInline(paragraphs.join("\n"))}</p>`);
      paragraphs.length = 0;
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (FENCE_RE.test(line.trim())) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_RE.test((lines[index] ?? "").trim())) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      flushParagraph();
      const level = heading[1]?.length ?? 1;
      blocks.push(`<h${level}>${renderInline((heading[2] ?? "").trim())}</h${level}>`);
      index += 1;
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }
    paragraphs.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks.join("\n");
}
