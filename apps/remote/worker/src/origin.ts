// SPDX-License-Identifier: Apache-2.0
/**
 * Origin allowlist for the cookie-bearing relay doors. Browsers send
 * `Origin` on WebSocket upgrades and POST fetches, and Lax cookies ride
 * same-site — so without this gate any subdomain XSS reaches the relay
 * as the victim. The check is an exact string match: no suffix, prefix
 * or subdomain matching, so a sibling origin never passes.
 */

/** The production browser origin; the default when the env omits the list. */
export const DEFAULT_ALLOWED_ORIGIN = "https://remote.univerlab.org";

/**
 * Parse the ALLOWED_ORIGINS env value: comma-separated origins, exact
 * match against what the browser sends. Blank entries are dropped; an
 * absent or all-blank value means the production default alone.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [DEFAULT_ALLOWED_ORIGIN];
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries.length === 0 ? [DEFAULT_ALLOWED_ORIGIN] : entries;
}

/**
 * True when `origin` is present and exactly one of `allowed`. A missing
 * header is never allowed here — the /turn host-bearer bypass lives in
 * its handler, where the credential is already verified.
 */
export function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  return origin !== null && allowed.includes(origin);
}
