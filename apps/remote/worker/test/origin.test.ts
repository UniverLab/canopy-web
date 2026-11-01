// SPDX-License-Identifier: Apache-2.0
/**
 * The Origin allowlist on the cookie-bearing doors: a same-site XSS (e.g.
 * community content on graphs.univerlab.org) rides the victim's Lax
 * session cookie, so /ws/device, /turn and POST /auth/logout accept only
 * Origins in ALLOWED_ORIGINS — default exactly the production origin.
 * /turn alone lets a missing Origin through, and only with a verified
 * host credential, whose HTTP client sends none.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handleLogout, signSession, type AuthEnv } from "../src/auth.js";
import { __clearHostCache } from "../src/github.js";
import { DEFAULT_ALLOWED_ORIGIN, isOriginAllowed, parseAllowedOrigins } from "../src/origin.js";
import { __clearTurnGrants, handleTurn, type TurnEnv } from "../src/turn.js";
import { handleDeviceWs, handleHostWs, type RoomNamespace, type RoomStub, type WsEnv } from "../src/ws.js";
import { FakeTurnNamespace, fakeFetch } from "./fakes.js";

const PROD = "https://remote.univerlab.org";
const EVIL = "https://evil.example";
const SIBLING = "https://graphs.univerlab.org";
const SECRET = "test-session-secret-that-is-long-enough";
const HOST_ID = "0123456789abcdef";
const UPSTREAM = { iceServers: [{ urls: "turn:turn.example:3478", username: "user", credential: "pass" }] };

/** A room binding that records which room each socket was sent to. */
class FakeNamespace implements RoomNamespace {
  names: string[] = [];
  forwarded: Request[] = [];

  idFromName(name: string): unknown {
    this.names.push(name);
    return name;
  }

  get(id: unknown): RoomStub {
    void id;
    return {
      fetch: (request: Request): Promise<Response> => {
        this.forwarded.push(request);
        return Promise.resolve(new Response("forwarded"));
      },
    };
  }
}

function deviceEnv(namespace: FakeNamespace, allowedOrigins?: string): WsEnv {
  return { USER_ROOM: namespace, SESSION_SECRET: SECRET, ALLOWED_ORIGINS: allowedOrigins };
}

function deviceRequest(cookie: string | undefined, origin: string | null): Request {
  const headers = new Headers({ upgrade: "websocket" });
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  if (origin !== null) {
    headers.set("origin", origin);
  }
  return new Request(new URL("/ws/device", PROD), { headers });
}

function logoutEnv(allowedOrigins?: string): AuthEnv {
  return {
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    SESSION_SECRET: SECRET,
    ALLOWED_ORIGINS: allowedOrigins,
  };
}

function logoutRequest(origin: string | null): Request {
  const headers = new Headers();
  if (origin !== null) {
    headers.set("origin", origin);
  }
  return new Request(new URL("/auth/logout", PROD), { method: "POST", headers });
}

function turnEnv(rooms: FakeTurnNamespace, allowedOrigins?: string): TurnEnv {
  return {
    SESSION_SECRET: SECRET,
    TURN_KEY_ID: "turn-key-id",
    TURN_KEY_API_TOKEN: "turn-api-token",
    USER_ROOM: rooms,
    ALLOWED_ORIGINS: allowedOrigins,
  };
}

function turnRequest(options: { cookie?: string; token?: string; origin?: string | null }): Request {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  if (options.token !== undefined) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  if (options.origin !== undefined && options.origin !== null) {
    headers.set("origin", options.origin);
  }
  return new Request(new URL("/turn", PROD), { headers });
}

async function sessionCookie(): Promise<string> {
  const session = await signSession(789, "octo", SECRET, Math.floor(Date.now() / 1000));
  return `cr_session=${session}`;
}

function githubStub() {
  return fakeFetch([
    { url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM },
    { url: "api.github.com/user", status: 200, body: { id: 456, login: "host-user" } },
  ]);
}

beforeEach(() => {
  __clearHostCache();
  __clearTurnGrants();
});

describe("the allowlist itself", () => {
  it("defaults to exactly the production origin", () => {
    expect(DEFAULT_ALLOWED_ORIGIN).toBe(PROD);
    expect(parseAllowedOrigins(undefined)).toEqual([PROD]);
    expect(parseAllowedOrigins("")).toEqual([PROD]);
    expect(parseAllowedOrigins("  ")).toEqual([PROD]);
  });

  it("splits on commas and drops blanks", () => {
    expect(parseAllowedOrigins("https://a.example, https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(parseAllowedOrigins("https://a.example,, ")).toEqual(["https://a.example"]);
  });

  it("matches exactly: neither suffixes nor lookalikes pass", () => {
    const allowed = parseAllowedOrigins(undefined);
    expect(isOriginAllowed(PROD, allowed)).toBe(true);
    expect(isOriginAllowed(null, allowed)).toBe(false);
    expect(isOriginAllowed(EVIL, allowed)).toBe(false);
    expect(isOriginAllowed(SIBLING, allowed)).toBe(false);
    expect(isOriginAllowed(`${PROD}.evil.example`, allowed)).toBe(false);
    expect(isOriginAllowed("https://evilremote.univerlab.org", allowed)).toBe(false);
  });
});

describe("GET /ws/device", () => {
  it("forwards the production origin", async () => {
    const namespace = new FakeNamespace();
    const response = await handleDeviceWs(deviceRequest(await sessionCookie(), PROD), deviceEnv(namespace));
    expect(response.status).toBe(200);
    expect(namespace.names).toEqual(["789"]);
  });

  it("denies an evil, sibling or lookalike origin with 403, before any room", async () => {
    for (const origin of [EVIL, SIBLING, `${PROD}.evil.example`]) {
      const namespace = new FakeNamespace();
      const response = await handleDeviceWs(deviceRequest(await sessionCookie(), origin), deviceEnv(namespace));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden_origin" });
      expect(namespace.names).toEqual([]);
    }
  });

  it("denies a missing Origin with 403, even without a session", async () => {
    const namespace = new FakeNamespace();
    for (const cookie of [await sessionCookie(), undefined]) {
      const response = await handleDeviceWs(deviceRequest(cookie, null), deviceEnv(namespace));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden_origin" });
    }
    expect(namespace.names).toEqual([]);
  });

  it("honors an env override: the listed origin passes, production does not", async () => {
    const override = "https://preview.example";
    const listed = new FakeNamespace();
    const listedResponse = await handleDeviceWs(
      deviceRequest(await sessionCookie(), override),
      deviceEnv(listed, override),
    );
    expect(listedResponse.status).toBe(200);
    expect(listed.names).toEqual(["789"]);
    const prod = new FakeNamespace();
    const prodResponse = await handleDeviceWs(
      deviceRequest(await sessionCookie(), PROD),
      deviceEnv(prod, override),
    );
    expect(prodResponse.status).toBe(403);
    expect(await prodResponse.json()).toEqual({ error: "forbidden_origin" });
    expect(prod.names).toEqual([]);
  });
});

describe("POST /auth/logout", () => {
  it("clears the session for the production origin", () => {
    const response = handleLogout(logoutRequest(PROD), logoutEnv());
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie().some((header) => header.startsWith("cr_session="))).toBe(true);
  });

  it("denies an evil or sibling origin with 403 and clears nothing", () => {
    for (const origin of [EVIL, SIBLING]) {
      const response = handleLogout(logoutRequest(origin), logoutEnv());
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("denies a missing Origin with 403 and clears nothing", async () => {
    const response = handleLogout(logoutRequest(null), logoutEnv());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("honors an env override: the listed origin passes, production does not", () => {
    const override = "https://preview.example, https://else.example";
    expect(handleLogout(logoutRequest("https://preview.example"), logoutEnv(override)).status).toBe(303);
    expect(handleLogout(logoutRequest("https://else.example"), logoutEnv(override)).status).toBe(303);
    const denied = handleLogout(logoutRequest(PROD), logoutEnv(override));
    expect(denied.status).toBe(403);
    expect(denied.headers.getSetCookie()).toEqual([]);
  });
});

describe("GET /turn", () => {
  it("serves a cookied browser sending the production origin", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = githubStub();
    const response = await handleTurn(
      turnRequest({ cookie: await sessionCookie(), origin: PROD }),
      turnEnv(rooms),
      fake.fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(fake.calls.filter((url) => url.includes("generate-ice-servers"))).toHaveLength(1);
  });

  it("denies an evil or sibling origin with 403 for sessions and host credentials", async () => {
    for (const origin of [EVIL, SIBLING]) {
      const sessionRooms = new FakeTurnNamespace(true);
      const sessionFake = githubStub();
      const sessionResponse = await handleTurn(
        turnRequest({ cookie: await sessionCookie(), origin }),
        turnEnv(sessionRooms),
        sessionFake.fetchImpl,
      );
      expect(sessionResponse.status).toBe(403);
      expect(await sessionResponse.json()).toEqual({ error: "forbidden_origin" });
      expect(sessionFake.calls).toEqual([]);
      expect(sessionRooms.probed).toEqual([]);

      const hostRooms = new FakeTurnNamespace(true);
      const hostFake = githubStub();
      const hostResponse = await handleTurn(
        turnRequest({ token: "gho_valid", origin }),
        turnEnv(hostRooms),
        hostFake.fetchImpl,
      );
      expect(hostResponse.status).toBe(403);
      expect(await hostResponse.json()).toEqual({ error: "forbidden_origin" });
      expect(hostFake.calls.filter((url) => url.includes("generate-ice-servers"))).toEqual([]);
      expect(hostRooms.probed).toEqual([]);
    }
  });

  it("denies a missing Origin with a session, beating no_host", async () => {
    const rooms = new FakeTurnNamespace(false);
    const fake = githubStub();
    const response = await handleTurn(
      turnRequest({ cookie: await sessionCookie() }),
      turnEnv(rooms),
      fake.fetchImpl,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
    expect(fake.calls).toEqual([]);
    expect(rooms.probed).toEqual([]);
  });

  it("serves a verified host credential without an Origin", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = githubStub();
    const response = await handleTurn(turnRequest({ token: "gho_valid" }), turnEnv(rooms), fake.fetchImpl);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      iceServers: [...UPSTREAM.iceServers, { urls: "stun:stun.cloudflare.com:3478" }],
    });
  });

  it("answers 401 for a missing Origin with no credential", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = githubStub();
    const response = await handleTurn(turnRequest({}), turnEnv(rooms), fake.fetchImpl);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(rooms.names).toEqual([]);
  });

  it("honors an env override: the listed origin passes, production does not", async () => {
    const override = "https://preview.example";
    const listedRooms = new FakeTurnNamespace(true);
    const listedFake = githubStub();
    const listed = await handleTurn(
      turnRequest({ cookie: await sessionCookie(), origin: "https://preview.example" }),
      turnEnv(listedRooms, override),
      listedFake.fetchImpl,
    );
    expect(listed.status).toBe(200);
    const prodRooms = new FakeTurnNamespace(true);
    const prodFake = githubStub();
    const prod = await handleTurn(
      turnRequest({ cookie: await sessionCookie(), origin: PROD }),
      turnEnv(prodRooms, override),
      prodFake.fetchImpl,
    );
    expect(prod.status).toBe(403);
    expect(await prod.json()).toEqual({ error: "forbidden_origin" });
    expect(prodFake.calls).toEqual([]);
  });
});

describe("untouched doors", () => {
  it("leaves /ws/host without an Origin gate", async () => {
    const namespace = new FakeNamespace();
    const fake = fakeFetch([{ url: "api.github.com/user", status: 200, body: { id: 456, login: "host-user" } }]);
    const response = await handleHostWs(
      new Request(new URL("/ws/host", PROD), {
        headers: {
          upgrade: "websocket",
          authorization: "Bearer gho_valid",
          "x-canopy-host-id": HOST_ID,
          "x-canopy-host-label": "devbox",
        },
      }),
      { USER_ROOM: namespace, SESSION_SECRET: SECRET },
      fake.fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(namespace.names).toEqual(["456"]);
  });
});
