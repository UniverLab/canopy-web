// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  handleCallback,
  handleLogin,
  handleLogout,
  handleMe,
  signSession,
  verifySession,
  type AuthEnv,
} from "../src/auth.js";
import { fakeFetch } from "./fakes.js";

const ORIGIN = "https://remote.univerlab.org";
const SECRET = "test-session-secret-that-is-long-enough";
const NOW = 1793100000;

const env: AuthEnv = {
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  SESSION_SECRET: SECRET,
};

function request(path: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  return new Request(new URL(path, ORIGIN), { headers });
}

/** The value of the named cookie in the response's Set-Cookie headers. */
function setCookie(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0]?.trim() ?? "";
    if (pair.startsWith(`${name}=`)) {
      return pair.slice(name.length + 1);
    }
  }
  return null;
}

function hasAttribute(response: Response, name: string, attribute: string): boolean {
  return response.headers
    .getSetCookie()
    .some((header) => header.startsWith(`${name}=`) && header.includes(attribute));
}

describe("session cookies", () => {
  it("round-trips a signed session", async () => {
    const value = await signSession(123, "octo", SECRET, NOW);
    expect(await verifySession(value, SECRET, NOW + 60)).toEqual({ uid: 123, login: "octo" });
  });

  it("rejects a tampered payload", async () => {
    const value = await signSession(123, "octo", SECRET, NOW);
    const [payload, signature] = value.split(".") as [string, string];
    const tampered = `${payload?.slice(0, -2)}xx.${signature}`;
    expect(await verifySession(tampered, SECRET, NOW + 60)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const value = await signSession(123, "octo", SECRET, NOW);
    const [payload, signature] = value.split(".") as [string, string];
    const tampered = `${payload}.${signature?.slice(0, -2)}xx`;
    expect(await verifySession(tampered, SECRET, NOW + 60)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const value = await signSession(123, "octo", SECRET, NOW);
    expect(await verifySession(value, SECRET, NOW + 43201)).toBeNull();
  });

  it("rejects a session signed with another secret", async () => {
    const value = await signSession(123, "octo", "another-secret", NOW);
    expect(await verifySession(value, SECRET, NOW + 60)).toBeNull();
  });

  it("rejects malformed values", async () => {
    expect(await verifySession("no-separator", SECRET, NOW)).toBeNull();
    expect(await verifySession("a.b.c", SECRET, NOW)).toBeNull();
    expect(await verifySession(".", SECRET, NOW)).toBeNull();
  });
});

describe("GET /auth/login", () => {
  it("redirects to GitHub with the client id, a state and no scope", () => {
    const response = handleLogin(request("/auth/login"), env);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") as string);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("allow_signup")).toBe("false");
    expect(location.searchParams.get("scope")).toBeNull();
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(setCookie(response, "cr_oauth_state")).toBe(state);
  });

  it("parks the state in a short-lived cookie", () => {
    const response = handleLogin(request("/auth/login"), env);
    expect(hasAttribute(response, "cr_oauth_state", "Max-Age=600")).toBe(true);
    expect(hasAttribute(response, "cr_oauth_state", "Path=/auth")).toBe(true);
    expect(hasAttribute(response, "cr_oauth_state", "HttpOnly")).toBe(true);
    expect(hasAttribute(response, "cr_oauth_state", "Secure")).toBe(true);
    expect(hasAttribute(response, "cr_oauth_state", "SameSite=Lax")).toBe(true);
  });

  it("answers 500 without the client id", () => {
    const response = handleLogin(request("/auth/login"), { SESSION_SECRET: SECRET });
    expect(response.status).toBe(500);
  });
});

describe("GET /auth/callback", () => {
  const github = () =>
    fakeFetch([
      { url: "login/oauth/access_token", status: 200, body: { access_token: "gho_token" } },
      { url: "api.github.com/user", status: 200, body: { id: 123, login: "octo" } },
    ]);

  it("sets the session and clears the state on success", async () => {
    const fake = github();
    const response = await handleCallback(
      request("/auth/callback?code=abc&state=state-1", "cr_oauth_state=state-1"),
      env,
      fake.fetchImpl,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(fake.missing).toEqual([]);
    const session = setCookie(response, "cr_session");
    expect(session).toBeTruthy();
    expect(await verifySession(session as string, SECRET, Math.floor(Date.now() / 1000))).toEqual({
      uid: 123,
      login: "octo",
    });
    expect(hasAttribute(response, "cr_session", "Max-Age=43200")).toBe(true);
    expect(hasAttribute(response, "cr_session", "Path=/")).toBe(true);
    expect(hasAttribute(response, "cr_session", "HttpOnly")).toBe(true);
    expect(hasAttribute(response, "cr_session", "Secure")).toBe(true);
    expect(hasAttribute(response, "cr_session", "SameSite=Strict")).toBe(true);
    expect(hasAttribute(response, "cr_oauth_state", "Max-Age=0")).toBe(true);
  });

  it("rejects a state mismatch and clears the state cookie", async () => {
    const fake = github();
    const response = await handleCallback(
      request("/auth/callback?code=abc&state=state-1", "cr_oauth_state=other"),
      env,
      fake.fetchImpl,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "oauth_failed" });
    expect(hasAttribute(response, "cr_oauth_state", "Max-Age=0")).toBe(true);
    expect(setCookie(response, "cr_session")).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("rejects a missing state, code or an error query", async () => {
    const fake = github();
    for (const path of [
      "/auth/callback?code=abc",
      "/auth/callback?state=state-1",
      "/auth/callback?code=abc&state=state-1&error=access_denied",
    ]) {
      const response = await handleCallback(
        request(path, "cr_oauth_state=state-1"),
        env,
        fake.fetchImpl,
      );
      expect(response.status).toBe(400);
    }
    expect(fake.calls).toEqual([]);
  });

  it("rejects a refused code exchange", async () => {
    const fake = fakeFetch([
      { url: "login/oauth/access_token", status: 400, body: { error: "bad_verification_code" } },
    ]);
    const response = await handleCallback(
      request("/auth/callback?code=bad&state=state-1", "cr_oauth_state=state-1"),
      env,
      fake.fetchImpl,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "oauth_failed" });
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie", () => {
    const response = handleLogout(request("/auth/logout", "cr_session=whatever"), env);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(setCookie(response, "cr_session")).toBe("");
    expect(hasAttribute(response, "cr_session", "Max-Age=0")).toBe(true);
  });
});

describe("GET /auth/me", () => {
  it("returns the login for a valid session", async () => {
    const session = await signSession(123, "octo", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleMe(request("/auth/me", `cr_session=${session}`), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ login: "octo" });
  });

  it("answers 401 without a session or with a forged one", async () => {
    expect((await handleMe(request("/auth/me"), env)).status).toBe(401);
    const forged = await signSession(123, "octo", "wrong-secret", Math.floor(Date.now() / 1000));
    const response = await handleMe(request("/auth/me", `cr_session=${forged}`), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});
