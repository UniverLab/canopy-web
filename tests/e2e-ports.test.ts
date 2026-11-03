// SPDX-License-Identifier: Apache-2.0
/**
 * The e2e suites share one machine with sibling checkouts and stale runs,
 * so no Playwright server may pin a fixed port: the second concurrent run
 * failed with "already used". Each suite computes its port with
 * scripts/e2e-port.mjs instead (per checkout and per process, inside a
 * window its neighbours never reach), and no spec names a port — cookies
 * go by domain, URLs stay relative off baseURL.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { E2E_PORT_SPAN, e2ePort } from "../scripts/e2e-port.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A suite's Playwright config: file, port window, and pin variable. */
const SUITES: Array<{ file: string; base: number; env: string }> = [
  { file: "apps/remote/web/playwright.config.ts", base: 5199, env: "E2E_PORT_SMOKE" },
  { file: "apps/remote/web/playwright.serve.config.ts", base: 8787, env: "E2E_PORT_SERVE" },
  { file: "apps/graphs/playwright.config.ts", base: 9300, env: "E2E_PORT_GRAPHS" },
];

function configSource(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

/** A fresh port computation, as the run's first config load would make. */
function freshPort(base: number, salt: string, env: string): number {
  delete process.env[env];
  try {
    return e2ePort(base, salt, env);
  } finally {
    delete process.env[env];
  }
}

describe("e2ePort", () => {
  it("stays an integer inside its suite window", () => {
    for (let salt = 0; salt < 64; salt++) {
      const port = freshPort(5199, `checkout-${salt}`, "E2E_PORT_TEST_RANGE");
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(5199);
      expect(port).toBeLessThan(5199 + E2E_PORT_SPAN);
    }
  });

  it("is deterministic for one process", () => {
    expect(freshPort(5199, "same-salt", "E2E_PORT_TEST_DET")).toBe(
      freshPort(5199, "same-salt", "E2E_PORT_TEST_DET"),
    );
  });

  it("spreads distinct checkouts over the window", () => {
    const ports = new Set<number>();
    for (let salt = 0; salt < 64; salt++) {
      ports.add(freshPort(5199, `checkout-${salt}`, "E2E_PORT_TEST_SPREAD"));
    }
    // Residues of distinct hashes: pid-independent, so this holds on
    // every run. 64 salts over 512 slots land on 57 today; the floor
    // only guards against a future edit collapsing the spread.
    expect(ports.size).toBeGreaterThanOrEqual(50);
  });

  it("pins the first load's port for every later load", () => {
    // Every Playwright worker re-loads the config in its own process,
    // while one server listens: without the pin each worker would aim
    // at its own pid-shifted port and find nothing there.
    const env = "E2E_PORT_TEST_PIN";
    delete process.env[env];
    try {
      const first = e2ePort(5199, "checkout-a", env);
      expect(e2ePort(5199, "checkout-a", env)).toBe(first);
    } finally {
      delete process.env[env];
    }
  });

  it("honours a preset variable and refuses a bogus one", () => {
    const env = "E2E_PORT_TEST_PRESET";
    process.env[env] = "5432";
    try {
      expect(e2ePort(5199, "checkout-a", env)).toBe(5432);
    } finally {
      delete process.env[env];
    }
    process.env[env] = "not-a-port";
    try {
      expect(() => e2ePort(5199, "checkout-a", env)).toThrow("is not a port");
    } finally {
      delete process.env[env];
    }
  });
});

describe("the Playwright suites", () => {
  it("compute their ports with e2ePort, never a fixed literal", () => {
    for (const suite of SUITES) {
      const source = configSource(suite.file);
      expect(source, suite.file).toContain(
        `e2ePort(${suite.base}, import.meta.dirname, "${suite.env}")`,
      );
      // The e2ePort base is the one place a port literal may appear:
      // baseURL, the server command and the health URL all render it.
      const withoutBase = source.replace(
        /e2ePort\(\d+, import\.meta\.dirname, "E2E_PORT_[A-Z]+"\)/,
        "",
      );
      expect(withoutBase, suite.file).not.toMatch(/5199|8787|8790|9300/);
    }
  });

  it("keeps the three port windows disjoint", () => {
    const windows = SUITES.map((suite) => [suite.base, suite.base + E2E_PORT_SPAN] as const);
    for (const [a, b] of windows) {
      for (const [c, d] of windows) {
        if (a === c) {
          continue;
        }
        expect(a < d && c < b, `${a}-${b} overlaps ${c}-${d}`).toBe(false);
      }
    }
  });

  it("starts its own server on every suite", () => {
    for (const suite of SUITES) {
      expect(configSource(suite.file), suite.file).toContain("reuseExistingServer: false");
    }
  });
});

describe("the e2e specs", () => {
  it("name no suite port", () => {
    const spec = readFileSync(path.join(ROOT, "apps/remote/web/test/turn.spec.ts"), "utf8");
    expect(spec).not.toMatch(/5199|8787|8790|9300/);
    expect(spec).toContain('domain: "127.0.0.1"');
  });
});
