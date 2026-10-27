// SPDX-License-Identifier: Apache-2.0
/**
 * The shared look kit: the colophon footer, the copied TUI tokens and the
 * build step that serves the kit to both apps.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderColophon } from "../packages/look/colophon/footer.js";
import { mountCanopyBackground } from "../packages/look/fondo/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const KIT = path.join(ROOT, "packages", "look");

const LINKS = [
  { label: "UniverLab", href: "https://univerlab.org/" },
  { label: "Experiments", href: "https://univerlab.org/experiments" },
  { label: "Canopy", href: "https://univerlab.org/canopy" },
];

describe("renderColophon", () => {
  it("renders the footer", () => {
    expect(renderColophon({ product: "Canopy", exp: "EXP-001", links: LINKS })).toMatchSnapshot();
  });

  it("names the product line", () => {
    const html = renderColophon({ product: "Canopy", exp: "EXP-001", links: LINKS });
    expect(html).toContain("Part of UniverLab · EXP-001 Canopy");
  });

  it("bands the frieze across the footer and seals the credits", () => {
    const html = renderColophon({ product: "Canopy", exp: "EXP-001", links: LINKS });
    expect(html).toContain("/look/colophon/frieze-1920.avif");
    expect(html).toContain("/look/colophon/frieze-960.webp");
    expect(html).toContain('<img src="/look/colophon/sello-lacre.svg"');
  });

  it("renders the links back to univerlab.org", () => {
    const html = renderColophon({ product: "Canopy", exp: "EXP-001", links: LINKS });
    for (const link of LINKS) {
      expect(html).toContain(`href="${link.href}"`);
      expect(html).toContain(`>${link.label}</a>`);
    }
  });

  it("escapes the product, the experiment and the links", () => {
    const html = renderColophon({
      product: "<img src=x>",
      exp: "E&X",
      links: [{ label: "<b>", href: "javascript:alert(1)" }],
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("E&amp;X");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });
});

describe("the look tokens", () => {
  const tokens = readFileSync(path.join(KIT, "tokens.css"), "utf8");

  it.each([
    ["--surface-bg: #012624"],
    ["--surface-bg-raise: #003734"],
    ["--surface-ink: #edfffe"],
    ["--surface-ink-dim: #bbc7c6"],
    ["--surface-ink-faint: #9aa8a7"],
    ["--surface-line: rgba(255,255,255,.10)"],
    ["--bg-deep: #011d1c"],
    ["--ink-hi: #fff"],
    ["--phosphor: #fde9ff"],
    [
      "--cta-gradient: linear-gradient(90deg, rgb(203,255,252) 0%, rgb(237,255,254) 26.25%, rgb(255,253,250) 47.57%, rgb(250,209,255) 88.96%)",
    ],
    ["--radius-card: 16px"],
    ["--radius-ctl: 6px"],
    ["--ink-dim: var(--surface-ink-dim, #9a9890)"],
    ["--canopy: #00a9a0"],
    ["--teal: #3fb8b0"],
    ["--font-display: 'Old Standard TT', Georgia, serif"],
    ["--font-body: 'EB Garamond', Garamond, Georgia, serif"],
    ["--font-mono: 'Sometype Mono', ui-monospace, Menlo, monospace"],
  ])("copies %s from univerlab", (declaration) => {
    expect(tokens).toContain(declaration);
  });
});

describe("the honeycomb background", () => {
  it("exports the mount function", () => {
    expect(typeof mountCanopyBackground).toBe("function");
  });

  it("keeps the tuning constants and the radial mask", () => {
    const canopy = readFileSync(path.join(KIT, "fondo", "canopy.ts"), "utf8");
    for (const constant of [
      "const TEAL = '#3fb8b0'",
      "const STEP_MS = 120",
      "const DRAW_MS = 33",
      "const BLUR_DOWN = 4",
      "export const MASK = 'radial-gradient(ellipse 66% 76% at 50% 44%, transparent 0 38%, #000 88%)'",
    ]) {
      expect(canopy).toContain(constant);
    }
  });
});

describe("the look build", () => {
  const GRAPHS_LOOK = path.join(ROOT, "apps", "graphs", "public", "look");
  const REMOTE_LOOK = path.join(ROOT, "apps", "remote", "web", "public", "look");

  const SHARED = [
    "tokens.css",
    "fonts/fonts.css",
    "fonts/old-standard-tt-400.woff2",
    "fonts/old-standard-tt-400-italic.woff2",
    "fonts/eb-garamond-400.woff2",
    "fonts/eb-garamond-400-italic.woff2",
    "fonts/eb-garamond-500.woff2",
    "fonts/sometype-mono-400.woff2",
    "fonts/sometype-mono-500.woff2",
    "fonts/OFL-OldStandardTT.txt",
    "fonts/OFL-EBGaramond.txt",
    "fonts/OFL-SometypeMono.txt",
    "colophon/colophon.css",
    "colophon/frieze-960.avif",
    "colophon/frieze-960.webp",
    "colophon/frieze-1920.avif",
    "colophon/frieze-1920.webp",
    "colophon/sello-lacre.svg",
    "fondo/assets/celdas.json",
    "fondo/assets/celdas.png",
    "fondo/assets/panal.webp",
  ];

  it("copies every expected file to both apps", () => {
    execFileSync("node", ["scripts/build-look.mjs"], { cwd: ROOT, stdio: "pipe" });
    for (const target of [GRAPHS_LOOK, REMOTE_LOOK]) {
      for (const file of SHARED) {
        expect(existsSync(path.join(target, file)), `${target}/${file}`).toBe(true);
      }
      expect(existsSync(path.join(target, "colophon", "footer.ts"))).toBe(false);
    }
  });

  it("copies the kit byte-identical", () => {
    const pairs: Array<[string, string]> = [
      ["tokens.css", "tokens.css"],
      ["fonts/fonts.css", "fonts/fonts.css"],
      ["colophon/colophon.css", "colophon/colophon.css"],
      ["colophon/frieze-1920.avif", "colophon/frieze-1920.avif"],
      ["fondo/assets/celdas.json", "fondo/assets/celdas.json"],
      ["fondo/assets/panal.webp", "fondo/assets/panal.webp"],
    ];
    for (const target of [GRAPHS_LOOK, REMOTE_LOOK]) {
      for (const [source, dest] of pairs) {
        expect(readFileSync(path.join(target, dest))).toEqual(readFileSync(path.join(KIT, source)));
      }
    }
  });

  it("bundles the background for the catalogue pages only", () => {
    const bundle = path.join(GRAPHS_LOOK, "fondo.js");
    expect(existsSync(bundle)).toBe(true);
    expect(existsSync(path.join(REMOTE_LOOK, "fondo.js"))).toBe(false);
    const script = readFileSync(bundle, "utf8");
    expect(script).toContain("mountCanopyBackground");
    expect(script).toContain("radial-gradient");
  });
});
