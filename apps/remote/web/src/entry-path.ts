// SPDX-License-Identifier: Apache-2.0
// What a URL means at the door: a mistyped path must never land on the
// pairing form, which reads like a broken app. classifyEntryPath names
// the pathname — the app's own routes, the editor chunk, a guest link,
// or nothing the app knows — and redirectUnknownRoute sends an unknown
// one home in the same document: one history entry, no reload, no
// round-trip. main.ts calls it before anything else reads the pathname,
// so every later check sees the rewritten URL.

/** What a pathname is at the door of the app. */
export type EntryPath = "app" | "editor" | "guest" | "unknown";

/** The app's own routes: home and the pairing screen. */
const APP_PATHS: ReadonlySet<string> = new Set(["/", "/pair"]);

/**
 * The pathname's verdict. `/editor...` first — byte-identical to the
 * check main.ts has always run, so `/editorial` stays the editor — then
 * `/g/...`, then the app's own routes with their trailing slashes
 * stripped. Everything else is unknown: `/g`, `/sessions`,
 * `/index.html`, `/pair/x`.
 */
export function classifyEntryPath(pathname: string): EntryPath {
  if (pathname.startsWith("/editor")) {
    return "editor";
  }
  if (pathname.startsWith("/g/")) {
    return "guest";
  }
  const clean = pathname.replace(/\/+$/, "") || "/";
  return APP_PATHS.has(clean) ? "app" : "unknown";
}

/** The home URL: `/` plus the query and the hash the visitor carried in. */
export function homeHref(location: { search: string; hash: string }): string {
  return "/" + location.search + location.hash;
}

/**
 * Rewrite an unknown pathname to home, in place. Returns true when it
 * did, false when the path is one of the app's own (nothing is touched).
 * history.replaceState — never location.replace or assign: same
 * document, no navigation, no round-trip, and the query and the hash
 * survive, so a `/pair#CODE` deep link still prefills.
 */
export function redirectUnknownRoute(
  location: { pathname: string; search: string; hash: string },
  history: { replaceState(data: unknown, unused: string, url?: string): void },
): boolean {
  if (classifyEntryPath(location.pathname) !== "unknown") {
    return false;
  }
  history.replaceState(null, "", homeHref(location));
  return true;
}
