// SPDX-License-Identifier: Apache-2.0
/**
 * The icon language both apps share: the kit's one icon module, the
 * server-rendered `iconSvg` over Lucide's `IconNode` data, the pinned
 * dependencies and their notices, and a source scan that keeps icons.ts
 * to exactly the icons the apps actually ask for.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { iconSvg } from "../packages/look/icon-svg.js";
import * as icons from "../packages/look/icons.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const KIT = path.join(ROOT, "packages", "look");
const ICONS = path.join(KIT, "icons.ts");
const ICON_SVG = path.join(KIT, "icon-svg.ts");
/** This file names the forbidden imports and glyphs on purpose. */
const SELF = path.join(ROOT, "tests", "icons.test.ts");

/** Every source folder the scan reads. */
const SOURCE_ROOTS = [
  "src",
  "tests",
  "packages/look",
  "apps/graphs/src",
  "apps/graphs/test",
  "apps/remote/web/src",
  "apps/remote/web/test",
  "apps/remote/worker/src",
  "apps/remote/worker/test",
  "scripts",
];

function filesUnder(entry: string): string[] {
  const full = path.join(ROOT, entry);
  const out: string[] = [];
  const walk = (target: string): void => {
    for (const name of readdirSync(target)) {
      const child = path.join(target, name);
      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (child.endsWith(".ts") || child.endsWith(".mjs")) {
        out.push(child);
      }
    }
  };
  walk(full);
  return out;
}

/** Every source file the scan reads, once each. */
function sources(): Array<{ file: string; text: string }> {
  const seen = new Set<string>();
  const out: Array<{ file: string; text: string }> = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of filesUnder(root)) {
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      out.push({ file, text: readFileSync(file, "utf8") });
    }
  }
  return out;
}

/** The lab names icons.ts exports, via `Original as name`. */
function exportedNames(): string[] {
  const text = readFileSync(ICONS, "utf8");
  return [...text.matchAll(/^\s+\w+ as (\w+),$/gm)].map((match) => match[1] ?? "");
}

describe("iconSvg", () => {
  const svg = iconSvg("copy");

  it("draws the Lucide node on the 24 grid, at 16 px, in currentColor", () => {
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" class="icon"`)).toBe(true);
    expect(svg).toContain(`width="16" height="16"`);
    expect(svg).toContain(`viewBox="0 0 24 24"`);
    expect(svg).toContain(`fill="none"`);
    expect(svg).toContain(`stroke="currentColor"`);
    expect(svg).toContain(`stroke-width="1.75"`);
    expect(svg).toContain(`stroke-linecap="round"`);
    expect(svg).toContain(`stroke-linejoin="round"`);
  });

  it("hides an unlabelled icon from assistive tech", () => {
    expect(svg).toContain(`aria-hidden="true"`);
    expect(svg).not.toContain(`role="img"`);
    expect(svg).not.toContain(`<title>`);
  });

  it("builds the drawing from the icon's own element list", () => {
    // Lucide's copy is a rect and a path; both arrive as real SVG elements.
    expect(svg).toContain(`<rect `);
    expect(svg).toContain(`<path d="M4 16`);
    expect(svg.endsWith(`</svg>`)).toBe(true);
  });

  it("takes a size", () => {
    expect(iconSvg("star", { size: 24 })).toContain(`width="24" height="24"`);
  });

  it("names a labelled icon with role and title", () => {
    const labelled = iconSvg("search", { label: "Search the catalogue" });
    expect(labelled).toContain(`role="img"`);
    expect(labelled).not.toContain(`aria-hidden`);
    expect(labelled).toContain(`<title>Search the catalogue</title>`);
  });

  it("escapes the label", () => {
    const labelled = iconSvg("star", { label: `<b>"x" & y</b>` });
    expect(labelled).toContain(`<title>&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;</title>`);
    expect(labelled).not.toContain(`<b>`);
  });

  it("throws on a name the kit does not export", () => {
    expect(() => iconSvg("nope" as never)).toThrow(/unknown icon: nope/);
    expect(() => iconSvg("Copy" as never)).toThrow(/unknown icon: Copy/);
    // A prototype member is not an icon either.
    expect(() => iconSvg("constructor" as never)).toThrow(/unknown icon: constructor/);
  });
});

describe("the icon module", () => {
  it("exports the vocabulary both apps draw", () => {
    const names = exportedNames();
    expect(names).toContain("copy");
    expect(names).toContain("check");
    expect(names).toContain("folderOpen");
    expect(names).toContain("wifiOff");
    expect(names).toContain("arrowRightToLine");
    for (const name of names) {
      const node = (icons as Record<string, unknown>)[name];
      expect(Array.isArray(node), name).toBe(true);
      expect((node as unknown[]).length, name).toBeGreaterThan(0);
    }
    expect(names).toHaveLength(Object.keys(icons).length);
  });

  it("exports only icons some source asks for, and asks only for exports", () => {
    const names = new Set(exportedNames());
    const scanned = sources();
    for (const name of names) {
      // This file names icons in its own assertions, so it proves nothing:
      // every export must be drawn by real code or another test.
      const used = scanned.some(
        ({ file, text }) => file !== ICONS && file !== SELF && text.includes(`"${name}"`),
      );
      expect(used, `packages/look/icons.ts exports ${name}, nobody draws it`).toBe(true);
    }
    // And no call site names an icon the module does not export.
    for (const { file, text } of scanned) {
      if (file === SELF) {
        continue;
      }
      for (const match of text.matchAll(/(?:iconSvg|icon|mountMorphSlot|to)\(\s*"(\w+)"/g)) {
        const name = match[1] ?? "";
        if (name === "" || name.startsWith("http")) {
          continue;
        }
        expect(names.has(name), `${path.relative(ROOT, file)} draws unknown icon ${name}`).toBe(true);
      }
    }
  });

  it("keeps lucide behind the one module", () => {
    for (const { file, text } of sources()) {
      if (file === ICONS || file === SELF) {
        continue;
      }
      expect(text, path.relative(ROOT, file)).not.toMatch(/from\s+["']lucide["']/);
    }
    // The morpher is imported where it belongs and nowhere else.
    for (const { file, text } of sources()) {
      if (file === ICON_SVG || file === SELF) {
        continue;
      }
      const relative = path.relative(ROOT, file).split(path.sep).join("/");
      if (!text.includes(`from "morphicons`)) {
        continue;
      }
      // Production code reaches the morpher through these two modules
      // only; a test may read its exported helpers (canonicalD) directly.
      const owners = ["packages/look/morph-client.ts", "apps/remote/web/src/icons-dom.ts"];
      expect(owners.includes(relative) || relative.includes("/test/"), relative).toBe(true);
    }
  });
});

describe("the icon dependencies", () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const notices = readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");

  it("pins lucide and morphicons to an exact version", () => {
    for (const name of ["lucide", "morphicons"]) {
      const version = manifest.dependencies?.[name] ?? "";
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // The catalogue needs 0.x for the brand marks (github), so it is pinned
    // there, and the morpher is the release that predates the two-week line.
    expect(manifest.dependencies?.["lucide"]).toBe("0.577.0");
    expect(manifest.dependencies?.["morphicons"]).toBe("1.7.1");
  });

  it("lists both licences where the colophon's Source link reaches", () => {
    expect(notices).toContain("Lucide");
    expect(notices).toContain("ISC");
    expect(notices).toContain("morphicons");
    expect(notices).toContain("MIT");
    expect(notices).toContain("lucide` 0.577.0");
    expect(notices).toContain("morphicons` 1.7.1");
  });

  it("ships no icon font and no sprite", () => {
    for (const { file, text } of sources()) {
      if (file === SELF) {
        continue;
      }
      const relative = path.relative(ROOT, file).split(path.sep).join("/");
      expect(text, relative).not.toMatch(/\.(woff2?|ttf|otf)["']\s*\)?\s*format\(["'](?:woff|truetype|opentype)/);
      expect(text, relative).not.toContain(`<use href="#icon-`);
    }
    // The icon bundle is generated, never checked in.
    const tracked = execFileSync("git", ["ls-files", "apps/graphs/public/look"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(tracked.trim()).toBe("");
  });
});
