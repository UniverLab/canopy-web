// SPDX-License-Identifier: Apache-2.0
// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The dead Fit switch is gone: neither the app source nor its tests may
// name its remembered state again. The word is assembled at run time so
// this test's own source does not match the scan.
const BANNED = "fit" + "Only";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("removed Fit preference", () => {
  it(`mentions ${BANNED} nowhere in src/ or test/`, () => {
    const root = join(process.cwd(), "apps/remote/web");
    const offenders = [...filesUnder(join(root, "src")), ...filesUnder(join(root, "test"))]
      .filter((path) => readFileSync(path, "utf8").includes(BANNED))
      .map((path) => path.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});
