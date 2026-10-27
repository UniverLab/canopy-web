// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { signSession } from "../src/auth.js";
import { __clearHostCache } from "../src/github.js";
import { handleDeviceWs, handleHostWs, type RoomNamespace, type RoomStub, type WsEnv } from "../src/ws.js";
import { fakeFetch } from "./fakes.js";

const ORIGIN = "https://remote.univerlab.org";
const SECRET = "test-session-secret-that-is-long-enough";
const HOST_ID = "0123456789abcdef";

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

function setup(): { namespace: FakeNamespace; env: WsEnv } {
  const namespace = new FakeNamespace();
  return { namespace, env: { USER_ROOM: namespace, SESSION_SECRET: SECRET } };
}

function deviceRequest(cookie?: string): Request {
  const headers = new Headers({ upgrade: "websocket" });
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  return new Request(new URL("/ws/device", ORIGIN), { headers });
}

function hostRequest(options: { token?: string; hostId?: string; label?: string }): Request {
  const headers = new Headers({ upgrade: "websocket" });
  if (options.token !== undefined) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  if (options.hostId !== undefined) {
    headers.set("x-canopy-host-id", options.hostId);
  }
  if (options.label !== undefined) {
    headers.set("x-canopy-host-label", options.label);
  }
  return new Request(new URL("/ws/host", ORIGIN), { headers });
}

const githubUser = (id = 456, login = "host-user") =>
  fakeFetch([{ url: "api.github.com/user", status: 200, body: { id, login } }]);

beforeEach(() => {
  __clearHostCache();
});

describe("GET /ws/device", () => {
  it("forwards a valid session to its own room", async () => {
    const { namespace, env } = setup();
    const session = await signSession(789, "octo", SECRET, Math.floor(Date.now() / 1000));
    const response = await handleDeviceWs(deviceRequest(`cr_session=${session}; other=1`), env);
    expect(response.status).toBe(200);
    expect(namespace.names).toEqual(["789"]);
    const forwarded = namespace.forwarded[0] as Request;
    expect(forwarded.headers.get("x-relay-role")).toBe("device");
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBeNull();
  });

  it("answers 401 without a session or with a forged or expired one", async () => {
    const { namespace, env } = setup();
    const now = Math.floor(Date.now() / 1000);
    const forged = await signSession(789, "octo", "wrong-secret", now);
    const expired = await signSession(789, "octo", SECRET, now - 50000);
    for (const cookie of [undefined, "cr_session=forged.value", `cr_session=${forged}`, `cr_session=${expired}`]) {
      const response = await handleDeviceWs(deviceRequest(cookie), env);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(namespace.names).toEqual([]);
  });
});

describe("GET /ws/host", () => {
  it("forwards a verified host with relay headers and no credentials", async () => {
    const { namespace, env } = setup();
    const fake = githubUser();
    const response = await handleHostWs(
      hostRequest({ token: "gho_valid", hostId: HOST_ID, label: "devbox" }),
      env,
      fake.fetchImpl,
    );
    expect(response.status).toBe(200);
    expect(namespace.names).toEqual(["456"]);
    const forwarded = namespace.forwarded[0] as Request;
    expect(forwarded.headers.get("x-relay-role")).toBe("host");
    expect(forwarded.headers.get("x-relay-host-id")).toBe(HOST_ID);
    expect(forwarded.headers.get("x-relay-label")).toBe("devbox");
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBeNull();
  });

  it("answers 401 for a missing, malformed or rejected bearer", async () => {
    const { namespace, env } = setup();
    const rejected = fakeFetch([{ url: "api.github.com/user", status: 401, body: { message: "Bad" } }]);
    const malformed = new Request(new URL("/ws/host", ORIGIN), {
      headers: { authorization: "Token gho_valid", "x-canopy-host-id": HOST_ID, "x-canopy-host-label": "devbox" },
    });
    for (const req of [
      hostRequest({ hostId: HOST_ID, label: "devbox" }),
      malformed,
      hostRequest({ token: "gho_bad", hostId: HOST_ID, label: "devbox" }),
    ]) {
      const response = await handleHostWs(req, env, rejected.fetchImpl);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(namespace.names).toEqual([]);
  });

  it("answers 400 for a host id that is not 16 lowercase hex", async () => {
    const { env } = setup();
    const fake = githubUser();
    for (const hostId of ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "not-a-host-id"]) {
      const response = await handleHostWs(
        hostRequest({ token: "gho_valid", hostId, label: "devbox" }),
        env,
        fake.fetchImpl,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_host_id" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("answers 400 for a missing, empty or overlong label", async () => {
    const { env } = setup();
    const fake = githubUser();
    for (const label of ["", "x".repeat(65)]) {
      const response = await handleHostWs(
        hostRequest({ token: "gho_valid", hostId: HOST_ID, label }),
        env,
        fake.fetchImpl,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_label" });
    }
    const missing = await handleHostWs(
      hostRequest({ token: "gho_valid", hostId: HOST_ID }),
      env,
      fake.fetchImpl,
    );
    expect(missing.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("caches a verified token and skips GitHub on the second call", async () => {
    const { namespace, env } = setup();
    const fake = githubUser();
    const first = await handleHostWs(
      hostRequest({ token: "gho_valid", hostId: HOST_ID, label: "devbox" }),
      env,
      fake.fetchImpl,
    );
    const second = await handleHostWs(
      hostRequest({ token: "gho_valid", hostId: HOST_ID, label: "devbox" }),
      env,
      fake.fetchImpl,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(fake.calls.filter((url) => url.includes("api.github.com/user"))).toHaveLength(1);
    expect(namespace.names).toEqual(["456", "456"]);
  });
});
