// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { signSession } from "../src/auth.js";
import { __clearHostCache } from "../src/github.js";
import { handleTurn, type TurnEnv } from "../src/turn.js";
import { fakeFetch, type FakeFetch } from "./fakes.js";

const ORIGIN = "https://remote.univerlab.org";
const SECRET = "test-session-secret-that-is-long-enough";

const env: TurnEnv = {
  SESSION_SECRET: SECRET,
  TURN_KEY_ID: "turn-key-id",
  TURN_KEY_API_TOKEN: "turn-api-token",
};

const UPSTREAM = { iceServers: [{ urls: "turn:turn.example:3478", username: "user", credential: "pass" }] };

function request(cookie?: string, token?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  if (token !== undefined) {
    headers.set("authorization", `Bearer ${token}`);
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
});

describe("GET /turn", () => {
  it("serves a cookied browser with upstream entries plus STUN", async () => {
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 201, body: UPSTREAM }]);
    const { fetchImpl, seen } = recording(fake);
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleTurn(request(`cr_session=${session}`), env, fetchImpl);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      iceServers: [...UPSTREAM.iceServers, { urls: "stun:stun.cloudflare.com:3478" }],
    });
    expect(fake.calls).toEqual([
      "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-id/credentials/generate-ice-servers",
    ]);
    expect(JSON.parse(fake.bodies[0] as string)).toEqual({ ttl: 3600 });
    expect(seen[0]?.["authorization"]).toBe("Bearer turn-api-token");
  });

  it("serves a host bearer without touching GitHub twice", async () => {
    const fake = fakeFetch([
      { url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM },
      { url: "api.github.com/user", status: 200, body: { id: 456, login: "host-user" } },
    ]);
    const first = await handleTurn(request(undefined, "gho_valid"), env, fake.fetchImpl);
    expect(first.status).toBe(200);
    const second = await handleTurn(request(undefined, "gho_valid"), env, fake.fetchImpl);
    expect(second.status).toBe(200);
    expect(fake.calls.filter((url) => url.includes("api.github.com/user"))).toHaveLength(1);
  });

  it("answers 502 when the upstream fails, without forwarding its body", async () => {
    const fake = fakeFetch([
      { url: "credentials/generate-ice-servers", status: 500, body: { internal: "details" } },
    ]);
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleTurn(request(`cr_session=${session}`), env, fake.fetchImpl);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "turn_unavailable" });
  });

  it("answers 401 with neither credential", async () => {
    const fake = fakeFetch([{ url: "credentials/generate-ice-servers", status: 200, body: UPSTREAM }]);
    const response = await handleTurn(request(), env, fake.fetchImpl);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(fake.calls).toEqual([]);
  });
});
