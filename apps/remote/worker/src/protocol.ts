// SPDX-License-Identifier: Apache-2.0
/**
 * Every literal shared by two or more modules lives here, so the relay's
 * wire details have exactly one home. If the same string appears in any
 * other module, it belongs here instead.
 */

/** Signed session cookie set by the OAuth callback. */
export const SESSION_COOKIE = "cr_session";

/** Short-lived OAuth state cookie, cleared by the callback. */
export const STATE_COOKIE = "cr_oauth_state";

/** Internal headers the Worker sets when forwarding to the room. */
export const RELAY_ROLE_HEADER = "X-Relay-Role";
export const RELAY_HOST_ID_HEADER = "X-Relay-Host-Id";
export const RELAY_LABEL_HEADER = "X-Relay-Label";

/** Largest accepted WebSocket frame, in bytes. */
export const FRAME_MAX_BYTES = 65536;

/** Most device sockets a room holds; the next one is refused. */
export const MAX_DEVICES = 8;

/** Most `pair_init` bodies a room accepts per window. */
export const PAIR_INIT_MAX = 20;

/** The `pair_init` window, in milliseconds. */
export const PAIR_INIT_WINDOW_MS = 600000;

/** How long a verified host token stays cached, in seconds. */
export const HOST_CACHE_TTL_S = 300;

/** Error codes the relay itself sends. */
export type RelayErrorCode = "no_target" | "too_large" | "rate_limited" | "bad_frame";

/** An envelope a client sends: a target plus an opaque body. */
export interface IncomingFrame {
  to: string;
  body: unknown;
}

/** An envelope the room delivers: a source plus the untouched body. */
export interface OutgoingFrame {
  from: string;
  body: unknown;
}

/** The per-socket attachment; runtime state lives only here. */
export interface RoomAttachment {
  role: "device" | "host";
  host_id?: string;
  label?: string;
  conn: string;
}

/** One host entry in the `hosts` notice. */
export interface HostItem {
  host_id: string;
  label: string;
}

/**
 * The security headers every response carries.
 *
 * The style directives allow what xterm.js needs and nothing more, measured
 * with a Playwright run that collects `securitypolicyviolation` events while
 * opening a session, typing, pushing output, resizing, zooming, then
 * rendering the graphs list (2026-10-29, @xterm/xterm 5.5.0,
 * @xterm/addon-webgl 0.18.0). On `Terminal.open()` the DOM renderer injects
 * two `<style>` elements — a 105-char dimensions rule and the ~55 KB
 * theme/ANSI stylesheet — reporting six `style-src-elem` violations before
 * the WebGL renderer replaces it; typing, output, resizing and zooming add
 * none (all sizing is CSSOM `element.style` writes, which the style
 * directives do not govern). The rules embed the runtime theme, fonts and
 * per-terminal keyframes, and xterm injects them itself on every open and on
 * its supported WebGL-to-DOM fallback (verified: a context loss re-injects
 * both, +6 violations), so no static stylesheet or hash can replace them:
 * `style-src-elem 'self' 'unsafe-inline'` is the last resort.
 * `style-src-attr 'unsafe-inline'` covers the live DOM renderer's cell
 * `style` attributes (selection backgrounds, truecolor cells) and the graphs
 * list's progress-bar widths (2 per render, refused without it).
 * `script-src` stays `'self'`.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; connect-src 'self' wss://remote.univerlab.org https://graphs.univerlab.org; " +
    "img-src 'self' data: blob:; style-src 'self'; style-src-attr 'unsafe-inline'; " +
    "style-src-elem 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** Set the security headers on `headers` and return it. */
export function applySecurityHeaders(headers: Headers): Headers {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}
