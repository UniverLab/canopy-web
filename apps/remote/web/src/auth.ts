// SPDX-License-Identifier: Apache-2.0
// The relay's auth HTTP: who the session cookie says this browser is, and
// signing out of it. The Worker answers 401 without a session cookie,
// 200 {login} with one; POST /auth/logout clears the cookie.
//
// The session cookie is HttpOnly, so the page cannot see it: a readable
// cr_hint cookie (the worker mirrors the session's presence with it, the
// primary signal) plus a localStorage hint (the terminal-prefs pattern,
// fail-open when storage is denied, secondary) record whether a session
// likely exists, and fetchLogin skips its /auth/me request when neither
// says so — the signed-out landing makes zero requests and logs zero 401s.
// The hints are armed on sign-in click and on every 200, cleared on 401
// and logout.

import { SESSION_HINT_COOKIE } from "../../worker/src/protocol.js";

/** localStorage hint: "1" while a relay session likely exists. */
export const SESSION_HINT_KEY = "canopy.remote.session";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a session is hinted. Fail open: any unreadable state fetches, so
 * signed-in boot never breaks on storage (private mode, denied webviews).
 */
function hintArmed(): boolean {
  try {
    const store = storage();
    return store === null || store.getItem(SESSION_HINT_KEY) === "1";
  } catch {
    return true;
  }
}

/** Record that a relay session likely exists (sign-in click, 200). */
export function armSessionHint(): void {
  try {
    storage()?.setItem(SESSION_HINT_KEY, "1");
  } catch {
    // A browser that cannot remember still signs in; it just fetches.
  }
}

/** Forget the session hint (401, logout). */
export function clearSessionHint(): void {
  try {
    storage()?.removeItem(SESSION_HINT_KEY);
  } catch {
    // Forgetting is best effort; a stale hint self-heals on the next 401.
  }
  try {
    document.cookie = `${SESSION_HINT_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Strict`;
  } catch {
    // Same: an unreadable cookie jar cannot hold a stale hint either.
  }
}

/**
 * Whether the readable hint cookie is present. The relay sets cr_hint=1
 * beside the HttpOnly session cookie, so its presence is the primary
 * signal. Fail open: when the cookies cannot be read, the fetch goes out.
 */
function sessionCookiePresent(): boolean {
  let cookies: string;
  try {
    cookies = globalThis.document?.cookie ?? "";
  } catch {
    return true;
  }
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    if (name === SESSION_HINT_COOKIE) {
      return true;
    }
  }
  return false;
}

/**
 * The login behind the session cookie, or null when signed out. Skips the
 * request entirely when no session is hinted and no session cookie reads
 * (fail open: an unreadable hint still fetches, so signed-in boot never
 * breaks on storage).
 */
export async function fetchLogin(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!hintArmed() && !sessionCookiePresent()) {
    return null;
  }
  let res: Response;
  try {
    res = await fetchImpl("/auth/me");
  } catch {
    return null;
  }
  if (res.status === 401) {
    clearSessionHint();
    return null;
  }
  if (!res.ok) {
    return null;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body === "object" && body !== null && typeof (body as { login: unknown }).login === "string") {
    armSessionHint();
    return (body as { login: string }).login;
  }
  return null;
}

/** Clear the relay session; throws when the request fails. */
export async function signOut(fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl("/auth/logout", { method: "POST" });
  } catch {
    throw new Error("Could not reach the relay");
  }
  if (!res.ok) {
    throw new Error(`Could not sign out (${res.status})`);
  }
  clearSessionHint();
}
