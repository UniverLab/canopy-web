// SPDX-License-Identifier: Apache-2.0
/**
 * The CI workflow as a contract: valid YAML, pull requests only, and an
 * `e2e` job that gates the Playwright suites beside the five jobs already
 * there. The document is parsed by whichever YAML parser the machine
 * already ships — python3 with PyYAML first, then yq — so no dependency
 * exists just to read one file. PyYAML reads `on` as the YAML 1.1 boolean
 * `true`, so the trigger may arrive under either key.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = path.resolve(import.meta.dirname, "../.github/workflows/ci.yml");

interface Step {
  uses?: string;
  run?: string;
}

interface Job {
  needs?: string;
  steps?: Step[];
}

interface Workflow {
  jobs?: Record<string, Job>;
  /** The trigger map: under `on`, or under `true` for a YAML 1.1 parser. */
  on?: Record<string, unknown>;
  true?: Record<string, unknown>;
}

/** Does this parser exist on this machine? Runs it for its exit status. */
function available(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Parse the workflow as YAML; a malformed document makes this throw. */
function parseWorkflow(): Workflow {
  const source = readFileSync(WORKFLOW, "utf8");
  if (available("python3", ["-c", "import yaml"])) {
    const json = execFileSync(
      "python3",
      ["-c", "import sys, yaml, json; print(json.dumps(yaml.safe_load(sys.stdin.read())))"],
      { input: source, encoding: "utf8" },
    );
    return JSON.parse(json) as Workflow;
  }
  if (available("yq", ["--version"])) {
    const json = execFileSync("yq", ["eval", "-o=json", "."], {
      input: source,
      encoding: "utf8",
    });
    return JSON.parse(json) as Workflow;
  }
  throw new Error(`${WORKFLOW} needs a YAML parser: install python3 with PyYAML, or yq`);
}

/** The trigger map of the workflow, whatever the parser called the key. */
function triggers(workflow: Workflow): Record<string, unknown> {
  return workflow.on ?? workflow.true ?? {};
}

describe("the CI workflow", () => {
  it("is valid YAML", () => {
    expect(parseWorkflow().jobs).toBeDefined();
  });

  it("runs on pull requests only", () => {
    expect(Object.keys(triggers(parseWorkflow()))).toEqual(["pull_request"]);
    expect(readFileSync(WORKFLOW, "utf8")).not.toMatch(/^\s*push:/m);
  });

  it("keeps the five existing jobs and adds the e2e gate", () => {
    const jobs = parseWorkflow().jobs ?? {};
    expect(Object.keys(jobs)).toEqual(["install", "lint", "typecheck", "test", "validate", "e2e"]);
    for (const job of ["lint", "typecheck", "test", "validate", "e2e"]) {
      expect(jobs[job]?.needs, job).toBe("install");
    }
  });

  it("installs Chromium and runs the browser suites in the e2e job", () => {
    const runs = (parseWorkflow().jobs?.e2e?.steps ?? []).map((step) => step.run ?? "");
    expect(runs).toContain("npm ci");
    expect(runs).toContain("npx playwright install --with-deps chromium");
    expect(runs).toContain("npm run test:e2e");
  });
});
