// SPDX-License-Identifier: Apache-2.0
/**
 * remote.univerlab.org — the blind signaling relay: GitHub auth, one room
 * per user, TURN credentials. Every route either proves an identity or
 * forwards an opaque envelope; any other path is a 404 for now.
 */
import { handleCallback, handleLogin, handleLogout, handleMe, type AuthEnv } from "./auth.js";
import { handleDeviceWs, handleHostWs, type RoomNamespace } from "./ws.js";
import { handleTurn, type TurnEnv } from "./turn.js";
import { applySecurityHeaders } from "./protocol.js";

export { UserRoom } from "./room.js";

/** The Worker's environment: one room binding plus the five secrets. */
export interface Env extends AuthEnv, TurnEnv {
  USER_ROOM: RoomNamespace;
}

function json(body: unknown, status: number): Response {
  const headers = applySecurityHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
  );
  return new Response(JSON.stringify(body), { status, headers });
}

/** The method each defined path answers; anything else is a 405. */
const ROUTE_METHODS: Record<string, string> = {
  "/auth/login": "GET",
  "/auth/callback": "GET",
  "/auth/logout": "POST",
  "/auth/me": "GET",
  "/ws/device": "GET",
  "/ws/host": "GET",
  "/turn": "GET",
};

export default {
  fetch(req: Request, env: Env): Response | Promise<Response> {
    const pathname = new URL(req.url).pathname;
    const method = ROUTE_METHODS[pathname];
    if (method === undefined) {
      return json({ error: "not_found" }, 404);
    }
    if (req.method !== method) {
      return json({ error: "method_not_allowed" }, 405);
    }
    switch (pathname) {
      case "/auth/login":
        return handleLogin(req, env);
      case "/auth/callback":
        return handleCallback(req, env);
      case "/auth/logout":
        return handleLogout(req, env);
      case "/auth/me":
        return handleMe(req, env);
      case "/ws/device":
        return handleDeviceWs(req, env);
      case "/ws/host":
        return handleHostWs(req, env);
      case "/turn":
        return handleTurn(req, env);
      default:
        return json({ error: "not_found" }, 404);
    }
  },
};
