// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { signSession } from "../src/auth.js";
import { __clearHostCache } from "../src/github.js";
import { HOSTS_PROBE_PATH } from "../src/room.js";
import { __clearTurnGrants, handleTurn, type TurnEnv } from "../src/turn.js";
import { FakeTurnNamespace, fakeFetch, type FakeFetch } from "./fakes.js";

const ORIGIN = "https://remote.univerlab.org";
const SECRET = "test-session-secret-that-is-long-enough";

function turnEnv(rooms: FakeTurnNamespace): TurnEnv {
  return {
    SESSION_SECRET: SECRET,
    TURN_KEY_ID: "turn-key-id",
    TURN_KEY_API_TOKEN: "turn-api-token",
    USER_ROOM: rooms,
  };
}

const UPSTREAM = { iceServers: [{ urls: "turn:turn.example:3478", username: "user", credential: "pass" }] };

function request(
  cookie?: string,
  token?: string,
  origin: string | null = ORIGIN,
  extra: Record<string, string> = {},
): Request {
  const headers = new Headers();
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  if (token !== undefined) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (origin !== null) {
    headers.set("origin", origin);
  }
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }
  return new Request(new URL("/turn", ORIGIN), { headers });
}

/** Wrap a fake fetch to also record the headers of every call. */
function recording(fake: FakeFetch): { fetchImpl: typeof fetch; seen: Array<Record<string, string>> } {
  const seen: Array<Record<string, string>> = [];
  const fetchImpl = (async (input: URL | Request | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    seen.push(record);
    return fake.fetchImpl(input, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

beforeEach(() => {
  __clearHostCache();
  __clearTurnGrants();
});

describe("GET /turn", () => {
  it("serves a cookied browser with upstream entries plus STUN", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 201, body: UPSTREAM }]);
    const { fetchImpl, seen } = recording(fake);
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleTurn(request(`cr_session=${session}`), turnEnv(rooms), fetchImpl);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      iceServers: [...UPSTREAM.iceServers, { urls: "stun:stun.cloudflare.com:3478" }],
    });
    expect(fake.calls).toEqual([
      "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-id/credentials/generate-ice-servers",
    ]);
    expect(JSON.parse(fake.bodies[0] as string)).toEqual({ ttl: 900 });
    expect(seen[0]?.["authorization"]).toBe("Bearer turn-api-token");
    expect(rooms.names).toEqual(["123"]);
    expect(rooms.probed).toEqual([HOSTS_PROBE_PATH]);
  });

  it("serves a host bearer without touching GitHub twice", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([
      { url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM },
      { url: "api.github.com/user", status: 200, body: { id: 456, login: "host-user" } },
    ]);
    const env = turnEnv(rooms);
    const first = await handleTurn(request(undefined, "gho_valid"), env, fake.fetchImpl);
    expect(first.status).toBe(200);
    const second = await handleTurn(request(undefined, "gho_valid"), env, fake.fetchImpl);
    expect(second.status).toBe(200);
    expect(fake.calls.filter((url) => url.includes("api.github.com/user"))).toHaveLength(1);
    expect(rooms.names).toEqual(["456", "456"]);
  });

  it("denies a stranger whose room holds no host", async () => {
    const rooms = new FakeTurnNamespace(false);
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
    const session = await signSession(123, "stranger", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleTurn(request(`cr_session=${session}`), turnEnv(rooms), fake.fetchImpl);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_host" });
    expect(fake.calls).toEqual([]);
    expect(rooms.names).toEqual(["123"]);
  });

  it("denies a host bearer when its room holds no host", async () => {
    const rooms = new FakeTurnNamespace(false);
    const fake = fakeFetch([
      { url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM },
      { url: "api.github.com/user", status: 200, body: { id: 456, login: "host-user" } },
    ]);
    const response = await handleTurn(request(undefined, "gho_valid"), turnEnv(rooms), fake.fetchImpl);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_host" });
    expect(fake.calls.filter((url) => url.includes("credentials/generate-ice-servers"))).toEqual([]);
  });

  it("fails closed when the room probe throws, 500s or malforms", async () => {
    for (const behavior of ["throw", "bad-status", "malformed"] as const) {
      const rooms = new FakeTurnNamespace(behavior);
      const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
      const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
      const response = await handleTurn(request(`cr_session=${session}`), turnEnv(rooms), fake.fetchImpl);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "no_host" });
      expect(fake.calls).toEqual([]);
    }
  });

  it("refuses the 21st grant within the hour with 429", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
    const env = turnEnv(rooms);
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    for (let index = 0; index < 20; index += 1) {
      const response = await handleTurn(request(`cr_session=${session}`), env, fake.fetchImpl);
      expect(response.status).toBe(200);
    }
    const limited = await handleTurn(request(`cr_session=${session}`), env, fake.fetchImpl);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(fake.calls).toHaveLength(20);
    expect(rooms.names).toHaveLength(21);
  });

  it("counts only successful grants against the quota", async () => {
    const rooms = new FakeTurnNamespace(true);
    const env = turnEnv(rooms);
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    const failing = fakeFetch([{ url: "credentials/generate-ice-servers", status: 500, body: {} }]);
    expect(await (await handleTurn(request(`cr_session=${session}`), env, failing.fetchImpl)).json()).toEqual({
      error: "turn_unavailable",
    });
    const succeeding = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
    for (let index = 0; index < 20; index += 1) {
      const response = await handleTurn(request(`cr_session=${session}`), env, succeeding.fetchImpl);
      expect(response.status).toBe(200);
    }
    const limited = await handleTurn(request(`cr_session=${session}`), env, succeeding.fetchImpl);
    expect(limited.status).toBe(429);
  });

  it("quotas one uid without touching another", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
    const env = turnEnv(rooms);
    const now = Math.floor(Date.now() / 1000);
    const first = await signSession(111, "first", SECRET, now);
    const second = await signSession(222, "second", SECRET, now);
    for (let index = 0; index < 20; index += 1) {
      expect((await handleTurn(request(`cr_session=${first}`), env, fake.fetchImpl)).status).toBe(200);
    }
    expect((await handleTurn(request(`cr_session=${first}`), env, fake.fetchImpl)).status).toBe(429);
    expect((await handleTurn(request(`cr_session=${second}`), env, fake.fetchImpl)).status).toBe(200);
  });

  it("answers 502 when the upstream fails, without forwarding its body", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([
      { url: "credentials/generate-ice-servers", status: 500, body: { internal: "details" } },
    ]);
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleTurn(request(`cr_session=${session}`), turnEnv(rooms), fake.fetchImpl);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "turn_unavailable" });
  });

  it("answers 401 with neither credential", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
    const response = await handleTurn(request(), turnEnv(rooms), fake.fetchImpl);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(fake.calls).toEqual([]);
    expect(rooms.names).toEqual([]);
  });

  it("turn_accepts_same_origin_get_without_origin", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleTurn(
      request(`cr_session=${session}`, undefined, null, { "sec-fetch-site": "same-origin" }),
      turnEnv(rooms),
      fake.fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      iceServers: [...UPSTREAM.iceServers, { urls: "stun:stun.cloudflare.com:3478" }],
    });
    expect(rooms.names).toEqual(["123"]);
  });

  it("turn_rejects_missing_origin_without_fetch_metadata", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleTurn(
      request(`cr_session=${session}`, undefined, null),
      turnEnv(rooms),
      fake.fetchImpl,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
    expect(fake.calls).toEqual([]);
    expect(rooms.names).toEqual([]);
  });

  it("turn_rejects_cross_site_without_origin", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleTurn(
      request(`cr_session=${session}`, undefined, null, { "sec-fetch-site": "cross-site" }),
      turnEnv(rooms),
      fake.fetchImpl,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
    expect(fake.calls).toEqual([]);
    expect(rooms.names).toEqual([]);
  });

  it("turn_keeps_bearer_without_origin", async () => {
    const rooms = new FakeTurnNamespace(true);
    const fake = fakeFetch([
      { url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM },
      { url: "api.github.com/user", status: 200, body: { id: 456, login: "host-user" } },
    ]);
    const response = await handleTurn(
      request(undefined, "gho_valid", null),
      turnEnv(rooms),
      fake.fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      iceServers: [...UPSTREAM.iceServers, { urls: "stun:stun.cloudflare.com:3478" }],
    });
  });
});
