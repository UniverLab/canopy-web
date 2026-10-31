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
 * The renderer is intentionally small: it reads `participant` lines and
 * `A->>B: message` arrows (solid and dotted alike) and draws participants,
 * lifelines and labelled arrows. `autonumber`, `loop`/`end` and `%%`
 * comments shape the source for human readers and are ignored in the
 * drawing. A message the parser cannot read fails the build with the line
 * and the reason — nothing malformed is ever bundled.
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
 * Parse the diagram source into participants and messages.
 *
 * @param {string} source - the .mmd text
 * @returns {{ participants: Array<{ id: string, label: string }>, messages: Array<{ from: string, to: string, text: string, dotted: boolean }> }}
 *   the drawing model, in source order
 */
export function parseDiagram(source) {
  const participants = [];
  const seen = new Set();
  const messages = [];
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("%%")) {
      continue;
    }
    if (line === "sequenceDiagram" || line === "autonumber" || line === "end") {
      continue;
    }
    if (line.startsWith("loop ")) {
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
  if (participants.length === 0) {
    throw new Error("review-assets: the diagram names no participants");
  }
  if (messages.length === 0) {
    throw new Error("review-assets: the diagram carries no messages");
  }
  return { participants, messages };
}

/**
 * Render the drawing model as one static SVG: participant boxes on top,
 * dashed lifelines below, one labelled arrow per message.
 *
 * @param {{ participants: Array<{ id: string, label: string }>, messages: Array<{ from: string, to: string, text: string, dotted: boolean }> }} model
 *   the parsed diagram
 * @returns {string} the SVG document
 */
export function renderDiagramSvg(model) {
  const lane = 170;
  const margin = 24;
  const top = 44;
  const row = 38;
  const width = model.participants.length * lane + margin * 2;
  const height = top + model.messages.length * row + margin + 8;
  const xOf = new Map(model.participants.map((p, i) => [p.id, margin + lane * i + lane / 2]));
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Indexing sequence diagram">`,
  );
  parts.push(`<title>Indexing sequence diagram</title>`);
  for (const [index, participant] of model.participants.entries()) {
    const x = margin + lane * index;
    const cx = xOf.get(participant.id) ?? 0;
    parts.push(
      `<rect x="${x + 8}" y="8" width="${lane - 16}" height="28" rx="4" fill="none" stroke="currentColor"/>` +
        `<text x="${cx}" y="27" text-anchor="middle" font-size="12" fill="currentColor">${escapeXml(participant.label)}</text>` +
        `<line x1="${cx}" y1="${top}" x2="${cx}" y2="${height - margin}" stroke="currentColor" stroke-dasharray="3 3" opacity="0.5"/>`,
    );
  }
  model.messages.forEach((message, rowIndex) => {
    const y = top + rowIndex * row + 18;
    const fromX = xOf.get(message.from) ?? 0;
    const toX = xOf.get(message.to) ?? 0;
    const left = Math.min(fromX, toX);
    const right = Math.max(fromX, toX);
    const self = fromX === toX;
    const dash = message.dotted ? ` stroke-dasharray="4 3"` : "";
    if (self) {
      parts.push(
        `<text x="${fromX + 6}" y="${y - 14}" font-size="11" fill="currentColor">${escapeXml(message.text)}</text>` +
          `<line x1="${fromX}" y1="${y}" x2="${fromX + 28}" y2="${y}" stroke="currentColor"${dash}/>` +
          `<line x1="${fromX + 28}" y1="${y}" x2="${fromX + 28}" y2="${y + 12}" stroke="currentColor"${dash}/>` +
          `<line x1="${fromX + 28}" y1="${y + 12}" x2="${fromX}" y2="${y + 12}" stroke="currentColor"${dash}/>` +
          `<polygon points="${fromX},${y + 12} ${fromX + 7},${y + 8} ${fromX + 7},${y + 16}" fill="currentColor"/>`,
      );
      return;
    }
    const flip = fromX > toX;
    parts.push(
      `<text x="${(left + right) / 2}" y="${y - 6}" text-anchor="middle" font-size="11" fill="currentColor">${escapeXml(message.text)}</text>` +
        `<line x1="${fromX}" y1="${y}" x2="${toX}" y2="${y}" stroke="currentColor"${dash}/>` +
        `<polygon points="${toX},${y} ${toX + (flip ? 7 : -7)},${y - 4} ${toX + (flip ? 7 : -7)},${y + 4}" fill="currentColor"/>`,
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
