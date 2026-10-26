// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createGitHub, TTL, USER_AGENT, type ApiError } from "../src/github.js";
import { FakeCache, fakeFetch, type Stub } from "./fakes.js";

const url = "https://api.github.com/repos/UniverLab/graphs";

function run(stubs: Stub[], options: { token?: string } = {}): {
  calls: string[];
  cache: FakeCache;
} {
  const fake = fakeFetch(stubs);
  const cache = new FakeCache();
  const github = createGitHub({
    fetchImpl: fake.fetchImpl,
    cache,
    token: options.token,
  });
  void github;
  return { calls: fake.calls, cache };
}

describe("the GitHub transport", () => {
  it("sends a Bearer token, the catalogue User-Agent and a GitHub accept header", async () => {
    const seen: Array<Headers> = [];
    const fetchImpl = (async (input: Request | string) => {
      const request = input instanceof Request ? input : new Request(String(input));
      seen.push(request.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const github = createGitHub({
      fetchImpl,
      cache: new FakeCache(),
      token: "tok-123",
    });
    const response = await github.get(url, "contents");
    expect(!(response as ApiError).kind).toBe(true);
    expect(seen[0].get("authorization")).toBe("Bearer tok-123");
    expect(seen[0].get("user-agent")).toBe(USER_AGENT);
    expect(seen[0].get("accept")).toContain("vnd.github");
  });

  it("omits the Bearer header when no token exists", async () => {
    const { calls } = run([{ url, status: 200, body: {} }]);
    void calls;
    const seen: Array<Headers> = [];
    const fetchImpl = (async (input: Request | string) => {
      const request = input instanceof Request ? input : new Request(String(input));
      seen.push(request.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const github = createGitHub({ fetchImpl, cache: new FakeCache() });
    await github.get(url, "contents");
    expect(seen[0].get("authorization")).toBeNull();
  });

  it("serves the second identical call from the cache", async () => {
    const fake = fakeFetch([{ url, status: 200, body: { ok: 1 } }]);
    const cache = new FakeCache();
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache });
    const first = await github.get(url, "contents");
    const second = await github.get(url, "contents");
    expect(String((first as Response).status)).toBe("200");
    expect(fake.calls.length).toBe(1);
    expect(cache.puts).toBe(1);
    // a cache hit is a fresh, usable copy, not the same consumed object
    const cached = second as Response;
    expect(String(cached.status)).toBe("200");
    expect(JSON.stringify(await cached.json())).toBe(JSON.stringify({ ok: 1 }));
    // the stored response still has its body: the clone keeps it usable
    const again = await github.get(url, "contents");
    expect(JSON.stringify(await (again as Response).json())).toBe(JSON.stringify({ ok: 1 }));
  });

  it("stores search and contents with their own time-to-live", async () => {
    const fake = fakeFetch([
      { url, status: 200, body: {} },
      { url: "https://api.github.com/search/repositories", status: 200, body: {} },
    ]);
    const cache = new FakeCache();
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache });
    await github.get(url, "contents");
    await github.get("https://api.github.com/search/repositories?x=1", "search");
    const contentsTtl = (await cache.match(new Request(url)))?.headers.get("cache-control");
    const searchTtl =
      (await cache.match(new Request("https://api.github.com/search/repositories?x=1")))
        ?.headers.get("cache-control") ?? "";
    expect(contentsTtl).toContain(`max-age=${TTL.contents}`);
    expect(searchTtl).toContain(`max-age=${TTL.search}`);
  });

  it("surfaces a rate limit as a typed 429 with a retry-after", async () => {
    const fake = fakeFetch([
      {
        url,
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
      },
    ]);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const error = await github.get(url, "contents");
    expect((error as ApiError).kind).toBe("rate-limit");
    expect((error as ApiError).status).toBe(429);
    expect((error as ApiError).retryAfter).toBeGreaterThan(0);
  });

  it("treats a 429 header answer as a rate limit too", async () => {
    const fake = fakeFetch([
      {
        url,
        status: 429,
        body: "",
        headers: { "x-ratelimit-remaining": "0" },
      },
    ]);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const error = await github.get(url, "contents");
    expect((error as ApiError).kind).toBe("rate-limit");
  });

  it("maps 404 to a not-found error and other failures to an upstream error", async () => {
    const missing = "https://api.github.com/repos/a/b/contents/nope";
    const fake = fakeFetch([
      { url: missing, status: 404, body: {} },
      { url: "https://api.github.com/repos/a/b/contents/broken", status: 502, body: "" },
    ]);
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
    const notFound = await github.get(missing, "contents");
    const upstream = await github.get(
      "https://api.github.com/repos/a/b/contents/broken",
      "contents",
    );
    expect((notFound as ApiError).kind).toBe("not-found");
    expect((notFound as ApiError).status).toBe(404);
    expect((upstream as ApiError).kind).toBe("upstream");
    expect((upstream as ApiError).status).toBe(502);
  });

  it("turns a network failure into an upstream error, never a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const github = createGitHub({ fetchImpl, cache: new FakeCache() });
    const error = await github.get(url, "contents");
    expect((error as ApiError).kind).toBe("upstream");
    expect((error as ApiError).status).toBe(502);
  });

  it("keeps a warm entry serving when the upstream starts rate limiting", async () => {
    const fake = fakeFetch([{ url, status: 200, body: { ok: 1 } }]);
    const cache = new FakeCache();
    const warm = createGitHub({ fetchImpl: fake.fetchImpl, cache });
    await warm.get(url, "contents");
    expect(fake.calls.length).toBe(1);

    const limited = fakeFetch([
      { url, status: 403, headers: { "x-ratelimit-remaining": "0" } },
    ]);
    const cold = createGitHub({ fetchImpl: limited.fetchImpl, cache });
    const stillWarm = await cold.get(url, "contents");
    expect(limited.calls.length).toBe(0);
    expect(String((stillWarm as Response).status)).toBe("200");
  });

  it("does not store a failure response", async () => {
    const fake = fakeFetch([{ url, status: 404, body: {} }]);
    const cache = new FakeCache();
    const github = createGitHub({ fetchImpl: fake.fetchImpl, cache });
    await github.get(url, "contents");
    expect(cache.has(url)).toBe(false);
    expect(cache.puts).toBe(0);
  });
});
