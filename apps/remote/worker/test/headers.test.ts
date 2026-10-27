// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.js";
import { signSession } from "../src/auth.js";
import { UserRoom } from "../src/room.js";
import type { RoomNamespace, RoomStub } from "../src/ws.js";
import { FakeRoomState } from "./fakes.js";

const ORIGIN = "https://remote.univerlab.org";

const EXPECTED_CSP =
  "default-src 'self'; connect-src 'self' wss://remote.univerlab.org; " +
  "img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'";

class FakeNamespace implements RoomNamespace {
  idFromName(name: string): unknown {
    void name;
    return "room";
  }

  get(id: unknown): RoomStub {
    void id;
    return {
      fetch: (): Promise<Response> => Promise.resolve(new Response("forwarded")),
    };
  }
}

const env: Env = {
  USER_ROOM: new FakeNamespace(),
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  SESSION_SECRET: "test-session-secret-that-is-long-enough",
  TURN_KEY_ID: "turn-key-id",
  TURN_KEY_API_TOKEN: "turn-api-token",
};

function request(path: string, options: { method?: string; cookie?: string } = {}): Request {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  return new Request(new URL(path, ORIGIN), { method: options.method ?? "GET", headers });
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("security headers", () => {
  const cases: Array<{ name: string; path: string; method?: string; cookie?: string; status: number }> = [
    { name: "login 302", path: "/auth/login", status: 302 },
    { name: "callback 400", path: "/auth/callback?code=x&state=y", cookie: "cr_oauth_state=z", status: 400 },
    { name: "me 401", path: "/auth/me", status: 401 },
    { name: "logout 303", path: "/auth/logout", method: "POST", status: 303 },
    { name: "device 401", path: "/ws/device", status: 401 },
    { name: "host 401", path: "/ws/host", status: 401 },
    { name: "turn 401", path: "/turn", status: 401 },
    { name: "unknown path 404", path: "/nope", status: 404 },
    { name: "wrong method 405", path: "/auth/me", method: "POST", status: 405 },
  ];

  for (const { name, path, method, cookie, status } of cases) {
    it(`carries the headers on ${name}`, async () => {
      const response = await worker.fetch(request(path, { method, cookie }), env);
      expect(response.status).toBe(status);
      expectSecurityHeaders(response);
    });
  }

  it("carries the headers on an internal 500", async () => {
    const throwing: Env = {
      ...env,
      USER_ROOM: {
        idFromName: (name: string): unknown => {
          void name;
          throw new Error("boom");
        },
        get: (id: unknown): RoomStub => {
          void id;
          throw new Error("boom");
        },
      },
    };
    const session = await signSession(123, "octo", env.SESSION_SECRET as string, Math.floor(Date.now() / 1000));
    const response = await worker.fetch(request("/ws/device", { cookie: `cr_session=${session}` }), throwing);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expectSecurityHeaders(response);
  });

  it("carries the headers on the room's 426 and 400", () => {
    const room = new UserRoom(new FakeRoomState());
    const upgrade = new Request("https://user-room/", {
      headers: { upgrade: "websocket", "x-relay-role": "browser" },
    });
    for (const response of [room.fetch(new Request("https://user-room/")), room.fetch(upgrade)]) {
      expectSecurityHeaders(response);
    }
    expect(room.fetch(new Request("https://user-room/")).status).toBe(426);
    expect(room.fetch(upgrade).status).toBe(400);
  });
});
