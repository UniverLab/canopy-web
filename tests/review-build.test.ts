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
  `<review_prompt version="v2">`,
  `  <patterns>{{PATTERNS}}</patterns>`,
  `  <document kind="{{KIND}}" name="{{NAME}}" slug="{{SLUG}}">`,
  `    {{COMMANDS}} {{PROMPTS}} {{ATTENTION}}`,
  `  </document>`,
  `</review_prompt>`,
  ``,
].join("\n");

const DIAGRAM = [
  `sequenceDiagram`,
  `  participant Cron as Cron */15`,
  `  participant Worker as Worker`,
  `  participant Review as {{REVIEW_PROVIDER}}`,
  `  participant Browser as Browser`,
  `  Cron->>Worker: scheduled trigger`,
  `  Worker->>Review: review newest unscanned docs`,
  `  Review-->>Worker: patterns and verdict`,
  `  Browser->>Worker: GET page or API`,
  ``,
].join("\n");

/** One exported SVG of the generated module, decoded. */
function exportedSvg(module: string, name: string): string {
  const match = new RegExp(`${name} = ("(?:[^"\\\\]|\\\\.)*");`).exec(module);
  expect(match, name).not.toBeNull();
  return JSON.parse(match?.[1] ?? '""') as string;
}

/** Build this diagram source to a generated module; the build must succeed. */
function buildDiagram(source: string): string {
  const { dir, out, remove } = scratch();
  try {
    writeFileSync(path.join(dir, "prompt.v2.xml"), PROMPT);
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
    writeFileSync(path.join(dir, "prompt.v2.xml"), PROMPT);
    writeFileSync(path.join(dir, "indexing.mmd"), source);
    return attempt(["--dir", dir, "--out", out]);
  } finally {
    remove();
  }
}

const RICH_DIAGRAM = [
  `sequenceDiagram`,
  `  autonumber`,
  `  participant Cron as Cron */15`,
  `  participant Worker as Worker`,
  `  participant GitHub as GitHub`,
  `  participant Browser as Browser`,
  `  Cron->>Worker: scheduled trigger`,
  `  activate Worker`,
  `  Worker->>GitHub: read blocked.json`,
  `  GitHub-->>Worker: blocked list`,
  `  loop per repository`,
  `    Worker->>Worker: validate graph and node JSON`,
  `  end`,
  `  Worker-->>Cron: done`,
  `  deactivate Worker`,
  `  Browser->>Worker: GET page or API`,
  ``,
].join("\n");

describe("the review bundle", () => {
  it("--check passes on the committed tree", () => {
    expect(attempt(["--check"])).toEqual({ status: 0, stderr: "" });
  });

  it("builds a valid fixture to SVG and --check detects drift", () => {
    const { dir, out, remove } = scratch();
    try {
      writeFileSync(path.join(dir, "prompt.v2.xml"), PROMPT);
      writeFileSync(path.join(dir, "indexing.mmd"), DIAGRAM);
      expect(attempt(["--dir", dir, "--out", out]).status).toBe(0);
      expect(existsSync(out)).toBe(true);
      const module = readFileSync(out, "utf8");
      expect(module).toContain(`REVIEW_PROMPT_VERSION = "v2"`);
      expect(module).toContain("{{COMMANDS}}");
      expect(module).toContain("sequenceDiagram");
      expect(module).toContain("<svg");
      expect(module).toContain("Cron");
      expect(module).toContain("scheduled trigger");
      expect(attempt(["--check", "--dir", dir, "--out", out]).status).toBe(0);
      writeFileSync(path.join(dir, "indexing.mmd"), DIAGRAM.replace("scheduled trigger", "changed"));
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
      writeFileSync(path.join(dir, "prompt.v2.xml"), `<review_prompt version="v2">no facts</review_prompt>\n`);
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
      writeFileSync(path.join(dir, "prompt.v2.xml"), PROMPT);
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
  it("emits the wide and mobile SVGs with the token and both phases", () => {
    const module = buildDiagram(DIAGRAM);
    const wide = exportedSvg(module, "INDEXING_SVG");
    const mobile = exportedSvg(module, "INDEXING_MOBILE_SVG");
    expect(wide).toContain("<svg");
    expect(mobile).toContain("<svg");
    for (const svg of [wide, mobile]) {
      expect(svg).toContain("{{REVIEW_PROVIDER}}");
      expect(svg).toContain("Index");
      expect(svg).toContain("Serve");
    }
    expect(wide).toContain("1 · Index");
    expect(wide).toContain("2 · Serve");
    expect(wide).toContain("every 15 minutes");
    expect(wide).toContain("on every request");
  });

  it("sources every participant colour from the page tokens", () => {
    const real = readFileSync(path.join(ROOT, "apps", "graphs", "review", "indexing.mmd"), "utf8");
    for (const svg of [exportedSvg(buildDiagram(real), "INDEXING_SVG"), exportedSvg(buildDiagram(real), "INDEXING_MOBILE_SVG")]) {
      for (const token of ["--attention", "--teal", "--surface-ink", "--canopy", "--phosphor"]) {
        expect(svg).toContain(`var(${token},`);
      }
      expect(svg).not.toContain("currentColor");
    }
  });

  it("draws activation bars over the lanes", () => {
    expect(exportedSvg(buildDiagram(RICH_DIAGRAM), "INDEXING_SVG")).toContain("opacity:.22");
  });

  it("renders replies dotted and calls solid", () => {
    const wide = exportedSvg(buildDiagram(RICH_DIAGRAM), "INDEXING_SVG");
    expect(wide).toContain("stroke-dasharray:5 4");
    expect(wide).toContain(`class="reply"`);
    expect(wide).toContain(`class="msg"`);
  });

  it("numbers every arrow at its origin, in order", () => {
    const wide = exportedSvg(buildDiagram(DIAGRAM), "INDEXING_SVG");
    const one = wide.indexOf(">1<");
    const two = wide.indexOf(">2<");
    const three = wide.indexOf(">3<");
    expect(one).toBeGreaterThan(-1);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
    // The wide art always numbers, autonumber or not.
    expect(exportedSvg(buildDiagram(RICH_DIAGRAM), "INDEXING_SVG")).toContain(`class="num"`);
    expect(exportedSvg(buildDiagram(DIAGRAM), "INDEXING_SVG")).toContain(`class="num"`);
  });

  it("frames loops with their labels and draws the self-call", () => {
    const wide = exportedSvg(buildDiagram(RICH_DIAGRAM), "INDEXING_SVG");
    expect(wide).toContain("loop · per repository");
    expect(wide).toContain(`class="msg" d="M`);
  });

  it("keeps the mobile timeline numberless with filled calls and hollow replies", () => {
    const mobile = exportedSvg(buildDiagram(DIAGRAM), "INDEXING_MOBILE_SVG");
    expect(mobile).not.toContain(`class="num"`);
    expect(mobile).toContain(`r="5"`);
    expect(mobile).toContain(`r="3.5"`);
    expect(mobile).toContain("Cron");
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
