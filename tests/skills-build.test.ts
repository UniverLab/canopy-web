// SPDX-License-Identifier: Apache-2.0
/**
 * The skills bundle as a contract: `npm run build:skills-index` validates
 * every skill in `apps/graphs/skills/` and `apps/remote/worker/skills/`
 * with the discovery rules and writes the committed
 * `skills-data.generated.ts` each Worker reads from — `--check` fails
 * when a module is stale, and a missing SKILL.md, an empty description
 * or a front-matter name that is not its own directory fails the build
 * with the skill and the reason.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectSkills,
  digestOf,
  readFrontMatter,
} from "../scripts/build-skills-index.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "build-skills-index.mjs");

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

/** Fresh scratch skills sources, removed by the caller. */
function scratch(): { dir: string; remove: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "skills-src-"));
  return {
    dir,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A minimal valid SKILL.md for a directory of this name. */
function skillText(name: string, description = "A fixture skill."): string {
  return ["---", `name: ${name}`, "description: >", `  ${description}`, "---", "", "# Fixture", ""].join(
    "\n",
  );
}

describe("the skills bundle", () => {
  it("--check passes on the committed tree", () => {
    // Both generated modules match their skills directories, and every
    // bundled skill validates: `--check` runs the same validation as the
    // build, so a malformed bundled skill fails here too.
    expect(attempt(["--check"])).toEqual({ status: 0, stderr: "" });
  });

  it("fails an unknown argument", () => {
    const failed = attempt(["--dir"]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("unknown argument");
  });

  it("fails a skill without a SKILL.md", () => {
    const { dir, remove } = scratch();
    try {
      mkdirSync(path.join(dir, "hollow"));
      writeFileSync(path.join(dir, "hollow", "README.md"), "# Hollow\n");
      expect(() => collectSkills(dir)).toThrow("hollow");
      expect(() => collectSkills(dir)).toThrow("no SKILL.md");
    } finally {
      remove();
    }
  });

  it("fails a skill whose description is empty", () => {
    const { dir, remove } = scratch();
    try {
      mkdirSync(path.join(dir, "quiet"));
      writeFileSync(path.join(dir, "quiet", "SKILL.md"), skillText("quiet", ""));
      expect(() => collectSkills(dir)).toThrow("quiet");
      expect(() => collectSkills(dir)).toThrow("no description");
    } finally {
      remove();
    }
  });

  it("fails a skill that calls itself another name", () => {
    const { dir, remove } = scratch();
    try {
      mkdirSync(path.join(dir, "renamed"));
      writeFileSync(path.join(dir, "renamed", "SKILL.md"), skillText("other"));
      expect(() => collectSkills(dir)).toThrow("renamed");
      expect(() => collectSkills(dir)).toThrow("calls itself other");
    } finally {
      remove();
    }
  });

  it("collects the files and digests the SKILL.md bytes", () => {
    const { dir, remove } = scratch();
    try {
      mkdirSync(path.join(dir, "fixture", "references"), { recursive: true });
      const text = skillText("fixture");
      writeFileSync(path.join(dir, "fixture", "SKILL.md"), text);
      writeFileSync(path.join(dir, "fixture", "references", "notes.md"), "# Notes\n");
      const [skill] = collectSkills(dir);
      expect(skill.name).toBe("fixture");
      expect(skill.description).toBe("A fixture skill.");
      expect(Object.keys(skill.files).sort()).toEqual(["SKILL.md", "references/notes.md"]);
      expect(skill.digest).toBe(`sha256:${createHash("sha256").update(text).digest("hex")}`);
    } finally {
      remove();
    }
  });
});

describe("the front-matter reader", () => {
  it("reads a folded block scalar as one line", () => {
    const source = ["---", "name: demo", "description: >", "  first line", "  second line", "---", ""].join(
      "\n",
    );
    expect(readFrontMatter(source).description).toBe("first line second line");
  });

  it("stops a block scalar at the next key", () => {
    const source = ["---", "description: >", "  folded text", "license: MIT", "---", ""].join("\n");
    const front = readFrontMatter(source);
    expect(front.description).toBe("folded text");
    expect(front.license).toBe("MIT");
  });
});

describe("the digest", () => {
  it("is a lowercase hex sha256 with the scheme prefix", () => {
    const digest = digestOf(Buffer.from("hello"));
    expect(digest).toBe(`sha256:${createHash("sha256").update("hello").digest("hex")}`);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
