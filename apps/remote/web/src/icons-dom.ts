// SPDX-License-Identifier: Apache-2.0
/**
 * The remote's icons: static markup through the kit's `iconSvg`, and the
 * morph slots that change an icon without swapping it.
 *
 * A slot owns one 16 px SVG with a single path; morphicons re-plans that
 * path's geometry between two Lucide `IconNode`s with a spring, so the
 * icon whose meaning changed appears to turn into the next one. The slot
 * keeps its box through the morph — only the path inside moves — and
 * honours `prefers-reduced-motion` through morphicons' "user" policy.
 *
 * Every icon is currentColor. The caller colours the slot: the error tint
 * is the only place an icon wears a colour of its own.
 */
import { canonicalD, createMorph, type ReducedMotionMode } from "morphicons/dom";
import { iconSvg, type IconName } from "../../../../packages/look/icon-svg.js";
import * as iconData from "../../../../packages/look/icons.js";

export type { IconName } from "../../../../packages/look/icon-svg.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface IconOptions {
  /** Drawn size in pixels; the drawing stays on Lucide's 24 × 24 grid. */
  size?: number;
  /** An accessible name; without one the icon is hidden from readers. */
  label?: string;
}

/** One icon as static markup, for the parts of the UI that never morph. */
export function icon(name: IconName, options: IconOptions = {}): string {
  return iconSvg(name, options);
}

export interface MorphSlotOptions {
  size?: number;
  /** morphicons' reduced-motion policy; "user" reads the OS setting. */
  reducedMotion?: ReducedMotionMode;
}

/** One icon that can become another; the box never changes. */
export interface MorphSlot {
  readonly host: HTMLElement;
  readonly name: IconName;
  /** Spring to `name`; the host's `data-icon` says where it is going. */
  to: (name: IconName) => void;
  /** Jump to `name` with no animation. */
  set: (name: IconName) => void;
  destroy: () => void;
}

/**
 * Mount a morph slot inside `host`, drawing `name` at rest. The host keeps
 * whatever size the stylesheet gives it; the SVG inside is `size` square.
 */
export function mountMorphSlot(
  host: HTMLElement,
  name: IconName,
  options: MorphSlotOptions = {},
): MorphSlot {
  const size = options.size ?? 16;
  const doc = host.ownerDocument;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("class", "icon");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", canonicalD(iconData[name]));
  svg.append(path);
  host.replaceChildren(svg);

  const morph = createMorph(path, iconData[name], {
    reducedMotion: options.reducedMotion ?? "user",
  });
  let current = name;
  host.dataset["icon"] = current;

  return {
    host,
    get name(): IconName {
      return current;
    },
    to(next: IconName): void {
      current = next;
      host.dataset["icon"] = next;
      morph.morphTo(iconData[next], "snappy");
    },
    set(next: IconName): void {
      current = next;
      host.dataset["icon"] = next;
      morph.set(iconData[next]);
    },
    destroy(): void {
      morph.destroy();
    },
  };
}
