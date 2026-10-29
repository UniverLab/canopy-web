// SPDX-License-Identifier: Apache-2.0
/**
 * The remote's icons: static markup through the kit's `iconSvgFrom`, and
 * the morph slots that change an icon without swapping it.
 *
 * A slot owns one 16 px SVG with a single path; morphicons re-plans that
 * path's geometry between two Lucide `IconNode`s with a spring, so the
 * icon whose meaning changed appears to turn into the next one. The slot
 * keeps its box through the morph — only the path inside moves — and
 * honours `prefers-reduced-motion` through morphicons' "user" policy.
 *
 * Every icon is currentColor. The caller colours the slot: the error tint
 * is the only place an icon wears a colour of its own.
 *
 * The imports name exactly the icons the remote draws, so the bundler
 * drops the rest of the kit: a namespace import would ship every icon
 * to every remote load. `RemoteIconName` is that subset; a new icon
 * joins the record and the name together, never one without the other.
 */
import { canonicalD, createMorph, type ReducedMotionMode } from "morphicons/dom";
import { iconSvgFrom, type IconSvgOptions } from "../../../../packages/look/icon-svg.js";
import {
  arrowDown,
  arrowLeft,
  arrowRight,
  arrowRightToLine,
  arrowUp,
  blocks,
  bot,
  check,
  chevronLeft,
  chevronRight,
  circle,
  circleDot,
  cornerDownLeft,
  folder,
  folderOpen,
  loader,
  logOut,
  minus,
  pause,
  plus,
  send,
  square,
  squareTerminal,
  triangleAlert,
  wifi,
  wifiOff,
  x,
  zap,
} from "../../../../packages/look/icons.js";

const REMOTE_ICONS = {
  arrowDown,
  arrowLeft,
  arrowRight,
  arrowRightToLine,
  arrowUp,
  blocks,
  bot,
  check,
  chevronLeft,
  chevronRight,
  circle,
  circleDot,
  cornerDownLeft,
  folder,
  folderOpen,
  loader,
  logOut,
  minus,
  pause,
  plus,
  send,
  square,
  squareTerminal,
  triangleAlert,
  wifi,
  wifiOff,
  x,
  zap,
};

/** The icons the remote draws: exactly the keys of its record. */
export type RemoteIconName = keyof typeof REMOTE_ICONS;

const SVG_NS = "http://www.w3.org/2000/svg";

/** One icon as static markup, for the parts of the UI that never morph. */
export function icon(name: RemoteIconName, options: IconSvgOptions = {}): string {
  return iconSvgFrom(REMOTE_ICONS, name, options);
}

export interface MorphSlotOptions {
  size?: number;
  /** morphicons' reduced-motion policy; "user" reads the OS setting. */
  reducedMotion?: ReducedMotionMode;
}

/** One icon that can become another; the box never changes. */
export interface MorphSlot {
  readonly host: HTMLElement;
  readonly name: RemoteIconName;
  /** Spring to `name`; the host's `data-icon` says where it is going. */
  to: (name: RemoteIconName) => void;
  /** Jump to `name` with no animation. */
  set: (name: RemoteIconName) => void;
  destroy: () => void;
}

/**
 * Mount a morph slot inside `host`, drawing `name` at rest. The host keeps
 * whatever size the stylesheet gives it; the SVG inside is `size` square.
 */
export function mountMorphSlot(
  host: HTMLElement,
  name: RemoteIconName,
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
  path.setAttribute("d", canonicalD(REMOTE_ICONS[name]));
  svg.append(path);
  host.replaceChildren(svg);

  const morph = createMorph(path, REMOTE_ICONS[name], {
    reducedMotion: options.reducedMotion ?? "user",
  });
  let current = name;
  host.dataset["icon"] = current;

  return {
    host,
    get name(): RemoteIconName {
      return current;
    },
    to(next: RemoteIconName): void {
      current = next;
      host.dataset["icon"] = next;
      morph.morphTo(REMOTE_ICONS[next], "snappy");
    },
    set(next: RemoteIconName): void {
      current = next;
      host.dataset["icon"] = next;
      morph.set(REMOTE_ICONS[next]);
    },
    destroy(): void {
      morph.destroy();
    },
  };
}
