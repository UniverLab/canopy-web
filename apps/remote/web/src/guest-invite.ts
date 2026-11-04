// SPDX-License-Identifier: Apache-2.0
// The guest's invite code: read from the link's fragment, canonicalised
// the way the host does, kept for this tab only, and validated when typed.
//
// The host prints `<origin>/g/<owner_uid>/<host_id>#invite=<code>`. The
// fragment never reaches the relay, its logs or a Referer; this page reads
// it, strips it from the address bar and keeps the code in sessionStorage
// alone, so a reload or a reconnect in the same tab still has it while no
// other tab, and nothing after the tab closes, ever does. The relay hashes
// exactly the string it receives and the host publishes the SHA-256 of
// the canonical `CNR-XXXX-XXXX-XXXX-XXXX` form, so only that form is sent.

import type { GuestLink } from "./guest.js";

/** The minimal Storage slice the invite needs (sessionStorage in prod). */
export interface InviteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Crockford base32, as the host's pairing and invite codes use it. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Symbols in one code, without the `CNR` prefix and the dashes. */
const CODE_SYMBOLS = 16;
/** Where the tab keeps one link's code. */
const STORAGE_PREFIX = "canopy.remote.invite:";

/** Shown under the form when the typed text is not a code at all. */
export const INVITE_FORMAT_ERROR =
  "That is not an invite code: it reads CNR- and 16 letters or digits.";

/** The relay refused the code before this tab ever joined with it. */
export const INVITE_REFUSED_MESSAGE =
  "The relay did not accept this invite code. It may be mistyped, expired or revoked, " +
  "or already used: each code works once. Check it, or ask the host for a new one.";

/** The relay refused the code after it let this tab in once: it is spent. */
export const INVITE_SPENT_MESSAGE =
  "Your invite code was used up when you joined: each code works once. " +
  "Ask the host for a new one to reconnect.";

/**
 * Hand-typed input to the canonical `CNR-XXXX-XXXX-XXXX-XXXX` form, or
 * null when it is not a code. Mirrors the host's normalize_code_input:
 * dashes and whitespace ignored, ASCII case folded, Crockford confusables
 * read as digits (`I`/`L` as 1, `O` as 0), the `CNR` prefix optional.
 */
export function canonicalInviteCode(input: string): string | null {
  let core = input
    .replace(/[-\s]/g, "")
    .replace(/[a-z]/g, (c) => c.toUpperCase())
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (core.length === 3 + CODE_SYMBOLS && core.startsWith("CNR")) {
    core = core.slice(3);
  }
  if (core.length !== CODE_SYMBOLS || [...core].some((c) => !ALPHABET.includes(c))) {
    return null;
  }
  return `CNR-${core.slice(0, 4)}-${core.slice(4, 8)}-${core.slice(8, 12)}-${core.slice(12)}`;
}

/** The form's verdict on typed text: an error message, or null when valid. */
export function inviteFormError(input: string): string | null {
  return canonicalInviteCode(input) === null ? INVITE_FORMAT_ERROR : null;
}

/**
 * Take the `invite` parameter out of the URL fragment (`#invite=<code>`):
 * the raw value, or null when the fragment carries none. A fragment that
 * carries one is stripped from the address bar in place (no reload, no
 * history entry), so the code is not left on screen or in the history.
 */
export function takeInviteFragment(
  location: { pathname: string; search: string; hash: string },
  history: { replaceState(data: unknown, unused: string, url?: string): void },
): string | null {
  if (location.hash.length < 2) {
    return null;
  }
  const code = new URLSearchParams(location.hash.slice(1)).get("invite");
  if (code === null) {
    return null;
  }
  history.replaceState(null, "", location.pathname + location.search);
  return code;
}

function defaultStorage(): InviteStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function keyFor(link: GuestLink): string {
  return `${STORAGE_PREFIX}${link.ownerUid}/${link.hostId}`;
}

/** This tab's code for one guest link, re-checked; null when none. */
export function loadInvite(link: GuestLink, storage = defaultStorage()): string | null {
  try {
    const stored = storage?.getItem(keyFor(link)) ?? null;
    return stored === null ? null : canonicalInviteCode(stored);
  } catch {
    return null;
  }
}

/** Keep the canonical code for this tab; a storage that refuses is fine. */
export function saveInvite(link: GuestLink, code: string, storage = defaultStorage()): void {
  try {
    storage?.setItem(keyFor(link), code);
  } catch {
    // Without storage the code lives in memory only: a reload asks again.
  }
}

/** Drop this tab's code for one guest link. */
export function forgetInvite(link: GuestLink, storage = defaultStorage()): void {
  try {
    storage?.removeItem(keyFor(link));
  } catch {
    // Nothing stored, or nothing to clear.
  }
}
