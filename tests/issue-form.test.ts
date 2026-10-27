// SPDX-License-Identifier: Apache-2.0
/**
 * The report issue form as a contract: valid YAML, named and labelled, with
 * every field the catalogue pre-fills — imported from the one constant the
 * page builds its URL from, so the form and the link cannot drift. The YAML
 * is parsed by whichever parser the machine already ships (python3 with
 * PyYAML first, then yq), exactly as `tests/ci.test.ts` does.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_PREFILL_IDS } from "../apps/graphs/src/pages/report.js";

const TEMPLATE = path.resolve(
  import.meta.dirname,
  "../.github/ISSUE_TEMPLATE/report-document.yml",
);
const CONFIG = path.resolve(import.meta.dirname, "../.github/ISSUE_TEMPLATE/config.yml");

interface Field {
  id?: string;
  type?: string;
  attributes?: {
    label?: string;
    options?: string[];
  };
  validations?: { required?: boolean };
}

interface Form {
  name?: string;
  description?: string;
  labels?: string[];
  body?: Field[];
}

interface Config {
  blank_issues_enabled?: boolean;
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

/** Parse a YAML file; a malformed document makes this throw. */
function parseYaml<T>(file: string): T {
  const source = readFileSync(file, "utf8");
  if (available("python3", ["-c", "import yaml"])) {
    const json = execFileSync(
      "python3",
      ["-c", "import sys, yaml, json; print(json.dumps(yaml.safe_load(sys.stdin.read())))"],
      { input: source, encoding: "utf8" },
    );
    return JSON.parse(json) as T;
  }
  if (available("yq", ["--version"])) {
    const json = execFileSync("yq", ["eval", "-o=json", "."], {
      input: source,
      encoding: "utf8",
    });
    return JSON.parse(json) as T;
  }
  throw new Error(`${file} needs a YAML parser: install python3 with PyYAML, or yq`);
}

function fields(): Field[] {
  return parseYaml<Form>(TEMPLATE).body ?? [];
}

function fieldWith(id: string): Field | undefined {
  return fields().find((field) => field.id === id);
}

describe("the report issue form", () => {
  it("is valid YAML, named and labelled", () => {
    const form = parseYaml<Form>(TEMPLATE);
    expect(form.name).toBe("Report a graph or node");
    expect(form.labels).toContain("report");
  });

  it("carries one field per pre-fill parameter, with the ids the URL uses", () => {
    const ids = fields().map((field) => field.id ?? "");
    for (const id of REPORT_PREFILL_IDS) {
      expect(ids, id).toContain(id);
    }
    // The remaining fields are what a reporter writes, not what we pre-fill.
    expect(ids).toEqual([...REPORT_PREFILL_IDS, "reason", "details"]);
  });

  it("asks for the catalogue URL, the kind and the source repository", () => {
    expect(fieldWith("document")?.type).toBe("input");
    expect(fieldWith("document")?.validations?.required).toBe(true);
    expect(fieldWith("kind")?.type).toBe("dropdown");
    expect(fieldWith("kind")?.attributes?.options).toEqual(["graph", "node"]);
    expect(fieldWith("source")?.type).toBe("input");
  });

  it("asks why, with the six reasons, and for details", () => {
    const reason = fieldWith("reason");
    expect(reason?.type).toBe("dropdown");
    expect(reason?.validations?.required).toBe(true);
    expect(reason?.attributes?.options).toEqual([
      "Malicious or dangerous command",
      "Misleading description",
      "Prompt that steers the agent to do harm",
      "Broken or invalid",
      "Copyright or licence",
      "Other",
    ]);
    expect(fieldWith("details")?.type).toBe("textarea");
    expect(fieldWith("details")?.validations?.required).toBe(true);
  });

  it("keeps blank issues enabled", () => {
    expect(parseYaml<Config>(CONFIG).blank_issues_enabled).toBe(true);
  });
});
