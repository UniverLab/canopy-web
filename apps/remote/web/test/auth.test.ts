// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { fetchLogin, signOut } from "../src/auth.js";

function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("fetchLogin", () => {
  it("returns the login behind the session cookie", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ login: "octo" }, 200));
    await expect(fetchLogin(fetchImpl)).resolves.toBe("octo");
    expect(calls).toEqual([{ url: "/auth/me", init: undefined }]);
  });

  it("returns null on 401", async () => {
    const { fetchImpl } = stubFetch(() => json({ error: "unauthorized" }, 401));
    await expect(fetchLogin(fetchImpl)).resolves.toBeNull();
  });

  it("returns null when the relay is unreachable or answers nonsense", async () => {
    const down = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchLogin(down.fetchImpl)).resolves.toBeNull();
    const broken = stubFetch(() => json({ user: "octo" }, 200));
    await expect(fetchLogin(broken.fetchImpl)).resolves.toBeNull();
  });
});

describe("signOut", () => {
  it("POSTs /auth/logout and resolves on success", async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response(null, { status: 200 }));
    await expect(signOut(fetchImpl)).resolves.toBeUndefined();
    expect(calls).toEqual([{ url: "/auth/logout", init: { method: "POST" } }]);
  });

  it("throws when the relay refuses or is unreachable", async () => {
    const refused = stubFetch(() => new Response(null, { status: 500 }));
    await expect(signOut(refused.fetchImpl)).rejects.toThrow("Could not sign out (500)");
    expect(refused.calls).toHaveLength(1);
    const down = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(signOut(down.fetchImpl)).rejects.toThrow("Could not reach the relay");
  });

  it("defaults to the global fetch", async () => {
    const global = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    try {
      await signOut();
      expect(global).toHaveBeenCalledWith("/auth/logout", { method: "POST" });
    } finally {
      global.mockRestore();
    }
  });
});
