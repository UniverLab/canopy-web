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

/** Where a guest link waits out the GitHub sign-in round trip (this tab). */
export const GUEST_RETURN_KEY = "canopy.remote.guestReturn";
/** A remembered guest link older than this is ignored: 15 minutes. */
export const GUEST_RETURN_TTL_MS = 15 * 60 * 1000;
const GUEST_PATH = /^\/g\/[1-9][0-9]*\/[0-9a-f]{16}\/?$/;

/** The sessionStorage slice the return trip needs. */
export interface ReturnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sessionStore(): ReturnStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Remember the guest link this tab signs in from: the OAuth callback
 * lands on `/`, which would otherwise drop the guest on the pairing form.
 * Only the pathname is kept; the invite code has its own tab-only slot.
 */
export function rememberGuestReturn(
  pathname: string,
  nowMs = Date.now(),
  storage: ReturnStorage | null = sessionStore(),
): void {
  if (!GUEST_PATH.test(pathname)) {
    return;
  }
  try {
    storage?.setItem(GUEST_RETURN_KEY, JSON.stringify({ path: pathname, at: nowMs }));
  } catch {
    // Without storage the guest opens the link again after signing in.
  }
}

/**
 * Back from sign-in at `/`: rewrite the URL to the remembered guest link,
 * in place, and forget it. True when it did. A stale, malformed or absent
 * entry changes nothing (and a stale or malformed one is dropped).
 */
export function resumeGuestReturn(
  location: { pathname: string },
  history: { replaceState(data: unknown, unused: string, url?: string): void },
  nowMs = Date.now(),
  storage: ReturnStorage | null = sessionStore(),
): boolean {
  if (location.pathname !== "/") {
    return false;
  }
  let raw: string | null;
  try {
    raw = storage?.getItem(GUEST_RETURN_KEY) ?? null;
    if (raw !== null) {
      storage?.removeItem(GUEST_RETURN_KEY);
    }
  } catch {
    return false;
  }
  if (raw === null) {
    return false;
  }
  let entry: unknown;
  try {
    entry = JSON.parse(raw);
  } catch {
    return false;
  }
  const { path, at } = (entry ?? {}) as { path?: unknown; at?: unknown };
  if (
    typeof path !== "string" ||
    !GUEST_PATH.test(path) ||
    typeof at !== "number" ||
    nowMs - at < 0 ||
    nowMs - at > GUEST_RETURN_TTL_MS
  ) {
    return false;
  }
  history.replaceState(null, "", path);
  return true;
}
