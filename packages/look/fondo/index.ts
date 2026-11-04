// SPDX-License-Identifier: Apache-2.0
/**
 * The live honeycomb background of the Canopy page, self-hosted: mount it
 * on any positioned host with the base URL the build step copied
 * fondo/assets/ to (for example `/look/fondo/assets/`).
 *
 * It honours prefers-reduced-motion with a static comb and no animation,
 * and the frame loop pauses while the page is hidden.
 */
import { mount } from "./canopy.js";

export function mountCanopyBackground(
  host: HTMLElement,
  assetBase: string,
): { destroy(): void } {
  const base = assetBase.endsWith("/") ? assetBase : `${assetBase}/`;
  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fondo = mount(host, { base, night: false, reduced });
  return { destroy: () => fondo.destroy() };
}
