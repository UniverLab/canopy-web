// SPDX-License-Identifier: Apache-2.0
/**
 * The two WebSocket doors: browsers prove the session cookie, hosts prove
 * a GitHub token plus their id and label. Browsers land in their own
 * UserRoom, or — with `?guest_of=<uid>&invite=<code>` — in that owner's
 * room as guests, carrying their own GitHub identity. The room admits only
 * guests whose invite hash matches a live host-published invite for their
 * uid, one socket per login, and only trusts the X-Relay-* headers set
 * here; what an invited guest may do is the hub's call.
 */
import { parseCookies, sha256Hex } from "./codec.js";
import { verifySession, type RevokedKV } from "./auth.js";
import { verifyHostToken } from "./github.js";
import { isOriginAllowed, parseAllowedOrigins } from "./origin.js";
import {
  RELAY_HOST_ID_HEADER,
  RELAY_INVITE_HASH_HEADER,
  RELAY_LABEL_HEADER,
  RELAY_LOGIN_HEADER,
  RELAY_ROLE_HEADER,
  RELAY_UID_HEADER,
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
  ALLOWED_ORIGINS?: string;
  SESSION_REVOKED?: RevokedKV;
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
function forward(
  req: Request,
  room: RoomStub,
  role: string,
  hostId?: string,
  label?: string,
  login?: string,
  uid?: number,
  inviteHash?: string,
): Promise<Response> {
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
  if (login !== undefined && uid !== undefined) {
    headers.set(RELAY_LOGIN_HEADER, login);
    headers.set(RELAY_UID_HEADER, String(uid));
  }
  if (inviteHash !== undefined) {
    headers.set(RELAY_INVITE_HASH_HEADER, inviteHash);
  }
  return room.fetch(new Request("https://user-room/", { headers }));
}

function roomFor(env: WsEnv, uid: number): RoomStub {
  return env.USER_ROOM.get(env.USER_ROOM.idFromName(String(uid)));
}

/**
 * A browser socket: the session cookie names its room — or, with a
 * `guest_of` query, the owner's room, as a guest carrying the caller's
 * own GitHub identity. The room admits the guest only when the invite hash
 * matches a live host-published invite for its uid; the hub authorizes
 * what it may do, from the identity headers forwarded here.
 *
 * Door errors: `misconfigured` (500, no secret), `forbidden_origin` (403,
 * foreign Origin), `unauthorized` (401, no or bad session), `bad_guest`
 * (400, malformed guest_of), `bad_invite` (403, missing invite here or no
 * live matching invite in the room).
 */
export async function handleDeviceWs(req: Request, env: WsEnv): Promise<Response> {
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    return json({ error: "misconfigured" }, 500);
  }
  if (!isOriginAllowed(req.headers.get("origin"), parseAllowedOrigins(env.ALLOWED_ORIGINS))) {
    return json({ error: "forbidden_origin" }, 403);
  }
  const cookies = parseCookies(req.headers.get("cookie"));
  const value = cookies[SESSION_COOKIE];
  if (!value) {
    return json({ error: "unauthorized" }, 401);
  }
  const session = await verifySession(
    value,
    sessionSecret,
    Math.floor(Date.now() / 1000),
    env.SESSION_REVOKED,
  );
  if (session === null) {
    return json({ error: "unauthorized" }, 401);
  }
  const params = new URL(req.url).searchParams;
  const guestOf = params.get("guest_of");
  if (guestOf === null || guestOf === String(session.uid)) {
    return forward(req, roomFor(env, session.uid), "device", undefined, undefined, session.login, session.uid);
  }
  if (!/^[1-9][0-9]*$/.test(guestOf)) {
    return json({ error: "bad_guest" }, 400);
  }
  // Digits past 2^53 lose precision in a Number and would land the guest
  // in another owner's room: fail closed like the room's own uid check.
  const ownerUid = Number(guestOf);
  if (!Number.isSafeInteger(ownerUid)) {
    return json({ error: "bad_guest" }, 400);
  }
  const invite = params.get("invite");
  if (invite === null || invite === "") {
    return json({ error: "bad_invite" }, 403);
  }
  // The room compares hashes; the cleartext code never leaves this door.
  const inviteHash = await sha256Hex(invite);
  return forward(
    req,
    roomFor(env, ownerUid),
    "guest",
    undefined,
    undefined,
    session.login,
    session.uid,
    inviteHash,
  );
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
