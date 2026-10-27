// SPDX-License-Identifier: Apache-2.0
/**
 * The two WebSocket doors: browsers prove the session cookie, hosts prove
 * a GitHub token plus their id and label. Both land in the caller's own
 * UserRoom; the room itself only trusts the X-Relay-* headers set here.
 */
import { parseCookies } from "./codec.js";
import { verifySession } from "./auth.js";
import { verifyHostToken } from "./github.js";
import {
  RELAY_HOST_ID_HEADER,
  RELAY_LABEL_HEADER,
  RELAY_ROLE_HEADER,
  SESSION_COOKIE,
  applySecurityHeaders,
} from "./protocol.js";

/** A room stub, narrowed to the one call the Worker makes. */
export interface RoomStub {
  fetch(request: Request): Promise<Response>;
}

/** The UserRoom binding, narrowed to naming a room by user id. */
export interface RoomNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): RoomStub;
}

/** What the WebSocket doors need from the environment. */
export interface WsEnv {
  USER_ROOM: RoomNamespace;
  SESSION_SECRET?: string;
}

const BEARER_PATTERN = /^Bearer (.+)$/;
const HOST_ID_PATTERN = /^[0-9a-f]{16}$/;

function json(body: unknown, status: number): Response {
  const headers = applySecurityHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
  );
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Forward the upgrade to `room` with the relay headers set and the
 * caller's credentials stripped.
 */
function forward(req: Request, room: RoomStub, role: string, hostId?: string, label?: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.set(RELAY_ROLE_HEADER, role);
  if (hostId !== undefined) {
    headers.set(RELAY_HOST_ID_HEADER, hostId);
  }
  if (label !== undefined) {
    headers.set(RELAY_LABEL_HEADER, label);
  }
  return room.fetch(new Request("https://user-room/", { headers }));
}

function roomFor(env: WsEnv, uid: number): RoomStub {
  return env.USER_ROOM.get(env.USER_ROOM.idFromName(String(uid)));
}

/** A browser socket: the session cookie names its room. */
export async function handleDeviceWs(req: Request, env: WsEnv): Promise<Response> {
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    return json({ error: "misconfigured" }, 500);
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
  return forward(req, roomFor(env, session.uid), "device");
}

/** A host socket: GitHub token plus id and label, verified then forwarded. */
export async function handleHostWs(
  req: Request,
  env: WsEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const bearer = authorization === null ? null : BEARER_PATTERN.exec(authorization);
  if (bearer === null) {
    return json({ error: "unauthorized" }, 401);
  }
  const hostId = req.headers.get("x-canopy-host-id");
  if (hostId === null || !HOST_ID_PATTERN.test(hostId)) {
    return json({ error: "bad_host_id" }, 400);
  }
  const label = req.headers.get("x-canopy-host-label");
  if (label === null || label.length < 1 || label.length > 64) {
    return json({ error: "bad_label" }, 400);
  }
  const user = await verifyHostToken(bearer[1] as string, fetchImpl);
  if (user === null) {
    return json({ error: "unauthorized" }, 401);
  }
  return forward(req, roomFor(env, user.id), "host", hostId, label);
}
