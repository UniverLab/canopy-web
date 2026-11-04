// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_HINT_COOKIE } from "../../worker/src/protocol.js";
import {
  armSessionHint,
  clearSessionHint,
  fetchLogin,
  SESSION_HINT_KEY,
  signOut,
} from "../src/auth.js";

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

function clearCookies(): void {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
}

beforeEach(() => {
  localStorage.clear();
  clearCookies();
});

function breakStorage(): { restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage is blocked");
    },
  });
  return {
    restore: () => {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      } else {
        Reflect.deleteProperty(globalThis, "localStorage");
      }
    },
  };
}

describe("fetchLogin", () => {
  it("skips the request without a session hint or cookie", async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ login: "octo" }, 200));
    await expect(fetchLogin(fetchImpl)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("fetches when the hint cookie is present with empty localStorage", async () => {
    document.cookie = `${SESSION_HINT_COOKIE}=1; path=/`;
    const { fetchImpl, calls } = stubFetch(() => json({ login: "octo" }, 200));
    await expect(fetchLogin(fetchImpl)).resolves.toBe("octo");
    expect(calls).toHaveLength(1);
  });

  it("fetches when the hint cookie is present, hint or not", async () => {
    document.cookie = `${SESSION_HINT_COOKIE}=1; path=/`;
    const { fetchImpl, calls } = stubFetch(() => json({ login: "octo" }, 200));
    await expect(fetchLogin(fetchImpl)).resolves.toBe("octo");
    expect(calls).toHaveLength(1);
  });

  it("ignores a cookie whose name merely contains the hint name", async () => {
    document.cookie = `other_${SESSION_HINT_COOKIE}=1; path=/`;
    const { fetchImpl, calls } = stubFetch(() => json({ login: "octo" }, 200));
    await expect(fetchLogin(fetchImpl)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns the login behind the session cookie and keeps the hint armed", async () => {
    armSessionHint();
    const { fetchImpl, calls } = stubFetch(() => json({ login: "octo" }, 200));
    await expect(fetchLogin(fetchImpl)).resolves.toBe("octo");
    expect(calls).toEqual([{ url: "/auth/me", init: undefined }]);
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe("1");
  });

  it("arms the hint on 200", async () => {
    document.cookie = `${SESSION_HINT_COOKIE}=1; path=/`;
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
    const { fetchImpl } = stubFetch(() => json({ login: "octo" }, 200));
    await expect(fetchLogin(fetchImpl)).resolves.toBe("octo");
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe("1");
  });

  it("returns null on 401 and clears the hint", async () => {
    armSessionHint();
    document.cookie = `${SESSION_HINT_COOKIE}=1; path=/`;
    const { fetchImpl } = stubFetch(() => json({ error: "unauthorized" }, 401));
    await expect(fetchLogin(fetchImpl)).resolves.toBeNull();
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
    expect(document.cookie).not.toContain(`${SESSION_HINT_COOKIE}=1`);
  });

  it("keeps the hint when the relay is unreachable or answers nonsense", async () => {
    armSessionHint();
    const down = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchLogin(down.fetchImpl)).resolves.toBeNull();
    const broken = stubFetch(() => json({ user: "octo" }, 200));
    await expect(fetchLogin(broken.fetchImpl)).resolves.toBeNull();
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe("1");
  });

  it("fetches when storage is denied (fail open)", async () => {
    const storage = breakStorage();
    try {
      const { fetchImpl, calls } = stubFetch(() => json({ login: "octo" }, 200));
      await expect(fetchLogin(fetchImpl)).resolves.toBe("octo");
      expect(calls).toHaveLength(1);
    } finally {
      storage.restore();
    }
  });
});

describe("session hint", () => {
  it("arms and clears", () => {
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
    armSessionHint();
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe("1");
    clearSessionHint();
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
  });

  it("survives a storage that throws (private mode)", () => {
    const storage = breakStorage();
    try {
      expect(() => armSessionHint()).not.toThrow();
      expect(() => clearSessionHint()).not.toThrow();
    } finally {
      storage.restore();
    }
  });
});

describe("signOut", () => {
  it("POSTs /auth/logout, resolves on success and clears the hint", async () => {
    armSessionHint();
    const { fetchImpl, calls } = stubFetch(() => new Response(null, { status: 200 }));
    await expect(signOut(fetchImpl)).resolves.toBeUndefined();
    expect(calls).toEqual([{ url: "/auth/logout", init: { method: "POST" } }]);
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
  });

  it("throws when the relay refuses or is unreachable, and keeps the hint", async () => {
    armSessionHint();
    const refused = stubFetch(() => new Response(null, { status: 500 }));
    await expect(signOut(refused.fetchImpl)).rejects.toThrow("Could not sign out (500)");
    expect(refused.calls).toHaveLength(1);
    const down = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(signOut(down.fetchImpl)).rejects.toThrow("Could not reach the relay");
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe("1");
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
