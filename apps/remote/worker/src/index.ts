// SPDX-License-Identifier: Apache-2.0
/**
 * remote.univerlab.org — the blind signaling relay: GitHub auth, one room
 * per user, TURN credentials. Every route either proves an identity or
 * forwards an opaque envelope; any other path either serves the SPA's
 * index.html (extensionless navigation) or answers an honest 404 (agent
 * probes and file paths no built asset holds).
 */
import { handleCallback, handleLogin, handleLogout, handleMe, type AuthEnv } from "./auth.js";
import { handleDeviceWs, handleHostWs, type RoomNamespace } from "./ws.js";
import { handleTurn, type TurnEnv } from "./turn.js";
import { applySecurityHeaders } from "./protocol.js";

export { UserRoom } from "./room.js";

/**
 * The static-assets binding, narrowed to what the SPA fallback uses:
 * fetching the built index.html. The production Fetcher satisfies it.
 */
export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

/** The Worker's environment: the room and assets bindings plus the five secrets. */
export interface Env extends AuthEnv, TurnEnv {
  USER_ROOM: RoomNamespace;
  ASSETS: AssetsFetcher;
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
  fetch(req: Request, env: Env): Promise<Response> {
    const pathname = new URL(req.url).pathname;
    const method = ROUTE_METHODS[pathname];
    if (method === undefined) {
      return fallback(pathname, req, env);
    }
    if (req.method !== method) {
      return Promise.resolve(json({ error: "method_not_allowed" }, 405));
    }
    return dispatch(pathname, req, env);
  },
};

/** Agent probes that never exist here: llms.txt, sitemap, well-known files. */
function isAgentPath(pathname: string): boolean {
  return (
    pathname === "/llms.txt" ||
    pathname === "/sitemap.xml" ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/")
  );
}

/** True when the last segment names a file (`/app.css`), not a route. */
function hasExtension(pathname: string): boolean {
  const last = pathname.split("/").pop() ?? "";
  return last.includes(".");
}

/**
 * The asset miss: the Worker answers what the static folder did not hold.
 * Agent probes and file paths 404 honestly instead of claiming to exist
 * with 200 HTML; extensionless GET/HEAD navigation serves the built
 * index.html through the ASSETS binding, so client routes and deep links
 * keep working. Anything else (a POST to a route, a missing index.html)
 * is a 404 too.
 */
async function fallback(pathname: string, req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json({ error: "not_found" }, 404);
  }
  // A trailing slash does not turn a probe into a route: /llms.txt/ is
  // still /llms.txt, and /app.css/ still names a file. Only the bare /
  // keeps its slash.
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (isAgentPath(clean) || hasExtension(clean)) {
    return json({ error: "not_found" }, 404);
  }
  try {
    const asset = await env.ASSETS.fetch(new Request(new URL("/index.html", req.url)));
    if (asset.status !== 200) {
      return json({ error: "not_found" }, 404);
    }
    // Same values as public/_headers, which does not decorate a response
    // the Worker fetched through the binding.
    const headers = applySecurityHeaders(new Headers(asset.headers));
    return new Response(asset.body, { status: 200, headers });
  } catch {
    return json({ error: "not_found" }, 404);
  }
}

/**
 * Run the routed handler; an unexpected throw or rejection answers 500
 * with the security headers, never the runtime's bare error page.
 */
async function dispatch(pathname: string, req: Request, env: Env): Promise<Response> {
  try {
    switch (pathname) {
      case "/auth/login":
        return handleLogin(req, env);
      case "/auth/callback":
        return await handleCallback(req, env);
      case "/auth/logout":
        return handleLogout(req, env);
      case "/auth/me":
        return await handleMe(req, env);
      case "/ws/device":
        return await handleDeviceWs(req, env);
      case "/ws/host":
        return await handleHostWs(req, env);
      case "/turn":
        return await handleTurn(req, env);
      default:
        return json({ error: "not_found" }, 404);
    }
  } catch {
    return json({ error: "internal" }, 500);
  }
}
