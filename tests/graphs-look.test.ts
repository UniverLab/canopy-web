// SPDX-License-Identifier: Apache-2.0
/**
 * The catalogue's dress as a contract: the kit's tokens keep the text
 * readable on the Canopy surface (WCAG AA, 4.5:1), the Worker serves the
 * generated look kit through `[assets]` while the API and install routes
 * keep running first in the Worker, the unit tests load a config without
 * assets, and the deploy builds the kit before wrangler runs. The visual
 * side (surface colour, loaded faces, colophon) is checked in a browser by
 * test/e2e/visual.spec.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKENS = path.join(ROOT, "packages", "look", "tokens.css");
const WRANGLER = path.join(ROOT, "apps", "graphs", "wrangler.toml");
const WRANGLER_E2E = path.join(ROOT, "apps", "graphs", "wrangler.e2e.toml");
const VITEST = path.join(ROOT, "apps", "graphs", "vitest.config.ts");
const DEPLOY = path.join(ROOT, ".github", "workflows", "deploy.yml");
const PACKAGE = path.join(ROOT, "package.json");

/** One token's value, as the kit declares it: `--name: #rrggbb;`. */
function token(css: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (match?.[1] === undefined) {
    throw new Error(`token --${name} not found in ${TOKENS}`);
  }
  return match[1];
}

/** WCAG relative luminance of an opaque #rrggbb colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

/** WCAG contrast ratio between two opaque #rrggbb colours, 1..21. */
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

/** `color-mix(in srgb, ink amount, base)` over two opaque #rrggbb colours. */
function mix(ink: string, base: string, amount: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const top = parseInt(ink.slice(offset, offset + 2), 16);
    const bottom = parseInt(base.slice(offset, offset + 2), 16);
    return Math.round(top * amount + bottom * (1 - amount)).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

describe("the tokens on the Canopy surface", () => {
  const css = readFileSync(TOKENS, "utf8");
  const bg = token(css, "bg-deep");
  const raise = token(css, "surface-bg-raise");
  const ink = token(css, "surface-ink");
  const dim = token(css, "surface-ink-dim");
  const faint = token(css, "surface-ink-faint");
  const teal = token(css, "teal");

  const pairs: Array<[string, string, string]> = [
    ["body ink on the surface", ink, bg],
    ["dim ink on the surface", dim, bg],
    ["faint ink on the surface", faint, bg],
    ["body ink on a card", ink, raise],
    ["dim ink on a card", dim, raise],
    ["faint ink on a card", faint, raise],
    ["link teal on the surface", teal, bg],
    ["link teal on a card", teal, raise],
  ];

  it.each(pairs)("keeps %s at 4.5:1 or better", (_label, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it("pins the lowest pair at 5.35:1, the faint stats on a card", () => {
    const ratios = pairs.map(([, foreground, background]) => contrast(foreground, background));
    expect(Math.min(...ratios)).toBeCloseTo(5.35, 1);
  });
});

describe("the install command field", () => {
  const css = readFileSync(TOKENS, "utf8");
  const field = token(css, "command-bg");
  const line = token(css, "command-line");
  const ink = token(css, "surface-ink");
  const card = token(css, "surface-panel");
  const page = token(css, "bg-deep");

  // The site ships one colour scheme (dark), so the "both schemes" pair is
  // the pair the field is painted on: a card and the page. A future light
  // scheme joins this list, it does not replace it.
  const hosts: Array<[string, string]> = [
    ["a card", card],
    ["the page", page],
  ];

  it.each(hosts)("keeps the field on %s at 1.5:1 or better", (_label, host) => {
    expect(contrast(field, host)).toBeGreaterThanOrEqual(1.5);
  });

  it("keeps the command ink on the field at 7:1 or better", () => {
    expect(contrast(ink, field)).toBeGreaterThanOrEqual(7);
  });

  it("keeps the field's outline visible on the field and on its host", () => {
    expect(contrast(line, field)).toBeGreaterThanOrEqual(2);
    for (const [, host] of hosts) {
      expect(contrast(line, host)).toBeGreaterThanOrEqual(3);
    }
  });

  it("pins the field's ratios: 2.13:1 on a card, 1.83:1 on the page, 9.3:1 for the ink", () => {
    expect(contrast(field, card)).toBeCloseTo(2.13, 1);
    expect(contrast(field, page)).toBeCloseTo(1.83, 1);
    expect(contrast(ink, field)).toBeCloseTo(9.3, 1);
  });
});

describe("the verdict inks", () => {
  const css = readFileSync(TOKENS, "utf8");
  const page = token(css, "page");
  const panel = token(css, "surface-panel");
  const inks: Array<[string, string]> = [
    ["looks-safe", token(css, "canopy")],
    ["needs-look", token(css, "attention")],
    ["flagged", token(css, "err-label")],
  ];

  it.each(inks)("keeps %s on the page at 4.5:1 or better", (_label, ink) => {
    expect(contrast(ink, page)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(inks)("keeps %s on its own 12% wash at 4.5:1 or better", (_label, ink) => {
    expect(contrast(ink, mix(ink, panel, 0.12))).toBeGreaterThanOrEqual(4.5);
  });

  it("pins the lowest verdict pair at 6.0:1, the safe ink on the page", () => {
    const ratios = inks.flatMap(([, ink]) => [contrast(ink, page), contrast(ink, mix(ink, panel, 0.12))]);
    expect(Math.min(...ratios)).toBeCloseTo(6.0, 1);
  });
});

describe("the verdict rules never read red", () => {
  const look = readFileSync(path.join(ROOT, "apps", "graphs", "src", "pages", "look.ts"), "utf8");

  it("paints needs-look from the attention amber", () => {
    const rule = /\.review-needs-look\s*\{[^}]*\}/.exec(look)?.[0] ?? "";
    expect(rule).toContain("var(--attention)");
  });

  it("paints no verdict from the warn or error tints", () => {
    const rules = [...look.matchAll(/\.review-[^{]*\{[^}]*\}/g)].map((match) => match[0]);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).not.toContain("--tint-warn");
      expect(rule).not.toContain("--tint-error");
    }
  });
});

describe("the Worker serves the look kit", () => {
  const config = readFileSync(WRANGLER, "utf8");

  it("declares public/ as the assets directory", () => {
    expect(config).toContain("[assets]");
    expect(config).toContain(`directory = "public"`);
  });

  it("keeps the API and the install routes in the Worker first", () => {
    expect(config).toContain(`run_worker_first = ["/api/*", "/i/*"]`);
  });

  it("serves the kit's stylesheets and bundle from /look/ once built", () => {
    const look = path.join(ROOT, "apps", "graphs", "public", "look");
    if (!existsSync(path.join(look, "tokens.css"))) {
      // The gate builds the kit before this suite in CI; a checkout that has
      // not run `npm run build:look` yet still gets the contract above.
      expect(existsSync(path.join(ROOT, "scripts", "build-look.mjs"))).toBe(true);
      return;
    }
    for (const file of ["tokens.css", "fonts/fonts.css", "colophon/colophon.css", "fondo.js"]) {
      expect(existsSync(path.join(look, file)), file).toBe(true);
    }
  });
});

describe("the test and e2e configurations", () => {
  it("loads a wrangler config without assets for the workers pool", () => {
    const vitest = readFileSync(VITEST, "utf8");
    expect(vitest).toContain(`configPath: "./wrangler.test.toml"`);
    const testConfig = readFileSync(path.join(ROOT, "apps", "graphs", "wrangler.test.toml"), "utf8");
    expect(testConfig).not.toContain("[assets]");
    expect(testConfig).toContain(`main = "src/index.ts"`);
  });

  it("runs the visual check against the fixture Worker and its stub data", () => {
    const e2e = readFileSync(WRANGLER_E2E, "utf8");
    expect(e2e).toContain(`main = "test/e2e/worker.ts"`);
    expect(e2e).toContain(`directory = "public"`);
    expect(e2e).not.toContain("[vars]");
    const fixture = readFileSync(path.join(ROOT, "apps", "graphs", "test", "e2e", "worker.ts"), "utf8");
    expect(fixture).toContain("createWorker");
    expect(fixture).toContain("officialStubs");
  });

  it("appends the visual check to test:e2e", () => {
    const scripts = JSON.parse(readFileSync(PACKAGE, "utf8")) as { scripts: Record<string, string> };
    expect(scripts.scripts["test:graphs-visual"]).toBe("playwright test --config apps/graphs/playwright.config.ts");
    expect(scripts.scripts["test:e2e"]?.endsWith("npm run test:graphs-visual")).toBe(true);
  });
});

describe("the deploy workflow", () => {
  it("builds the look kit before wrangler deploys the Worker", () => {
    const workflow = readFileSync(DEPLOY, "utf8");
    const build = workflow.indexOf("npm run build:look");
    const deploy = workflow.indexOf("Deploy with Wrangler");
    expect(build).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(-1);
    expect(build).toBeLessThan(deploy);
  });
});
