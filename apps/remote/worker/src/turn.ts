// SPDX-License-Identifier: Apache-2.0
/**
 * Short-lived TURN credentials for hosts and their guests only. Either
 * credential the relay accepts (session cookie or host bearer) names a
 * room, and that room must hold at least one connected host; a valid
 * session alone mints nothing. The credentials come from Cloudflare's
 * TURN API and are never stored.
 */
import { parseCookies } from "./codec.js";
import { verifySession } from "./auth.js";
import { verifyHostToken } from "./github.js";
import { HOSTS_PROBE_PATH } from "./room.js";
import type { RoomNamespace } from "./ws.js";
import { SESSION_COOKIE, applySecurityHeaders } from "./protocol.js";

/** The secrets the TURN route needs; absent means 500, never a guess. */
export interface TurnEnv {
  SESSION_SECRET?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  USER_ROOM?: RoomNamespace;
}

/** Credential lifetime requested from Cloudflare, in seconds. */
const TURN_TTL_S = 900;

/** Most grants a uid mints per window; the next one is refused. */
const TURN_GRANTS_MAX = 20;

/** The grants window, in milliseconds. */
const TURN_GRANTS_WINDOW_MS = 3600000;

/** Granted-at stamps per uid, newest last. Isolate memory only. */
const grants = new Map<number, number[]>();

/** Test-only: drop every recorded grant. */
export function __clearTurnGrants(): void {
  grants.clear();
}

const BEARER_PATTERN = /^Bearer (.+)$/;

function json(body: unknown, status: number): Response {
  const headers = applySecurityHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
  );
  return new Response(JSON.stringify(body), { status, headers });
}

/** A caller the room probe cleared, keyed by the uid the quota counts. */
interface TurnCaller {
  uid: number;
}

/** Whether the room for `uid` holds a connected host; errors mean no. */
async function roomHasHost(uid: number, rooms: RoomNamespace): Promise<boolean> {
  try {
    const stub = rooms.get(rooms.idFromName(String(uid)));
    const response = await stub.fetch(new Request(`https://user-room${HOSTS_PROBE_PATH}`));
    if (!response.ok) {
      return false;
    }
    const parsed = (await response.json()) as Record<string, unknown>;
    return parsed["hasHost"] === true;
  } catch {
    return false;
  }
}

/**
 * Either a valid session cookie or a verified host token unlocks TURN —
 * but only when the caller's room holds a connected host. Null means no
 * valid credential; "no_host" means a valid credential with no host (or
 * an unreadable room: the probe fails closed).
 */
async function authorized(
  req: Request,
  env: TurnEnv,
  fetchImpl: typeof fetch,
): Promise<TurnCaller | "no_host" | null> {
  const rooms = env.USER_ROOM;
  if (rooms === undefined) {
    return "no_host";
  }
  const sessionSecret = env.SESSION_SECRET;
  if (sessionSecret) {
    const cookies = parseCookies(req.headers.get("cookie"));
    const value = cookies[SESSION_COOKIE];
    if (value) {
      const session = await verifySession(value, sessionSecret, Math.floor(Date.now() / 1000));
      if (session !== null) {
        return (await roomHasHost(session.uid, rooms)) ? { uid: session.uid } : "no_host";
      }
    }
  }
  const authorization = req.headers.get("authorization");
  const bearer = authorization === null ? null : BEARER_PATTERN.exec(authorization);
  if (bearer === null) {
    return null;
  }
  const user = await verifyHostToken(bearer[1] as string, fetchImpl);
  if (user === null) {
    return null;
  }
  return (await roomHasHost(user.id, rooms)) ? { uid: user.id } : "no_host";
}

/** True when `uid` already spent its grants window. */
function isRateLimited(uid: number, now: number): boolean {
  const stamps = grants.get(uid) ?? [];
  const fresh = stamps.filter((stamp) => now - stamp < TURN_GRANTS_WINDOW_MS);
  if (fresh.length !== stamps.length) {
    grants.set(uid, fresh);
  }
  return fresh.length >= TURN_GRANTS_MAX;
}

/** Record one granted mint for `uid`. Successful grants only. */
function recordGrant(uid: number, now: number): void {
  const stamps = grants.get(uid) ?? [];
  const fresh = stamps.filter((stamp) => now - stamp < TURN_GRANTS_WINDOW_MS);
  fresh.push(now);
  grants.set(uid, fresh);
}

/** Mint TURN credentials: upstream entries plus Cloudflare STUN. */
export async function handleTurn(
  req: Request,
  env: TurnEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const keyId = env.TURN_KEY_ID;
  const apiToken = env.TURN_KEY_API_TOKEN;
  if (!env.SESSION_SECRET || !keyId || !apiToken || !env.USER_ROOM) {
    return json({ error: "misconfigured" }, 500);
  }
  const caller = await authorized(req, env, fetchImpl);
  if (caller === null) {
    return json({ error: "unauthorized" }, 401);
  }
  if (caller === "no_host") {
    return json({ error: "no_host" }, 403);
  }
  if (isRateLimited(caller.uid, Date.now())) {
    return json({ error: "rate_limited" }, 429);
  }
  let response: Response;
  try {
    response = await fetchImpl(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL_S }),
      },
    );
  } catch {
    return json({ error: "turn_unavailable" }, 502);
  }
  if (!response.ok) {
    return json({ error: "turn_unavailable" }, 502);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return json({ error: "turn_unavailable" }, 502);
  }
  const upstream = (parsed as Record<string, unknown>)?.["iceServers"];
  if (!Array.isArray(upstream)) {
    return json({ error: "turn_unavailable" }, 502);
  }
  recordGrant(caller.uid, Date.now());
  return json(
    { iceServers: [...upstream, { urls: "stun:stun.cloudflare.com:3478" }] },
    200,
  );
}
