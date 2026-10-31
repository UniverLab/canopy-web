// SPDX-License-Identifier: Apache-2.0
/**
 * One real Meta review from the laptop: `npm run review:local -- <fixture>`.
 *
 * The documented local end-to-end proof for the `meta` review provider.
 * It reads the key from `apps/graphs/.dev.vars` (never from argv, never
 * printed), fills the same versioned prompt the Worker sends, posts it to
 * the configured `META_API_BASE_URL` with the configured `REVIEW_MODEL`,
 * and prints the verdict plus the token usage. Without the key — or
 * without the endpoint or the model — it refuses with a clear error and
 * sends nothing. The fixture is one graph or node document as JSON; the
 * coordinates default to a local stand-in and accept overrides:
 *
 *   npm run review:local -- apps/graphs/review/local-fixture.json
 *   npm run review:local -- doc.json --kind=node --owner=acme --repo=things --slug=cool
 *
 * Run with tsx (`npm run review:local`); plain `process.stdout` writes,
 * so the no-console rule stays satisfied.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { DocumentKind, JsonValue } from "../src/schema.js";
import { bundledPatterns } from "../apps/graphs/src/patterns-bundled.js";
import { createMetaProvider } from "../apps/graphs/src/review-meta.js";
import type { ReviewDocument } from "../apps/graphs/src/review.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_VARS = path.join(ROOT, "apps", "graphs", ".dev.vars");

/** Write one stdout line. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Write one stderr line. */
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

const USAGE = [
  "usage: npm run review:local -- <fixture.json> [--kind=graph|node] [--owner=o] [--repo=r] [--slug=s] [--name=n]",
  "The Meta key comes from apps/graphs/.dev.vars (see .dev.vars.example); nothing secret is printed.",
].join("\n");

/** Read `KEY=VALUE` lines: blanks and `#` comments skipped, quotes stripped. */
function readDevVars(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals < 0) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") {
      values[key] = value;
    }
  }
  return values;
}

interface LocalArgs {
  fixture: string;
  kind: DocumentKind;
  owner: string;
  repo: string;
  slug: string;
  name: string;
}

/** Parse argv: one positional fixture plus `--key=value` coordinates. */
function parseArgs(argv: string[]): LocalArgs | null {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals < 0) {
        return null;
      }
      flags[arg.slice(2, equals)] = arg.slice(equals + 1);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1 || positional[0] === "") {
    return null;
  }
  const kind = flags["kind"] ?? "graph";
  if (kind !== "graph" && kind !== "node") {
    return null;
  }
  const fallback = path.basename(positional[0] as string).replace(/\.json$/i, "") || "fixture";
  const slug = flags["slug"] ?? fallback;
  return {
    fixture: positional[0] as string,
    kind,
    owner: flags["owner"] ?? "local",
    repo: flags["repo"] ?? "fixture",
    slug,
    name: flags["name"] ?? slug,
  };
}

/** Fail with a clear line; values (and the key above all) are never echoed. */
function refuse(message: string): never {
  err(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    err(USAGE);
    process.exit(1);
  }
  let document: JsonValue;
  try {
    document = JSON.parse(readFileSync(path.resolve(args.fixture), "utf8")) as JsonValue;
  } catch {
    refuse(`review:local: cannot read the fixture ${args.fixture}`);
  }
  if (!existsSync(DEV_VARS)) {
    refuse(
      "review:local: no apps/graphs/.dev.vars — copy apps/graphs/.dev.vars.example there and set META_API_KEY",
    );
  }
  const vars = readDevVars(DEV_VARS);
  const apiKey = vars["META_API_KEY"] ?? "";
  const baseUrl = vars["META_API_BASE_URL"] ?? "";
  const model = vars["REVIEW_MODEL"] ?? "";
  if (apiKey === "") {
    refuse("review:local: META_API_KEY is empty in apps/graphs/.dev.vars; refusing without the key");
  }
  if (baseUrl === "") {
    refuse("review:local: META_API_BASE_URL is empty in apps/graphs/.dev.vars; refusing without the endpoint");
  }
  if (model === "") {
    refuse("review:local: REVIEW_MODEL is empty in apps/graphs/.dev.vars; refusing without the model");
  }
  const bundled = await bundledPatterns();
  const lines: string[] = [];
  const provider = createMetaProvider({
    apiKey,
    baseUrl,
    model,
    patternSlugs: bundled.entries.map((entry) => entry.slug),
    effort: vars["REVIEW_EFFORT"],
    maxTokens: vars["REVIEW_MAX_TOKENS"],
    log: (line) => {
      lines.push(line);
    },
  });
  const input: ReviewDocument = {
    kind: args.kind,
    owner: args.owner,
    repo: args.repo,
    slug: args.slug,
    name: args.name,
    document,
  };
  let result;
  try {
    result = await provider.review(input);
  } catch (error) {
    refuse(`review:local: the review failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  out(`verdict: ${result.verdict}`);
  out(`reasons: ${result.reasons === "" ? "(none)" : result.reasons}`);
  out(`patterns: ${result.patterns.length === 0 ? "(none)" : result.patterns.join(", ")}`);
  out(`model: ${provider.model}`);
  for (const line of lines) {
    out(line);
  }
}

void main();
