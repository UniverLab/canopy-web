// SPDX-License-Identifier: Apache-2.0
/**
 * Short-lived TURN credentials for both ends of a call. Either credential
 * the relay accepts (session cookie or host bearer) unlocks it; the
 * credentials come from Cloudflare's TURN API and are never stored.
 */
import { parseCookies } from "./codec.js";
import { verifySession } from "./auth.js";
import { verifyHostToken } from "./github.js";
import { SESSION_COOKIE, applySecurityHeaders } from "./protocol.js";

/** The secrets the TURN route needs; absent means 500, never a guess. */
export interface TurnEnv {
  SESSION_SECRET?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

/** Credential lifetime requested from Cloudflare, in seconds. */
const TURN_TTL_S = 3600;

const BEARER_PATTERN = /^Bearer (.+)$/;

function json(body: unknown, status: number): Response {
  const headers = applySecurityHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
  );
  return new Response(JSON.stringify(body), { status, headers });
}

/** Either a valid session cookie or a verified host bearer unlocks TURN. */
async function authorized(
  req: Request,
  env: TurnEnv,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const sessionSecret = env.SESSION_SECRET;
  if (sessionSecret) {
    const cookies = parseCookies(req.headers.get("cookie"));
    const value = cookies[SESSION_COOKIE];
    if (value) {
      const session = await verifySession(value, sessionSecret, Math.floor(Date.now() / 1000));
      if (session !== null) {
        return true;
      }
    }
  }
  const authorization = req.headers.get("authorization");
  const bearer = authorization === null ? null : BEARER_PATTERN.exec(authorization);
  if (bearer === null) {
    return false;
  }
  return (await verifyHostToken(bearer[1] as string, fetchImpl)) !== null;
}

/** Mint TURN credentials: upstream entries plus Cloudflare STUN. */
export async function handleTurn(
  req: Request,
  env: TurnEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const keyId = env.TURN_KEY_ID;
  const apiToken = env.TURN_KEY_API_TOKEN;
  if (!env.SESSION_SECRET || !keyId || !apiToken) {
    return json({ error: "misconfigured" }, 500);
  }
  if (!(await authorized(req, env, fetchImpl))) {
    return json({ error: "unauthorized" }, 401);
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
  return json(
    { iceServers: [...upstream, { urls: "stun:stun.cloudflare.com:3478" }] },
    200,
  );
}
