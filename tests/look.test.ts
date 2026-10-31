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
import {
  BANNER_GRADIENT,
  BANNER_LINES,
  GRAPHS_BANNER_LINES,
  REMOTE_BANNER_LINES,
  bannerColor,
  bannerSvg,
  renderBanner,
  renderHeaderBanner,
} from "../packages/look/banner/banner.js";
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

  it("links the lab's privacy and terms pages from the UniverLab group", () => {
    const html = renderColophon({ product: "Canopy", exp: "EXP-001", links: LINKS });
    expect(html).toContain('href="https://univerlab.org/privacy/"');
    expect(html).toContain('href="https://univerlab.org/terms/"');
    expect(html).toContain(">Privacy</a>");
    expect(html).toContain(">Terms</a>");
    // They ride in the aria-label="UniverLab" nav, like every other link.
    const nav = html.slice(html.indexOf('aria-label="UniverLab"'), html.indexOf("</nav>"));
    expect(nav).toContain('href="https://univerlab.org/privacy/"');
    expect(nav).toContain('href="https://univerlab.org/terms/"');
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

  it.each([
    ["--page: #012624"],
    ["--surface-panel: #050505"],
    ["--stage-bg: #050505"],
    ["--stage-line: #1f1f1f"],
    ["--stage-ink: #e6e6e6"],
    ["--tint-info: #011d26"],
    ["--tint-ok: #012619"],
    ["--tint-warn: #26010e"],
    ["--tint-error: #260103"],
    ["--tint-line: rgba(255,255,255,.08)"],
    ["--err-label: #ff6b6b"],
  ])("defines the stage-and-tint token %s", (declaration) => {
    expect(tokens).toContain(declaration);
  });

  it.each([
    ["--command-bg: #454545"],
    ["--command-line: #787878"],
  ])("defines the install-field token %s", (declaration) => {
    expect(tokens).toContain(declaration);
  });
});

describe("bannerSvg", () => {
  const rects = (svg: string): string[] => svg.match(/<rect [^>]*\/>/g) ?? [];

  it("draws one cell per character on a fixed grid", () => {
    const svg = bannerSvg(["██░ ██"], "look-banner-art");
    // Six columns, one row of 1:2 terminal cells; the space is a cell
    // with no rect.
    expect(svg).toContain(`viewBox="0 0 6 2"`);
    expect(svg).toContain(`shape-rendering="crispEdges"`);
    const widths = rects(svg).map((rect) => Number(/width="(\d+)"/.exec(rect)?.[1]));
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(5);
    // Every run is two units tall: the terminal cell, twice as tall as
    // wide.
    for (const rect of rects(svg)) {
      expect(rect).toContain(`height="2"`);
    }
    // The space is a cell with no rect — and no text node either: only
    // rects may sit between the tags, never the art's own characters.
    expect(svg.replace(/<[^>]*>/g, "")).toBe("");
  });

  it("merges adjacent cells of one kind into one rect, shade runs too", () => {
    const svg = bannerSvg(["█████", "░░███"], "look-banner-art");
    const cells = rects(svg);
    expect(cells).toHaveLength(3);
    expect(cells[0]).toContain(`x="0" y="0" width="5" height="2"`);
    expect(cells[1]).toContain(`x="0" y="2" width="2" height="2" fill-opacity=".35"`);
    expect(cells[2]).toContain(`x="2" y="2" width="3" height="2"`);
    expect(cells[0]).not.toContain("fill-opacity");
  });

  it("fills each line with its gradient stop, as a presentation attribute", () => {
    const svg = bannerSvg(GRAPHS_BANNER_LINES, "look-banner-art");
    const fills = [...svg.matchAll(/<g class="look-banner-line" fill="(#[0-9a-f]{6})">/g)].map(
      (match) => match[1],
    );
    const stops = [0, 0, 1, 1, 1, 2, 2, 3, 3, 3, 4];
    expect(fills).toEqual(stops.map((stop) => BANNER_GRADIENT[stop]));
    // A style attribute is refused by the remote's CSP: fills never use one.
    expect(svg).not.toContain("style=");
  });

  it("keeps the graphs banner under 6 KB", () => {
    // The exact bytes the graphs header ships, not a shorter variant.
    expect(Buffer.byteLength(renderHeaderBanner("graphs"))).toBeLessThan(6144);
  });
});

describe("the house banner", () => {
  it("is the ten DOS Rebel art lines, byte-identical to banner.rs", () => {
    expect(BANNER_LINES).toHaveLength(10);
    expect(BANNER_LINES.map((line) => line.length)).toEqual([53, 60, 60, 60, 60, 60, 60, 60, 60, 60]);
    for (const line of BANNER_LINES) {
      expect(line).toMatch(/^[ █░]*$/);
    }
    // The first line is blank space; the art carries block and shade runs.
    expect(BANNER_LINES[0]).toBe(" ".repeat(53));
    expect(BANNER_LINES[1]).toContain("██████");
  });

  it("runs the five-stop teal gradient light to dark", () => {
    expect(BANNER_GRADIENT).toEqual(["#52fff6", "#1ffff3", "#00e0d4", "#00a9a0", "#006661"]);
    expect(BANNER_GRADIENT).not.toContain("#003330");
  });

  it("colours the ten lines stops [0,0,1,1,2,2,2,3,3,4], like gradient_rgb", () => {
    const stops = [0, 0, 1, 1, 2, 2, 2, 3, 3, 4];
    expect(BANNER_LINES.map((_, index) => bannerColor(index))).toEqual(
      stops.map((stop) => BANNER_GRADIENT[stop]),
    );
  });

  it("renders the art as an SVG hidden from assistive tech, with a reader Canopy", () => {
    const html = renderBanner("remote");
    expect(html).toContain(`class="look-banner-art"`);
    expect(html).toContain(`aria-hidden="true"`);
    expect(html).toContain(`<span class="look-banner-vh">Canopy</span>`);
    // One group per art line, ten of them, each with its gradient stop.
    expect(html.match(/<g class="look-banner-line"/g) ?? []).toHaveLength(10);
    expect(html).not.toContain("style=");
  });

  it("names the app under the art, and only the app differs", () => {
    const remote = renderBanner("remote");
    const graphs = renderBanner("graphs");
    expect(remote).toContain(`<p class="look-banner-app">remote</p>`);
    expect(graphs).toContain(`<p class="look-banner-app">graphs</p>`);
    expect(graphs.replaceAll("graphs", "remote")).toBe(remote);
  });
});

describe("the header banners", () => {
  it("is eleven DOS Rebel art lines per app, one width each", () => {
    expect(GRAPHS_BANNER_LINES).toHaveLength(11);
    expect(REMOTE_BANNER_LINES).toHaveLength(11);
    expect(GRAPHS_BANNER_LINES.map((line) => line.length)).toEqual(new Array(11).fill(58));
    expect(REMOTE_BANNER_LINES.map((line) => line.length)).toEqual(new Array(11).fill(63));
    for (const line of [...GRAPHS_BANNER_LINES, ...REMOTE_BANNER_LINES]) {
      expect(line).toMatch(/^[ █░]*$/);
    }
    // Both carry block runs; the graphs ascender opens the first line.
    expect(GRAPHS_BANNER_LINES[0]).toContain("█████");
    expect(GRAPHS_BANNER_LINES[2]).toContain("███████");
    expect(REMOTE_BANNER_LINES[2]).toContain("████████");
  });

  it("colours the eleven lines light to dark, like gradient_rgb", () => {
    const stops = [0, 0, 1, 1, 1, 2, 2, 3, 3, 3, 4];
    for (const lines of [GRAPHS_BANNER_LINES, REMOTE_BANNER_LINES]) {
      expect(lines.map((_, index) => bannerColor(index, lines.length))).toEqual(
        stops.map((stop) => BANNER_GRADIENT[stop]),
      );
    }
  });

  it("renders one named SVG per app with eleven line groups and no inline style", () => {
    for (const app of ["graphs", "remote"] as const) {
      const html = renderHeaderBanner(app);
      expect(html).toMatch(
        new RegExp(`^<svg [^>]*class="look-banner-header look-banner-header-${app}"`),
      );
      expect(html).toContain(`role="img"`);
      expect(html).toContain(`aria-label="Canopy ${app}"`);
      expect(html.match(/<g class="look-banner-line"/g) ?? []).toHaveLength(11);
      // A style attribute is refused by the remote's CSP: the ink is fill.
      expect(html).not.toContain("style=");
    }
    expect(renderHeaderBanner("graphs")).not.toBe(renderHeaderBanner("remote"));
  });

  it("sizes the header art in banner.css to about 160 px, 96 px on a phone", () => {
    const css = readFileSync(path.join(KIT, "banner", "banner.css"), "utf8");
    const width = (name: string): number => {
      const match = new RegExp(`\\.${name} \\{\\s*width: (\\d+)px;`).exec(css);
      if (match?.[1] === undefined) {
        throw new Error(`width for .${name} not found in banner.css`);
      }
      return Number(match[1]);
    };
    const cases: Array<[string, number, number, number]> = [
      ["look-banner-header-graphs", 58, 421, 253],
      ["look-banner-header-remote", 63, 458, 275],
    ];
    for (const [name, cells, desktop, phone] of cases) {
      expect(width(name)).toBe(desktop);
      // Eleven 1:2 terminal cells: 421/58 × 22 = 160 px, 253/58 × 22 = 96 px.
      expect(Math.round((desktop * 22) / cells)).toBe(160);
      expect(Math.abs((phone * 22) / cells - 96)).toBeLessThanOrEqual(1);
    }
    // The phone widths live in the one ≤639 px block.
    expect(css).toMatch(
      /@media \(max-width: 639px\) \{[\s\S]*?\.look-banner-header-graphs \{\s*width: 253px;[\s\S]*?\.look-banner-header-remote \{\s*width: 275px;/,
    );
    // No font and no per-line colour rules any more: fills ride on the SVG.
    expect(css).not.toContain("font-size");
    expect(css).not.toContain("nth-child");
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
    "banner/banner.css",
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
      expect(existsSync(path.join(target, "banner", "banner.ts"))).toBe(false);
    }
  });

  it("copies the kit byte-identical", () => {
    const pairs: Array<[string, string]> = [
      ["tokens.css", "tokens.css"],
      ["fonts/fonts.css", "fonts/fonts.css"],
      ["colophon/colophon.css", "colophon/colophon.css"],
      ["banner/banner.css", "banner/banner.css"],
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

  it("bundles the copy morph for the catalogue pages only", () => {
    const bundle = path.join(GRAPHS_LOOK, "icons.js");
    expect(existsSync(bundle)).toBe(true);
    expect(existsSync(path.join(REMOTE_LOOK, "icons.js"))).toBe(false);
    const script = readFileSync(bundle, "utf8");
    // The element the Copy button upgrades to, and the entry point the page
    // calls; the remote imports the same sources through Vite instead.
    expect(script).toContain("mountCopyButtons");
    expect(script).toContain("morph-icon");
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
