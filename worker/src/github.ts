// SPDX-License-Identifier: Apache-2.0
/**
 * GitHub transport for graphs.univerlab.org.
 *
 * Every call is a GET wrapped in the Cache API: the exact GitHub URL is the
 * cache key, only status 200 is stored, and the time-to-live depends on what
 * the URL is for (search 10 minutes, contents and raw files 30 minutes).
 * Lookup happens before the fetch, so a warm cache keeps serving when the
 * token runs out of rate limit.
 *
 * Errors are typed values, never exceptions: rate limiting, a missing path
 * and an upstream failure all come back as an `ApiError` the pages can show.
 */

/** Where the caller wants the result cached, which sets the time-to-live. */
export type CacheClass = "search" | "contents" | "raw" | "analytics";

/** Time-to-live in seconds, per cache class. */
export const TTL: Record<CacheClass, number> = {
  search: 600,
  contents: 1800,
  raw: 1800,
  analytics: 3600,
};

/** User-Agent GitHub asks every client to send. */
export const USER_AGENT = "canopy-graphs";

/** A sink for notes worth keeping (dropped documents, skipped repos). */
export type Log = (message: string) => void;

/** The smallest Cache API surface the transport needs. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** A typed catalogue error. `status` is what the API answers with. */
export interface ApiError {
  kind: "rate-limit" | "not-found" | "upstream" | "invalid-path" | "invalid-query" | "invalid-document";
  message: string;
  status: number;
  /** Seconds until the rate limit resets; only for `rate-limit`. */
  retryAfter?: number;
}

/** Dot-access on an unknown value, `undefined` when not an object. */
function field(value: unknown, key: string): unknown {
  if (value !== null && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

export function isApiError(value: unknown): value is ApiError {
  return field(value, "kind") !== undefined && typeof value === "object";
}

/** Dependency injection: tests pass fakes, the Worker passes the real ones. */
export interface GitHubOptions {
  /** Substitutable fetch; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Substitutable cache; defaults to `caches.default`. */
  cache?: CacheLike;
  /** Optional token, sent as a Bearer so the catalogue shares its quota fairly. */
  token?: string;
  /** Where dropped or skipped things are noted; defaults to no-op. */
  log?: Log;
}

/** The transport the catalogue modules program against. */
export interface GitHub {
  /** GET a URL, cache-first. Returns the (cached) Response or a typed error. */
  get(url: string, cacheClass: CacheClass): Promise<Response | ApiError>;
}

/** `caches.default` from the Worker runtime, found without a hard type import. */
function defaultCache(): CacheLike {
  const runtime = globalThis as unknown as { caches?: { default: CacheLike } };
  const found = runtime.caches;
  if (found === undefined || found.default === undefined) {
    throw new Error("the Cache API is unavailable in this runtime");
  }
  return found.default;
}

/** Seconds from now until the epoch-second limit resets, when parseable. */
function retryAfter(resetHeader: string | null): number | undefined {
  if (resetHeader === null) {
    return undefined;
  }
  const reset = Number.parseInt(resetHeader, 10);
  if (!Number.isFinite(reset)) {
    return undefined;
  }
  const seconds = Math.max(0, Math.ceil(reset - Date.now() / 1000));
  return seconds;
}

/** Shape a non-ok upstream response into a typed error. Never throws. */
function errorFor(response: Response, url: string): ApiError {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const base = `${(new URL(url)).host}${(new URL(url)).pathname} answered ${response.status}`;
  if (remaining === "0" && (response.status === 403 || response.status === 429)) {
    return {
      kind: "rate-limit",
      message: `GitHub rate limit reached: ${base}`,
      status: 429,
      retryAfter: retryAfter(response.headers.get("x-ratelimit-reset")),
    };
  }
  if (response.status === 404 || response.status === 410) {
    return { kind: "not-found", message: `Not found: ${base}`, status: 404 };
  }
  return { kind: "upstream", message: `Upstream error: ${base}`, status: 502 };
}

/**
 * Store one successful response in the cache with the class's time-to-live.
 * Cache failure (quota, private mode) shrugs: the fetch already succeeded.
 */
async function store(
  cache: CacheLike,
  request: Request,
  response: Response,
  cacheClass: CacheClass,
): Promise<void> {
  try {
    const headers = new Headers(response.headers);
    headers.delete("set-cookie");
    headers.set("cache-control", `public, max-age=${TTL[cacheClass]}`);
    // Buffer the body: the returned Response keeps its own, the clone goes to
    // the cache, and neither disturbs the other.
    const buffered = await response.clone().arrayBuffer();
    await cache.put(
      request,
      new Response(buffered, { status: response.status, headers }),
    );
  } catch {
    // A missing cache entry only costs the next request one fetch.
  }
}

/** Build the transport. Defaults wire to the Worker runtime; tests inject. */
export function createGitHub(options: GitHubOptions = {}): GitHub {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache: CacheLike = options.cache ?? defaultCache();
  const log: Log = options.log ?? (() => undefined);

  async function get(url: string, cacheClass: CacheClass): Promise<Response | ApiError> {
    const request = new Request(url, { method: "GET" });
    try {
      const cached = await cache.match(request);
      if (cached !== undefined) {
        return cached;
      }
    } catch {
      // An unreadable cache falls through to a plain fetch.
    }

    const headers = new Headers({
      "user-agent": USER_AGENT,
      accept: "application/vnd.github+json",
    });
    if (options.token !== undefined && options.token !== "") {
      headers.set("authorization", `Bearer ${options.token}`);
    }

    let response: Response;
    try {
      response = await fetchImpl(new Request(url, { headers }));
    } catch (error) {
      log(`github: fetch failed for ${url}: ${String(error)}`);
      return { kind: "upstream", message: `GitHub unreachable: ${url}`, status: 502 };
    }

    if (!response.ok) {
      log(`github: ${url} answered ${response.status}`);
      return errorFor(response, url);
    }
    await store(cache, request, response, cacheClass);
    return response;
  }

  return { get };
}
