// SPDX-License-Identifier: Apache-2.0
/**
 * Arrowhead markers for the plate and the editor canvas: one id shape,
 * `<prefix>-arrow` / `<prefix>-arrow-fail` / `<prefix>-arrow-error`,
 * shared by both. A plate's prefix carries its orientation and its
 * figure's marker seed — `vertical-9f3` — so the two plates in one
 * figure never share an id: `url(#…)` resolves to the *first* marker in
 * the document, and Chrome paints no marker from a `display:none`
 * subtree, which is exactly how the phone's hidden horizontal twin used
 * to swallow every arrowhead. The canvas passes the fixed prefix `edge`,
 * keeping its markers and stylesheet byte-identical.
 *
 * The head is a 1.3-unit triangle in user units, tip at the path end;
 * `markerCss` returns the rules painting each head, every selector
 * starting with the caller's own scope (`.plate-svg`, `.editor-svg`).
 */

/** The marker head's paint per flow class, as full CSS declarations. */
export interface MarkerFills {
  pass: string;
  fail: string;
  error: string;
}

/** The id of the marker a class ends in, or null for order guides. */
export function markerId(prefix: string, cls: string): string | null {
  if (cls === "fail") {
    return `${prefix}-arrow-fail`;
  }
  if (cls === "error") {
    return `${prefix}-arrow-error`;
  }
  if (cls === "order") {
    return null;
  }
  return `${prefix}-arrow`;
}

/** One marker per flow class, inside a single `<defs>` block. */
export function markerDefs(prefix: string): string {
  const marker = (id: string): string =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" ` +
    `markerWidth="1.3" markerHeight="1.3" markerUnits="userSpaceOnUse" ` +
    `orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>`;
  return (
    `<defs>${marker(`${prefix}-arrow`)}${marker(`${prefix}-arrow-fail`)}` +
    `${marker(`${prefix}-arrow-error`)}</defs>`
  );
}

/** The stylesheet rules painting each marker head under a scope. */
export function markerCss(scope: string, prefix: string, fills: MarkerFills): string {
  return (
    `${scope} #${prefix}-arrow path{${fills.pass}}` +
    `${scope} #${prefix}-arrow-fail path{${fills.fail}}` +
    `${scope} #${prefix}-arrow-error path{${fills.error}}`
  );
}
