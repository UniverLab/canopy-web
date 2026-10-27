// SPDX-License-Identifier: Apache-2.0
/**
 * GitHub OAuth for browsers: login redirect, code exchange, signed session.
 * The GitHub token is discarded after `/user`; the browser keeps only the
 * `cr_session` cookie, an HMAC-signed {uid, login, exp}.
 */
import { b64urlDecode, b64urlEncode, parseCookies, serializeCookie, timingSafeEqual } from "./codec.js";
import { SESSION_COOKIE, STATE_COOKIE, applySecurityHeaders } from "./protocol.js";
import { exchangeCode, fetchUser } from "./github.js";

/** The secrets the auth routes need; absent means 500, never a guess. */
export interface AuthEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}

export interface Session {
  uid: number;
  login: string;
}

/** Session lifetime: 12 hours, in seconds. */
const SESSION_TTL_S = 43200;

/** OAuth state lifetime: 10 minutes, in seconds. */
const STATE_TTL_S = 600;

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

/** Sign {uid, login, exp} with SESSION_SECRET. `nowSec` is unix seconds. */
export async function signSession(
  uid: number,
  login: string,
  secret: string,
  nowSec: number,
): Promise<string> {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ uid, login, exp: nowSec + SESSION_TTL_S })),
  );
  const signature = b64urlEncode(await hmacSha256(secret, payload));
  return `${payload}.${signature}`;
}

/** Verify a session cookie, or null when it is forged, expired or malformed. */
export async function verifySession(
  value: string,
  secret: string,
  nowSec: number,
): Promise<Session | null> {
  const parts = value.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts as [string, string];
  const payloadBytes = b64urlDecode(payload);
  const signatureBytes = b64urlDecode(signature);
  if (payloadBytes === null || signatureBytes === null) {
    return null;
  }
  const expected = await hmacSha256(secret, payload);
  if (!timingSafeEqual(signatureBytes, expected)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const { uid, login, exp } = parsed as Record<string, unknown>;
  if (typeof uid !== "number" || !Number.isInteger(uid)) {
    return null;
  }
  if (typeof login !== "string" || login === "") {
    return null;
  }
  if (typeof exp !== "number" || !(exp > nowSec)) {
    return null;
  }
  return { uid, login };
}

/** Fresh OAuth state: 32 random bytes, base64url. */
export function newState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

function clearStateCookie(): string {
  return serializeCookie(STATE_COOKIE, "", {
    maxAge: 0,
    path: "/auth",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
}

function json(body: unknown, status: number): Response {
  const headers = applySecurityHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
  );
  return new Response(JSON.stringify(body), { status, headers });
}

function misconfigured(): Response {
  return json({ error: "misconfigured" }, 500);
}

function oauthFailed(): Response {
  const headers = applySecurityHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
  );
  headers.append("set-cookie", clearStateCookie());
  return new Response(JSON.stringify({ error: "oauth_failed" }), { status: 400, headers });
}

/**
 * Redirect to GitHub's authorize page (identity only: no scope) and park
 * the state in a short-lived cookie.
 */
export function handleLogin(_req: Request, env: AuthEnv): Response {
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return misconfigured();
  }
  const state = newState();
  const location =
    "https://github.com/login/oauth/authorize" +
    `?client_id=${encodeURIComponent(clientId)}&state=${encodeURIComponent(state)}&allow_signup=false`;
  const headers = applySecurityHeaders(new Headers({ location }));
  headers.append(
    "set-cookie",
    serializeCookie(STATE_COOKIE, state, {
      maxAge: STATE_TTL_S,
      path: "/auth",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    }),
  );
  return new Response(null, { status: 302, headers });
}

/** Exchange the code, fetch the user, discard the token, set the session. */
export async function handleCallback(
  req: Request,
  env: AuthEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  const sessionSecret = env.SESSION_SECRET;
  if (!clientId || !clientSecret || !sessionSecret) {
    return misconfigured();
  }
  const url = new URL(req.url);
  const cookies = parseCookies(req.headers.get("cookie"));
  const state = url.searchParams.get("state");
  const cookieState = cookies[STATE_COOKIE];
  if (
    url.searchParams.get("error") !== null ||
    url.searchParams.get("code") === null ||
    !state ||
    !cookieState ||
    state !== cookieState
  ) {
    return oauthFailed();
  }
  const code = url.searchParams.get("code") as string;
  const token = await exchangeCode(code, { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret }, fetchImpl);
  if (token === null) {
    return oauthFailed();
  }
  const user = await fetchUser(token, fetchImpl);
  if (user === null) {
    return oauthFailed();
  }
  const session = await signSession(user.id, user.login, sessionSecret, Math.floor(Date.now() / 1000));
  const headers = applySecurityHeaders(new Headers({ location: "/" }));
  headers.append("set-cookie", clearStateCookie());
  headers.append(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, session, {
      maxAge: SESSION_TTL_S,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }),
  );
  return new Response(null, { status: 302, headers });
}

/** Clear the session cookie. */
export function handleLogout(_req: Request, _env: AuthEnv): Response {
  void _req;
  void _env;
  const headers = applySecurityHeaders(new Headers({ location: "/" }));
  headers.append(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, "", {
      maxAge: 0,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }),
  );
  return new Response(null, { status: 303, headers });
}

/** Who the session cookie says this browser is, or 401. */
export async function handleMe(req: Request, env: AuthEnv): Promise<Response> {
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    return misconfigured();
  }
  const cookies = parseCookies(req.headers.get("cookie"));
  const value = cookies[SESSION_COOKIE];
  if (!value) {
    return json({ error: "unauthorized" }, 401);
  }
  const session = await verifySession(value, sessionSecret, Math.floor(Date.now() / 1000));
  if (session === null) {
    return json({ error: "unauthorized" }, 401);
  }
  return json({ login: session.login }, 200);
}
