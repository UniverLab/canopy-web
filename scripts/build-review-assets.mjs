// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle the review assets into the Worker.
 *
 * The review prompt (`apps/graphs/review/prompt.v2.xml`, versioned XML) and
 * the indexing diagram (`apps/graphs/review/indexing.mmd`, a mermaid
 * `sequenceDiagram`) are committed in-repo; this script validates both and
 * writes the committed `apps/graphs/src/review-assets.generated.ts` the
 * Worker renders from. The diagram is pre-rendered here to two static SVGs
 * — the wide sequence and the numberless phone timeline — so the
 * transparency page inlines both and no runtime mermaid.js ships.
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

const PROMPT_FILE = "prompt.v2.xml";
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
 * The lane style of each participant, keyed by lowercased mermaid id. The
 * colours are the page tokens, with the design's literals as fallbacks so
 * each SVG also stands alone; a diagram naming an id outside this table
 * fails the build — the art is written for this one story.
 */
export const LANES = {
  cron: { color: "--attention", fallback: "#ffb454", role: "every 15 min" },
  worker: { color: "--teal", fallback: "#3fb8b0", role: "graphs.univerlab.org" },
  github: { color: "--surface-ink", fallback: "#edfffe", role: "public repos" },
  kv: { color: "--canopy", fallback: "#00a9a0", role: "index · docs · reviews" },
  review: { color: "--phosphor", fallback: "#fde9ff", role: "a model, via API" },
  browser: { color: "--surface-ink-dim", fallback: "#bbc7c6", role: "you" },
};

/** The lane key of one participant id. */
function laneKey(id) {
  return id.toLowerCase();
}

/** The token colour expression of one lane. */
function laneColor(key) {
  const lane = LANES[key];
  return `var(${lane.color},${lane.fallback})`;
}

/**
 * Resolve the participants into lanes, failing the build on an unknown id.
 * The head label is the mermaid label with the trailing cron interval
 * removed, so the box reads `Cron` while the source keeps its schedule.
 *
 * The page substitutes the review token at request time, so geometry is
 * measured against the generic label it falls back to — otherwise the
 * box and the phone arrow are sized for a word the reader never sees.
 *
 * @param {{ participants: Array<{ id: string, label: string }> }} model
 * @returns {Map<string, { id: string, label: string, measure: string, color: string, fallback: string, role: string }>}
 */
function resolveLanes(model) {
  const lanes = new Map();
  for (const participant of model.participants) {
    const key = laneKey(participant.id);
    const lane = LANES[key];
    if (lane === undefined) {
      throw new Error(`review-assets: no lane style for participant ${participant.id}`);
    }
    const label = participant.label.replace(/\s*\*\/15\s*$/, "").trim();
    lanes.set(key, {
      id: key,
      label,
      measure: label.replaceAll("{{REVIEW_PROVIDER}}", "Review API"),
      ...lane,
    });
  }
  return lanes;
}

/**
 * Flatten the diagram into drawing steps: a phase band at the top and at
 * the first Browser-originated message, loop markers around each loop's
 * messages, and one step per message.
 *
 * @param {{ messages: Array<{ from: string, to: string, text: string, dotted: boolean }>, loops?: Array<{ label: string, start: number, end: number }> }} model
 * @returns {Array<Record<string, unknown>>} the steps in drawing order
 */
function resolveSteps(model) {
  const messages = model.messages.map((message) => ({
    kind: "message",
    from: laneKey(message.from),
    to: laneKey(message.to),
    text: message.text,
    reply: message.dotted,
  }));
  const split = messages.findIndex((message) => message.from === "browser");
  if (split <= 0) {
    throw new Error("review-assets: the diagram needs a Browser message to split the phases");
  }
  const loops = model.loops ?? [];
  const steps = [];
  for (let index = 0; index <= messages.length; index += 1) {
    if (index === 0) {
      steps.push({ kind: "phase", title: "Index", sub: "every 15 minutes, nobody waiting" });
    }
    if (index === split) {
      steps.push({ kind: "phase", title: "Serve", sub: "on every request, from KV only" });
    }
    for (const loop of loops) {
      if (loop.start === index) {
        steps.push({ kind: "loop-open", label: loop.label });
      }
    }
    if (index < messages.length) {
      steps.push(messages[index]);
    }
    for (const loop of loops) {
      if (loop.end === index + 1) {
        steps.push({ kind: "loop-close" });
      }
    }
  }
  return steps;
}

/** Shared marker definitions, one arrow per lane. */
function arrowDefs(lanes, prefix) {
  const parts = ["<defs>"];
  for (const key of lanes.keys()) {
    parts.push(
      `<marker id="${prefix}-arrow-${key}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ` +
        `markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" style="fill:${laneColor(key)}"/></marker>`,
    );
  }
  parts.push("</defs>");
  return parts.join("");
}

const WIDE_STYLE = `
<style>
  .seq{font-family:var(--font-mono,'Sometype Mono',ui-monospace,Menlo,monospace)}
  .seq .bg{fill:var(--stage-bg,#050505)}
  .seq .frame{fill:none;stroke:var(--stage-line,#1f2a29);stroke-width:1}
  .seq .ink{fill:var(--surface-ink,#edfffe)}
  .seq .dim{fill:var(--surface-ink-dim,#bbc7c6)}
  .seq .faint{fill:var(--surface-ink-faint,#9aa8a7)}
  .seq .life{stroke:var(--surface-ink-faint,#9aa8a7);stroke-width:1;stroke-dasharray:2 5;opacity:.45}
  .seq .band{fill:var(--surface-bg-raise,#003734);opacity:.35}
  .seq .loop{fill:none;stroke:var(--surface-ink-faint,#9aa8a7);stroke-width:1;stroke-dasharray:4 3;opacity:.8}
  .seq .msg{stroke-width:1.6;fill:none}
  .seq .reply{stroke-width:1.2;stroke-dasharray:5 4;opacity:.75;fill:none}
  .seq .badge{fill:var(--stage-bg,#050505);stroke-width:1.2}
  .seq .num{font-size:10px;font-weight:700}
  .seq .lbl{font-size:12.5px}
  .seq .lbl-reply{font-size:12px}
  .seq .head{font-size:13px;font-weight:700;letter-spacing:.04em}
  .seq .role{font-size:10px}
  .seq .phase{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
  .seq .phase-sub{font-size:11px}
</style>`;

const MOBILE_STYLE = `
<style>
  .seq{font-family:var(--font-mono,'Sometype Mono',ui-monospace,Menlo,monospace)}
  .seq .bg{fill:var(--stage-bg,#050505)}
  .seq .frame{fill:none;stroke:var(--stage-line,#1f2a29);stroke-width:1}
  .seq .ink{fill:var(--surface-ink,#edfffe)}
  .seq .dim{fill:var(--surface-ink-dim,#bbc7c6)}
  .seq .faint{fill:var(--surface-ink-faint,#9aa8a7)}
  .seq .msg{stroke-width:1.6;fill:none}
  .seq .reply{stroke-width:1.2;stroke-dasharray:5 4;opacity:.75;fill:none}
  .seq .lbl{font-size:12.5px}
  .seq .lbl-reply{font-size:12px}
  .seq .head{font-size:13px;font-weight:700;letter-spacing:.04em}
  .seq .phase{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
  .seq .phase-sub{font-size:11px}
  .seq .loop-cap{font-size:11px}
</style>`;

/**
 * Render the wide diagram: two phase bands, one coloured head per lane,
 * activation bars, the loop frame, the self-call, dotted replies, and a
 * numbered badge at each message's origin. The wide art always numbers,
 * regardless of the source's `autonumber`.
 *
 * @param {{ participants: Array<{ id: string, label: string }>, messages: Array<{ from: string, to: string, text: string, dotted: boolean }>, loops?: Array<{ label: string, start: number, end: number }> }} model
 * @returns {string} the SVG document
 */
export function renderWideSvg(model) {
  const lanes = resolveLanes(model);
  const steps = resolveSteps(model);
  const width = 960;
  const x0 = 92;
  const gap = (width - 2 * x0) / (lanes.size - 1);
  const rowHeight = 40;
  const head = 96;
  const x = new Map([...lanes.keys()].map((key, index) => [key, x0 + index * gap]));
  let y = head + 6;
  const phases = [];
  const loopFrames = [];
  const messageSteps = [];
  let openLoop = null;
  for (const step of steps) {
    if (step.kind === "phase") {
      y += 16;
      phases.push({ title: step.title, sub: step.sub, top: y - 14, bottom: null });
      if (phases.length > 1) {
        phases[phases.length - 2].bottom = y - 30;
      }
      y += 40;
    } else if (step.kind === "loop-open") {
      openLoop = { label: step.label, top: y - 12, bottom: null };
      y += 30;
    } else if (step.kind === "loop-close") {
      openLoop.bottom = y - 16;
      loopFrames.push(openLoop);
      openLoop = null;
      y += 10;
    } else {
      step.y = y;
      messageSteps.push(step);
      y += rowHeight + (step.from === step.to ? 14 : 0);
    }
  }
  const height = y + 30;
  phases[phases.length - 1].bottom = height - 22;

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" class="seq" viewBox="0 0 ${width} ${height}" role="img" ` +
      `aria-label="Indexing sequence diagram: how the catalogue is indexed every 15 minutes and served from KV">`,
    "<title>Indexing sequence diagram</title>",
    WIDE_STYLE,
    arrowDefs(lanes, "seq"),
    `<rect class="bg" x="0" y="0" width="${width}" height="${height}" rx="14"/>`,
    `<rect class="frame" x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="14"/>`,
  ];
  phases.forEach((phase, index) => {
    const title = `${index + 1} · ${phase.title}`;
    parts.push(
      `<rect class="band" x="14" y="${phase.top}" width="${width - 28}" height="${phase.bottom - phase.top}" rx="10"/>` +
        `<text class="phase" x="30" y="${phase.top + 20}" style="fill:${laneColor("worker")}">${escapeXml(title)}</text>` +
        `<text class="phase-sub faint" x="${30 + title.length * 9.4 + 16}" y="${phase.top + 20}">${escapeXml(phase.sub)}</text>`,
    );
  });
  for (const lane of lanes.values()) {
    const cx = x.get(lane.id);
    parts.push(`<line class="life" x1="${cx}" y1="${head - 6}" x2="${cx}" y2="${height - 20}"/>`);
    const boxWidth = Math.max(100, 10 * lane.measure.length + 48);
    parts.push(
      `<rect x="${cx - boxWidth / 2}" y="22" width="${boxWidth}" height="34" rx="17" style="fill:var(--stage-bg,#050505);stroke:${laneColor(lane.id)};stroke-width:1.4"/>` +
        `<circle cx="${cx - boxWidth / 2 + 16}" cy="39" r="4" style="fill:${laneColor(lane.id)}"/>` +
        `<text class="head" x="${cx + 9}" y="43.5" text-anchor="middle" style="fill:${laneColor(lane.id)}">${escapeXml(lane.label)}</text>` +
        `<text class="role faint" x="${cx}" y="74" text-anchor="middle">${escapeXml(lane.role)}</text>`,
    );
  }
  const bar = (key, top, bottom) => {
    parts.push(
      `<rect x="${x.get(key) - 4}" y="${top}" width="8" height="${bottom - top}" rx="3" style="fill:${laneColor(key)};opacity:.22"/>`,
    );
  };
  const phaseRows = phases.map(() => []);
  let phaseIndex = -1;
  for (const step of steps) {
    if (step.kind === "phase") {
      phaseIndex += 1;
    } else if (step.kind === "message") {
      phaseRows[phaseIndex].push(step.y);
    }
  }
  for (const rows of phaseRows) {
    if (rows.length > 0 && lanes.has("worker")) {
      bar("worker", rows[0] - 6, rows[rows.length - 1] + 8);
    }
  }
  for (let index = 0; index + 1 < messageSteps.length; index += 1) {
    const first = messageSteps[index];
    const second = messageSteps[index + 1];
    if (["github", "kv", "review"].includes(first.to) && second.from === first.to && second.reply) {
      bar(first.to, first.y - 6, second.y + 6);
    } else if (first.to === "kv" && second.from !== "kv") {
      bar("kv", first.y - 6, first.y + 8);
    }
  }
  const selfWidest = messageSteps
    .filter((step) => step.from === "worker" && step.to === "worker")
    .reduce((widest, step) => Math.max(widest, step.text.length), 0);
  for (const frame of loopFrames) {
    const leftEdge = x.get("worker") - 46;
    const rightEdge = Math.max(x.get("github") + 70, x.get("worker") + 60 + selfWidest * 7.7 + 24);
    parts.push(
      `<rect class="loop" x="${leftEdge}" y="${frame.top}" width="${rightEdge - leftEdge}" height="${frame.bottom - frame.top}" rx="8"/>` +
        `<rect x="${leftEdge}" y="${frame.top}" width="128" height="18" rx="8" style="fill:var(--surface-bg-raise,#003734)"/>` +
        `<text class="role dim" x="${leftEdge + 10}" y="${frame.top + 13}">↻ loop · ${escapeXml(frame.label)}</text>`,
    );
  }
  messageSteps.forEach((step, index) => {
    const color = laneColor(step.from);
    let badgeX;
    if (step.from === step.to) {
      const startX = x.get(step.from) + 4;
      const path = `M${startX} ${step.y} h34 q8 0 8 8 v6 q0 8 -8 8 h-32`;
      parts.push(
        `<path class="msg" d="${path}" style="stroke:${color}" marker-end="url(#seq-arrow-${step.from})"/>` +
          `<text class="lbl ink" x="${startX + 52}" y="${step.y + 12}">${escapeXml(step.text)}</text>`,
      );
      badgeX = x.get(step.from) - 20;
    } else {
      const sign = x.get(step.to) > x.get(step.from) ? 1 : -1;
      const startX = x.get(step.from) + 5 * sign;
      const endX = x.get(step.to) - 5 * sign;
      const className = step.reply ? "reply" : "msg";
      parts.push(
        `<line class="${className}" x1="${startX}" y1="${step.y}" x2="${endX}" y2="${step.y}" style="stroke:${color}" marker-end="url(#seq-arrow-${step.from})"/>` +
          `<text class="${step.reply ? "lbl-reply dim" : "lbl ink"}" x="${startX + sign * 22}" y="${step.y - 8}" text-anchor="${sign > 0 ? "start" : "end"}">${escapeXml(step.text)}</text>`,
      );
      badgeX = startX + sign * 9;
    }
    parts.push(
      `<circle class="badge" cx="${badgeX}" cy="${step.y}" r="8.5" style="stroke:${color}"/>` +
        `<text class="num" x="${badgeX}" y="${step.y + 3.5}" text-anchor="middle" style="fill:${color}">${index + 1}</text>`,
    );
  });
  parts.push("</svg>");
  return parts.join("\n");
}

/**
 * Render the phone timeline: numberless, one rail, one dot per step
 * (filled for a call, hollow for a reply), `Origin → Destination` in the
 * participants' colours, and the message below. Drawn on a 360-unit
 * viewBox so 11-unit text is 11 px on a 360 px screen.
 *
 * @param {{ participants: Array<{ id: string, label: string }>, messages: Array<{ from: string, to: string, text: string, dotted: boolean }>, loops?: Array<{ label: string, start: number, end: number }> }} model
 * @returns {string} the SVG document
 */
export function renderMobileSvg(model) {
  const lanes = resolveLanes(model);
  const steps = resolveSteps(model);
  const width = 360;
  const rail = 32;
  const body = [];
  let y = 20;
  let railTop = null;
  let loopTop = null;
  for (const step of steps) {
    if (step.kind === "phase") {
      if (railTop !== null) {
        body.push(
          `<line x1="${rail}" y1="${railTop}" x2="${rail}" y2="${y - 18}" style="stroke:var(--surface-ink-faint,#9aa8a7);stroke-width:1;opacity:.35"/>`,
        );
      }
      y += 10;
      body.push(`<text class="phase" x="20" y="${y + 14}" style="fill:${laneColor("worker")}">${escapeXml(step.title)}</text>`);
      body.push(`<text class="phase-sub faint" x="20" y="${y + 31}">${escapeXml(step.sub)}</text>`);
      y += 50;
      railTop = y;
      continue;
    }
    if (step.kind === "loop-open") {
      loopTop = y - 4;
      body.push(`<text class="loop-cap dim" x="${rail + 20}" y="${y + 8}">↻ for each ${escapeXml(step.label.replace(/^per\s+/, ""))}</text>`);
      y += 20;
      continue;
    }
    if (step.kind === "loop-close") {
      body.push(
        `<rect x="${rail + 10}" y="${loopTop}" width="${width - rail - 26}" height="${y - loopTop - 2}" rx="8" style="fill:none;stroke:var(--surface-ink-faint,#9aa8a7);stroke-dasharray:4 3;opacity:.6"/>`,
      );
      y += 8;
      continue;
    }
    const fromLabel = lanes.get(step.from).label;
    const toLabel = lanes.get(step.to).label;
    const fromMeasure = lanes.get(step.from).measure;
    body.push(
      `<circle cx="${rail}" cy="${y + 6}" r="${step.reply ? 3.5 : 5}" style="fill:${step.reply ? "var(--stage-bg,#050505)" : laneColor(step.from)};stroke:${laneColor(step.from)};stroke-width:1.5"/>`,
    );
    const textX = rail + 20;
    body.push(`<text class="head" x="${textX}" y="${y + 10}" style="font-size:11px;fill:${laneColor(step.from)}">${escapeXml(fromLabel)}</text>`);
    const arrowX = textX + fromMeasure.length * 7.6 + 6;
    if (step.from !== step.to) {
      body.push(
        `<line class="${step.reply ? "reply" : "msg"}" x1="${arrowX}" y1="${y + 6}" x2="${arrowX + 22}" y2="${y + 6}" style="stroke:${laneColor(step.from)}" marker-end="url(#seqm-arrow-${step.from})"/>` +
          `<text class="head" x="${arrowX + 30}" y="${y + 10}" style="font-size:11px;fill:${laneColor(step.to)}">${escapeXml(toLabel)}</text>`,
      );
    }
    body.push(
      `<text class="${step.reply ? "lbl-reply dim" : "lbl ink"}" x="${textX}" y="${y + 28}">${escapeXml(step.text)}</text>`,
    );
    y += 44;
  }
  body.push(
    `<line x1="${rail}" y1="${railTop}" x2="${rail}" y2="${y - 30}" style="stroke:var(--surface-ink-faint,#9aa8a7);stroke-width:1;opacity:.35"/>`,
  );
  const height = y + 6;
  const rails = body.filter((element) => element.startsWith(`<line x1="${rail}"`));
  const rest = body.filter((element) => !element.startsWith(`<line x1="${rail}"`));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="seq" viewBox="0 0 ${width} ${height}" role="img" ` +
      `aria-label="Indexing sequence, step by step">`,
    "<title>Indexing sequence, step by step</title>",
    MOBILE_STYLE,
    arrowDefs(lanes, "seqm"),
    `<rect class="bg" x="0" y="0" width="${width}" height="${height}" rx="14"/>`,
    `<rect class="frame" x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="14"/>`,
    ...rails,
    ...rest,
    "</svg>",
  ].join("\n");
}

/**
 * Render the generated module: the prompt, the diagram source and both
 * pre-rendered SVGs, plus the stamp. Payloads stay JSON-encoded on one
 * line each.
 *
 * @param {string} prompt - the prompt.v2.xml text
 * @param {string} mmd - the indexing.mmd text
 * @param {string} svg - the wide SVG
 * @param {string} mobileSvg - the phone timeline SVG
 * @param {string} builtAt - the ISO-8601 stamp
 * @returns {string} the module text
 */
function renderModule(prompt, mmd, svg, mobileSvg, builtAt) {
  return [
    `// SPDX-License-Identifier: Apache-2.0`,
    `/**`,
    ` * The bundled review assets. Generated by \`npm run build:review-assets\``,
    ` * from \`apps/graphs/review/\` — committed, do not edit.`,
    ` */`,
    `/** The review prompt's version: the transparency page names it. */`,
    `export const REVIEW_PROMPT_VERSION = "v2";`,
    ``,
    `/** When the bundled payload last changed, ISO-8601. */`,
    `export const REVIEW_ASSETS_BUILT_AT = ${JSON.stringify(builtAt)};`,
    ``,
    `/** The bundled review prompt; the runner strips its leading comments, and /transparency shows the stripped bytes. */`,
    `export const REVIEW_PROMPT_V2 = ${JSON.stringify(prompt)};`,
    ``,
    `/** The indexing diagram source, a mermaid sequenceDiagram. */`,
    `export const INDEXING_MMD = ${JSON.stringify(mmd)};`,
    ``,
    `/** The wide diagram, pre-rendered to static SVG at build time. */`,
    `export const INDEXING_SVG = ${JSON.stringify(svg)};`,
    ``,
    `/** The phone timeline, pre-rendered to static SVG at build time. */`,
    `export const INDEXING_MOBILE_SVG = ${JSON.stringify(mobileSvg)};`,
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
    const prompt = /REVIEW_PROMPT_V2 = ("(?:[^"\\]|\\.)*");/.exec(text)?.[1];
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
  const model = parseDiagram(mmd);
  const svg = renderWideSvg(model);
  const mobileSvg = renderMobileSvg(model);
  const previous = previousPayload(out);
  const builtAt =
    previous !== null && previous.prompt === prompt && previous.mmd === mmd
      ? (previousStamp(out) ?? new Date().toISOString())
      : new Date().toISOString();
  const module = renderModule(prompt, mmd, svg, mobileSvg, builtAt);

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
