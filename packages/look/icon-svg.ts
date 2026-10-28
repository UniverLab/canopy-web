// SPDX-License-Identifier: Apache-2.0
/**
 * One icon, as a server-rendered string: the catalogue's pages are
 * strings, and the remote's static markup is built the same way, so both
 * read their icons through here.
 *
 * `iconSvg(name)` returns the whole `<svg>` built from the Lucide
 * `IconNode` in icons.ts: `currentColor` strokes, 1.75 width, 16 px, and
 * hidden from assistive tech unless a label is given — then it carries
 * `role="img"` and a `<title>`. No icon font, no sprite request: the
 * markup travels with the page.
 */
import * as icons from "./icons.js";

/** The lab's icon names: exactly the keys icons.ts exports. */
export type IconName = keyof typeof icons;

/** Lucide's `IconNode` shape, structural so this module needs no lucide type. */
type IconNode = ReadonlyArray<
  readonly [tag: string, attrs: Readonly<Record<string, string | number | undefined>>]
>;

export interface IconSvgOptions {
  /** Drawn size in pixels; the viewBox stays Lucide's 24 × 24 grid. */
  size?: number;
  /** An accessible name; without one the icon hides from assistive tech. */
  label?: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);
}

/** One node of the drawing: `<path …/>`, `<circle …/>`, `<rect …/>`. */
function element([tag, attrs]: readonly [
  string,
  Readonly<Record<string, string | number | undefined>>,
]): string {
  const drawn = Object.entries(attrs)
    .flatMap(([name, value]) => (value === undefined ? [] : [` ${name}="${escapeAttribute(`${value}`)}"`]))
    .join("");
  return `<${tag}${drawn}/>`;
}

/**
 * The icon `name` as inline SVG. Throws on a name the kit does not export,
 * so a typo fails the page test instead of drawing an empty box.
 */
export function iconSvg(name: IconName, options: IconSvgOptions = {}): string {
  // Own keys only: a name the kit does not export must throw, never fall
  // through to a prototype member ("constructor") and break mid-drawing.
  const node = Object.hasOwn(icons, name) ? (icons[name] as IconNode) : undefined;
  if (node === undefined) {
    throw new Error(`unknown icon: ${name}`);
  }
  const size = options.size ?? 16;
  const label = options.label;
  const title = label === undefined ? "" : `<title>${escapeAttribute(label)}</title>`;
  const accessibility =
    label === undefined ? ` aria-hidden="true"` : ` role="img"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" class="icon"` +
    ` width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"` +
    ` stroke="currentColor" stroke-width="1.75"` +
    ` stroke-linecap="round" stroke-linejoin="round"${accessibility}>` +
    `${title}${node.map(element).join("")}</svg>`
  );
}
