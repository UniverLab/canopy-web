// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle the review assets into the Worker.
 *
 * The review prompt (`apps/graphs/review/prompt.v1.xml`, versioned XML) and
 * the indexing diagram (`apps/graphs/review/indexing.mmd`, a mermaid
 * `sequenceDiagram`) are committed in-repo; this script validates both and
 * writes the committed `apps/graphs/src/review-assets.generated.ts` the
 * Worker renders from. The diagram is pre-rendered to static SVG here, so
 * the transparency page inlines an image and no runtime mermaid.js ships.
 *
 * The renderer is intentionally small: it reads `participant` lines,
 * `A->>B: message` calls and `A-->>B: message` replies, `activate` /
 * `deactivate` lifeline boxes, `autonumber` badges and one-level `loop` /
 * `end` frames, and draws participants, lifelines, labelled arrows and
 * the frames. `%%` comments shape the source for human readers and are
 * ignored in the drawing. Strict grammar: no `+`/`-` arrow suffixes, no
 * same-participant nesting, no nested loops. A line the parser cannot
 * read fails the build with the line and the reason — nothing malformed
 * is ever bundled.
 *
 * `REVIEW_ASSETS_BUILT_AT` marks when the payload last changed: it is
 * carried over from the previous generated file while prompt and diagram
 * are byte-identical, and stamped with the run's clock otherwise.
 *
 * Run with node (`npm run build:review-assets`). `--check` validates and
 * compares without writing: it exits nonzero when the generated module is
 * stale, which is how the test suite pins the committed file to these
 * sources. `--dir` and `--out` override the sources and the destination
 * for tests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_DIR = path.join(ROOT, "apps", "graphs", "review");
const GENERATED = path.join(ROOT, "apps", "graphs", "src", "review-assets.generated.ts");

const PROMPT_FILE = "prompt.v1.xml";
const DIAGRAM_FILE = "indexing.mmd";

/**
 * Read one asset, naming it when the read fails.
 *
 * @param {string} file - the absolute path to read
 * @param {string} dir - the review directory, for the error's relative name
 * @returns {string} the file's UTF-8 text
 */
function readNamed(file, dir) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error(`review-assets: cannot read ${path.relative(dir, file)}`);
  }
}

/**
 * Escape one SVG text span.
 *
 * @param {string} text - the raw text
 * @returns {string} the escaped text
 */
function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Parse the diagram source into participants, messages, activations and loops.
 *
 * Activations span message rows: `activate X` records the next message's
 * index, `deactivate X` closes at the current one, so the box covers the
 * messages between the two lines. Loops likewise cover the messages
 * between `loop <label>` and `end`. Strict: activating an unknown or
 * already-active participant, deactivating an inactive one, `end` without
 * a loop, a nested or unlabelled loop, and an unclosed loop or activation
 * all fail the build.
 *
 * @param {string} source - the .mmd text
 * @returns {{ participants: Array<{ id: string, label: string }>, messages: Array<{ from: string, to: string, text: string, dotted: boolean }>, autonumber: boolean, activations: Array<{ participant: string, start: number, end: number }>, loops: Array<{ label: string, start: number, end: number }> }}
 *   the drawing model, in source order
 */
export function parseDiagram(source) {
  const participants = [];
  const seen = new Set();
  const messages = [];
  const activations = [];
  const loops = [];
  let autonumber = false;
  const active = new Map();
  let openLoop = null;
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("%%")) {
      continue;
    }
    if (line === "sequenceDiagram") {
      continue;
    }
    if (line === "autonumber") {
      autonumber = true;
      continue;
    }
    if (line === "end") {
      if (openLoop === null) {
        throw new Error(`review-assets: end without a loop: ${line}`);
      }
      loops.push({ label: openLoop.label, start: openLoop.start, end: messages.length });
      openLoop = null;
      continue;
    }
    if (line.startsWith("loop ") || line === "loop") {
      if (openLoop !== null) {
        throw new Error(`review-assets: nested loops are not supported: ${line}`);
      }
      const label = line.slice("loop".length).trim();
      if (label === "") {
        throw new Error(`review-assets: loop without a label: ${line}`);
      }
      openLoop = { label, start: messages.length };
      continue;
    }
    const activate = /^activate\s+(\S+)$/.exec(line);
    if (activate !== null) {
      const id = activate[1] ?? "";
      if (!seen.has(id)) {
        throw new Error(`review-assets: activate names an unknown participant: ${line}`);
      }
      if (active.has(id)) {
        throw new Error(`review-assets: participant already active: ${line}`);
      }
      active.set(id, messages.length);
      continue;
    }
    const deactivate = /^deactivate\s+(\S+)$/.exec(line);
    if (deactivate !== null) {
      const id = deactivate[1] ?? "";
      if (!seen.has(id)) {
        throw new Error(`review-assets: deactivate names an unknown participant: ${line}`);
      }
      const start = active.get(id);
      if (start === undefined) {
        throw new Error(`review-assets: deactivate without activate: ${line}`);
      }
      active.delete(id);
      activations.push({ participant: id, start, end: messages.length });
      continue;
    }
    const participant = /^participant\s+(\S+)(?:\s+as\s+(.+))?$/.exec(line);
    if (participant !== null) {
      const id = participant[1];
      const label = (participant[2] ?? id).trim();
      if (seen.has(id)) {
        throw new Error(`review-assets: duplicate participant ${id}`);
      }
      seen.add(id);
      participants.push({ id, label });
      continue;
    }
    const message = /^(\S+?)(-->>|->>|-->|->)(\S+?)\s*:\s*(.+)$/.exec(line);
    if (message !== null) {
      const from = message[1];
      const arrow = message[2];
      const to = message[3];
      const text = message[4].trim();
      if (!seen.has(from) || !seen.has(to)) {
        throw new Error(`review-assets: message names an unknown participant: ${line}`);
      }
      if (text === "") {
        throw new Error(`review-assets: message without text: ${line}`);
      }
      messages.push({ from, to, text, dotted: arrow.startsWith("--") });
      continue;
    }
    throw new Error(`review-assets: cannot parse diagram line: ${line}`);
  }
  if (openLoop !== null) {
    throw new Error("review-assets: the diagram leaves a loop unclosed");
  }
  if (active.size !== 0) {
    throw new Error(`review-assets: the diagram leaves ${[...active.keys()].join(", ")} active`);
  }
  if (participants.length === 0) {
    throw new Error("review-assets: the diagram names no participants");
  }
  if (messages.length === 0) {
    throw new Error("review-assets: the diagram carries no messages");
  }
  return { participants, messages, autonumber, activations, loops };
}

/**
 * Render the drawing model as one static SVG: participant boxes on top,
 * dashed lifelines below, activation boxes over the lifelines, one
 * labelled arrow per message (calls solid, `-->>` replies dashed and
 * lighter), a labelled frame per loop, and — when the source says
 * `autonumber` — a gutter column of numbered badges in message order.
 *
 * @param {{ participants: Array<{ id: string, label: string }>, messages: Array<{ from: string, to: string, text: string, dotted: boolean }>, autonumber?: boolean, activations?: Array<{ participant: string, start: number, end: number }>, loops?: Array<{ label: string, start: number, end: number }> }} model
 *   the parsed diagram
 * @returns {string} the SVG document
 */
export function renderDiagramSvg(model) {
  const lane = 170;
  const margin = 24;
  const top = 44;
  const row = 38;
  const numbered = model.autonumber === true;
  const activations = model.activations ?? [];
  const loops = model.loops ?? [];
  const gutter = numbered ? 44 : 0;
  const left = margin + gutter;
  const width = left + model.participants.length * lane + margin;
  const height = top + model.messages.length * row + margin + 8;
  const xOf = new Map(model.participants.map((p, i) => [p.id, left + lane * i + lane / 2]));
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Indexing sequence diagram">`,
  );
  parts.push(`<title>Indexing sequence diagram</title>`);
  for (const [index, participant] of model.participants.entries()) {
    const x = left + lane * index;
    const cx = xOf.get(participant.id) ?? 0;
    parts.push(
      `<rect x="${x + 8}" y="8" width="${lane - 16}" height="28" rx="4" fill="none" stroke="currentColor"/>` +
        `<text x="${cx}" y="27" text-anchor="middle" font-size="12" fill="currentColor">${escapeXml(participant.label)}</text>` +
        `<line x1="${cx}" y1="${top}" x2="${cx}" y2="${height - margin}" stroke="currentColor" stroke-dasharray="3 3" opacity="0.5"/>`,
    );
  }
  for (const loop of loops) {
    const frameTop = top + loop.start * row - 4;
    const frameBottom = top + loop.end * row + 8;
    const frameWidth = model.participants.length * lane;
    parts.push(
      `<rect x="${left}" y="${frameTop}" width="${frameWidth}" height="${frameBottom - frameTop}" fill="none" stroke="currentColor"/>` +
        `<text x="${left + 8}" y="${frameTop + 14}" font-size="11" fill="currentColor">loop ${escapeXml(loop.label)}</text>`,
    );
  }
  for (const activation of activations) {
    const cx = xOf.get(activation.participant) ?? 0;
    const boxTop = top + activation.start * row + 6;
    const boxBottom = Math.max(top + activation.end * row + 6, boxTop + 14);
    parts.push(
      `<rect x="${cx - 6}" y="${boxTop}" width="12" height="${boxBottom - boxTop}" fill="currentColor" fill-opacity="0.12" stroke="currentColor"/>`,
    );
  }
  model.messages.forEach((message, rowIndex) => {
    const y = top + rowIndex * row + 18;
    const fromX = xOf.get(message.from) ?? 0;
    const toX = xOf.get(message.to) ?? 0;
    const leftEdge = Math.min(fromX, toX);
    const rightEdge = Math.max(fromX, toX);
    const self = fromX === toX;
    const dash = message.dotted ? ` stroke-dasharray="4 3"` : "";
    const dim = message.dotted ? ` opacity="0.65"` : "";
    if (numbered) {
      const badgeCx = margin + gutter / 2;
      parts.push(
        `<rect x="${badgeCx - 12}" y="${y - 8}" width="24" height="16" rx="8" fill="none" stroke="currentColor"/>` +
          `<text x="${badgeCx}" y="${y + 4}" text-anchor="middle" font-size="10" fill="currentColor">${rowIndex + 1}</text>`,
      );
    }
    if (self) {
      parts.push(
        `<text x="${fromX + 6}" y="${y - 14}" font-size="11" fill="currentColor"${dim}>${escapeXml(message.text)}</text>` +
          `<line x1="${fromX}" y1="${y}" x2="${fromX + 28}" y2="${y}" stroke="currentColor"${dash}${dim}/>` +
          `<line x1="${fromX + 28}" y1="${y}" x2="${fromX + 28}" y2="${y + 12}" stroke="currentColor"${dash}${dim}/>` +
          `<line x1="${fromX + 28}" y1="${y + 12}" x2="${fromX}" y2="${y + 12}" stroke="currentColor"${dash}${dim}/>` +
          `<polygon points="${fromX},${y + 12} ${fromX + 7},${y + 8} ${fromX + 7},${y + 16}" fill="currentColor"${dim}/>`,
      );
      return;
    }
    const flip = fromX > toX;
    parts.push(
      `<text x="${(leftEdge + rightEdge) / 2}" y="${y - 6}" text-anchor="middle" font-size="11" fill="currentColor"${dim}>${escapeXml(message.text)}</text>` +
        `<line x1="${fromX}" y1="${y}" x2="${toX}" y2="${y}" stroke="currentColor"${dash}${dim}/>` +
        `<polygon points="${toX},${y} ${toX + (flip ? 7 : -7)},${y - 4} ${toX + (flip ? 7 : -7)},${y + 4}" fill="currentColor"${dim}/>`,
    );
  });
  parts.push(`</svg>`);
  return parts.join("");
}

/**
 * Render the generated module: the prompt, the diagram source and its SVG,
 * plus the stamp. Payloads stay JSON-encoded on one line each.
 *
 * @param {string} prompt - the prompt.v1.xml text
 * @param {string} mmd - the indexing.mmd text
 * @param {string} svg - the pre-rendered SVG
 * @param {string} builtAt - the ISO-8601 stamp
 * @returns {string} the module text
 */
function renderModule(prompt, mmd, svg, builtAt) {
  return [
    `// SPDX-License-Identifier: Apache-2.0`,
    `/**`,
    ` * The bundled review assets. Generated by \`npm run build:review-assets\``,
    ` * from \`apps/graphs/review/\` — committed, do not edit.`,
    ` */`,
    `/** The review prompt's version: the transparency page names it. */`,
    `export const REVIEW_PROMPT_VERSION = "v1";`,
    ``,
    `/** When the bundled payload last changed, ISO-8601. */`,
    `export const REVIEW_ASSETS_BUILT_AT = ${JSON.stringify(builtAt)};`,
    ``,
    `/** The exact review prompt text, shown verbatim on /transparency. */`,
    `export const REVIEW_PROMPT_V1 = ${JSON.stringify(prompt)};`,
    ``,
    `/** The indexing diagram source, a mermaid sequenceDiagram. */`,
    `export const INDEXING_MMD = ${JSON.stringify(mmd)};`,
    ``,
    `/** The diagram pre-rendered to static SVG at build time. */`,
    `export const INDEXING_SVG = ${JSON.stringify(svg)};`,
    ``,
  ].join("\n");
}

/**
 * Read the stamp the previous generated file carries, if any.
 *
 * @param {string} out - the generated file path
 * @returns {string | null} the previous stamp, or null when unreadable
 */
function previousStamp(out) {
  try {
    const text = readFileSync(out, "utf8");
    return /REVIEW_ASSETS_BUILT_AT = "([^"]+)"/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the payload the previous generated file carries, if any.
 *
 * @param {string} out - the generated file path
 * @returns {{ prompt: string, mmd: string } | null} the previous texts
 */
function previousPayload(out) {
  try {
    const text = readFileSync(out, "utf8");
    const prompt = /REVIEW_PROMPT_V1 = ("(?:[^"\\]|\\.)*");/.exec(text)?.[1];
    const mmd = /INDEXING_MMD = ("(?:[^"\\]|\\.)*");/.exec(text)?.[1];
    if (prompt === undefined || mmd === undefined) {
      return null;
    }
    return { prompt: JSON.parse(prompt), mmd: JSON.parse(mmd) };
  } catch {
    return null;
  }
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const dirFlag = args.indexOf("--dir");
  const outFlag = args.indexOf("--out");
  const dir = dirFlag === -1 ? REVIEW_DIR : path.resolve(args[dirFlag + 1] ?? REVIEW_DIR);
  const out = outFlag === -1 ? GENERATED : path.resolve(args[outFlag + 1] ?? GENERATED);

  const prompt = readNamed(path.join(dir, PROMPT_FILE), dir);
  if (!prompt.includes("<review_prompt") || !prompt.includes("{{COMMANDS}}") || !prompt.includes("{{PROMPTS}}") || !prompt.includes("{{ATTENTION}}")) {
    throw new Error("review-assets: the prompt is missing its root tag or its fact placeholders");
  }
  const mmd = readNamed(path.join(dir, DIAGRAM_FILE), dir);
  if (!mmd.includes("sequenceDiagram")) {
    throw new Error("review-assets: the diagram is not a mermaid sequenceDiagram");
  }
  const svg = renderDiagramSvg(parseDiagram(mmd));
  const previous = previousPayload(out);
  const builtAt =
    previous !== null && previous.prompt === prompt && previous.mmd === mmd
      ? (previousStamp(out) ?? new Date().toISOString())
      : new Date().toISOString();
  const module = renderModule(prompt, mmd, svg, builtAt);

  if (check) {
    let current = null;
    try {
      current = readFileSync(out, "utf8");
    } catch {
      current = null;
    }
    if (current !== module) {
      process.stderr.write("review-assets: the generated module is stale; run npm run build:review-assets\n");
      process.exit(1);
    }
  } else {
    writeFileSync(out, module);
  }
}
