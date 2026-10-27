// SPDX-License-Identifier: Apache-2.0
/**
 * The asset miss: what the Worker answers when the static folder held no
 * file for the path. Agent probes and file paths 404 honestly; only
 * extensionless navigation falls back to the SPA's index.html.
 */
import { describe, expect, it } from "vitest";
import worker, { type AssetsFetcher, type Env } from "../src/index.js";
import type { RoomNamespace, RoomStub } from "../src/ws.js";
import { FakeAssets } from "./fakes.js";

const ORIGIN = "https://remote.univerlab.org";

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

function testEnv(assets: AssetsFetcher = new FakeAssets()): Env {
  return {
    USER_ROOM: new FakeNamespace(),
    ASSETS: assets,
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    SESSION_SECRET: "test-session-secret-that-is-long-enough",
    TURN_KEY_ID: "turn-key-id",
    TURN_KEY_API_TOKEN: "turn-api-token",
  };
}

function request(path: string, method = "GET"): Request {
  return new Request(new URL(path, ORIGIN), { method });
}

describe("the SPA fallback", () => {
  it.each(["/", "/pair", "/pair/", "/deep/link"])("serves index.html for extensionless %s", async (path) => {
    const response = await worker.fetch(request(path), testEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain('<div id="app">');
  });

  it("carries the security headers on the fallback page", async () => {
    const response = await worker.fetch(request("/pair"), testEnv());
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 404 when the assets binding has no index.html", async () => {
    const missing: AssetsFetcher = {
      fetch: (): Promise<Response> => Promise.resolve(new Response("gone\n", { status: 404 })),
    };
    const response = await worker.fetch(request("/pair"), testEnv(missing));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("answers 404 when the assets binding throws", async () => {
    const broken: AssetsFetcher = {
      fetch: (): Promise<Response> => Promise.reject(new Error("binding is down")),
    };
    const response = await worker.fetch(request("/pair"), testEnv(broken));
    expect(response.status).toBe(404);
  });
});

describe("honest 404s", () => {
  it.each([
    "/.well-known",
    "/.well-known/api-catalog",
    "/.well-known/other",
    "/llms.txt",
    "/llms.txt/",
    "/sitemap.xml",
    "/sitemap.xml/",
  ])(
    "answers %s with a 404, never the SPA",
    async (path) => {
      const response = await worker.fetch(request(path), testEnv());
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.json()).toEqual({ error: "not_found" });
    },
  );

  it.each(["/app.css", "/app.css/", "/look/tokens.css", "/favicon.ico"])(
    "answers %s with a 404 when no built asset holds it",
    async (path) => {
      const response = await worker.fetch(request(path), testEnv());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    },
  );

  it("answers a POST to a route with a 404, not the SPA", async () => {
    const response = await worker.fetch(request("/pair", "POST"), testEnv());
    expect(response.status).toBe(404);
  });
});
