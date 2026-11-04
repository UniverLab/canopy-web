// SPDX-License-Identifier: Apache-2.0
/**
 * Bundle the Agent Skills each Worker serves into the Worker.
 *
 * The skills are authored as `skills/<name>/SKILL.md` plus the files that
 * name's own relative links resolve to (graphs vendors
 * `canopy-graph-design` from the skills repo; remote authors the short
 * `canopy-remote` in-tree); this script validates every skill with the
 * same rules the discovery index is checked against (a name, a non-empty
 * description, a SHA-256 digest over the exact bytes served) and writes
 * the committed `skills-data.generated.ts` each Worker reads from.
 * A missing SKILL.md, an empty description, or a front-matter name that
 * is not its own directory fails the build with the skill and the reason.
 *
 * `SKILLS_BUILT_AT` marks when the bundled payload last changed: it is
 * carried over from the previous generated file while the payload is
 * byte-identical, and stamped with the run's clock otherwise.
 *
 * Run with node (`npm run build:skills-index`). `--check` validates and
 * compares without writing: it exits nonzero when a generated module is
 * stale.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every app whose Worker serves an Agent Skills index. */
const APPS = [
  {
    dir: path.join(ROOT, "apps", "graphs", "skills"),
    out: path.join(ROOT, "apps", "graphs", "src", "skills-data.generated.ts"),
  },
  {
    dir: path.join(ROOT, "apps", "remote", "worker", "skills"),
    out: path.join(ROOT, "apps", "remote", "worker", "src", "skills-data.generated.ts"),
  },
];

/** A skill name: lowercase alphanumeric plus hyphens, like the index schema. */
const NAME_RE = /^[a-z0-9-]+$/;

/**
 * Read `name` and `description` out of a SKILL.md's YAML front matter.
 * Hand-rolled because this needs exactly two scalars — but it understands
 * block scalars (`>` and `|`), since skill descriptions are written as
 * folded blocks and a naive `key: value` reader returns an empty string
 * for every one of them. Matches univerlab's own index builder.
 *
 * @param {string} source - the SKILL.md text
 * @returns {Record<string, string>} the front-matter scalars
 */
export function readFrontMatter(source) {
  const match = /^---\n([\s\S]*?)\n---/.exec(source);
  if (match === null) {
    return {};
  }
  const out = {};
  const lines = match[1].split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const keyed = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(lines[index]);
    if (keyed === null) {
      continue;
    }
    const key = keyed[1];
    const inline = keyed[2];
    if (inline !== ">" && inline !== "|" && inline !== ">-" && inline !== "|-") {
      out[key] = inline.replace(/^["']|["']$/g, "").trim();
      continue;
    }
    // Block scalar: every following line indented deeper than the key
    // belongs to it. The index wants one line, so both folds collapse.
    const block = [];
    while (
      index + 1 < lines.length &&
      (lines[index + 1].trim() === "" || /^\s+\S/.test(lines[index + 1]))
    ) {
      block.push(lines[index + 1].trim());
      index += 1;
    }
    out[key] = block.join(" ").replace(/\s+/g, " ").trim();
  }
  return out;
}

/**
 * The discovery digest of the exact bytes served: `sha256:` plus the
 * lowercase hex, over the SKILL.md buffer, not its string.
 *
 * @param {Buffer} bytes - the served bytes
 * @returns {string} the digest
 */
export function digestOf(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Read one file, naming it when the read fails.
 *
 * @param {string} file - the absolute path to read
 * @param {string} dir - the skills directory, for the error's relative name
 * @returns {Buffer} the file's bytes
 */
function readNamed(file, dir) {
  try {
    return readFileSync(file);
  } catch {
    throw new Error(`skills: cannot read ${path.relative(dir, file)}`);
  }
}

/**
 * Every file under a skill directory, as forward-slash relative paths in
 * sort order. The skill's own relative links resolve against these, so the
 * Worker serves the whole tree exactly as it sits on disk.
 *
 * @param {string} dir - the skill directory
 * @returns {string[]} the relative paths
 */
function listFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        found.push(path.relative(dir, absolute).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * Collect and validate every skill in the directory: each skill is a
 * directory with a SKILL.md whose front matter names it and describes it
 * in one non-empty line.
 *
 * @param {string} dir - the skills directory
 * @returns {Array<{ name: string, description: string, digest: string, files: Record<string, string> }>}
 *   the skills, in directory order
 */
export function collectSkills(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error(`skills: cannot read ${path.relative(ROOT, dir)}`);
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`skills: ${path.relative(ROOT, dir)} holds no skill; refusing an empty index`);
  }
  const collected = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) {
      throw new Error(`skills: ${name} is not a skill name`);
    }
    const skillDir = path.join(dir, name);
    const relpaths = listFiles(skillDir);
    if (!relpaths.includes("SKILL.md")) {
      throw new Error(`skills: ${name} has no SKILL.md`);
    }
    const files = {};
    for (const relpath of relpaths) {
      files[relpath] = readNamed(path.join(skillDir, relpath), dir).toString("utf8");
    }
    const front = readFrontMatter(files["SKILL.md"]);
    if (front.name !== undefined && front.name !== name) {
      throw new Error(`skills: ${name} calls itself ${front.name}`);
    }
    if ((front.description ?? "") === "") {
      throw new Error(`skills: ${name} has no description`);
    }
    collected.push({
      name,
      description: front.description,
      digest: digestOf(Buffer.from(files["SKILL.md"], "utf8")),
      files,
    });
  }
  return collected;
}

/**
 * Render the generated module: the skills as one JSON payload plus the
 * timestamp. The payload stays one line, so the generated file stays small.
 *
 * @param {string} source - the skills directory, relative to the repo root
 * @param {Array<{ name: string, description: string, digest: string, files: Record<string, string> }>} skills
 * @param {string} builtAt - the ISO-8601 stamp for this payload
 * @returns {string} the module text
 */
export function renderModule(source, skills, builtAt) {
  const payload = JSON.stringify(JSON.stringify(skills));
  return (
    `// SPDX-License-Identifier: Apache-2.0\n` +
    `/**\n` +
    ` * The bundled Agent Skills. Generated by \`npm run build:skills-index\`\n` +
    ` * from \`${source}/\` — committed, do not edit. The build validated\n` +
    ` * every skill with the discovery rules, so the request path serves\n` +
    ` * these bytes and digests without a failure mode.\n` +
    ` */\n` +
    `/** One bundled skill: its index row plus every file it serves. */\n` +
    `export interface BundledSkill {\n` +
    `  name: string;\n` +
    `  description: string;\n` +
    `  digest: string;\n` +
    `  files: Record<string, string>;\n` +
    `}\n` +
    `\n` +
    `/** When the bundled payload last changed, ISO-8601. */\n` +
    `export const SKILLS_BUILT_AT = ${JSON.stringify(builtAt)};\n` +
    `\n` +
    `/** Every bundled skill, in directory order. */\n` +
    `export const BUNDLED_SKILLS: BundledSkill[] = JSON.parse(${payload}) as BundledSkill[];\n`
  );
}

/**
 * The previous generation: its stamp and payload, or null when the file
 * is missing or unreadable (a first generation).
 *
 * @param {string} out - the generated file's path
 * @returns {{ builtAt: string, payload: string } | null}
 */
export function previousBuild(out) {
  let text;
  try {
    text = readFileSync(out, "utf8");
  } catch {
    return null;
  }
  const builtAt = /^export const SKILLS_BUILT_AT = ("(?:[^"\\]|\\.)*");$/m.exec(text);
  const payload =
    /^export const BUNDLED_SKILLS: BundledSkill\[\] = JSON\.parse\((.*)\) as BundledSkill\[];$/m.exec(
      text,
    );
  if (builtAt === null || payload === null) {
    return null;
  }
  try {
    return { builtAt: JSON.parse(builtAt[1]), payload: JSON.parse(payload[1]) };
  } catch {
    return null;
  }
}

/**
 * Validate every app's skills and write (or check) the generated modules.
 *
 * @param {{ check?: boolean, now?: () => string }} options
 * @returns {Promise<{ changed: boolean }>} whether a destination differs
 */
export async function buildSkillsIndex(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  let changed = false;
  for (const app of APPS) {
    const skills = collectSkills(app.dir);
    const payload = JSON.stringify(skills);
    const previous = previousBuild(app.out);
    const builtAt = previous !== null && previous.payload === payload ? previous.builtAt : now();
    if (previous === null || previous.payload !== payload) {
      changed = true;
    }
    if (options.check === true) {
      continue;
    }
    writeFileSync(app.out, renderModule(path.relative(ROOT, app.dir), skills, builtAt));
  }
  return { changed };
}

/** The CLI: `build-skills-index [--check]`. */
async function main(argv) {
  let check = false;
  for (const arg of argv) {
    if (arg === "--check") {
      check = true;
    } else {
      throw new Error(`skills: unknown argument ${arg}`);
    }
  }
  const { changed } = await buildSkillsIndex({ check });
  if (check && changed) {
    throw new Error(`skills: a skills-data.generated.ts is stale; run npm run build:skills-index`);
  }
}

const invoked =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
