// SPDX-License-Identifier: Apache-2.0
/**
 * The pattern bundle as a contract: `npm run build:patterns` validates
 * every page in `apps/graphs/patterns/` with the site's own parsing rules
 * and writes the committed `patterns-data.generated.ts` — `--check` fails
 * when the module is stale, and a malformed page, a missing figure or an
 * unreferenced file fails the build with the file and the reason.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "build-patterns.mjs");

interface Attempt {
  status: number | null;
  stderr: string;
}

/** Run the builder over these args; a failure arrives as a status, never a throw. */
function attempt(args: string[]): Attempt {
  try {
    execFileSync("npx", ["--no-install", "tsx", SCRIPT, ...args], {
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

/**
 * Fresh scratch sources plus an output path beside them (never inside:
 * the builder rejects any file in the sources no page references).
 */
function scratch(): { dir: string; out: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "patterns-src-"));
  const outDir = mkdtempSync(path.join(tmpdir(), "patterns-out-"));
  return {
    dir,
    out: path.join(outDir, "out.ts"),
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

/** A minimal valid page naming its own figure. */
function pageText(overrides: { status?: string; figure?: string } = {}): string {
  return [
    "---",
    "title: Fixture",
    "summary: A fixture page.",
    `status: ${overrides.status ?? "standard"}`,
    "implements: []",
    `figure: ${overrides.figure ?? "fixture.figure.json"}`,
    "sources:",
    "  - title: Canopy docs",
    "    url: https://univerlab.org/canopy/",
    "---",
    "",
    "The fixture page.",
    "",
  ].join("\n");
}

/** A minimal figure that passes the graph schema. */
const FIGURE_TEXT = JSON.stringify({
  format_version: 6,
  name: "fixture",
  nodes: [],
  edges: [],
});

describe("the pattern bundle", () => {
  it("--check passes on the committed tree", () => {
    // The committed module matches `apps/graphs/patterns/`, and every
    // page in it validates: `--check` runs the same validation as the
    // build, so a malformed bundled page fails here too.
    expect(attempt(["--check"])).toEqual({ status: 0, stderr: "" });
  });

  it("fails a malformed page with the file and the reason", () => {
    const { dir, out, remove } = scratch();
    try {
      writeFileSync(path.join(dir, "bad.md"), pageText({ status: "canon", figure: "bad.figure.json" }));
      writeFileSync(path.join(dir, "bad.figure.json"), FIGURE_TEXT);
      const failed = attempt(["--dir", dir, "--out", out]);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("bad.md");
      expect(failed.stderr).toContain("malformed front matter");
      expect(existsSync(out)).toBe(false);
    } finally {
      remove();
    }
  });

  it("fails a page whose figure is missing", () => {
    const { dir, out, remove } = scratch();
    try {
      writeFileSync(path.join(dir, "ghost.md"), pageText({ figure: "ghost.figure.json" }));
      const failed = attempt(["--dir", dir, "--out", out]);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("ghost.md");
      expect(failed.stderr).toContain("missing figure");
      expect(existsSync(out)).toBe(false);
    } finally {
      remove();
    }
  });

  it("fails a figure no page names", () => {
    const { dir, out, remove } = scratch();
    try {
      writeFileSync(path.join(dir, "fixture.md"), pageText());
      writeFileSync(path.join(dir, "fixture.figure.json"), FIGURE_TEXT);
      writeFileSync(path.join(dir, "orphan.figure.json"), FIGURE_TEXT);
      const failed = attempt(["--dir", dir, "--out", out]);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("orphan.figure.json");
      expect(failed.stderr).toContain("named by no page");
      expect(existsSync(out)).toBe(false);
    } finally {
      remove();
    }
  });

  it("builds a valid fixture and --check detects drift", () => {
    const { dir, out, remove } = scratch();
    try {
      writeFileSync(path.join(dir, "fixture.md"), pageText());
      writeFileSync(path.join(dir, "fixture.figure.json"), FIGURE_TEXT);
      expect(attempt(["--dir", dir, "--out", out]).status).toBe(0);
      expect(existsSync(out)).toBe(true);
      expect(attempt(["--check", "--dir", dir, "--out", out]).status).toBe(0);
      writeFileSync(path.join(dir, "fixture.md"), pageText().replace("standard", "experiment"));
      const stale = attempt(["--check", "--dir", dir, "--out", out]);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("is stale");
    } finally {
      remove();
    }
  });
});
