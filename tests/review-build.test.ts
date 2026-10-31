// SPDX-License-Identifier: Apache-2.0
/**
 * The review bundle as a contract: `npm run build:review-assets` validates
 * the versioned prompt and the indexing `sequenceDiagram` in
 * `apps/graphs/review/` and writes the committed
 * `review-assets.generated.ts` — `--check` fails when the module is stale,
 * a prompt without its fact placeholders fails, and a diagram line the
 * renderer cannot read fails with the line and the reason.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "build-review-assets.mjs");

interface Attempt {
  status: number | null;
  stderr: string;
}

/** Run the builder over these args; a failure arrives as a status, never a throw. */
function attempt(args: string[]): Attempt {
  try {
    execFileSync("node", [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number | null; stderr?: unknown };
    return {
      status: failed.status ?? null,
      stderr: typeof failed.stderr === "string" ? failed.stderr : String(failed.stderr ?? ""),
    };
  }
}

/** Fresh scratch sources plus an output path beside them. */
function scratch(): { dir: string; out: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "review-src-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "review-out-"));
  return {
    dir,
    out: path.join(outDir, "out.ts"),
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

const PROMPT = [
  `<review_prompt version="v1">`,
  `  <patterns>{{PATTERNS}}</patterns>`,
  `  <document kind="{{KIND}}" name="{{NAME}}" slug="{{SLUG}}">`,
  `    {{COMMANDS}} {{PROMPTS}} {{ATTENTION}}`,
  `  </document>`,
  `</review_prompt>`,
  ``,
].join("\n");

const DIAGRAM = [
  `sequenceDiagram`,
  `  participant A as Alpha`,
  `  participant B as Beta`,
  `  A->>B: hello`,
  `  B-->>A: hi back`,
  ``,
].join("\n");

/** Build this diagram source to a generated module; the build must succeed. */
function buildDiagram(source: string): string {
  const { dir, out, remove } = scratch();
  try {
    writeFileSync(path.join(dir, "prompt.v1.xml"), PROMPT);
    writeFileSync(path.join(dir, "indexing.mmd"), source);
    const result = attempt(["--dir", dir, "--out", out]);
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(out, "utf8");
  } finally {
    remove();
  }
}

/** Attempt this diagram source; the caller asserts on the failure. */
function failDiagram(source: string): Attempt {
  const { dir, out, remove } = scratch();
  try {
    writeFileSync(path.join(dir, "prompt.v1.xml"), PROMPT);
    writeFileSync(path.join(dir, "indexing.mmd"), source);
    return attempt(["--dir", dir, "--out", out]);
  } finally {
    remove();
  }
}

const RICH_DIAGRAM = [
  `sequenceDiagram`,
  `  autonumber`,
  `  participant A as Alpha`,
  `  participant B as Beta`,
  `  A->>B: hello`,
  `  activate B`,
  `  B-->>A: hi back`,
  `  deactivate B`,
  `  loop every one`,
  `    A->>A: think`,
  `  end`,
  ``,
].join("\n");

describe("the review bundle", () => {
  it("--check passes on the committed tree", () => {
    expect(attempt(["--check"])).toEqual({ status: 0, stderr: "" });
  });

  it("builds a valid fixture to SVG and --check detects drift", () => {
    const { dir, out, remove } = scratch();
    try {
      writeFileSync(path.join(dir, "prompt.v1.xml"), PROMPT);
      writeFileSync(path.join(dir, "indexing.mmd"), DIAGRAM);
      expect(attempt(["--dir", dir, "--out", out]).status).toBe(0);
      expect(existsSync(out)).toBe(true);
      const module = readFileSync(out, "utf8");
      expect(module).toContain(`REVIEW_PROMPT_VERSION = "v1"`);
      expect(module).toContain("{{COMMANDS}}");
      expect(module).toContain("sequenceDiagram");
      expect(module).toContain("<svg");
      expect(module).toContain("Alpha");
      expect(module).toContain("hello");
      expect(attempt(["--check", "--dir", dir, "--out", out]).status).toBe(0);
      writeFileSync(path.join(dir, "indexing.mmd"), DIAGRAM.replace("hello", "changed"));
      const stale = attempt(["--check", "--dir", dir, "--out", out]);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("is stale");
    } finally {
      remove();
    }
  });

  it("fails a prompt without its fact placeholders", () => {
    const { dir, out, remove } = scratch();
    try {
      writeFileSync(path.join(dir, "prompt.v1.xml"), `<review_prompt version="v1">no facts</review_prompt>\n`);
      writeFileSync(path.join(dir, "indexing.mmd"), DIAGRAM);
      const failed = attempt(["--dir", dir, "--out", out]);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("placeholders");
      expect(existsSync(out)).toBe(false);
    } finally {
      remove();
    }
  });

  it("fails a diagram line the renderer cannot read", () => {
    const { dir, out, remove } = scratch();
    try {
      writeFileSync(path.join(dir, "prompt.v1.xml"), PROMPT);
      writeFileSync(path.join(dir, "indexing.mmd"), `${DIAGRAM}  this is not a message\n`);
      const failed = attempt(["--dir", dir, "--out", out]);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("cannot parse diagram line");
      expect(existsSync(out)).toBe(false);
    } finally {
      remove();
    }
  });
});

describe("the sequence renderer", () => {
  it("draws activation boxes between activate and deactivate", () => {
    const module = buildDiagram(RICH_DIAGRAM);
    expect(module).toContain(`fill-opacity=\\"0.12\\"`);
  });

  it("renders replies dashed and lighter than calls", () => {
    const module = buildDiagram(RICH_DIAGRAM);
    expect(module).toContain(`stroke-dasharray=\\"4 3\\" opacity=\\"0.65\\"`);
    expect(module).toContain(`stroke=\\"currentColor\\"/>`);
  });

  it("numbers every arrow in order when autonumber is set", () => {
    const module = buildDiagram(RICH_DIAGRAM);
    const one = module.indexOf(">1<");
    const two = module.indexOf(">2<");
    const three = module.indexOf(">3<");
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
    expect(buildDiagram(DIAGRAM)).not.toContain(`rx=\\"8\\"`);
  });

  it("frames loops with their labels", () => {
    expect(buildDiagram(RICH_DIAGRAM)).toContain("loop every one");
  });

  it("fails the strict grammar with the line and the reason", () => {
    const cases: Array<[string, string, string]> = [
      ["activate names an unknown participant", `  activate Z\n`, "unknown participant"],
      ["double activate", `  activate A\n  activate A\n`, "already active"],
      ["deactivate without activate", `  deactivate A\n`, "without activate"],
      ["end without a loop", `  end\n`, "without a loop"],
      ["nested loops", `  loop outer\n  loop inner\n`, "nested loops"],
      ["loop without a label", `  loop\n`, "without a label"],
      ["unclosed loop", `  loop outer\n  A->>B: hello\n`, "unclosed"],
      ["unclosed activation", `  activate A\n  A->>B: hello\n`, "leaves A active"],
    ];
    for (const [name, extra, reason] of cases) {
      const source = [
        `sequenceDiagram`,
        `  participant A as Alpha`,
        `  participant B as Beta`,
        extra,
        ``,
      ].join("\n");
      const failed = failDiagram(source);
      expect(failed.status, name).toBe(1);
      expect(failed.stderr, name).toContain(reason);
    }
  });
});
