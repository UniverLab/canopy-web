// SPDX-License-Identifier: Apache-2.0
/**
 * A minimal markdown renderer for READMEs, safe by construction.
 *
 * Supported: headings, lists, paragraphs, fenced code blocks, links,
 * inline code and `**strong**`/`__strong__`/`*em*`/`_em_` emphasis —
 * nothing else. Intraword underscores stay literal and code spans are never
 * emphasized. Everything the renderer does not recognise is
 * escaped, so HTML in a README never passes through as HTML; the only tags
 * in the output are the ones this file emits. Links carry `rel="nofollow"`
 * and only http(s), relative and anchor targets survive; anything else
 * renders as its text. Lists are ordered ("1. ") or unordered ("- ", "* ")
 * and nest one level by two-space indent, the child list living inside its
 * parent <li>. No dependency: this is the whole sanitizer.
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

/**
 * Inline emphasis, applied to already-escaped text (so `*` and `_` are still
 * literal while `<`, `>` and `&` are entities). Strong first, then emphasis;
 * `*` pairs anywhere with a non-empty run, while `_` pairs only at word
 * boundaries — an underscore with a word character on its outer side stays
 * literal, so `snake_case_name` never emphasizes. Code spans never reach
 * here: the inline scanner pulls them out before this runs. No run may
 * contain a tag bracket, so an emphasis pair can never span the `<strong>`
 * tags the first pass emitted (mixed markers like `**a _b** c_` stay
 * literal instead of nesting invalidly).
 */
function renderEmphasis(escaped: string): string {
  const strong = escaped
    .replace(/\*\*([^*<\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![A-Za-z0-9_])__([^_<\n]+?)__(?![A-Za-z0-9_])/g, "<strong>$1</strong>");
  return strong
    .replace(/\*([^*<\n]+?)\*/g, "<em>$1</em>")
    .replace(/(?<![A-Za-z0-9_])_([^_<\n]+?)_(?![A-Za-z0-9_])/g, "<em>$1</em>");
}

function renderInline(raw: string): string {
  let html = "";
  let cursor = 0;
  for (const match of raw.matchAll(INLINE_RE)) {
    const piece = match[0];
    const start = match.index ?? 0;
    html += renderEmphasis(escapeHtml(raw.slice(cursor, start)));
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
  return html + renderEmphasis(escapeHtml(raw.slice(cursor)));
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```/;

/**
 * List lines, indent measured in leading spaces only (a tab makes a line
 * plain text) and the text non-empty ("- " with nothing after stays a
 * paragraph).
 */
const ORDERED_RE = /^( *)\d+\.\s+(\S.*)$/;
const UNORDERED_RE = /^( *)[-*]\s+(\S.*)$/;

/** One list line this renderer recognised. */
interface ListLine {
  indent: number;
  ordered: boolean;
  text: string;
}

/** One item: its text plus, one indent level down, its own list. */
interface ListItem {
  text: string;
  child: ListBlock | null;
}

/** One open or finished list: the marker kind, its base indent, its items. */
interface ListBlock {
  ordered: boolean;
  indent: number;
  items: ListItem[];
}

/** A list line this renderer understands, or null when the line is not one. */
function matchListLine(line: string): ListLine | null {
  const ordered = ORDERED_RE.exec(line);
  if (ordered !== null) {
    return { indent: ordered[1].length, ordered: true, text: ordered[2] };
  }
  const unordered = UNORDERED_RE.exec(line);
  if (unordered !== null) {
    return { indent: unordered[1].length, ordered: false, text: unordered[2] };
  }
  return null;
}

/** What one list line does to the open block: maybe closes it, then opens. */
interface ListStep {
  /** The block the line ended, if any; it belongs in `blocks` right now. */
  closed: ListBlock | null;
  /** The block the line leaves open, with it as the newest item. */
  open: ListBlock;
}

/**
 * Append one list line to the open block: an indent two or more spaces
 * deeper nests it into the previous item (one level — deeper indents clamp
 * into that same child), the same marker stays a sibling, and a marker
 * switch or a de-dent closes the block so the line opens the next one.
 */
function appendListLine(open: ListBlock | null, line: ListLine): ListStep {
  const startsBlock = (): ListBlock => ({
    ordered: line.ordered,
    indent: line.indent,
    items: [{ text: line.text, child: null }],
  });
  if (open === null) {
    return { closed: null, open: startsBlock() };
  }
  const parent = open.items.at(-1);
  const delta = line.indent - open.indent;
  if (parent !== undefined && delta >= 2) {
    if (parent.child === null) {
      parent.child = { ordered: line.ordered, indent: line.indent, items: [] };
    }
    parent.child.items.push({ text: line.text, child: null });
    return { closed: null, open };
  }
  if (parent !== undefined && delta >= -1 && line.ordered === open.ordered) {
    open.items.push({ text: line.text, child: null });
    return { closed: null, open };
  }
  return { closed: open, open: startsBlock() };
}

/** One list as HTML: items joined, a child list inside its parent `<li>`. */
function renderList(block: ListBlock): string {
  const tag = block.ordered ? "ol" : "ul";
  const items = block.items.map(
    (item) => `<li>${renderInline(item.text)}${item.child === null ? "" : renderList(item.child)}</li>`,
  );
  return `<${tag}>${items.join("")}</${tag}>`;
}

/** Render markdown to escaped, sanitized HTML. Never throws. */
export function renderMarkdown(markdown: string): string {
  const blocks: string[] = [];
  const paragraphs: string[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let index = 0;
  let open: ListBlock | null = null;

  // A list comes before a paragraph that trailed it; a list line that found
  // a pending paragraph flushes it first (the paragraph has no list after).
  const flushList = (): void => {
    if (open !== null) {
      blocks.push(renderList(open));
      open = null;
    }
  };

  const flushParagraph = (): void => {
    flushList();
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
    const item = matchListLine(line);
    if (item !== null) {
      if (paragraphs.length > 0) {
        flushParagraph();
      }
      const step = appendListLine(open, item);
      if (step.closed !== null) {
        blocks.push(renderList(step.closed));
      }
      open = step.open;
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
